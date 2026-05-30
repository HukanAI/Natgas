// js/forecast-trend.js
// "Forecast trend" view for the Weather Demand card.
// Loads data/history.json (hourly snapshots written by the GitHub Actions bot),
// keeps the last 7 days, and draws how the summed 16-day Demand outlook has
// evolved over time. All timestamps are shown in Prague time (Europe/Prague),
// regardless of the viewer's location.

const HISTORY_URL = 'data/history.json';
const WINDOW_DAYS = 7;
const DEM_COLOR = '#a371f7';

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

async function loadHistory() {
  const res = await fetch(HISTORY_URL + '?t=' + Date.now());
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  // Keep only the last 7 days of snapshots.
  const cutoff = Date.now() - WINDOW_DAYS * 86400000;
  return data.filter(r => r && r.ts && new Date(r.ts).getTime() >= cutoff);
}

function renderTrendChart(records) {
  const canvas = $('ft-canvas');
  const spin = $('ft-spin');
  const wrap = $('ft-wrap');
  if (!canvas || !wrap) return;

  if (!records.length) {
    if (spin) {
      spin.style.display = 'flex';
      spin.textContent = 'Not enough data yet — collection runs hourly.';
    }
    wrap.style.display = 'none';
    return;
  }

  if (spin) spin.style.display = 'none';
  wrap.style.display = 'block';

  const labels = records.map(r => pragueLabel(r.ts));
  const dem = records.map(r => r.dem);

  const textCol = getComputedStyle(document.documentElement).getPropertyValue('--text3').trim() || '#6e7681';
  const gridCol = getComputedStyle(document.documentElement).getPropertyValue('--border').trim() || '#1f242c';

  // Subtitle: show the forecast window the latest snapshot covers.
  const last = records[records.length - 1];
  const sub = $('ft-sub');
  if (sub && last && last.from && last.to) {
    sub.textContent = 'Outlook ' + fmtDate(last.from) + ' – ' + fmtDate(last.to) + ' · last 7 days · Prague time';
  }

  if (_trendChart) { _trendChart.destroy(); _trendChart = null; }

  _trendChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Demand (16d sum)',
        data: dem,
        borderColor: DEM_COLOR,
        backgroundColor: DEM_COLOR,
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 4,
        tension: 0.25,
        fill: false,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1c2128',
          borderColor: 'rgba(255,255,255,0.08)',
          borderWidth: 1,
          titleColor: '#e6edf3',
          bodyColor: '#9ba3ad',
          padding: 10,
          callbacks: {
            label: ctx => 'Demand: ' + (ctx.parsed.y != null ? ctx.parsed.y.toFixed(1) : 'N/A'),
          },
        },
      },
      scales: {
        x: {
          grid: { color: gridCol },
          ticks: {
            color: textCol,
            font: { size: 10, family: 'var(--mono, monospace)' },
            maxRotation: 0, autoSkip: true, maxTicksLimit: 8,
          },
        },
        y: {
          grid: { color: gridCol },
          title: {
            display: true, text: 'Demand (16d sum)', color: textCol,
            font: { size: 10, family: 'var(--mono, monospace)', weight: '600' },
            padding: { bottom: 4 },
          },
          ticks: { color: textCol, font: { size: 10, family: 'var(--mono, monospace)' } },
        },
      },
    },
  });
}

// "2026-05-30" -> "30.5."
function fmtDate(iso) {
  const p = (iso || '').split('-');
  if (p.length === 3) return parseInt(p[2], 10) + '.' + parseInt(p[1], 10) + '.';
  return iso;
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
  }
}

// Toggle between the existing "Current" chart (hm-*) and the new trend chart (ft-*).
function setMode(mode) {
  _mode = mode;
  const isTrend = mode === 'trend';

  // Existing current-view elements
  const hmWrap = $('hm-wrap');
  const hmSpin = $('hm-spin');
  // New trend-view elements
  const ftWrap = $('ft-wrap');
  const ftSpin = $('ft-spin');

  if (hmWrap) hmWrap.style.display = isTrend ? 'none' : 'block';
  if (hmSpin && isTrend) hmSpin.style.display = 'none';
  if (ftWrap) ftWrap.style.display = isTrend ? 'block' : 'none';
  if (ftSpin && !isTrend) ftSpin.style.display = 'none';

  // Button active states
  const bCur = $('ft-btn-current');
  const bTr = $('ft-btn-trend');
  if (bCur) bCur.classList.toggle('on', !isTrend);
  if (bTr) bTr.classList.toggle('on', isTrend);

  if (isTrend) showTrend();
}

export function initForecastTrend() {
  const bCur = $('ft-btn-current');
  const bTr = $('ft-btn-trend');
  if (!bCur || !bTr) return; // markup not present yet
  bCur.addEventListener('click', () => setMode('current'));
  bTr.addEventListener('click', () => setMode('trend'));
  setMode('trend'); // default view
}
