// js/snapshot.js
// Builds a serializable snapshot of the dashboard's RAW data (not the Market
// Overview verdicts). Harvested hourly by scripts/snapshot.mjs (headless
// Chromium) and fed to Claude, which forms its own independent assessment and
// writes data/claude-overview.json.
//
// Everything is read from data the app already computed/loaded (window.state +
// rendered KPI cells), and TA indicators are computed with the app's own
// exported functions — no duplicated logic.

import { state } from './state.js';
import { taEMA, taBB, taRSI, taMACD } from './technical.js';

function txt(id) {
  const el = document.getElementById(id);
  if (!el) return null;
  const t = el.textContent.trim();
  return t && t !== '—' && t !== '' ? t : null;
}

function num(s) {
  if (s == null) return null;
  const v = parseFloat(String(s).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(v) ? v : null;
}

function rnd(v, d = 3) {
  return v == null || !Number.isFinite(v) ? null : +v.toFixed(d);
}

function lastClose(arr) {
  if (!Array.isArray(arr) || !arr.length) return null;
  const r = arr[arr.length - 1];
  if (r == null) return null;
  const v = r.close ?? r.value ?? r.c ?? null;
  return Number.isFinite(v) ? v : null;
}

const lastOf = (arr) => (Array.isArray(arr) && arr.length ? arr[arr.length - 1] : null);

// ── Weather demand over a forecast horizon (mirrors widgets.js demHorizonFull) ─
function demHorizon(from, to) {
  const wx = state.wxS;
  if (!wx || !wx.demAll || !wx.dem5avg || !wx.dem5min || !wx.dem5max || wx.todayIdx == null) return null;
  const { demAll, dem5avg, dem5min, dem5max, todayIdx } = wx;
  let demSum = 0, avgSum = 0, minSum = 0, maxSum = 0, n = 0;
  const start = todayIdx + from, end = Math.min(todayIdx + to, demAll.length);
  for (let i = start; i < end; i++) {
    if (demAll[i] != null && dem5avg[i] != null && dem5min[i] != null && dem5max[i] != null) {
      demSum += demAll[i]; avgSum += dem5avg[i]; minSum += dem5min[i]; maxSum += dem5max[i]; n++;
    }
  }
  if (!n || avgSum === 0) return null;
  const rangeSize = maxSum - minSum;
  return {
    pctVs5y: rnd((demSum - avgSum) / avgSum * 100, 1),
    rangePos: rnd(rangeSize > 0 ? (demSum - minSum) / rangeSize : 0.5, 2),
    aboveMax: demSum > maxSum,
    belowMin: demSum < minSum,
  };
}

// ── Technical-analysis summary for one timeframe (uses the app's TA helpers) ──
function taSummary(candles) {
  if (!Array.isArray(candles) || candles.length < 30) return null;
  const closes = candles.map((c) => c.close).filter((v) => v != null);
  if (closes.length < 30) return null;
  const last = closes[closes.length - 1];
  const ema50 = lastOf(taEMA(closes, 50));
  const ema200 = lastOf(taEMA(closes, 200));
  const bb = taBB(closes, 20, 2);
  const bbu = lastOf(bb.upper), bbl = lastOf(bb.lower);
  const rsi = lastOf(taRSI(closes, 14));
  const macd = taMACD(closes, 12, 26, 9);
  const hist = lastOf(macd.hist);
  let trend = 'neutral';
  if (ema50 != null && ema200 != null) {
    if (last > ema50 && ema50 > ema200) trend = 'bullish';
    else if (last < ema50 && ema50 < ema200) trend = 'bearish';
  }
  let bb_pos = 'inside band';
  if (bbu != null && last > bbu) bb_pos = 'above upper';
  else if (bbl != null && last < bbl) bb_pos = 'below lower';
  return {
    close: rnd(last),
    trend,
    rsi14: rnd(rsi, 1),
    macdHist: hist == null ? null : hist > 0 ? 'positive' : 'negative',
    emaCross: ema50 != null && ema200 != null ? (ema50 > ema200 ? '50>200' : '50<200') : null,
    bollinger: bb_pos,
  };
}

// ── COT (managed money) from raw state.cotData + a 5y percentile of MM net ───
function cotBlock() {
  const arr = state.cotData || [];
  if (!arr.length) return null;
  const lat = arr[arr.length - 1];
  const win = arr.slice(-260); // ~5 years of weekly reports
  const nets = win.map((r) => r.mmNet).filter((v) => v != null);
  let pct = null;
  if (nets.length > 5) pct = Math.round((nets.filter((v) => v < lat.mmNet).length / nets.length) * 100);
  return {
    date: lat.date,
    mmNet: lat.mmNet,
    mmLong: lat.mmLong,
    mmShort: lat.mmShort,
    mmRatio: rnd(lat.mmRatio, 2),
    producerNet: lat.prodNet,
    swapNet: lat.swapNet,
    mmNetPercentile5y: pct,
  };
}

function fairHorizon(prefix) {
  return {
    fair: txt(prefix),
    band: txt(prefix + '-range'),
    front: { spread: txt(prefix + '-vs-front'), status: txt(prefix + '-front-status') },
    next: { spread: txt(prefix + '-vs-next'), status: txt(prefix + '-next-status') },
  };
}

export function buildSnapshot() {
  const front =
    state.frontLivePrice ?? lastClose(state.stNgfData) ?? num(txt('fpv-banner-front'));
  const next =
    state.nextContractPrice ?? lastClose(state.dailyHistory?.next) ?? num(txt('fpv-banner-next'));

  const curve = (state.fcContractsData || [])
    .filter((c) => c && c.price != null)
    .map((c) => ({ label: c.label, price: rnd(c.price), spreadVsFront: rnd(c.spread), isFront: !!c.isFront, isNext: !!c.isNext }));

  const tfs = ['5m', '15m', '1h', '4h', '1d', '1w'];
  const technicals = {};
  for (const tf of tfs) {
    const s = taSummary(state.taData?.[tf]);
    if (s) technicals[tf] = s;
  }

  return {
    generatedAt: new Date().toISOString(),

    price: {
      front,
      next,
      frontPrevClose: lastClose(state.dailyHistory?.front) ?? lastClose(state.stNgfData),
      nextPrevClose: lastClose(state.dailyHistory?.next),
      frontIsLive: state.frontLivePrice != null,
    },

    // ── PRIORITY 1: seasonality (incl. price vs median) ──
    seasonality: {
      season: txt('season-cur-name'),
      vsMedian: txt('sstat-pos-val'),
      vsMedianDetail: txt('sstat-pos-sub'),
      probHigher_1_2_3_4w: txt('sstat-prob-val'),
      probHigherDetail: txt('sstat-prob-sub'),
      typicalMove4w: txt('sstat-fwd-val'),
      strongestWeakestMonth: txt('sstat-month-val'),
      strongestWeakestDetail: txt('sstat-month-sub'),
      reliability: txt('sstat-rel-val'),
      reliabilityDetail: txt('sstat-rel-sub'),
    },

    // ── PRIORITY 2: weather + weather trend ──
    weather: {
      demand_1_7D: demHorizon(0, 7),
      demand_8_16D: demHorizon(7, 16),
      trend: {
        nowDemand: txt('ft-stat-now'),
        change24h: txt('ft-stat-chg'),
        range7d: txt('ft-stat-range'),
        vs5yNormal: txt('ft-stat-vs5y'),
      },
    },

    // ── PRIORITY 3: price vs fair value with min/max band, per horizon ──
    fairValue: {
      frontPrice: txt('fpv-banner-front'),
      nextPrice: txt('fpv-banner-next'),
      now: fairHorizon('b-fp0'),
      plus7D: fairHorizon('b-fp7'),
      plus14D: fairHorizon('b-fp14'),
      plus21D: fairHorizon('b-fp21'),
    },

    // ── Secondary but important ──
    cot: cotBlock(),

    storage: {
      value: txt('b-stor-val'),
      weekChange: txt('b-stor-wkchg'),
      deviationVs5y: txt('b-stor-dev'),
      date: txt('b-stor-date'),
      forecast: txt('b-stor-fcst'),
      surprise: txt('b-stor-surprise'),
    },

    technicals,

    futuresCurve: curve.length ? curve : null,

    dataCounts: {
      ngf: (state.stNgfData || []).length,
      storage: (state.stStorageData || []).length,
      cot: (state.cotData || []).length,
      taTimeframes: Object.keys(technicals).length,
    },
  };
}

if (typeof window !== 'undefined') {
  window.__SNAPSHOT__ = buildSnapshot;
}
