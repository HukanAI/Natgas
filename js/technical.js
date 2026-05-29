// js/technical.js
import { TA_TFS, MONTHS } from './constants.js';
import { state } from './state.js';
import { dbLog } from './debug.js';
import { esc } from './utils.js';
import { killChart, baseTT, zoomOpts } from './charts.js';
import { buildSMCOverlays, smcLabelPlugin } from './smc.js';
import { buildSessionMarkers, sessionMarkerPlugin } from './sessions.js';
import { yahooFetch, ngfCurrent, ngfNext } from './contracts.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtCET(ts, tf) {
  const d = new Date(ts);
  if (tf === '1w' || tf === '1d') {
    return d.toLocaleDateString('en-GB', { timeZone: 'Europe/Prague', day: '2-digit', month: 'short', year: '2-digit' });
  }
  const s = d.toLocaleString('en-GB', {
    timeZone: 'Europe/Prague',
    day: '2-digit', month: '2-digit',
    hour: '2-digit', minute: '2-digit',
    hour12: false
  });
  return s + ' CET';
}

function spinShow(tf) {
  const spin = document.getElementById('ta-spin-' + tf);
  const wrap = document.getElementById('ta-wrap-' + tf);
  if (wrap) wrap.style.display = 'none';
  if (spin) { spin.style.display = 'block'; spin.innerHTML = '<span class="sp"></span>Fetching...'; }
}

function spinError(tf, msg) {
  const spin = document.getElementById('ta-spin-' + tf);
  if (spin) { spin.style.display = 'block'; spin.innerHTML = 'Error: ' + esc(msg); }
}

// ── Indicators ────────────────────────────────────────────────────────────────

export function taEMA(data, period) {
  const k = 2 / (period + 1);
  const out = new Array(data.length).fill(null);
  let start = -1;
  for (let i = 0; i < data.length; i++) {
    if (data[i] != null) { start = i; break; }
  }
  if (start < 0 || start + period > data.length) return out;
  let sum = 0;
  for (let j = start; j < start + period; j++) sum += (data[j] || 0);
  out[start + period - 1] = sum / period;
  for (let i = start + period; i < data.length; i++) {
    const v = data[i] != null ? data[i] : out[i - 1];
    out[i] = v * k + out[i - 1] * (1 - k);
  }
  return out;
}

export function taBB(closes, period, mult) {
  period = period || 20;
  mult = mult || 2;
  const mid = new Array(closes.length).fill(null);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    const sl = [];
    for (let j = i - period + 1; j <= i; j++) { if (closes[j] != null) sl.push(closes[j]); }
    if (sl.length < period) continue;
    let avg = 0;
    for (let j = 0; j < sl.length; j++) avg += sl[j];
    avg = avg / sl.length;
    let variance = 0;
    for (let j = 0; j < sl.length; j++) variance += (sl[j] - avg) * (sl[j] - avg);
    const sd = Math.sqrt(variance / sl.length);
    mid[i] = avg;
    upper[i] = avg + mult * sd;
    lower[i] = avg - mult * sd;
  }
  return { mid: mid, upper: upper, lower: lower };
}

export function taRSI(closes, period) {
  period = period || 14;
  const out = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const dd = closes[i] - closes[i - 1];
    if (dd > 0) gains += dd; else losses -= dd;
  }
  let avgG = gains / period;
  let avgL = losses / period;
  out[period] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  for (let i = period + 1; i < closes.length; i++) {
    if (closes[i] == null || closes[i - 1] == null) { out[i] = out[i - 1]; continue; }
    const d2 = closes[i] - closes[i - 1];
    const g = d2 > 0 ? d2 : 0;
    const l = d2 < 0 ? -d2 : 0;
    avgG = (avgG * (period - 1) + g) / period;
    avgL = (avgL * (period - 1) + l) / period;
    out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  }
  return out;
}

export function taMACD(closes, fast, slow, signal) {
  fast = fast || 12; slow = slow || 26; signal = signal || 9;
  const emaF = taEMA(closes, fast);
  const emaS = taEMA(closes, slow);
  const macdLine = [];
  for (let i = 0; i < closes.length; i++) {
    macdLine.push((emaF[i] != null && emaS[i] != null) ? emaF[i] - emaS[i] : null);
  }
  const sigLine = taEMA(macdLine, signal);
  const hist = [];
  for (let i = 0; i < macdLine.length; i++) {
    hist.push((macdLine[i] != null && sigLine[i] != null) ? macdLine[i] - sigLine[i] : null);
  }
  return { macd: macdLine, signal: sigLine, hist: hist };
}

function fibDailyLevels(dailyCandles, length = 200) {
  if (!dailyCandles || dailyCandles.length < length) return null;
  const slice = dailyCandles.slice(-length);
  let low = Infinity;
  let high = -Infinity;
  for (let i = 0; i < slice.length; i++) {
    const c = slice[i];
    if (c && c.low != null && c.low < low) low = c.low;
    if (c && c.high != null && c.high > high) high = c.high;
  }
  if (low === Infinity || high === -Infinity) return null;
  const range = high - low;
  return {
    lowest: low,
    highest: high,
    lvl1: high - 0.236 * range,
    lvl2: high - 0.382 * range,
    lvl3: high - 0.5   * range,
    lvl4: high - 0.618 * range,
    lvl5: high - 0.786 * range,
  };
}



export function taPatterns(candles) {
  const found = [];
  const n = candles.length;
  if (n < 3) return found;
  const i = n - 1;
  const c = candles[i];
  const p = candles[i - 1];
  const cBody = Math.abs(c.close - c.open);
  const cRange = c.high - c.low;
  if (cRange > 0 && cBody < cRange * 0.1) found.push({ name: 'Doji', bull: null, idx: i });
  if (c.close > c.open && cRange > 0 && (c.open - c.low) > cRange * 0.5 && cBody < cRange * 0.4) found.push({ name: 'Hammer', bull: true, idx: i });
  if (c.close < c.open && cRange > 0 && (c.high - c.open) > cRange * 0.5 && cBody < cRange * 0.4) found.push({ name: 'ShootingStar', bull: false, idx: i });
  if (p.close < p.open && c.close > c.open && c.open <= p.close && c.close >= p.open) found.push({ name: 'BullEngulf', bull: true, idx: i });
  if (p.close > p.open && c.close < c.open && c.open >= p.close && c.close <= p.open) found.push({ name: 'BearEngulf', bull: false, idx: i });
  return found;
}

// ── Aggregation ───────────────────────────────────────────────────────────────

function aggregateBySlot(bars, getKey) {
  const buckets = {};
  for (let i = 0; i < bars.length; i++) {
    const c = bars[i];
    const key = getKey(c);
    if (!buckets[key]) {
      buckets[key] = { ts: key, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 };
    } else {
      if (c.high > buckets[key].high) buckets[key].high = c.high;
      if (c.low < buckets[key].low) buckets[key].low = c.low;
      buckets[key].close = c.close;
      buckets[key].volume += (c.volume || 0);
    }
  }
  const keys = Object.keys(buckets);
  keys.sort(function(a, b) { return Number(a) - Number(b); });
  const result = [];
  for (let i = 0; i < keys.length; i++) result.push(buckets[keys[i]]);
  return result;
}

function aggregate15m(bars) {
  return aggregateBySlot(bars, function(c) {
    const d = new Date(c.ts);
    const slot = Math.floor(d.getUTCMinutes() / 15) * 15;
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), slot);
  });
}

function aggregate4h(bars) {
  return aggregateBySlot(bars, function(c) {
    const d = new Date(c.ts);
    const slot = Math.floor(d.getUTCHours() / 4) * 4;
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), slot);
  });
}

// ── Fetch ─────────────────────────────────────────────────────────────────────

async function fetchRaw(interval, rangeStr) {
  state.taApiCount++;
  document.getElementById('ta-api-count').textContent = state.taApiCount;
  const bust = '&_t=' + Date.now();
  // Resolve ticker: use direct contract ticker (NGM26.NYM etc.), not NG=F continuous
  // Exception: 1w uses NG=F via stNgfData fallback in taLoadAll
  let ticker;
  if (state.taTicker === 'next') {
    const cur = ngfCurrent();
    const nxt = cur ? ngfNext(cur) : null;
    ticker = (nxt && nxt.ticker) ? nxt.ticker : 'NG=F';
  } else {
    // Front: use direct contract ticker
    const cur = ngfCurrent();
    ticker = (cur && cur.ticker) ? cur.ticker : 'NG=F';
  }
  return await yahooFetch(ticker, 'interval=' + interval + '&range=' + rangeStr + bust);
}

// ── Load all ──────────────────────────────────────────────────────────────────

export async function taLoadAll() {
  document.getElementById('ta-badge').textContent = 'Loading...';
  document.getElementById('ta-badge').className = 'cbadge loading';
  document.getElementById('ta-dot').className = 'sdot loading';

  TA_TFS.forEach(function(tf) { spinShow(tf); });

  let errs = 0;

  async function loadTF(tf, fn) {
    try {
      const c = await fn();
      state.taData[tf] = c;
      taRenderTF(tf, c);
      dbLog('TA ' + tf + ': OK (' + c.length + ' bars)', 'ok');
    } catch(e) {
      errs++;
      spinError(tf, e.message);
      dbLog('TA ' + tf + ': ' + e.message, 'error');
    }
  }

  // Parallel fetch wave 1: 5m + 1d
  // Note: CORS proxies have ~1-2MB payload limits, so we keep ranges modest
  const [raw5m, raw1d] = await Promise.all([
    fetchRaw('5m', '15d').catch(function(e) { dbLog('TA 5m fetch fail: ' + e.message, 'warn'); return null; }),
    fetchRaw('1d', '5y').catch(function(e) { dbLog('TA 1d fetch fail: ' + e.message, 'warn'); return null; })
  ]);

  // Parallel fetch wave 2: 15m + 1h
  const [raw15m, raw1h] = await Promise.all([
    fetchRaw('15m', '30d').catch(function(e) { dbLog('TA 15m fetch fail: ' + e.message, 'warn'); return null; }),
    fetchRaw('1h', '180d').catch(function(e) { dbLog('TA 1h fetch fail: ' + e.message, 'warn'); return null; })
  ]);

  // Parallel fetch wave 3: 1wk
  const raw1wk = await fetchRaw('1wk', '10y').catch(function(e) { dbLog('TA 1wk fetch fail: ' + e.message, 'warn'); return null; });

  // 5m
  await loadTF('5m', async function() {
    if (!raw5m || !raw5m.length) throw new Error('5m data unavailable');
    return raw5m;
  });

  // 15m — direct fetch (much more bars than aggregating from 5m)
  await loadTF('15m', async function() {
    if (raw15m && raw15m.length) return raw15m;
    if (raw5m && raw5m.length) return aggregate15m(raw5m);
    throw new Error('15m data unavailable');
  });

  // 1h
  await loadTF('1h', async function() {
    if (!raw1h || !raw1h.length) throw new Error('1h data unavailable');
    return raw1h;
  });

  // 4h — aggregate from 1h
  await loadTF('4h', async function() {
    if (!raw1h || !raw1h.length) throw new Error('1h data unavailable for 4h');
    return aggregate4h(raw1h);
  });

  // 1d
  await loadTF('1d', async function() {
    if (!raw1d || !raw1d.length) throw new Error('1d data unavailable');
    return raw1d;
  });

  // Re-render other timeframe charts once daily data is available, so Fib overlay appears on all TA charts.
  if (state.taData['1d']) {
    TA_TFS.forEach(function(tf) {
      if (tf !== '1d' && state.taData[tf] && state.taCharts[tf]) {
        taRenderTF(tf, state.taData[tf]);
      }
    });
  }

  // 1w
  await loadTF('1w', async function() {
    // Prefer the direct front-month weekly contract if available.
    if (raw1wk && raw1wk.length) return raw1wk;
    // Fallback to NG=F weekly history only when the direct contract is not available.
    if (state.taTicker !== 'next' && state.stNgfData.length >= 200) {
      return state.stNgfData.map(function(d) {
        return { ts: d.ts, open: d.open, high: d.high, low: d.low, close: d.close };
      });
    }
    throw new Error('1w data unavailable');
  });

  if (errs === 0) {
    document.getElementById('ta-badge').textContent = 'Live data';
    document.getElementById('ta-badge').className = 'cbadge live';
    document.getElementById('ta-dot').className = 'sdot ok';
  } else {
    document.getElementById('ta-badge').textContent = errs + ' error(s)';
    document.getElementById('ta-badge').className = 'cbadge err';
    document.getElementById('ta-dot').className = 'sdot err';
  }
}

export function taRefresh() {
  TA_TFS.forEach(function(tf) {
    if (state.taCharts[tf]) {
      ['price', 'rsi', 'macd', 'vol'].forEach(function(k) { killChart(state.taCharts[tf][k]); });
    }
    state.taData[tf] = null;
    state.taCharts[tf] = null;
    spinShow(tf);
  });
  taLoadAll();
}

// Silent background refresh — re-fetches and re-renders without showing spinners
// or destroying existing charts. Used for periodic auto-refresh.
export async function taSilentRefresh() {
  try {
    const bust = '&_=' + Date.now();
    const [raw5m, raw1d] = await Promise.all([
      fetchRaw('5m',  '5d').catch(function(e)  { dbLog('TA silent 5m: '  + e.message, 'warn'); return null; }),
      fetchRaw('1d',  '500d').catch(function(e) { dbLog('TA silent 1d: '  + e.message, 'warn'); return null; })
    ]);
    const [raw1h, raw1wk] = await Promise.all([
      fetchRaw('1h',  '60d').catch(function(e)  { dbLog('TA silent 1h: '  + e.message, 'warn'); return null; }),
      fetchRaw('1wk', '10y').catch(function(e)  { dbLog('TA silent 1w: '  + e.message, 'warn'); return null; })
    ]);

    // Update each TF's data and re-render chart in-place (no spinner, no destroy)
    const updates = [
      { tf: '5m',  raw: raw5m },
      { tf: '15m', raw: raw5m },   // aggregated from 5m
      { tf: '1h',  raw: raw1h },
      { tf: '4h',  raw: raw1h },   // aggregated from 1h
      { tf: '1d',  raw: raw1d },
      { tf: '1w',  raw: raw1wk },
    ];

    updates.forEach(function(u) {
      if (!u.raw || !u.raw.length) return;
      let candles = u.raw;
      if (u.tf === '15m') candles = aggregate15m(u.raw);
      if (u.tf === '4h')  candles = aggregate4h(u.raw);
      if (!candles || !candles.length) return;
      state.taData[u.tf] = candles;
      // Re-render only if chart exists (don't create from scratch)
      if (state.taData[u.tf]) taRenderTF(u.tf, candles);
    });

    dbLog('TA silent refresh done', 'ok');
  } catch(e) {
    dbLog('TA silent refresh error: ' + e.message, 'warn');
  }
}

export function taSetType(type) {
  state.taType = type;
  document.getElementById('ta-btn-candle').className = 'tw-btn' + (type === 'candle' ? ' on' : '');
  document.getElementById('ta-btn-line').className = 'tw-btn' + (type === 'line' ? ' on' : '');
  TA_TFS.forEach(function(tf) {
    if (state.taData[tf] && state.taData[tf].length) taRenderTF(tf, state.taData[tf]);
  });
}

export async function taSetTicker(ticker) {
  if (state.taTicker === ticker) return;
  state.taTicker = ticker;
  document.getElementById('ta-btn-front').className = 'tw-btn' + (ticker === 'front' ? ' on' : '');
  document.getElementById('ta-btn-next').className  = 'tw-btn' + (ticker === 'next'  ? ' on' : '');
  // Clear data and re-fetch all
  state.taData = {};
  TA_TFS.forEach(function(tf) {
    ['price', 'rsi', 'macd', 'vol'].forEach(function(k) { killChart(state.taCharts[tf] && state.taCharts[tf][k]); });
  });
  await taLoadAll();
}

// ── Render one timeframe ──────────────────────────────────────────────────────

export function taRenderTF(tf, candles) {
  const n = candles.length;
  const closes = [];
  for (let i = 0; i < candles.length; i++) closes.push(candles[i].close);

  const PADDING = 30; // empty bars to the right — allows panning past last candle
  const labels = [];
  for (let i = 0; i < candles.length; i++) labels.push(fmtCET(candles[i].ts, tf));
  for (let i = 0; i < PADDING; i++) labels.push('');

  const ema50 = taEMA(closes, 50);
  const ema200 = taEMA(closes, 200);
  const bb = taBB(closes, 20, 2);
  const rsi = taRSI(closes, 14);
  const macdObj = taMACD(closes, 12, 26, 9);
  const patterns = taPatterns(candles);
  const fibDaily = fibDailyLevels(state.taData['1d'], 200);
  const fibLevels = fibDaily ? [
    { value: fibDaily.highest, label: 'Fib high', color: 'gray' },
    { value: fibDaily.lvl1,   label: 'Fib 23.6%', color: 'red' },
    { value: fibDaily.lvl2,   label: 'Fib 38.2%', color: 'orange' },
    { value: fibDaily.lvl3,   label: 'Fib 50%',   color: 'green' },
    { value: fibDaily.lvl4,   label: 'Fib 61.8%', color: 'teal' },
    { value: fibDaily.lvl5,   label: 'Fib 78.6%', color: 'aqua' },
    { value: fibDaily.lowest, label: 'Fib low',  color: 'gray' }
  ] : [];
  const fibDatasets = [];
  if (fibLevels.length) {
    fibDatasets.push({ _k: 'fib_high', label: 'Fib high', data: labels.map((_, idx) => (idx < closes.length ? fibDaily.highest : null)), borderColor: 'gray',  borderWidth: 1, pointRadius: 0, fill: false, tension: 0 });
    fibDatasets.push({ _k: 'fib_23',  label: 'Fib 23.6%', data: labels.map((_, idx) => (idx < closes.length ? fibDaily.lvl1    : null)), borderColor: 'red',   borderWidth: 1, pointRadius: 0, fill: false, tension: 0 });
    fibDatasets.push({ _k: 'fib_38',  label: 'Fib 38.2%', data: labels.map((_, idx) => (idx < closes.length ? fibDaily.lvl2    : null)), borderColor: 'orange', borderWidth: 1, pointRadius: 0, fill: false, tension: 0 });
    fibDatasets.push({ _k: 'fib_50',  label: 'Fib 50%',   data: labels.map((_, idx) => (idx < closes.length ? fibDaily.lvl3    : null)), borderColor: 'green',  borderWidth: 1, pointRadius: 0, fill: false, tension: 0 });
    fibDatasets.push({ _k: 'fib_61',  label: 'Fib 61.8%', data: labels.map((_, idx) => (idx < closes.length ? fibDaily.lvl4    : null)), borderColor: 'teal',   borderWidth: 1, pointRadius: 0, fill: false, tension: 0 });
    fibDatasets.push({ _k: 'fib_78',  label: 'Fib 78.6%', data: labels.map((_, idx) => (idx < closes.length ? fibDaily.lvl5    : null)), borderColor: 'aqua',   borderWidth: 1, pointRadius: 0, fill: false, tension: 0 });
    fibDatasets.push({ _k: 'fib_low',  label: 'Fib low',  data: labels.map((_, idx) => (idx < closes.length ? fibDaily.lowest : null)), borderColor: 'gray',  borderWidth: 1, pointRadius: 0, fill: false, tension: 0 });
  }
  

  // ── Fair price overlay removed (now lives in the overview seasonality card) ──



  if (state.taCharts[tf]) {
    ['price', 'rsi', 'macd', 'vol'].forEach(function(k) { killChart(state.taCharts[tf][k]); });
  }
  state.taCharts[tf] = { price: null, rsi: null, macd: null, vol: null };

  // Pattern labels
  const patEl = document.getElementById('ta-pat-' + tf);
  if (patEl) {
    if (patterns.length) {
      let html = '';
      for (let i = 0; i < patterns.length; i++) {
        const pat = patterns[i];
        const col = pat.bull === null ? '#e3b341' : pat.bull ? '#3fb950' : '#ff7b72';
        const sym = pat.bull === null ? '◆' : pat.bull ? '▲' : '▼';
        html += '<span style="color:' + col + ';margin-right:6px">' + sym + ' ' + esc(pat.name) + '</span>';
      }
      patEl.innerHTML = html;
    } else {
      patEl.innerHTML = '<span style="color:var(--text3)">No pattern</span>';
    }
  }

  // Subtitle
  const fd = new Date(candles[0].ts);
  const ld = new Date(candles[n - 1].ts);
  function fD(dd) {
    return dd.getUTCDate() + ' ' + MONTHS[dd.getUTCMonth()] + ' ' + dd.getUTCFullYear();
  }
  const delayNote = (tf === '5m' || tf === '15m') ? ' · 15min delay' : '';
  const subEl = document.getElementById('ta-sub-' + tf);
  if (subEl) subEl.textContent = fD(fd) + ' – ' + fD(ld);

  // Show chart
  const spinEl = document.getElementById('ta-spin-' + tf);
  const wrapEl = document.getElementById('ta-wrap-' + tf);
  if (spinEl) spinEl.style.display = 'none';
  if (wrapEl) wrapEl.style.display = 'block';

  // Y range
  let hi = -Infinity, lo = Infinity;
  for (let i = 0; i < candles.length; i++) {
    if (candles[i].high > hi) hi = candles[i].high;
    if (candles[i].low < lo) lo = candles[i].low;
  }
  const yPad = (hi - lo) * 0.05 || 0.1;

  const axisY = {
    position: 'right',
    grid: { color: 'rgba(255,255,255,0.04)' },
    ticks: { color: '#6e7681', font: { family: 'JetBrains Mono', size: 8 }, maxTicksLimit: 6 },
    afterFit: function(scale) { scale.width = 38; }
  };

  function syncLinked(chart) {
    const xSc = chart.scales && chart.scales.x;
    if (!xSc) return;
    const mn = xSc.min, mxv = xSc.max;
    let vLo = Infinity, vHi = -Infinity;
    const iMin = Math.max(0, Math.floor(mn));
    const iMax = Math.min(n - 1, Math.ceil(mxv));
    for (let ci = iMin; ci <= iMax; ci++) {
      const cc = candles[ci];
      if (cc) {
        if (cc.low < vLo) vLo = cc.low;
        if (cc.high > vHi) vHi = cc.high;
      }
    }
    if (vLo < Infinity) {
      const vp = (vHi - vLo) * 0.08 || 0.1;
      chart.options.scales.y.min = vLo - vp;
      chart.options.scales.y.max = vHi + vp;
      chart.update('none');
    }
    ['rsi', 'macd', 'vol'].forEach(function(k) {
      const ch2 = state.taCharts[tf] && state.taCharts[tf][k];
      if (!ch2) return;
      ch2.scales.x.options.min = mn;
      ch2.scales.x.options.max = mxv;
      ch2.update('none');
    });
  }

  // Candle plugin
  const candlePlugin = {
    id: 'cp_' + tf,
    afterDatasetsDraw: function(chart) {
      if (state.taType !== 'candle') return;
      const cx = chart.ctx;
      const ca = chart.chartArea;
      const xSc = chart.scales.x;
      const ySc = chart.scales.y;
      const rawW = n > 1 ? Math.abs(xSc.getPixelForValue(1) - xSc.getPixelForValue(0)) : 6;
      const barW = Math.max(1, Math.min(rawW * 0.7, 12));
      const half = barW / 2;
      cx.save();
      cx.beginPath();
      cx.rect(ca.left, ca.top, ca.right - ca.left, ca.bottom - ca.top);
      cx.clip();
      for (let idx = 0; idx < candles.length; idx++) {
        const c = candles[idx];
        const xc = xSc.getPixelForValue(idx);
        const yO = ySc.getPixelForValue(c.open);
        const yC = ySc.getPixelForValue(c.close);
        const yH = ySc.getPixelForValue(c.high);
        const yL = ySc.getPixelForValue(c.low);
        const col = c.close >= c.open ? '#3fb950' : '#ff7b72';
        cx.strokeStyle = col;
        cx.lineWidth = 1;
        cx.beginPath();
        cx.moveTo(xc, yH);
        cx.lineTo(xc, yL);
        cx.stroke();
        cx.fillStyle = col;
        cx.fillRect(xc - half, Math.min(yO, yC), barW, Math.max(1, Math.abs(yO - yC)));
      }
      cx.restore();
    }
  };

  // Pattern plugin
  const patPlugin = {
    id: 'pat_' + tf,
    afterDraw: function(chart) {
      if (!patterns.length) return;
      const cx = chart.ctx;
      const ca = chart.chartArea;
      const xSc = chart.scales.x;
      const ySc = chart.scales.y;
      cx.save();
      cx.beginPath();
      cx.rect(ca.left, ca.top, ca.right - ca.left, ca.bottom - ca.top);
      cx.clip();
      for (let pi = 0; pi < patterns.length; pi++) {
        const pat = patterns[pi];
        if (pat.idx < 0 || pat.idx >= n) continue;
        const px = xSc.getPixelForValue(pat.idx);
        const col = pat.bull === null ? '#e3b341' : pat.bull ? '#3fb950' : '#ff7b72';
        const sym = pat.bull === null ? '◆' : pat.bull ? '▲' : '▼';
        let yPos = pat.bull === false
          ? ySc.getPixelForValue(candles[pat.idx].high) - 10
          : ySc.getPixelForValue(candles[pat.idx].low) + 12;
        yPos = Math.max(ca.top + 10, Math.min(ca.bottom - 4, yPos));
        cx.fillStyle = col;
        cx.font = 'bold 10px Arial';
        cx.textAlign = 'center';
        cx.fillText(sym, px, yPos);
      }
      cx.restore();
    }
  };

  

  const bbDs = [
    { _k: 'bbu', label: 'BB Upper', data: bb.upper, borderColor: 'rgba(68,147,248,0.45)', borderWidth: 1, pointRadius: 0, fill: '+1', backgroundColor: 'rgba(68,147,248,0.07)', tension: 0 },
    { _k: 'bbl', label: 'BB Lower', data: bb.lower, borderColor: 'rgba(68,147,248,0.45)', borderWidth: 1, pointRadius: 0, fill: false, tension: 0 },
    { _k: 'bbm', label: 'BB Mid',   data: bb.mid,   borderColor: 'rgba(68,147,248,0.25)', borderWidth: 1, borderDash: [3, 3], pointRadius: 0, fill: false, tension: 0 }
  ];

  const priceTT = Object.assign({}, baseTT(), {
    callbacks: {
      title: function(items) { return items[0] ? labels[items[0].dataIndex] : ''; },
      label: function(c) {
        const lk = c.dataset._k;
        const v = c.parsed.y;
        if (v == null) return null;
        // Price line (line mode only — in candle mode priceData is null)
        if (lk === 'price') {
          return state.taType === 'line' && v != null ? ' Close: $' + v.toFixed(3) : null;
        }
        // Invisible close dataset — carries the close in candle mode
        if (lk === 'priceClose') {
          return state.taType === 'candle' && v != null ? ' Close: $' + v.toFixed(3) : null;
        }
        // EMAs
        if (lk === 'e50')  return ' EMA50: $' + v.toFixed(3);
        if (lk === 'e200') return ' EMA200: $' + v.toFixed(3);
        // Strong/Weak high/low — only on TFs with SMC enabled
        if (lk === 'smc_top') return ' ' + (c.dataset.label || 'High') + ': $' + v.toFixed(3);
        if (lk === 'smc_bot') return ' ' + (c.dataset.label || 'Low')  + ': $' + v.toFixed(3);
        // Everything else (BB, STS, zones, flips) — hide from tooltip
        return null;
      },
      filter: function(item) { return item.parsed.y != null; }
    }
  });

  // Nearest Fibonacci levels (one above + one below the hovered close).
  // If price is above the highest level, show only that highest; if below the
  // lowest, show only that lowest.
  if (fibLevels.length) {
    priceTT.callbacks.afterBody = function(items) {
      const i = items && items[0] ? items[0].dataIndex : null;
      if (i == null || i < 0 || i >= candles.length) return [];
      const cd = candles[i];
      if (!cd || cd.close == null) return [];
      const px = cd.close;
      let above = null, below = null;
      for (let k = 0; k < fibLevels.length; k++) {
        const lv = fibLevels[k];
        if (lv.value == null) continue;
        if (lv.value > px && (above == null || lv.value < above.value)) above = lv;
        if (lv.value < px && (below == null || lv.value > below.value)) below = lv;
      }
      const out = [];
      if (above) out.push('↑ ' + above.label + ': $' + above.value.toFixed(3));
      if (below) out.push('↓ ' + below.label + ': $' + below.value.toFixed(3));
      return out;
    };
  }

  // Price chart
  const priceData = [];
  for (let i = 0; i < closes.length; i++) {
    priceData.push(state.taType === 'line' ? closes[i] : null);
  }

  // ── Build SMC overlays (Strong/Weak HL) — only for 5m, 15m, 1h ───────────
  const SMC_ALLOWED_TFS = ['5m', '15m', '1h'];
  const smcFlags = state.smcFlags || { highLow: true, zones: false, sts: false };
  const smcEnabled = SMC_ALLOWED_TFS.includes(tf);
  const smc = buildSMCOverlays(candles, labels.length, {
    showHighLow: smcEnabled && smcFlags.highLow,
    showZones:   smcEnabled && smcFlags.zones,
    showSTS:     smcEnabled && smcFlags.sts,
    swingLen:    50,
  });
  // ── Session markers (Asian/European/RTH/Pause) — only for 5m, 15m ─────────
  const SESSION_TFS = ['5m', '15m'];
  if (SESSION_TFS.includes(tf)) {
    state.taCharts[tf]._sessionMarkers = buildSessionMarkers(candles);
  } else {
    state.taCharts[tf]._sessionMarkers = [];
  }

  state.taCharts[tf]._smcLabels = smc.plugins;

  // Closes array (used for tooltip "Price" line in candle mode)
  const closesPadded = [...closes];
  for (let i = closes.length; i < labels.length; i++) closesPadded.push(null);

  state.taCharts[tf].price = new Chart(
    document.getElementById('ta-c-price-' + tf).getContext('2d'),
    {
      type: 'line',
      plugins: [candlePlugin, patPlugin, smcLabelPlugin(() => state.taCharts[tf]._smcLabels || []), sessionMarkerPlugin(() => state.taCharts[tf]._sessionMarkers || [])],
      data: {
        labels: labels,
        datasets: [
          { _k: 'price', label: 'Price', data: priceData, borderColor: '#e3b341', borderWidth: 1.5, pointRadius: 0, tension: 0.2, fill: false },
          // Invisible "close" dataset — only for tooltip in candle mode (since priceData is null then)
          { _k: 'priceClose', label: 'Price', data: closesPadded, borderColor: 'transparent', backgroundColor: 'transparent', borderWidth: 0, pointRadius: 0, fill: false, hidden: false, showLine: false },
          { _k: 'e50',  label: 'EMA50',  data: ema50,  borderColor: '#e3b341', borderWidth: 1.5, pointRadius: 0, tension: 0, fill: false },
          { _k: 'e200', label: 'EMA200', data: ema200, borderColor: '#ff7b72', borderWidth: 1.5, pointRadius: 0, tension: 0, fill: false },
          ...fibDatasets,
          bbDs[0], bbDs[1], bbDs[2],
          ...smc.datasets
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 0 },
        clip: true,
        layout: { padding: { left: 4, right: 4, top: 4, bottom: 0 } },
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: false }, tooltip: priceTT, zoom: zoomOpts(syncLinked) },
        scales: {
          x: { display: false, grid: { display: false } },
          y: {
            position: 'right',
            grid: { color: 'rgba(255,255,255,0.04)' },
            min: lo - yPad,
            max: hi + yPad,
            ticks: { color: '#6e7681', font: { family: 'JetBrains Mono', size: 8 }, maxTicksLimit: 6, callback: function(v) { return '$' + v.toFixed(2); } },
            afterFit: function(scale) { scale.width = 38; }
          }
        }
      }
    }
  );

  // Volume chart
  const volData    = candles.map(c => c.volume != null ? c.volume : 0);
  const volPadded  = [...volData, ...new Array(PADDING).fill(null)];
  const volColors  = candles.map(c => c.close >= c.open ? 'rgba(63,185,80,0.55)' : 'rgba(255,123,114,0.55)');
  const volColorsPadded = [...volColors, ...new Array(PADDING).fill('transparent')];

  const volTT = Object.assign({}, baseTT(), {
    callbacks: {
      title: function(items) { return items[0] ? labels[items[0].dataIndex] : ''; },
      label: function(c) {
        const v = c.parsed.y;
        if (v == null) return null;
        // Human-readable volume formatting
        if (v >= 1e6) return ' Vol: ' + (v / 1e6).toFixed(2) + 'M';
        if (v >= 1e3) return ' Vol: ' + (v / 1e3).toFixed(1) + 'K';
        return ' Vol: ' + v.toFixed(0);
      },
      filter: function(item) { return item.parsed.y != null; }
    }
  });

  const volCanvas = document.getElementById('ta-c-vol-' + tf);
  if (volCanvas) {
    state.taCharts[tf].vol = new Chart(volCanvas.getContext('2d'), {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [{
          _k: 'vol',
          label: 'Volume',
          data: volPadded,
          backgroundColor: volColorsPadded,
          borderWidth: 0,
          barPercentage: 1.0,
          categoryPercentage: 0.9,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 0 },
        clip: true,
        layout: { padding: { left: 4, right: 4, top: 2, bottom: 0 } },
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: false }, tooltip: volTT, zoom: false },
        scales: {
          x: { display: false, grid: { display: false } },
          y: {
            display: true,
            position: 'right',
            grid: { color: 'rgba(255,255,255,0.04)' },
            ticks: {
              color: '#6e7681',
              font: { family: 'JetBrains Mono', size: 8 },
              maxTicksLimit: 3,
              callback: function(v) {
                if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
                if (v >= 1e3) return (v / 1e3).toFixed(0) + 'K';
                return v;
              }
            },
            afterFit: function(scale) { scale.width = 38; }
          }
        }
      }
    });
  }

  // RSI chart
  const rsiZonePlugin = {
    id: 'rsiz_' + tf,
    beforeDatasetsDraw: function(chart) {
      const cx = chart.ctx, ca = chart.chartArea, ySc = chart.scales.y;
      cx.save();
      cx.fillStyle = 'rgba(255,123,114,0.07)';
      cx.fillRect(ca.left, ySc.getPixelForValue(100), ca.right - ca.left, ySc.getPixelForValue(70) - ySc.getPixelForValue(100));
      cx.fillStyle = 'rgba(63,185,80,0.07)';
      cx.fillRect(ca.left, ySc.getPixelForValue(30), ca.right - ca.left, ySc.getPixelForValue(0) - ySc.getPixelForValue(30));
      cx.restore();
    }
  };

  const rsiTT = Object.assign({}, baseTT(), {
    callbacks: {
      title: function(items) { return items[0] ? labels[items[0].dataIndex] : ''; },
      label: function(c) { return c.datasetIndex === 0 && c.parsed.y != null ? ' RSI: ' + c.parsed.y.toFixed(1) : null; },
      filter: function(item) { return item.datasetIndex === 0 && item.parsed.y != null; }
    }
  });

  const refLine70 = [...new Array(n).fill(70), ...new Array(PADDING).fill(null)];
  const refLine30 = [...new Array(n).fill(30), ...new Array(PADDING).fill(null)];
  const refLine50 = [...new Array(n).fill(50), ...new Array(PADDING).fill(null)];

  state.taCharts[tf].rsi = new Chart(
    document.getElementById('ta-c-rsi-' + tf).getContext('2d'),
    {
      type: 'line',
      plugins: [rsiZonePlugin],
      data: {
        labels: labels,
        datasets: [
          { data: rsi, borderColor: '#4493f8', borderWidth: 1.5, pointRadius: 0, tension: 0.3, fill: false },
          { data: refLine70, borderColor: 'rgba(255,123,114,0.4)', borderWidth: 1, borderDash: [3, 3], pointRadius: 0, fill: false },
          { data: refLine30, borderColor: 'rgba(63,185,80,0.4)',   borderWidth: 1, borderDash: [3, 3], pointRadius: 0, fill: false },
          { data: refLine50, borderColor: 'rgba(255,255,255,0.25)', borderWidth: 1, borderDash: [3, 3], pointRadius: 0, fill: false }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 0 },
        clip: true,
        layout: { padding: { left: 4, right: 4, top: 2, bottom: 0 } },
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: false }, tooltip: rsiTT, zoom: false },
        scales: {
          x: { display: false, grid: { display: false } },
          y: {
            position: 'right',
            grid: { color: 'rgba(255,255,255,0.04)' },
            min: 0, max: 100,
            ticks: { color: '#6e7681', font: { family: 'JetBrains Mono', size: 8 }, maxTicksLimit: 6, callback: function(v) { return (v === 0 || v === 50 || v === 100) ? v : ''; } },
            afterFit: function(scale) { scale.width = 38; }
          }
        }
      }
    }
  );

  // MACD chart
  const histColors = [];
  for (let i = 0; i < macdObj.hist.length; i++) {
    const v = macdObj.hist[i];
    histColors.push(v == null ? 'transparent' : v >= 0 ? 'rgba(63,185,80,0.75)' : 'rgba(255,123,114,0.75)');
  }

  const macdTT = Object.assign({}, baseTT(), {
    callbacks: {
      title: function(items) { return items[0] ? labels[items[0].dataIndex] : ''; },
      label: function(c) {
        const v = c.parsed.y;
        if (v == null) return null;
        const names = ['Hist', 'MACD', 'Signal'];
        return ' ' + (names[c.datasetIndex] || '') + ': ' + v.toFixed(4);
      }
    }
  });

  state.taCharts[tf].macd = new Chart(
    document.getElementById('ta-c-macd-' + tf).getContext('2d'),
    {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          { type: 'bar',  data: macdObj.hist,   backgroundColor: histColors, borderWidth: 0, order: 2 },
          { type: 'line', data: macdObj.macd,   borderColor: '#4493f8', borderWidth: 1.5, pointRadius: 0, tension: 0.3, fill: false, order: 1 },
          { type: 'line', data: macdObj.signal, borderColor: '#f0883e', borderWidth: 1.5, pointRadius: 0, tension: 0.3, fill: false, order: 1 }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 0 },
        clip: true,
        layout: { padding: { left: 4, right: 4, top: 2, bottom: 0 } },
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: false }, tooltip: macdTT, zoom: false },
        scales: {
          x: { display: false, grid: { display: false } },
          y: {
            position: 'right',
            grid: { color: 'rgba(255,255,255,0.04)' },
            ticks: { color: '#6e7681', font: { family: 'JetBrains Mono', size: 8 }, maxTicksLimit: 4, callback: function(v) { return v.toFixed(2); } },
            afterFit: function(scale) { scale.width = 38; }
          }
        }
      }
    }
  );

  requestAnimationFrame(function() { taResetZoomTF(tf, candles); });
}

// ── Reset zoom ────────────────────────────────────────────────────────────────

export function taResetZoomTF(tf, candles) {
  candles = candles || state.taData[tf];
  if (!candles || !candles.length) return;
  const n = candles.length;
  const ZOOM = 120;
  const zStart = n > ZOOM ? n - ZOOM : 0;
  const zEnd = n - 1 + 10;
  let vHi = -Infinity, vLo = Infinity;
  for (let i = zStart; i < n; i++) {
    if (candles[i].high > vHi) vHi = candles[i].high;
    if (candles[i].low < vLo) vLo = candles[i].low;
  }
  const vPad = (vHi - vLo) * 0.08 || 0.1;
  const ch = state.taCharts[tf];
  if (!ch) return;
  if (ch.price) {
    ch.price.scales.x.options.min = zStart;
    ch.price.scales.x.options.max = zEnd;
    ch.price.options.scales.y.min = vLo - vPad;
    ch.price.options.scales.y.max = vHi + vPad;
    ch.price.update('none');
  }
  ['rsi', 'macd', 'vol'].forEach(function(k) {
    const c2 = ch[k];
    if (!c2) return;
    c2.scales.x.options.min = zStart;
    c2.scales.x.options.max = zEnd;
    c2.update('none');
  });
}
