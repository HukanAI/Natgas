// js/contracts.js
import { MONTHS, NGF_CODES } from './constants.js';
import { state } from './state.js';
import { dbLog } from './debug.js';
import { proxyFetchJSON } from './proxy.js';

// ── NYMEX holiday calculation (shared with widgets.js roll KPI) ───────────────

function easterSunday(year) {
    const a = year % 19, b = Math.floor(year / 100), c = year % 100;
    const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4), k = c % 4;
    const L = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * L) / 451);
    const month = Math.floor((h + L - 7 * m + 114) / 31);
    const day   = ((h + L - 7 * m + 114) % 31) + 1;
    return new Date(Date.UTC(year, month - 1, day));
}

const _nymexHolidayCache = {};
function nymexHolidays(year) {
    const set = new Set();
    const add = d => set.add(d.toISOString().slice(0, 10));
    const adj = d => {
        const dow = d.getUTCDay();
        if (dow === 6) d.setUTCDate(d.getUTCDate() - 1);
        else if (dow === 0) d.setUTCDate(d.getUTCDate() + 1);
        return d;
    };
    const nth = (y, mo, n, dow) => {
        const d = new Date(Date.UTC(y, mo, 1));
        d.setUTCDate(1 + (dow - d.getUTCDay() + 7) % 7 + (n - 1) * 7);
        return d;
    };
    const last = (y, mo, dow) => {
        const d = new Date(Date.UTC(y, mo + 1, 0));
        d.setUTCDate(d.getUTCDate() - (d.getUTCDay() - dow + 7) % 7);
        return d;
    };
    add(adj(new Date(Date.UTC(year, 0, 1))));             // New Year's
    add(nth(year, 0, 3, 1));                              // MLK Day
    add(nth(year, 1, 3, 1));                              // Presidents Day
    const goodFri = new Date(easterSunday(year));
    goodFri.setUTCDate(goodFri.getUTCDate() - 2);
    add(goodFri);                                         // Good Friday
    add(last(year, 4, 1));                                // Memorial Day
    add(adj(new Date(Date.UTC(year, 5, 19))));            // Juneteenth
    add(adj(new Date(Date.UTC(year, 6, 4))));             // Independence Day
    add(nth(year, 8, 1, 1));                              // Labor Day
    add(nth(year, 10, 4, 4));                             // Thanksgiving
    add(adj(new Date(Date.UTC(year, 11, 25))));           // Christmas
    return set;
}

function isNYMEXHoliday(d) {
    const y = d.getUTCFullYear();
    if (!_nymexHolidayCache[y]) _nymexHolidayCache[y] = nymexHolidays(y);
    return _nymexHolidayCache[y].has(d.toISOString().slice(0, 10));
}

export function isBusinessDayNYMEX(d) {
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) return false;
    if (isNYMEXHoliday(d)) return false;
    return true;
}

// NYMEX last trading day = 3 business days before 1st of delivery month
export function nymexLastTradingDay(year, deliveryMonth) {
    const d = new Date(Date.UTC(year, deliveryMonth, 1));
    let counted = 0;
    while (counted < 3) {
        d.setUTCDate(d.getUTCDate() - 1);
        if (isBusinessDayNYMEX(d)) counted++;
    }
    return d;
}

// T212 roll = 2 business days before NYMEX last trading day
export function t212RollDate(year, deliveryMonth) {
    const expiry = nymexLastTradingDay(year, deliveryMonth);
    let counted = 0;
    while (counted < 2) {
        expiry.setUTCDate(expiry.getUTCDate() - 1);
        if (isBusinessDayNYMEX(expiry)) counted++;
    }
    expiry.setUTCHours(19, 30, 0, 0); // ~14:30 ET settlement
    return expiry;
}

// ── Contract objects ──────────────────────────────────────────────────────────

export function ngfExpiry(yr, m0) {
    // Legacy: NYMEX last trading day (used elsewhere)
    return nymexLastTradingDay(yr, m0);
}

function ngfContractObj(m0, yr) {
    return { m0, yr, label: MONTHS[m0] + ' ' + yr, ticker: 'NG' + NGF_CODES[m0] + String(yr).slice(-2) + '.NYM', isFront: false };
}

// ── T212-based front contract ─────────────────────────────────────────────────
// Front = contract whose T212 roll date is in the FUTURE (or today)
// When T212 roll passes → next contract becomes front automatically

export function ngfCurrent() {
    const now = new Date();
    for (let off = 0; off <= 13; off++) {
        const totalM = now.getUTCMonth() + off;
        const m0 = totalM % 12;
        const yr = now.getUTCFullYear() + Math.floor(totalM / 12);
        const roll = t212RollDate(yr, m0);
        if (roll > now) {
            const obj = ngfContractObj(m0, yr);
            obj.isFront = true;
            obj.t212Roll = roll;
            return obj;
        }
    }
    return null;
}

export function ngfNext(cur) {
    const m0 = (cur.m0 + 1) % 12;
    const yr  = cur.yr + (cur.m0 === 11 ? 1 : 0);
    return ngfContractObj(m0, yr);
}

export function ngfLogContracts() {
    const now = new Date();
    // Every contract that has not rolled yet satisfies `roll > now`, so testing
    // that per row labelled all of them FRONT. Only the nearest one is.
    const front = ngfCurrent();
    for (let off = 0; off < 4; off++) {
        const totalM = now.getUTCMonth() + off;
        const m0 = totalM % 12;
        const yr = now.getUTCFullYear() + Math.floor(totalM / 12);
        const roll = t212RollDate(yr, m0);
        const isFront = !!front && front.m0 === m0 && front.yr === yr;
        dbLog('Contract ' + MONTHS[m0] + ' ' + yr + ' [' + NGF_CODES[m0] + '] T212-roll=' + roll.toDateString() + (isFront ? ' FRONT' : ''), isFront ? 'ok' : 'info');
    }
}

// ── Lightweight live quote (for periodic refresh — minimal data transfer) ──────
// Fetches only today's 1-minute bars to get the latest close.
// Much smaller payload than the full year history used by ngfFetchTwoDays.

export async function ngfFetchQuote(ticker, isFront) {
  // The dated contract is the authority; NG=F (continuous front month) is only a
  // fallback. Trying NG=F first made the mobile page show a different front-month
  // price than the desktop, which prefers the dated ticker.
  const symbols = isFront ? [ticker, 'NG=F'] : [ticker];
  // Same params as fetchDailyHistory so the two calls the mobile page makes for
  // one contract collapse into a single request in the proxy layer.
  const params = 'interval=1d&range=10d';
  for (const sym of symbols) {
    try {
      const rows = await yahooFetch(sym, params);
      if (!rows?.length) continue;
      // Walk backwards to find last non-null close
      for (let i = rows.length - 1; i >= 0; i--) {
        const last = rows[i].close;
        if (last != null && isFinite(last) && last > 0) return { sym, last };
      }
    } catch(e) { /* try next symbol silently */ }
  }
  dbLog('Quote ' + symbols.join('/') + ': all failed', 'warn');
  return null;
}

// ── Yahoo Finance fetch ───────────────────────────────────────────────────────

const YAHOO_BASES = [
  'https://query1.finance.yahoo.com/v8/finance/chart/',
  'https://query2.finance.yahoo.com/v8/finance/chart/',
];

// How long a given response stays reusable. Intraday bars go stale fast; the
// multi-year weekly history changes once a week. Caching here is what keeps the
// startup burst (12 futures contracts + 6 TA timeframes) from re-requesting the
// same symbol through a rate-limited proxy.
function cacheTtlFor(queryParams) {
  if (/interval=1wk|interval=1mo/.test(queryParams)) return 30 * 60 * 1000;
  // Everything shorter feeds a live price or an intraday chart, so the window is
  // just wide enough to collapse the startup burst without showing stale prices
  // (the front-month price refreshes on a 60s timer).
  return 30 * 1000;
}

function parseChart(data) {
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error('no chart result');
  const ts = result.timestamp, q = result.indicators?.quote?.[0];
  if (!ts || !q) throw new Error('no quotes');
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const o = parseFloat(q.open[i]), h = parseFloat(q.high[i]),
          l = parseFloat(q.low[i]),  c = parseFloat(q.close[i]);
    const v = q.volume ? parseFloat(q.volume[i]) : null;
    if (isFinite(o) && isFinite(h) && isFinite(l) && isFinite(c))
      out.push({ ts: ts[i] * 1000, open: o, high: h, low: l, close: c, volume: isFinite(v) ? v : null });
  }
  if (!out.length) throw new Error('empty result');
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

export async function yahooFetch(symbol, queryParams) {
  const ttl = cacheTtlFor(queryParams);
  let lastErr = null;
  for (const base of YAHOO_BASES) {
    const url = base + encodeURIComponent(symbol) + '?' + queryParams + '&lang=en-US&region=US';
    // Callers add `_t=<now>` to defeat proxy-side caching; strip it from the
    // cache key so our own de-duplication still recognises repeat requests.
    const key = url.replace(/[?&]_t=\d+/, '');
    try {
      // validate runs before a proxy is trusted, so a proxy answering HTTP 200
      // with an error page is rejected and the next proxy is tried.
      const data = await proxyFetchJSON(url, {
        ttl, key,
        validate: j => !!j?.chart?.result?.[0]?.timestamp,
      });
      return parseChart(data);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('yahooFetch failed for ' + symbol);
}

export async function ngfFetchTwoDays(ticker, isFrontMonth) {
  // Only the last two daily closes are used, so ask for a month rather than the
  // 1.5 years this used to download — 12 of these run in parallel for the
  // futures curve, and the oversized payload was a large part of why free
  // proxies rate-limited the dashboard.
  const symbols = isFrontMonth ? [ticker, 'NG=F'] : [ticker];
  let lastErr = null;
  for (const sym of symbols) {
    try {
      const rows = await yahooFetch(sym, 'interval=1d&range=1mo&events=history');
      if (!rows?.length) continue;
      const closes = rows.map(r => r.close);
      return {last:closes[closes.length-1], prev:closes.length>=2?closes[closes.length-2]:null};
    } catch(e) { lastErr=e; dbLog('Price '+sym+' fail: '+e.message, 'warn'); }
  }
  throw lastErr || new Error('all symbols failed for '+ticker);
}

// ── Daily history fetcher (for prev-day close calculations) ─────────────────
// Returns array of {ts, open, high, low, close} for last ~10 trading days
export async function fetchDailyHistory(ticker) {
  // Use only the specific ticker — no NG=F fallback to avoid wrong prev close
  const symbols = ticker === 'NG=F' ? ['NG=F'] : [ticker];
  let lastErr = null;
  for (const sym of symbols) {
    try {
      const rows = await yahooFetch(sym, 'interval=1d&range=10d');
      if (rows && rows.length >= 2) return rows;
      lastErr = new Error('insufficient bars for ' + sym);
    } catch(e) {
      lastErr = e;
      dbLog('Daily history ' + sym + ' fail: ' + e.message, 'warn');
    }
  }
  throw lastErr || new Error('daily history failed for ' + ticker);
}

// ── Futures contract list builder ─────────────────────────────────────────────

export function fcBuildContractList(count) {
  const cur = ngfCurrent(); if (!cur) return [];
  const list = [cur]; let prev = cur;
  for (let i=1; i<count; i++) { prev=ngfNext(prev); list.push(prev); }
  return list;
}
