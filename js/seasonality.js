// js/seasonality.js — NG=F seasonality: current year vs historical median & 10–90% band
import { state } from './state.js';
import { dbLog } from './debug.js';
import { killChart, baseX, baseY, baseTT, zoomOpts } from './charts.js';
import { buildFairPriceSeries } from './futures2.js';

const WEEKS = 52;
const MONTH_TICKS = { 1: 'Jan', 5: 'Feb', 9: 'Mar', 13: 'Apr', 18: 'May', 22: 'Jun', 27: 'Jul', 31: 'Aug', 35: 'Sep', 40: 'Oct', 44: 'Nov', 48: 'Dec' };

function setBadge(t, txt) { const el = document.getElementById('season-badge'); if (el) { el.textContent = txt; el.className = 'cbadge ' + t; } }
function setDot(s)        { const el = document.getElementById('season-dot');   if (el) el.className = 'sdot ' + s; }

// Week-of-year (1..52); the partial 53rd week folds into 52.
function weekOfYear(d) {
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  const doy = Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - start) / 864e5);
  return Math.min(WEEKS, Math.floor(doy / 7) + 1);
}

// Group NG=F weekly closes by year → { year: { week: close } }
function groupByYear() {
  const byYear = {};
  state.stNgfData.forEach(d => {
    const dt = new Date(d.ts);
    const y = dt.getUTCFullYear();
    const w = weekOfYear(dt);
    if (!byYear[y]) byYear[y] = {};
    // keep the last close seen for a given week slot
    byYear[y][w] = d.close;
  });
  return byYear;
}

// Linear-interpolated percentile (p in 0..1) over a numeric array.
function pct(sorted, p) {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function median(arr) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  return pct(s, 0.5);
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ── Seasonal statistics ───────────────────────────────────────────────────────
// All stats are computed from weekly % price moves relative to the current week
// of year, independent of the chart's $/% toggle.

function computeSeasonStats() {
  const byYear = groupByYear();
  const years = Object.keys(byYear).map(Number).sort((a, b) => a - b);
  const curYear = new Date().getUTCFullYear();
  const histYears = years.filter(y => y !== curYear);
  if (!histYears.length) return null;

  // Current week of year (latest week we have data for in the current year)
  const curMap = byYear[curYear] || {};
  let nowW = 0;
  for (let w = 1; w <= WEEKS; w++) { if (curMap[w] != null) nowW = w; }
  if (!nowW) return null;

  // % change from start of year, per year → for "current vs median" + reliability
  const pctFromJan = y => yearSeries(byYear[y], 'pct');
  // Current-year position: prefer the live front price (1-min refresh) over the
  // last weekly close, so "Current vs median" tracks the market intraday.
  let curPct = pctFromJan(curYear)[nowW - 1];
  let curBase = null;
  for (let w = 1; w <= WEEKS; w++) { if (curMap[w] != null) { curBase = curMap[w]; break; } }
  const live = state.frontLivePrice;
  if (live != null && isFinite(live) && curBase && curBase > 0) {
    curPct = (live / curBase - 1) * 100;
  }
  const histPctAtNow = histYears.map(y => pctFromJan(y)[nowW - 1]).filter(v => v != null && isFinite(v));
  const medAtNow = median(histPctAtNow);
  const p10 = histPctAtNow.length >= 2 ? pct(histPctAtNow.slice().sort((a, b) => a - b), 0.1) : null;
  const p90 = histPctAtNow.length >= 2 ? pct(histPctAtNow.slice().sort((a, b) => a - b), 0.9) : null;

  // Forward move from current week: price[nowW+h] / price[nowW] - 1, per historical year
  function fwdMoves(h) {
    const out = [];
    histYears.forEach(y => {
      const m = byYear[y];
      const a = m[nowW], b = m[Math.min(WEEKS, nowW + h)];
      if (a != null && b != null && a > 0) out.push((b / a - 1) * 100);
    });
    return out;
  }
  const fwd1 = fwdMoves(1), fwd2 = fwdMoves(2), fwd3 = fwdMoves(3), fwd4 = fwdMoves(4);
  const probOf = arr => arr.length ? arr.filter(v => v > 0).length / arr.length * 100 : null;
  const prob1 = probOf(fwd1), prob2 = probOf(fwd2), prob3 = probOf(fwd3), prob4 = probOf(fwd4);
  const medFwd4 = median(fwd4);

  // Per-month median % move (first→last available week of each calendar month, per year)
  const WEEK_TO_MONTH = w => { // approx: 52 weeks across 12 months
    const monthStartWeek = [1, 5, 9, 14, 18, 22, 27, 31, 35, 40, 44, 48];
    let m = 0; for (let i = 0; i < 12; i++) { if (w >= monthStartWeek[i]) m = i; }
    return m;
  };
  const monthMoves = Array.from({ length: 12 }, () => []);
  histYears.forEach(y => {
    const m = byYear[y];
    // collect first & last close within each month bucket
    const firstByM = new Array(12).fill(null), lastByM = new Array(12).fill(null);
    for (let w = 1; w <= WEEKS; w++) {
      if (m[w] == null) continue;
      const mo = WEEK_TO_MONTH(w);
      if (firstByM[mo] == null) firstByM[mo] = m[w];
      lastByM[mo] = m[w];
    }
    for (let mo = 0; mo < 12; mo++) {
      if (firstByM[mo] != null && lastByM[mo] != null && firstByM[mo] > 0) {
        monthMoves[mo].push((lastByM[mo] / firstByM[mo] - 1) * 100);
      }
    }
  });
  const monthMedians = monthMoves.map(arr => median(arr));
  let strongest = null, weakest = null;
  monthMedians.forEach((v, i) => {
    if (v == null) return;
    if (strongest == null || v > monthMedians[strongest]) strongest = i;
    if (weakest == null || v < monthMedians[weakest]) weakest = i;
  });

  return {
    nowW, curYear, histCount: histYears.length,
    curPct, medAtNow, p10, p90,
    prob1, prob2, prob3, prob4, medFwd4,
    monthMedians, strongest, weakest
  };
}

export function renderSeasonStats() {
  const block = document.getElementById('season-stats-block');
  const s = computeSeasonStats();
  if (!s) { if (block) block.style.display = 'none'; return; }
  if (block) block.style.display = 'block';

  const sgnPP = v => (v >= 0 ? '+' : '') + v.toFixed(1);
  const setText = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
  const setColor = (id, col) => { const el = document.getElementById(id); if (el) el.style.color = col; };
  const RED = '#ff7b72', GREEN = '#3fb950', NEU = '#e6edf3';

  // 1. Current vs median
  if (s.curPct != null && s.medAtNow != null) {
    const dev = s.curPct - s.medAtNow;
    setText('sstat-pos-val', sgnPP(dev) + ' pp');
    setColor('sstat-pos-val', dev >= 0 ? RED : GREEN);
    setText('sstat-pos-sub', (dev >= 0 ? 'above' : 'below') + ' typical year (' + sgnPP(s.curPct) + '% YTD vs ' + sgnPP(s.medAtNow) + '% median)');
  } else {
    setText('sstat-pos-val', 'N/A'); setColor('sstat-pos-val', NEU);
    setText('sstat-pos-sub', 'insufficient current-year data');
  }

  // 2. Probability higher in 1 / 2 / 3 / 4 weeks — colour each value on its own
  const probColorOf = v => v == null ? NEU : (v >= 55 ? GREEN : v >= 45 ? NEU : RED);
  const probHTML = [s.prob1, s.prob2, s.prob3, s.prob4]
    .map(v => v != null
      ? '<span style="color:' + probColorOf(v) + '">' + Math.round(v) + '%</span>'
      : '<span style="color:' + NEU + '">—</span>')
    .join('<span style="color:' + NEU + '"> / </span>');
  const setHTML = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
  if (s.prob1 != null || s.prob4 != null) {
    setHTML('sstat-prob-val', probHTML);
    setColor('sstat-prob-val', ''); // colour now comes from inner spans
    setText('sstat-prob-sub', 'price up in 1 / 2 / 3 / 4 wks · ' + s.histCount + 'y history');
  } else {
    setText('sstat-prob-val', 'N/A'); setText('sstat-prob-sub', '—');
  }

  // Mirror the probability into the header KPI (same data, no separate refresh loop)
  {
    const kv = document.getElementById('kpi-season-prob');
    if (kv) {
      if (s.prob1 != null || s.prob4 != null) { kv.innerHTML = probHTML; kv.style.color = ''; }
      else { kv.textContent = '—'; kv.style.color = NEU; }
    }
  }

  // 3. Typical move ahead (median, next 4 weeks)
  if (s.medFwd4 != null) {
    setText('sstat-fwd-val', sgnPP(s.medFwd4) + '%');
    setColor('sstat-fwd-val', s.medFwd4 >= 0 ? GREEN : RED);
    setText('sstat-fwd-sub', 'median move, next 4 weeks');
  } else {
    setText('sstat-fwd-val', 'N/A'); setText('sstat-fwd-sub', '—');
  }

  // 4. Strongest / weakest month
  if (s.strongest != null && s.weakest != null) {
    setText('sstat-month-val', MONTH_NAMES[s.strongest] + ' / ' + MONTH_NAMES[s.weakest]);
    setColor('sstat-month-val', NEU);
    setText('sstat-month-sub', 'strongest ' + sgnPP(s.monthMedians[s.strongest]) + '% · weakest ' + sgnPP(s.monthMedians[s.weakest]) + '%');
  } else {
    setText('sstat-month-val', 'N/A'); setText('sstat-month-sub', '—');
  }

  // 5. Seasonal reliability — width of the 10–90% band at the current week
  if (s.p10 != null && s.p90 != null) {
    const spread = s.p90 - s.p10;
    // narrower band → more reliable seasonal pattern
    const rating = spread < 15 ? 'High' : spread < 30 ? 'Medium' : 'Low';
    const col = spread < 15 ? GREEN : spread < 30 ? '#e3b341' : RED;
    setText('sstat-rel-val', rating);
    setColor('sstat-rel-val', col);
    setText('sstat-rel-sub', '10–90% spread ' + spread.toFixed(0) + ' pp this week');
  } else {
    setText('sstat-rel-val', 'N/A'); setText('sstat-rel-sub', '—');
  }
}

// Convert a {week: value} map into a 52-length array, optionally normalised to
// "% change from the first available week of that year".
function yearSeries(weekMap, mode) {
  const out = new Array(WEEKS).fill(null);
  let base = null;
  if (mode === 'pct') {
    for (let w = 1; w <= WEEKS; w++) { if (weekMap[w] != null) { base = weekMap[w]; break; } }
  }
  for (let w = 1; w <= WEEKS; w++) {
    const v = weekMap[w];
    if (v == null) continue;
    out[w - 1] = (mode === 'pct')
      ? (base ? (v / base - 1) * 100 : null)
      : v;
  }
  return out;
}

export function renderSeasonChart() {
  _renderSeason({
    canvasId: 'season-canvas', wrapId: 'season-wrap', spinId: 'season-spin',
    slot: 'seasonChart', compact: false, badge: true, zoom: true
  });
  try { renderSeasonStats(); } catch (e) { dbLog('season stats: ' + e.message, 'warn'); }
}

// Overview-card variant: smaller, no zoom, sparse month ticks.
export function renderSeasonChartOverview() {
  populateSeasonYearSelect();
  _renderSeason({
    canvasId: 'fw-season-canvas', wrapId: 'fw-season-wrap', spinId: 'fw-spin',
    slot: 'seasonChartOv', compact: true, badge: false, zoom: false,
    // only paint the spinner state if the season tab is the active card view
    onlyIfActive: () => state.fwCardMode === 'season'
  });
  // keep the overview legend's line label in sync with the selected year
  const curYear = new Date().getUTCFullYear();
  const shownYear = state.seasonOvYear && state.seasonOvYear !== curYear ? state.seasonOvYear : curYear;
  const ly = document.getElementById('fw-season-curyear');
  if (ly) ly.textContent = shownYear === curYear ? 'This year' : String(shownYear);
}

// Fill the year <select> with available years (most recent first), once.
function populateSeasonYearSelect() {
  const sel = document.getElementById('fw-season-year');
  if (!sel) return;
  const byYear = groupByYear();
  const years = Object.keys(byYear).map(Number).sort((a, b) => b - a);
  if (!years.length) return;
  const curYear = new Date().getUTCFullYear();
  // rebuild only if option count changed (cheap + avoids clobbering selection)
  if (sel.options.length !== years.length) {
    sel.innerHTML = '';
    years.forEach(y => {
      const o = document.createElement('option');
      o.value = String(y);
      o.textContent = (y === curYear) ? y + ' (current)' : String(y);
      sel.appendChild(o);
    });
  }
  sel.value = String(state.seasonOvYear || curYear);
}

export function seasonOvSetYear(year) {
  const curYear = new Date().getUTCFullYear();
  const y = parseInt(year, 10);
  state.seasonOvYear = (isNaN(y) || y === curYear) ? null : y;
  try { renderSeasonChartOverview(); } catch (e) { dbLog('season overview year: ' + e.message, 'warn'); }
}

function _renderSeason(cfg) {
  const canvas = document.getElementById(cfg.canvasId);
  const wrap = document.getElementById(cfg.wrapId);
  const spin = document.getElementById(cfg.spinId);
  if (!canvas || typeof Chart === 'undefined') return;

  if (!state.stNgfData.length) {
    if (cfg.badge) { setDot('loading'); setBadge('loading', 'Loading…'); }
    if (spin && (!cfg.onlyIfActive || cfg.onlyIfActive())) { spin.style.display = 'block'; spin.innerHTML = 'Waiting for NG=F history…'; }
    if (wrap) wrap.style.display = 'none';
    return;
  }

  const mode = state.seasonMode === 'abs' ? 'abs' : 'pct';
  const byYear = groupByYear();
  const years = Object.keys(byYear).map(Number).sort((a, b) => a - b);
  const curYear = new Date().getUTCFullYear();

  // Historical years = everything except the current (incomplete) year
  const histYears = years.filter(y => y !== curYear);

  // Build per-week robust stats from historical years.
  // Median + 10–90 percentile band keeps the typical seasonal envelope readable
  // even when a single crisis year (e.g. 2022) sits far outside the norm.
  const med  = new Array(WEEKS).fill(null);
  const mins = new Array(WEEKS).fill(null); // p10
  const maxs = new Array(WEEKS).fill(null); // p90
  for (let w = 1; w <= WEEKS; w++) {
    const vals = [];
    histYears.forEach(y => {
      const s = yearSeries(byYear[y], mode);
      const v = s[w - 1];
      if (v != null && isFinite(v)) vals.push(v);
    });
    if (vals.length >= 2) {
      vals.sort((a, b) => a - b);
      med[w - 1]  = pct(vals, 0.5);
      mins[w - 1] = pct(vals, 0.1);
      maxs[w - 1] = pct(vals, 0.9);
    }
  }

  // Which year is highlighted by the bold line. In the overview card the user
  // can pick a historical year; the list always shows the current year.
  const isCurrentYear = !(cfg.compact && state.seasonOvYear && state.seasonOvYear !== curYear);
  const displayYear = isCurrentYear ? curYear : state.seasonOvYear;
  const current = byYear[displayYear] ? yearSeries(byYear[displayYear], mode) : new Array(WEEKS).fill(null);

  const labels = [];
  for (let w = 1; w <= WEEKS; w++) labels.push(MONTH_TICKS[w] || '');

  const fmtVal = mode === 'pct'
    ? (v => (v >= 0 ? '+' : '') + v.toFixed(1) + '%')
    : (v => '$' + v.toFixed(2));
  // Tooltip uses more precision than the axis labels
  const fmtTip = mode === 'pct'
    ? (v => (v >= 0 ? '+' : '') + v.toFixed(2) + '%')
    : (v => '$' + v.toFixed(3));

  if (spin) spin.style.display = 'none';
  if (wrap) wrap.style.display = 'block';
  killChart(state[cfg.slot]); state[cfg.slot] = null;

  // Latest week with current-year data → "where are we now"
  let nowIdx = -1;
  for (let i = WEEKS - 1; i >= 0; i--) { if (current[i] != null) { nowIdx = i; break; } }
  const nowVal = nowIdx >= 0 ? current[nowIdx] : null;
  const nowMed = nowIdx >= 0 ? med[nowIdx] : null;
  const nowDev = (nowVal != null && nowMed != null) ? nowVal - nowMed : null;

  // Fair price overlay — overview card, $ mode only. Mapped onto weeks-of-year
  // for the selected year. Current year is shown only through the current week;
  // historical years are shown for the full year.
  let fpFair = null, fpMin = null, fpMax = null;
  if (cfg.compact && mode === 'abs') {
    const isoForWeek = w => {
      // Thursday of ISO-ish week w in the display year (matches weekOfYear bucketing)
      const d = new Date(Date.UTC(displayYear, 0, 1 + (w - 1) * 7 + 3));
      return d.toISOString().slice(0, 10);
    };
    const isoDates = [];
    for (let w = 1; w <= WEEKS; w++) isoDates.push(isoForWeek(w));
    const fps = buildFairPriceSeries(isoDates);
    if (fps && !fps.fair.every(v => v == null)) {
      if (isCurrentYear && nowIdx >= 0) {
        // only show up to the current week for the running year
        const cut = arr => arr.map((v, i) => i <= nowIdx ? v : null);
        fpFair = cut(fps.fair); fpMin = cut(fps.mins); fpMax = cut(fps.maxs);
      } else {
        fpFair = fps.fair; fpMin = fps.mins; fpMax = fps.maxs;
      }
    }
  }
  const fpDatasets = fpFair ? [
    { _k: 'fp_fair', label: 'Fair price', data: fpFair, borderColor: '#a371f7', borderWidth: 1.5, pointRadius: 0, tension: 0.3, fill: false },
    { _k: 'fp_min',  label: 'Fair min',   data: fpMin,  borderColor: 'rgba(163,113,247,0.7)', borderWidth: 1, borderDash: [4, 3], pointRadius: 0, tension: 0.3, fill: false },
    { _k: 'fp_max',  label: 'Fair max',   data: fpMax,  borderColor: 'rgba(163,113,247,0.7)', borderWidth: 1, borderDash: [4, 3], pointRadius: 0, tension: 0.3, fill: false }
  ] : [];

  // Deviation of the current price vs fair price (abs mode, current year only).
  // Computed independently of the overlay so it also works on the full list chart.
  let fairDev = null;
  if (mode === 'abs' && isCurrentYear && nowIdx >= 0 && nowVal != null) {
    const d = new Date(Date.UTC(displayYear, 0, 1 + nowIdx * 7 + 3));
    const fps = buildFairPriceSeries([d.toISOString().slice(0, 10)]);
    const nowFair = fps && fps.fair && fps.fair[0] != null ? fps.fair[0] : null;
    if (nowFair != null) fairDev = nowVal - nowFair;
  }

  const fcstDatasets = [];

  const fontSize = cfg.compact ? 8 : 9;
  // In compact mode show fewer month labels to avoid clutter
  const compactTicks = { 1: 'Jan', 9: 'Mar', 18: 'May', 27: 'Jul', 35: 'Sep', 44: 'Nov' };
  const tickMap = cfg.compact ? compactTicks : MONTH_TICKS;

  const tt = Object.assign({}, baseTT(), {
    callbacks: {
      title: items => {
        const i = items[0] ? items[0].dataIndex : null;
        return i == null ? '' : 'Week ' + (i + 1);
      },
      label: c => {
        if (c.dataset._k === 'min' || c.dataset._k === 'max') return null;
        if (c.dataset._k === 'fp_min' || c.dataset._k === 'fp_max') return null;
        if (c.parsed.y == null) return null;
        return ' ' + c.dataset.label + ': ' + fmtTip(c.parsed.y);
      },
      afterBody: items => {
        const i = items[0] ? items[0].dataIndex : null;
        if (i == null || mins[i] == null) return [];
        return ['10–90% band: ' + fmtTip(mins[i]) + ' – ' + fmtTip(maxs[i])];
      }
    }
  });

  const fmtDev = mode === 'pct'
    ? (v => (v >= 0 ? '+' : '') + v.toFixed(1) + ' pp')
    : (v => (v >= 0 ? '+' : '') + '$' + Math.abs(v).toFixed(2));

  // "Where are we now" marker: vertical guide at the current week, a dot on the
  // current-year line, and (full size only) a label with the deviation vs median.
  const nowMarkerPlugin = {
    id: 'seasonNow_' + cfg.slot,
    afterDatasetsDraw(chart) {
      if (!isCurrentYear || nowIdx < 0 || nowVal == null) return;
      const x = chart.scales.x, y = chart.scales.y, ca = chart.chartArea;
      const px = x.getPixelForValue(nowIdx);
      const py = y.getPixelForValue(nowVal);
      const cx = chart.ctx;
      cx.save();
      // vertical guide
      cx.strokeStyle = 'rgba(227,179,65,0.35)';
      cx.lineWidth = 1;
      cx.setLineDash([3, 3]);
      cx.beginPath(); cx.moveTo(px, ca.top); cx.lineTo(px, ca.bottom); cx.stroke();
      cx.setLineDash([]);
      // dot on the current-year line
      cx.fillStyle = '#e3b341';
      cx.strokeStyle = '#11151c';
      cx.lineWidth = 2;
      cx.beginPath(); cx.arc(px, py, cfg.compact ? 3.5 : 4.5, 0, Math.PI * 2); cx.fill(); cx.stroke();
      // deviation label — full size: single line "vs median"; compact (overview):
      // two stacked lines, "vs median" and (in $ mode) "vs fair".
      const lines = [];
      if (nowDev != null) lines.push({ txt: fmtDev(nowDev) + ' vs median', col: nowDev >= 0 ? '#ff7b72' : '#3fb950' });
      if (cfg.compact && mode === 'abs' && fpFair && fpFair[nowIdx] != null) {
        const fairDev = nowVal - fpFair[nowIdx];
        lines.push({ txt: fmtDev(fairDev) + ' vs fair', col: fairDev >= 0 ? '#ff7b72' : '#3fb950' });
      }
      if (lines.length) {
        const fs = cfg.compact ? 9 : 11;
        const lh = cfg.compact ? 13 : 16;       // line height
        const pad = cfg.compact ? 4 : 6;
        cx.font = '600 ' + fs + 'px Inter, sans-serif';
        const tw = Math.max(...lines.map(l => cx.measureText(l.txt).width));
        const bw = tw + pad * 2;
        const bh = lines.length * lh + pad * 2 - (lines.length > 1 ? 2 : 0);
        let bx = px + (cfg.compact ? 7 : 10);
        if (bx + bw > ca.right) bx = px - (cfg.compact ? 7 : 10) - bw; // flip near right edge
        let by = py - (cfg.compact ? 20 : 26) - (lines.length - 1) * lh;
        by = Math.max(ca.top + 4, by);
        cx.fillStyle = 'rgba(28,33,40,0.92)';
        cx.strokeStyle = 'rgba(255,255,255,0.10)';
        cx.lineWidth = 1;
        cx.beginPath();
        if (cx.roundRect) cx.roundRect(bx, by, bw, bh, 4); else cx.rect(bx, by, bw, bh);
        cx.fill(); cx.stroke();
        cx.textBaseline = 'middle';
        lines.forEach((l, i) => {
          cx.fillStyle = l.col;
          cx.fillText(l.txt, bx + pad, by + pad + lh * i + lh / 2 - (cfg.compact ? 1 : 0));
        });
      }
      cx.restore();
    }
  };

  // 1-week seasonal direction is rendered as an HTML badge next to the legend.

  state[cfg.slot] = new Chart(canvas.getContext('2d'), {
    type: 'line',
    plugins: [nowMarkerPlugin],
    data: { labels, datasets: [
      { _k: 'max',  label: 'P90',          data: maxs, borderColor: 'transparent', backgroundColor: 'rgba(68,147,248,0.10)', pointRadius: 0, fill: '+1', tension: 0.3 },
      { _k: 'min',  label: 'P10',          data: mins, borderColor: 'transparent', backgroundColor: 'transparent', pointRadius: 0, fill: false, tension: 0.3 },
      { _k: 'avg',  label: 'Hist. median', data: med,  borderColor: 'rgba(68,147,248,0.6)', borderWidth: 1.5, borderDash: [5, 4], pointRadius: 0, tension: 0.3, fill: false },
      { _k: 'cur',  label: String(displayYear), data: current, borderColor: '#e3b341', borderWidth: cfg.compact ? 2 : 2.5, pointRadius: 0, pointHoverRadius: 5, tension: 0.3, fill: false },
      ...fpDatasets,
      ...fcstDatasets
    ]},
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false }, tooltip: tt, zoom: cfg.zoom ? zoomOpts() : false },
      scales: {
        x: Object.assign(baseX(), { ticks: { color: '#6e7681', font: { family: 'Inter', size: fontSize }, autoSkip: false, maxRotation: 0, callback: function(val, idx) { return tickMap[idx + 1] || ''; } } }),
        y: baseY(fmtVal)
      }
    }
  });

  if (cfg.badge) {
    setDot('ok');
    setBadge('live', histYears.length + 'y history · ' + curYear);
  }

  // Show the "Fair value" legend entry only when the fair price overlay is drawn
  if (cfg.compact) {
    const fpLeg = document.getElementById('fw-legend-fp');
    if (fpLeg) fpLeg.style.display = fpFair ? 'flex' : 'none';
  }
}

export function seasonSetMode(mode) {
  if (mode !== 'pct' && mode !== 'abs') return;
  if (state.seasonMode === mode) return;
  state.seasonMode = mode;
  document.querySelectorAll('[data-season-mode]').forEach(b => b.classList.toggle('on', b.dataset.seasonMode === mode));
  // Update subtitle
  const sub = document.getElementById('season-sub');
  if (sub) sub.textContent = mode === 'pct'
    ? 'Weekly · % change from start of year · current year vs historical median & 10–90% band'
    : 'Weekly · $/MMBtu · current year vs historical median & 10–90% band';
  try { renderSeasonChart(); } catch (e) { dbLog('season chart: ' + e.message, 'warn'); }
  // keep overview card in sync if it's currently showing seasonality
  if (state.fwCardMode === 'season') {
    try { renderSeasonChartOverview(); } catch (e) { dbLog('season overview: ' + e.message, 'warn'); }
  }
}

// ── Overview futures card: Curve ↔ Seasonality toggle ─────────────────────────
export function fwCardSetMode(mode) {
  if (mode !== 'curve' && mode !== 'season') return;
  state.fwCardMode = mode;

  const isSeason = mode === 'season';
  const btnCurve  = document.getElementById('fw-tab-curve');
  const btnSeason = document.getElementById('fw-tab-season');
  if (btnCurve)  btnCurve.classList.toggle('on', !isSeason);
  if (btnSeason) btnSeason.classList.toggle('on', isSeason);

  const title = document.getElementById('fw-card-title');
  if (title) title.textContent = isSeason ? 'Seasonality' : 'Futures Curve';

  const legCurve  = document.getElementById('fw-legend-curve');
  const legSeason = document.getElementById('fw-legend-season');
  if (legCurve)  legCurve.style.display  = isSeason ? 'none' : 'flex';
  if (legSeason) legSeason.style.display = isSeason ? 'flex' : 'none';

  const helpBtn = document.getElementById('fw-season-help-btn');
  if (helpBtn) helpBtn.style.display = isSeason ? '' : 'none';
  const yearSel = document.getElementById('fw-season-year');
  if (yearSel) yearSel.style.display = isSeason ? '' : 'none';

  const curveWrap  = document.getElementById('fw-wrap');
  const seasonWrap = document.getElementById('fw-season-wrap');
  const spin = document.getElementById('fw-spin');

  // The footer note ("Contango …") only applies to the curve view
  const note = document.getElementById('fw-note');
  if (note) note.style.display = isSeason ? 'none' : '';

  if (isSeason) {
    if (curveWrap) curveWrap.style.display = 'none';
    if (spin) spin.style.display = 'none';
    try { renderSeasonChartOverview(); } catch (e) { dbLog('season overview: ' + e.message, 'warn'); }
  } else {
    if (seasonWrap) seasonWrap.style.display = 'none';
    // curve re-render is triggered by the caller (main.js) which owns renderFuturesCurve
  }
}
