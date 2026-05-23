// js/composite.js — Composite Bias scoring engine
// Aggregates 8 market factors into a single bullish/bearish score (-8 to +8).
//
// Inputs (read from state, no fetches):
//   - state.stStorageData  (EIA Lower-48 weekly)
//   - state.wxS            (16-day weather + 5y dem stats)
//   - state.peData.prod    (monthly U.S. dry-gas production)
//   - state.taData['1d']   (NG=F daily candles for EMA / RSI)
//   - state.stLastF7/14/21 (forward storage forecasts from bias.js)
//   - state.stNgfData      (NGF front-month price history)
//   - state.nextContractPrice (next contract last price, set by bias.js)
//   - state.cotData        (CFTC MM Net, weekly)
//   - getSeasonInfo()      (heating / shoulder / cooling)
//
// Output: { total, label, factors: [{ key, label, score, valueText, subText, tone }] }
//
// Scoring convention:
//   +1.0  strongly bullish (higher prices)
//   +0.5  mildly bullish
//    0    neutral / insufficient data
//   -0.5  mildly bearish
//   -1.0  strongly bearish

import { state } from './state.js';
import { st5y } from './storage5y.js';
import { getSeasonInfo } from './season.js';
import { taEMA, taRSI } from './technical.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function emptyFactor(key, label, reason) {
    return { key, label, score: 0, valueText: 'N/A', subText: reason || 'no data', tone: 'neu' };
}

function toneFromScore(s) {
    if (s >= 0.5) return 'bull';
    if (s <= -0.5) return 'bear';
    return 'neu';
}

// ── 1. STORAGE — deviation vs 5y avg ─────────────────────────────────────────
// Surplus (positive dev%) = bearish; deficit = bullish.

function scoreStorage() {
    const sd = state.stStorageData;
    if (!sd || sd.length < 2) return emptyFactor('storage', 'Storage', 'waiting for EIA');
    const lat = sd[sd.length - 1];
    const band = st5y(sd, [lat.date])[0];
    if (!band || band.avg == null || band.avg === 0) return emptyFactor('storage', 'Storage', 'no 5y avg');

    const devBcf = lat.value - band.avg;
    const devPct = devBcf / band.avg * 100;

    let score = 0;
    if (devPct >= 5)        score = -1.0;
    else if (devPct >= 2)   score = -0.5;
    else if (devPct <= -5)  score = +1.0;
    else if (devPct <= -2)  score = +0.5;

    const sign = devPct >= 0 ? '+' : '';
    const valueText = sign + devPct.toFixed(1) + '%';
    const subText = devPct >= 0 ? 'surplus vs 5y avg' : 'deficit vs 5y avg';
    return { key: 'storage', label: 'Storage', score, valueText, subText, tone: toneFromScore(score) };
}

// ── 2. WEATHER / DEMAND — 16D dem vs 5Y avg ──────────────────────────────────

function scoreWeather() {
    if (!state.wxS) return emptyFactor('weather', 'Weather', 'waiting for GFS');
    const { demAll, dem5avg, todayIdx } = state.wxS;
    if (!demAll || demAll.length === 0 || todayIdx == null) return emptyFactor('weather', 'Weather', 'no fcst');

    const horizon = 16;
    const lim = Math.min(todayIdx + horizon, demAll.length);
    let demSum = 0, avgSum = 0, n = 0;
    for (let i = todayIdx; i < lim; i++) {
        if (demAll[i] != null && dem5avg[i] != null) {
            demSum += demAll[i];
            avgSum += dem5avg[i];
            n++;
        }
    }
    if (!n || avgSum === 0) return emptyFactor('weather', 'Weather', 'insufficient data');

    const devPct = (demSum - avgSum) / avgSum * 100;

    let score = 0;
    if (devPct >= 12)       score = +1.0;
    else if (devPct >= 5)   score = +0.5;
    else if (devPct <= -12) score = -1.0;
    else if (devPct <= -5)  score = -0.5;

    const sign = devPct >= 0 ? '+' : '';
    const valueText = sign + devPct.toFixed(1) + '%';
    const subText = '16D demand vs 5y avg';
    return { key: 'weather', label: 'Weather', score, valueText, subText, tone: toneFromScore(score) };
}

// ── 3. PRODUCTION — 3M vs prior-3M trend in U.S. dry-gas production ─────────

function scoreProduction() {
    const prod = state.peData?.prod;
    if (!prod || !Array.isArray(prod) || prod.length < 6) {
        return emptyFactor('production', 'Production', 'waiting for EIA');
    }
    const vals = prod.map(r => r.value).filter(v => v != null && isFinite(v));
    const n = vals.length;
    if (n < 6) return emptyFactor('production', 'Production', 'insufficient bars');
    const recent = (vals[n-1] + vals[n-2] + vals[n-3]) / 3;
    const prior  = (vals[n-4] + vals[n-5] + vals[n-6]) / 3;
    if (!prior) return emptyFactor('production', 'Production', 'invalid');
    const chgPct = (recent - prior) / prior * 100;

    let score = 0;
    if (chgPct >= 2)         score = -1.0;
    else if (chgPct >= 0.5)  score = -0.5;
    else if (chgPct <= -2)   score = +1.0;
    else if (chgPct <= -0.5) score = +0.5;

    const sign = chgPct >= 0 ? '+' : '';
    const valueText = sign + chgPct.toFixed(1) + '%';
    const subText = '3M trend (recent vs prior)';
    return { key: 'production', label: 'Production', score, valueText, subText, tone: toneFromScore(score) };
}

// ── 4. TECHNICALS — NG=F daily price vs EMA50/EMA200 + RSI guardrails ───────

function scoreTechnicals() {
    // Prefer daily TF for trend; fall back to 4h if daily has too few bars.
    let td = state.taData?.['1d'];
    let tfLabel = '1D';
    if (!td || td.length < 200) {
        const alt = state.taData?.['4h'];
        if (alt && alt.length >= 200) { td = alt; tfLabel = '4H'; }
    }
    if (!td || td.length < 50) return emptyFactor('technicals', 'Technicals', 'waiting for NG=F');

    const closes = td.map(c => c.close);
    const ema50  = taEMA(closes, 50);
    const ema200 = closes.length >= 200 ? taEMA(closes, 200) : null;
    const rsiArr = taRSI(closes, 14);
    const i = closes.length - 1;
    const last = closes[i];
    const e50 = ema50[i];
    const e200 = ema200 ? ema200[i] : null;
    const rsi = rsiArr[i];
    if (e50 == null) return emptyFactor('technicals', 'Technicals', 'EMAs n/a');

    let score = 0;
    if (e200 != null) {
        if (last > e50 && last > e200)       score = +1.0;
        else if (last > e50 || last > e200)  score = +0.5;
        else if (last < e50 && last < e200)  score = -1.0;
        else                                  score = -0.5;
    } else {
        // EMA50 only
        score = last > e50 ? +0.5 : -0.5;
    }

    // RSI moderation
    if (rsi != null) {
        if (rsi >= 75 && score > 0) score = Math.min(score, 0.5);
        else if (rsi <= 25 && score < 0) score = Math.max(score, -0.5);
    }

    const struct = e200 == null ? (last > e50 ? 'above EMA50' : 'below EMA50')
                : (last > e50 && last > e200) ? 'above EMA50/200'
                : (last < e50 && last < e200) ? 'below EMA50/200'
                : 'between EMAs';
    const valueText = '$' + last.toFixed(2);
    const subText = tfLabel + ' · ' + struct + (rsi != null ? ' · RSI ' + rsi.toFixed(0) : '');
    return { key: 'technicals', label: 'Technicals', score, valueText, subText, tone: toneFromScore(score) };
}

// ── 5. STORAGE TRAJECTORY — 7/14/21D projected deviation trend vs 5Y ────────
// Looks at WHERE storage is heading (forward fcst from bias.js), not where it is.
// A worsening surplus (dev getting more positive) is incrementally bearish.
// An improving deficit (dev getting more negative) is incrementally bullish.
//
// Method: compute dev% at 7D / 14D / 21D horizons, compare to current dev%.
// Score = trajectory direction × magnitude, averaged across available horizons.

function scoreStorageTrajectory() {
    const sd = state.stStorageData;
    if (!sd || sd.length < 2) return emptyFactor('sttraj', 'Storage Trend', 'waiting for EIA');
    const lat = sd[sd.length - 1];

    // Current dev% as baseline
    const curBand = st5y(sd, [lat.date])[0];
    if (!curBand || curBand.avg == null || curBand.avg === 0) {
        return emptyFactor('sttraj', 'Storage Trend', 'no 5y avg');
    }
    const curDevPct = (lat.value - curBand.avg) / curBand.avg * 100;

    // Build forward dev% at each horizon
    const fcsts = [
        { f: state.stLastF7,  label: '7D' },
        { f: state.stLastF14, label: '14D' },
        { f: state.stLastF21, label: '21D' }
    ];
    const horizons = [];
    fcsts.forEach(h => {
        if (!h.f || h.f.predictedLevel == null || !h.f.endDate) return;
        const band = st5y(sd, [h.f.endDate])[0];
        if (!band || band.avg == null || band.avg === 0) return;
        const devPct = (h.f.predictedLevel - band.avg) / band.avg * 100;
        horizons.push({ label: h.label, devPct });
    });

    if (horizons.length === 0) {
        return emptyFactor('sttraj', 'Storage Trend', 'awaiting weather fcst');
    }

    // Avg deviation across horizons (more weight on later = where price reacts)
    const weights = { '7D': 0.25, '14D': 0.35, '21D': 0.40 };
    let wSum = 0, wTot = 0;
    horizons.forEach(h => { const w = weights[h.label] || 0.33; wSum += h.devPct * w; wTot += w; });
    const avgFwdDevPct = wSum / wTot;
    const deltaDev = avgFwdDevPct - curDevPct;  // negative = improving (bullish)

    // Two-component scoring:
    //   (a) absolute forward dev% — same scale as Storage factor but on the trajectory
    //   (b) change from current — does the deficit deepen or shrink?
    let absScore = 0;
    if (avgFwdDevPct >= 5)        absScore = -1.0;
    else if (avgFwdDevPct >= 2)   absScore = -0.5;
    else if (avgFwdDevPct <= -5)  absScore = +1.0;
    else if (avgFwdDevPct <= -2)  absScore = +0.5;

    let deltaScore = 0;
    if (deltaDev >= 2)        deltaScore = -0.5;   // surplus deepening = bearish
    else if (deltaDev <= -2)  deltaScore = +0.5;   // deficit deepening = bullish

    // Composite: 60% trajectory level, 40% change vs current — capped at ±1.0
    let score = absScore * 0.6 + deltaScore * 0.4;
    if (score > 1.0) score = 1.0;
    if (score < -1.0) score = -1.0;

    const sign = avgFwdDevPct >= 0 ? '+' : '';
    const dSign = deltaDev >= 0 ? '+' : '';
    const valueText = sign + avgFwdDevPct.toFixed(1) + '%';
    const dirWord = deltaDev > 0.3 ? 'widening' : deltaDev < -0.3 ? 'narrowing' : 'flat';
    const subText = '21D fwd · ' + dSign + deltaDev.toFixed(1) + 'pp (' + dirWord + ')';
    return { key: 'sttraj', label: 'Storage Trend', score, valueText, subText, tone: toneFromScore(score) };
}

// ── 6. CALENDAR SPREAD — next contract vs front month ───────────────────────
// Backwardation (next < front) = market expects supply tightening → bullish.
// Contango (next > front) = market expects surplus → bearish.
//
// Threshold tiered by spread size in $/MMBtu and as % of front price.

function scoreCalendarSpread() {
    const ngf = state.stNgfData;
    const nextPrice = state.nextContractPrice;
    if (!ngf || !ngf.length || nextPrice == null) {
        return emptyFactor('calspread', 'Cal Spread', 'waiting for futures');
    }
    const front = ngf[ngf.length - 1].close;
    if (!front || !isFinite(front) || front <= 0) {
        return emptyFactor('calspread', 'Cal Spread', 'invalid front');
    }
    const spread = nextPrice - front;          // positive = contango (bearish)
    const spreadPct = (spread / front) * 100;

    let score = 0;
    let mode = 'flat';

    // Bullish backwardation
    if (spreadPct <= -3)        { score = +1.0; mode = 'strong backwardation'; }
    else if (spreadPct <= -1)   { score = +0.5; mode = 'backwardation'; }
    // Bearish contango
    else if (spreadPct >= 3)    { score = -1.0; mode = 'strong contango'; }
    else if (spreadPct >= 1)    { score = -0.5; mode = 'contango'; }
    else                         { score = 0;    mode = 'flat curve'; }

    const sign = spread >= 0 ? '+' : '';
    const valueText = sign + '$' + spread.toFixed(3);
    const subText = mode + ' · ' + sign + spreadPct.toFixed(1) + '% vs front';
    return { key: 'calspread', label: 'Cal Spread', score, valueText, subText, tone: toneFromScore(score) };
}

// ── 7. COT FLOW — MM Net W/W change + 52w percentile contrarian extreme ─────

function scoreCotFlow() {
    const cd = state.cotData;
    if (!cd || cd.length < 8) return emptyFactor('cotflow', 'COT Flow', 'waiting for CFTC');
    const last = cd[cd.length - 1];
    const prev = cd[cd.length - 2];
    const wkChg = last.mmNet - prev.mmNet;

    // Trailing-52w percentile of MM Net
    const win = cd.slice(-52);
    const nets = win.map(r => r.mmNet).sort((a, b) => a - b);
    const idx = nets.findIndex(v => v >= last.mmNet);
    const pct = idx < 0 ? 100 : (idx / nets.length) * 100;

    let score = 0;
    let note = '';

    // Directional flow (W/W)
    if (wkChg >= 5000)       score = +0.5;
    else if (wkChg <= -5000) score = -0.5;

    // Contrarian extremes override
    if (pct <= 15) {
        score = +1.0;
        note = ' · extreme net-short (contra-bull)';
    } else if (pct >= 85) {
        score = -1.0;
        note = ' · extreme net-long (contra-bear)';
    }

    const sign = wkChg >= 0 ? '+' : '';
    const valueText = sign + (wkChg / 1000).toFixed(1) + 'k W/W';
    const subText = 'pct ' + pct.toFixed(0) + '/100' + note;
    return { key: 'cotflow', label: 'COT Flow', score, valueText, subText, tone: toneFromScore(score) };
}

// ── 8. SEASONALITY — heating boosts, shoulder neutral, cooling mild ─────────

function scoreSeasonality() {
    const si = getSeasonInfo();
    const isCooling = /cooling/i.test(si.name || '');
    let score = 0, sub = '';
    if (si.isHeating) {
        score = +0.5;
        sub = 'heating season';
    } else if (isCooling) {
        score = +0.25;
        sub = 'cooling season';
    } else {
        score = 0;
        sub = 'shoulder season';
    }
    // Early heating (< day 30) — slight extra demand pickup risk
    if (si.isHeating && si.daysIn != null && si.daysIn < 30) {
        score = Math.min(1.0, score + 0.25);
    }
    return { key: 'seasonality', label: 'Seasonality', score, valueText: si.name, subText: sub, tone: toneFromScore(score) };
}

// ── Public API ────────────────────────────────────────────────────────────────

// Verdict bands scaled for 8-factor model (range −8 .. +8).
// Roughly: ±0.6 / ±1.8 / ±4.5 (relative to ±0.5 / ±1.5 / ±3.5 on a 6-factor scale).
const VERDICTS = [
    { min: +4.5,  label: 'STRONG BULL',   color: '#3fb950' },
    { min: +2.0,  label: 'BULLISH',       color: '#3fb950' },
    { min: +0.6,  label: 'MILD BULL',     color: '#7ec97f' },
    { min: -0.6,  label: 'NEUTRAL',       color: '#9ba3ad' },
    { min: -2.0,  label: 'MILD BEAR',     color: '#ffb085' },
    { min: -4.5,  label: 'BEARISH',       color: '#ff7b72' },
    { min: -99,   label: 'STRONG BEAR',   color: '#ff5c5c' }
];

export function computeComposite() {
    const factors = [
        scoreStorage(),
        scoreWeather(),
        scoreProduction(),
        scoreTechnicals(),
        scoreStorageTrajectory(),
        scoreCalendarSpread(),
        scoreCotFlow(),
        scoreSeasonality()
    ];
    const total = factors.reduce((s, f) => s + f.score, 0);
    const verdict = VERDICTS.find(v => total >= v.min) || VERDICTS[VERDICTS.length - 1];

    const sorted = factors.slice().sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
    const drivers = sorted.filter(f => Math.abs(f.score) >= 0.5).slice(0, 3).map(f => {
        const dir = f.score > 0 ? '+' : '';
        return f.label + ' (' + dir + f.score.toFixed(1) + ')';
    });

    return {
        total,
        max: 8,
        verdict: verdict.label,
        verdictColor: verdict.color,
        factors,
        drivers
    };
}

// ── Renderer ──────────────────────────────────────────────────────────────────

export function renderComposite() {
    const c = computeComposite();

    const elTotal   = document.getElementById('cmp-total');
    const elVerdict = document.getElementById('cmp-verdict');
    const elDrivers = document.getElementById('cmp-drivers');
    const elBar     = document.getElementById('cmp-bar-fill');
    const elBarLbl  = document.getElementById('cmp-bar-lbl');

    if (elVerdict) { elVerdict.textContent = c.verdict; elVerdict.style.color = c.verdictColor; }
    if (elTotal)   { elTotal.textContent = (c.total >= 0 ? '+' : '') + c.total.toFixed(1) + ' / ' + c.max; }
    if (elDrivers) {
        elDrivers.textContent = c.drivers.length
            ? 'Key drivers: ' + c.drivers.join(', ')
            : 'No strong directional signals · awaiting more data';
    }

    // Score bar — fills FROM the center (50%) outward, color = verdict color
    if (elBar) {
        const width = Math.abs(c.total / c.max) * 50;        // 0–50%
        elBar.style.width = width + '%';
        elBar.style.background = c.verdictColor;
        elBar.style.marginLeft = c.total >= 0 ? '50%' : (50 - width) + '%';
    }
    if (elBarLbl) elBarLbl.textContent = c.verdict;

    c.factors.forEach(f => {
        const wrap = document.getElementById('cmp-f-' + f.key);
        if (!wrap) return;
        const val = wrap.querySelector('.cmp-f-val');
        const sub = wrap.querySelector('.cmp-f-sub');
        const sco = wrap.querySelector('.cmp-f-sco');
        wrap.classList.remove('bull', 'bear', 'neu');
        wrap.classList.add(f.tone);
        if (val) val.textContent = f.valueText;
        if (sub) sub.textContent = f.subText;
        if (sco) sco.textContent = (f.score >= 0 ? '+' : '') + f.score.toFixed(1);
    });

    return c;
}
