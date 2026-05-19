// js/contracts.js
import { MONTHS, NGF_CODES } from './constants.js';
import { state } from './state.js';
import { dbLog } from './debug.js';

// ── Expiry calculation ────────────────────────────────────────────────────────

export function ngfExpiry(yr, m0) {
  let pm = m0-1, py = yr;
  if (pm < 0) { pm=11; py--; }
  const d = new Date(py, pm+1, 0);
  while (d.getDay()===0 || d.getDay()===6) d.setDate(d.getDate()-1);
  let bdays = 0;
  while (bdays < 3) { d.setDate(d.getDate()-1); if(d.getDay()!==0&&d.getDay()!==6) bdays++; }
  return d;
}

function ngfContractObj(m0, yr) {
  return {m0, yr, label:MONTHS[m0]+' '+yr, ticker:'NG'+NGF_CODES[m0]+String(yr).slice(-2)+'.NYM', isFront:false};
}

export function ngfCurrent() {
  const now=new Date(), today=new Date(now.getFullYear(), now.getMonth(), now.getDate());
  for (let off=0; off<=13; off++) {
    const totalM=now.getMonth()+off, m0=totalM%12, yr=now.getFullYear()+Math.floor(totalM/12);
    const exp=ngfExpiry(yr,m0), expDay=new Date(exp.getFullYear(), exp.getMonth(), exp.getDate());
    if (expDay >= today) { const obj=ngfContractObj(m0,yr); obj.isFront=true; return obj; }
  }
  return null;
}

export function ngfNext(cur) {
  const m0=(cur.m0+1)%12, yr=cur.yr+(cur.m0===11?1:0);
  return ngfContractObj(m0, yr);
}

export function ngfLogContracts() {
  const now=new Date(), today=new Date(now.getFullYear(), now.getMonth(), now.getDate());
  for (let off=0; off<4; off++) {
    const totalM=now.getMonth()+off, m0=totalM%12, yr=now.getFullYear()+Math.floor(totalM/12);
    const exp=ngfExpiry(yr,m0), expDay=new Date(exp.getFullYear(), exp.getMonth(), exp.getDate());
    dbLog('Contract '+MONTHS[m0]+' '+yr+' ['+NGF_CODES[m0]+'] exp='+exp.toDateString()+(expDay>=today?' FRONT':''), expDay>=today?'ok':'info');
  }
}

// ── Lightweight live quote (for periodic refresh — minimal data transfer) ──────
// Fetches only today's 1-minute bars to get the latest close.
// Much smaller payload than the full year history used by ngfFetchTwoDays.

export async function ngfFetchQuote(ticker, isFront) {
  const symbols = isFront ? ['NG=F', ticker] : [ticker];
  const now = Math.floor(Date.now() / 1000);
  const p1  = now - 7 * 86400;
  const params = 'period1=' + p1 + '&period2=' + now + '&interval=1d&events=history';
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

const CORS_PROXIES = [
  u => 'https://corsproxy.io/?url=' + encodeURIComponent(u),
  u => 'https://proxy.cors.sh/' + u,
  u => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u),
  u => 'https://thingproxy.freeboard.io/fetch/' + u,
];

export async function yahooFetch(symbol, queryParams) {
  let lastErr = null;
  for (const base of YAHOO_BASES) {
    const baseUrl = base + encodeURIComponent(symbol) + '?' + queryParams + '&lang=en-US&region=US';
    for (const proxy of CORS_PROXIES) {
      try {
        const res = await fetch(proxy(baseUrl), { signal: AbortSignal.timeout(8000), cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        let text = await res.text(), data;
        try { data = JSON.parse(text); if (data.contents) data = JSON.parse(data.contents); }
        catch(pe) { throw new Error('JSON parse error'); }
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
      } catch(e) { lastErr = e; /* try next proxy silently */ }
    }
  }
  throw new Error('All proxies failed: ' + (lastErr?.message || '?'));
}

export async function ngfFetchTwoDays(ticker, isFrontMonth) {
  const p1t = Math.floor(new Date(new Date().getFullYear()-1, 0, 1).getTime()/1000);
  const p2t = Math.floor(Date.now()/1000);
  const symbols = isFrontMonth ? ['NG=F', ticker] : [ticker];
  let lastErr = null;
  for (const sym of symbols) {
    try {
      const rows = await yahooFetch(sym, 'period1='+p1t+'&period2='+p2t+'&interval=1d&events=history');
      if (!rows?.length) continue;
      const closes = rows.map(r => r.close);
      return {last:closes[closes.length-1], prev:closes.length>=2?closes[closes.length-2]:null};
    } catch(e) { lastErr=e; dbLog('Price '+sym+' fail: '+e.message, 'warn'); }
  }
  throw lastErr || new Error('all symbols failed for '+ticker);
}

// ── Futures contract list builder ─────────────────────────────────────────────

export function fcBuildContractList(count) {
  const cur = ngfCurrent(); if (!cur) return [];
  const list = [cur]; let prev = cur;
  for (let i=1; i<count; i++) { prev=ngfNext(prev); list.push(prev); }
  return list;
}
