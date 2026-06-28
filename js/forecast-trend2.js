// js/forecast-trend.js
// "Forecast trend" view for the Weather Demand card.
// Loads data/history.json (hourly snapshots written by the GitHub Actions bot),
// keeps the last 7 days, and draws how the summed 16-day Demand outlook has
// evolved over time. All timestamps are shown in Prague time (Europe/Prague),
// regardless of the viewer's location.
//
// Pro styling:
//   - line segments colored green (rising outlook) / red (falling outlook)
//   - the latest point is highlighted with a labelled value badge
//   - a stats row above the chart shows current value, 24h change, 7d range

const HISTORY_URL = 'data/history.json';
const WINDOW_DAYS = 7;
const COL_GREEN = '#3fb950';
const COL_RED = '#ff7b72';
const COL_PURPLE = '#a371f7';
const COL_NORMAL = '#8b949e'; // 5-year normal reference line (grey)

let _trendChart = null;
let _loaded = false;
let _mode = 'trend'; // 'current' | 'trend'

function $(id) { return document.getElementById(id); }

// Format an ISO timestamp into Prague local time, e.g. "30.5. 10:23".
const _fmt = new Intl.DateTimeFormat('cs-CZ', {
  timeZone: 'Europe/Prague',
  day: 'numeric', month: 'numeric',
  hour: '2-digit', minute: '2-digit',
});
function pragueLabel(iso) {
  try { return _fmt.format(new Date(iso)).replace(',', ''); }
  catch { return iso; }
}

// "2026-05-30" -> "30.5."
function fmtDate(iso) {
  const p = (iso || '').split('-');
  if (p.length === 3) return parseInt(p[2], 10) + '.' + parseInt(p[1], 10) + '.';
  return iso;
}

const FCST_DAYS = 16; // canonical forecast-window length

async function loadHistory() {
  const res = await fetch(HISTORY_URL + '?t=' + Date.now());
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  const cutoff = Date.now() - WINDOW_DAYS * 86400000;
  // dem / dem5y are SUMS over the forecast window. Open-Meteo occasionally
  // returns 15 instead of 16 days in the early UTC morning, which would make
  // both sums dip. Normalise every record to a 16-day-equivalent sum so the
  // series (and the 5y-normal line) stay smooth regardless of window length.
  return data
    .filter(r => r && r.ts && typeof r.dem === 'number' && new Date(r.ts).getTime() >= cutoff)
    .map(r => {
      const days = (typeof r.days === 'number' && r.days > 0) ? r.days : FCST_DAYS;
      const k = FCST_DAYS / days;
      return {
        ...r,
        dem: r.dem * k,
        dem5y: (typeof r.dem5y === 'number') ? r.dem5y * k : r.dem5y,
      };
    })
    .sort((a, b) => new Date(a.ts) - new Date(b.ts));
}

// Plugin: draw a highlighted dot + value badge on the last data point.
const lastPointPlugin = {
  id: 'ftLastPoint',
  afterDatasetsDraw(chart) {
    const ds = chart.data.datasets[0];
    if (!ds || !ds.data.length) return;
    const meta = chart.getDatasetMeta(0);
    const pts = meta.data;
    if (!pts || !pts.length) return;
    const i = pts.length - 1;
    const pt = pts[i];
    if (!pt) return;
    const val = ds.data[i];
    const ctx = chart.ctx;

    // Rising vs falling for the dot/badge color (compare to previous point).
    const prev = ds.data[i - 1];
    const rising = prev == null || val >= prev;
    const col = rising ? COL_GREEN : COL_RED;

    // Glow dot
    const glow = col + '33'; // hex + alpha
    ctx.save();
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 6, 0, Math.PI * 2);
    ctx.fillStyle = glow;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = col;
    ctx.fill();
    ctx.strokeStyle = '#0a0d12';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Value badge
    const txt = val.toFixed(1);
    ctx.font = '600 11px JetBrains Mono, monospace';
    const tw = ctx.measureText(txt).width;
    const padX = 6, padY = 3, bw = tw + padX * 2, bh = 18;
    let bx = pt.x + 10, by = pt.y - bh / 2;
    // keep badge inside the chart area
    if (bx + bw > chart.chartArea.right) bx = pt.x - 10 - bw;
    if (by < chart.chartArea.top) by = chart.chartArea.top;
    if (by + bh > chart.chartArea.bottom) by = chart.chartArea.bottom - bh;

    ctx.fillStyle = '#1c2128';
    ctx.strokeStyle = col;
    ctx.lineWidth = 1;
    const r = 4;
    ctx.beginPath();
    ctx.moveTo(bx + r, by);
    ctx.arcTo(bx + bw, by, bx + bw, by + bh, r);
    ctx.arcTo(bx + bw, by + bh, bx, by + bh, r);
    ctx.arcTo(bx, by + bh, bx, by, r);
    ctx.arcTo(bx, by, bx + bw, by, r);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = col;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(txt, bx + padX, by + bh / 2 + 0.5);
    ctx.restore();
  },
};

function updateStats(records) {
  const now = records[records.length - 1];
  const elNow = $('ft-stat-now');
  const elChg = $('ft-stat-chg');
  const elRange = $('ft-stat-range');
  if (!now) return;

  if (elNow) elNow.textContent = now.dem.toFixed(1);

  // 24h change: compare to the record closest to 24h ago.
  if (elChg) {
    const target = new Date(now.ts).getTime() - 86400000;
    let ref = null, best = Infinity;
    for (const r of records) {
      const d = Math.abs(new Date(r.ts).getTime() - target);
      if (d < best) { best = d; ref = r; }
    }
    // only meaningful if we have a point within ~6h of 24h ago
    if (ref && ref !== now && best <= 6 * 3600000) {
      const diff = now.dem - ref.dem;
      const sign = diff >= 0 ? '+' : '';
      elChg.textContent = sign + diff.toFixed(1);
      elChg.style.color = diff >= 0 ? COL_GREEN : COL_RED;
    } else {
      elChg.textContent = 'n/a';
      elChg.style.color = 'var(--text3)';
    }
  }

  // 7d range
  if (elRange) {
    const vals = records.map(r => r.dem);
    const mn = Math.min(...vals), mx = Math.max(...vals);
    elRange.textContent = mn.toFixed(1) + ' – ' + mx.toFixed(1);
    elRange.style.color = 'var(--text2)';
  }

  // vs 5y normal: how far the latest outlook is above/below the 5-year normal.
  const elVs5y = $('ft-stat-vs5y');
  if (elVs5y) {
    if (typeof now.dem5y === 'number' && now.dem5y > 0) {
      const diff = now.dem - now.dem5y;
      const pct = diff / now.dem5y * 100;
      const sign = diff >= 0 ? '+' : '';
      elVs5y.textContent = sign + diff.toFixed(1) + ' (' + sign + pct.toFixed(0) + '%)';
      elVs5y.style.color = diff >= 0 ? COL_GREEN : COL_RED;
    } else {
      elVs5y.textContent = 'n/a';
      elVs5y.style.color = 'var(--text3)';
    }
  }
}

// Build a horizontal gradient for one line segment that blends from the
// previous segment's color into this segment's color, so the green<->red
// switch is a soft local fade instead of a hard corner.
function segGradient(ctx, p0, p1, fromCol, toCol) {
  try {
    const g = ctx.createLinearGradient(p0.x, 0, p1.x, 0);
    g.addColorStop(0, fromCol);
    g.addColorStop(1, toCol);
    return g;
  } catch {
    return toCol;
  }
}

function renderTrendChart(records) {
  const canvas = $('ft-canvas');
  const spin = $('ft-spin');
  const wrap = $('ft-wrap');
  const stats = $('ft-stats');
  if (!canvas || !wrap) return;

  if (!records.length) {
    if (spin) { spin.style.display = 'flex'; spin.textContent = 'Not enough data yet — collection runs hourly.'; }
    wrap.style.display = 'none';
    if (stats) stats.style.display = 'none';
    return;
  }

  if (spin) spin.style.display = 'none';
  wrap.style.display = 'block';
  if (stats) stats.style.display = 'flex';

  updateStats(records);

  const labels = records.map(r => pragueLabel(r.ts));
  const dem = records.map(r => r.dem);
  // 5y normal series — null where older records don't have it (line breaks there).
  const dem5y = records.map(r => (typeof r.dem5y === 'number' ? r.dem5y : null));
  const has5y = dem5y.some(v => v != null);

  const textCol = getComputedStyle(document.documentElement).getPropertyValue('--text3').trim() || '#6e7681';
  const gridCol = 'rgba(255,255,255,0.05)';

  // Subtitle: forecast window the latest snapshot covers.
  const last = records[records.length - 1];
  const sub = $('ft-sub');
  if (sub && last && last.from && last.to) {
    sub.textContent = 'Outlook ' + fmtDate(last.from) + ' – ' + fmtDate(last.to) + ' · last 7 days · Prague time';
  }

  if (_trendChart) { _trendChart.destroy(); _trendChart = null; }

  _trendChart = new Chart(canvas, {
    type: 'line',
    plugins: [lastPointPlugin],
    data: {
      labels,
      datasets: [{
        label: 'Demand (16d sum)',
        data: dem,
        borderColor: COL_GREEN,
        borderWidth: 2.5,
        pointRadius: 0,
        pointHoverRadius: 4,
        tension: 0.3,
        fill: false,
        // Binary green (rising) / red (falling), but each segment fades from the
        // previous segment's color into its own, so the switch is a soft local
        // blend rather than a hard corner.
        segment: {
          borderColor: (c) => {
            const ctx = c.chart.ctx;
            const data = c.chart.data.datasets[0].data;
            const i = c.p1DataIndex;          // segment goes from i-1 to i
            const cur = data[i] >= data[i - 1] ? COL_GREEN : COL_RED;
            // color of the previous segment (i-1 to i-2)
            let prevCol = cur;
            if (i - 2 >= 0) prevCol = data[i - 1] >= data[i - 2] ? COL_GREEN : COL_RED;
            if (prevCol === cur) return cur;  // no change → solid
            return segGradient(ctx, c.p0, c.p1, prevCol, cur);
          },
        },
      },
      ...(has5y ? [{
        label: '5y normal',
        data: dem5y,
        borderColor: COL_NORMAL,
        borderWidth: 1.5,
        borderDash: [5, 4],
        pointRadius: 0,
        pointHoverRadius: 3,
        tension: 0.3,
        fill: false,
        spanGaps: true, // bridge older records that lack dem5y
      }] : [])],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      layout: { padding: { right: 44, top: 6 } },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1c2128',
          borderColor: 'rgba(255,255,255,0.08)',
          borderWidth: 1,
          titleColor: '#e6edf3',
          bodyColor: '#9ba3ad',
          padding: 10,
          displayColors: false,
          callbacks: {
            label: ctx => {
              const v = ctx.parsed.y;
              if (v == null) return null;
              const name = ctx.dataset.label === '5y normal' ? '5y normal' : 'Demand';
              return name + ': ' + v.toFixed(1);
            },
          },
        },
      },
      scales: {
        x: {
          grid: { color: gridCol },
          ticks: {
            color: textCol,
            font: { size: 10, family: 'JetBrains Mono, monospace' },
            maxRotation: 0, autoSkip: true, maxTicksLimit: 8,
          },
        },
        y: {
          grid: { color: gridCol },
          title: {
            display: true, text: 'Demand (16d sum)', color: textCol,
            font: { size: 10, family: 'JetBrains Mono, monospace', weight: '600' },
            padding: { bottom: 4 },
          },
          ticks: { color: textCol, font: { size: 10, family: 'JetBrains Mono, monospace' } },
        },
      },
    },
  });
}

async function showTrend() {
  const spin = $('ft-spin');
  if (spin && !_loaded) { spin.style.display = 'flex'; spin.textContent = 'Loading history…'; }
  try {
    const records = await loadHistory();
    _loaded = true;
    renderTrendChart(records);
  } catch (e) {
    if (spin) { spin.style.display = 'flex'; spin.textContent = 'Could not load history: ' + e.message; }
    const stats = $('ft-stats');
    if (stats) stats.style.display = 'none';
  }
}

// Toggle between the existing "Current" chart (hm-*) and the new trend chart (ft-*).
// Visibility is driven by a class on the .hm-card so it wins over the inline
// display styles that renderWeatherHeatmap() sets later.
function setMode(mode) {
  _mode = mode;
  const isTrend = mode === 'trend';

  const card = $('ft-btn-trend')?.closest('.hm-card');
  if (card) {
    card.classList.toggle('ft-show-trend', isTrend);
    card.classList.toggle('ft-show-current', !isTrend);
  }

  const ftWrap = $('ft-wrap');
  const hmWrap = $('hm-wrap');
  const stats = $('ft-stats');
  if (ftWrap) ftWrap.style.display = isTrend ? 'block' : 'none';
  if (hmWrap && !isTrend) hmWrap.style.display = 'block';
  if (stats) stats.style.display = isTrend ? 'flex' : 'none';

  const bCur = $('ft-btn-current');
  const bTr = $('ft-btn-trend');
  if (bCur) bCur.classList.toggle('on', !isTrend);
  if (bTr) bTr.classList.toggle('on', isTrend);

  if (isTrend) showTrend();
}

export function initForecastTrend() {
  const bCur = $('ft-btn-current');
  const bTr = $('ft-btn-trend');
  if (!bCur || !bTr) return;
  bCur.addEventListener('click', () => setMode('current'));
  bTr.addEventListener('click', () => setMode('trend'));
  setMode('trend'); // default view
}
