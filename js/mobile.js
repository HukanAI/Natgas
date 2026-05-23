// mobile.js — Mobile UI controller
// Handles: hamburger menu, bottom navigation, mobile data rendering

import { state } from './state.js';
import { getSeasonInfo } from './season.js';
import { t212RollDate } from './contracts.js';
import { dbLog } from './debug.js';

// ── Device detection ──────────────────────────────────────────────────────────
export const isMobile = () => window.innerWidth <= 768;

// ── Hamburger menu ────────────────────────────────────────────────────────────
export function initMobileDrawer() {
    const hamburger = document.getElementById('mob-hamburger');
    const drawer    = document.getElementById('mob-drawer');
    const overlay   = document.getElementById('mob-overlay');
    const closeBtn  = document.getElementById('mob-drawer-close');
    if (!hamburger || !drawer) return;

    const openDrawer  = () => { drawer.classList.add('open'); overlay.classList.add('open'); };
    const closeDrawer = () => { drawer.classList.remove('open'); overlay.classList.remove('open'); };

    hamburger.addEventListener('click', openDrawer);
    closeBtn?.addEventListener('click', closeDrawer);
    overlay.addEventListener('click', closeDrawer);

    // Drawer nav items → switch page and close
    drawer.querySelectorAll('[data-mob-tab]').forEach(btn => {
        btn.addEventListener('click', () => {
            switchPage(btn.dataset.mobTab);
            closeDrawer();
        });
    });
}

// ── Bottom navigation + page switching ────────────────────────────────────────
let _currentPage = 'overview';

export function switchPage(name) {
    _currentPage = name;
    // Hide all pages
    document.querySelectorAll('.mob-page').forEach(p => p.classList.remove('active'));
    // Show target page
    const page = document.getElementById('mob-page-' + name);
    if (page) {
        page.classList.add('active');
        // Scroll to top when switching
        page.scrollTop = 0;
    }
    // Update bottom nav active state
    document.querySelectorAll('.mob-nav-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mobTab === name);
    });
    // Re-render charts if switching to charts tab
    if (name === 'charts') renderMobileChart(_activeTF);
    // Render news if switching to news tab
    if (name === 'news') renderMobileNews();
}

export function initMobileNav() {
    document.querySelectorAll('.mob-nav-btn').forEach(btn => {
        btn.addEventListener('click', () => switchPage(btn.dataset.mobTab));
    });
    // More page items
    document.querySelectorAll('[data-mob-tab-goto]').forEach(item => {
        item.addEventListener('click', () => switchPage(item.dataset.mobTabGoto));
    });
    // Back buttons
    ['futures', 'storage', 'weather', 'cot', 'production'].forEach(name => {
        const btn = document.getElementById('mob-back-' + name);
        if (btn) btn.addEventListener('click', () => switchPage('more'));
    });
}

// ── Mobile Overview rendering ─────────────────────────────────────────────────

export function renderMobileOverview() {
    if (!isMobile()) return;
    renderMobileSentiment();
    renderMobileFairPrice();
    renderMobileSignals();
    renderMobileStorage();
    renderMobileCountdowns();
}

function renderMobileSentiment() {
    const signals = window._ovSignals;
    if (!signals) return;
    const total = Object.values(signals).reduce((s, sig) => s + (sig.score || 0), 0);

    let label, col;
    if (total >= 3.5)       { label = 'Bullish';          col = '#3fb950'; }
    else if (total >= 2.0)  { label = 'Slightly Bullish'; col = '#7ec97f'; }
    else if (total > -2.0)  { label = 'Neutral';          col = '#e6edf3'; }
    else if (total > -3.5)  { label = 'Slightly Bearish'; col = '#ffb085'; }
    else                    { label = 'Bearish';           col = '#ff7b72'; }

    const el = document.getElementById('mob-sentiment-label');
    const sc = document.getElementById('mob-sentiment-score');
    if (el) { el.textContent = label; el.style.color = col; }
    if (sc) sc.textContent = 'score ' + (total >= 0 ? '+' : '') + total.toFixed(1) + ' / 6.5';
}

function renderMobileSignals() {
    const signals = window._ovSignals;
    const grid = document.getElementById('mob-signals-grid');
    if (!signals || !grid) return;

    const colOf = col => col === '#9ba3ad' ? '#e6edf3' : col;
    grid.innerHTML = Object.entries(signals).map(([, sig]) => `
        <div class="mob-signal-row">
            <div class="mob-signal-name">${sig.name}</div>
            <div class="mob-signal-val" style="color:${colOf(sig.col)}">${sig.label}</div>
        </div>
    `).join('');
}

function renderMobileFairPrice() {
    // Mirror from desktop Fair Price cells
    const pairs = [
        ['b-fp0',  'mob-fp-now',  'b-fp0-front-status',  'mob-fp-now-status'],
        ['b-fp7',  'mob-fp-7',    'b-fp7-front-status',  'mob-fp-7-status'],
        ['b-fp14', 'mob-fp-14',   'b-fp14-front-status', 'mob-fp-14-status'],
        ['b-fp21', 'mob-fp-21',   'b-fp21-front-status', 'mob-fp-21-status'],
    ];
    pairs.forEach(([srcId, valId, statusSrcId, statusDestId]) => {
        const srcEl = document.getElementById(srcId);
        const statusSrc = document.getElementById(statusSrcId);
        const valEl = document.getElementById(valId);
        const statusEl = document.getElementById(statusDestId);
        if (srcEl && valEl) valEl.textContent = srcEl.textContent;
        if (statusSrc && statusEl) {
            statusEl.textContent = statusSrc.textContent;
            statusEl.style.color = statusSrc.style.color;
        }
    });
}

function renderMobileStorage() {
    const sd = state.stStorageData;
    if (!sd || !sd.length) return;
    const lat = sd[sd.length - 1];
    const valEl = document.getElementById('mob-storage-val');
    const detEl = document.getElementById('mob-storage-detail');
    if (valEl) { valEl.textContent = Math.round(lat.value).toLocaleString() + ' Bcf'; valEl.style.color = 'var(--text)'; }
    if (detEl) detEl.textContent = lat.date;
}

function renderMobileCountdowns() {
    // Mirror EIA date/eta from topbar elements
    const mirror = (srcId, destId) => {
        const src = document.getElementById(srcId);
        const dest = document.getElementById(destId);
        if (src && dest) dest.textContent = src.textContent;
    };
    mirror('eia-kpi-date', 'mob-eia-date');
    mirror('eia-kpi-eta',  'mob-eia-eta');
    mirror('roll-kpi-date','mob-roll-date');
    mirror('roll-kpi-eta', 'mob-roll-eta');
    mirror('cot-kpi-date', 'mob-cot-date');
    mirror('cot-kpi-eta',  'mob-cot-eta');

    // Season
    const si = getSeasonInfo();
    if (si) {
        const sv = document.getElementById('mob-season-val');
        const sn = document.getElementById('mob-season-next');
        if (sv) { sv.textContent = si.icon + ' ' + si.name; sv.style.color = si.col; }
        if (sn) sn.textContent = si.daysLeft + 'd → ' + (si.nxtIcon || '') + ' ' + (si.nxtName || '');
    }
}

// ── Mobile Charts ─────────────────────────────────────────────────────────────
let _activeTF = '1d';
let _mobPriceChart = null;
let _mobRsiChart = null;
import('./charts.js').catch(() => {});

export function initMobileCharts() {
    document.querySelectorAll('.mob-ta-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.mob-ta-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            _activeTF = tab.dataset.tf;
            renderMobileChart(_activeTF);
        });
    });
}

export function renderMobileChart(tf) {
    if (!isMobile() || _currentPage !== 'charts') return;
    const candles = state.taData[tf];
    if (!candles || !candles.length) {
        const sub = document.getElementById('mob-chart-sub');
        if (sub) sub.textContent = 'Loading ' + tf + '…';
        return;
    }

    // Update subtitle
    const sub = document.getElementById('mob-chart-sub');
    if (sub) {
        const first = new Date(candles[0].ts);
        const last  = new Date(candles[candles.length - 1].ts);
        const fmt = d => d.getUTCDate() + '/' + (d.getUTCMonth()+1) + '/' + d.getUTCFullYear();
        sub.textContent = tf.toUpperCase() + ' · ' + fmt(first) + ' – ' + fmt(last) + ' · ' + candles.length + ' bars';
    }

    const canvas = document.getElementById('mob-price-canvas');
    const rsiCanvas = document.getElementById('mob-rsi-canvas');
    if (!canvas || typeof Chart === 'undefined') return;

    // Destroy existing charts
    if (_mobPriceChart) { _mobPriceChart.destroy(); _mobPriceChart = null; }
    if (_mobRsiChart) { _mobRsiChart.destroy(); _mobRsiChart = null; }

    const labels = candles.map(c => {
        const d = new Date(c.ts);
        return d.getUTCDate() + '/' + (d.getUTCMonth()+1);
    });
    const closes = candles.map(c => c.close);

    // Simple line chart for mobile (performance)
    const textCol = '#6e7681';
    const gridCol = 'rgba(255,255,255,0.04)';

    // EMA helper
    function calcEMA(data, period) {
        const k = 2 / (period + 1);
        const ema = [data[0]];
        for (let i = 1; i < data.length; i++) ema.push(data[i] * k + ema[i-1] * (1 - k));
        return ema;
    }
    const ema50  = calcEMA(closes, 50);
    const ema200 = calcEMA(closes, 200);

    _mobPriceChart = new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
            labels,
            datasets: [
                { data: closes, borderColor: '#e6edf3', borderWidth: 1.5, pointRadius: 0, fill: false, order: 1 },
                { data: ema50,  borderColor: '#e3b341', borderWidth: 1,   pointRadius: 0, fill: false, order: 2 },
                { data: ema200, borderColor: '#ff7b72', borderWidth: 1,   pointRadius: 0, fill: false, order: 3 },
            ]
        },
        options: {
            responsive: true, maintainAspectRatio: false, animation: { duration: 0 },
            interaction: { mode: 'index', intersect: false },
            plugins: { legend: { display: false }, tooltip: {
                backgroundColor: '#1c2128', titleColor: '#e6edf3', bodyColor: '#9ba3ad',
                callbacks: { label: c => c.datasetIndex === 0 ? '$' + c.parsed.y.toFixed(3) : null,
                             filter: c => c.datasetIndex === 0 }
            }},
            scales: {
                x: { grid: { color: gridCol }, ticks: { color: textCol, font: { size: 8 }, maxTicksLimit: 6, autoSkip: true }},
                y: { position: 'right', grid: { color: gridCol }, ticks: { color: textCol, font: { size: 8 }, callback: v => '$' + v.toFixed(2) }}
            }
        }
    });

    // RSI
    function calcRSI(data, period) {
        const rsi = new Array(period).fill(null);
        let gains = 0, losses = 0;
        for (let i = 1; i <= period; i++) {
            const d = data[i] - data[i-1];
            if (d > 0) gains += d; else losses -= d;
        }
        let avgG = gains / period, avgL = losses / period;
        rsi.push(avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL));
        for (let i = period + 1; i < data.length; i++) {
            const d = data[i] - data[i-1];
            avgG = (avgG * (period - 1) + Math.max(0, d)) / period;
            avgL = (avgL * (period - 1) + Math.max(0, -d)) / period;
            rsi.push(avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL));
        }
        return rsi;
    }
    const rsiData = calcRSI(closes, 14);

    _mobRsiChart = new Chart(rsiCanvas.getContext('2d'), {
        type: 'line',
        data: {
            labels,
            datasets: [{ data: rsiData, borderColor: '#4493f8', borderWidth: 1.2, pointRadius: 0, fill: false }]
        },
        options: {
            responsive: true, maintainAspectRatio: false, animation: { duration: 0 },
            plugins: { legend: { display: false }, tooltip: {
                backgroundColor: '#1c2128', titleColor: '#e6edf3', bodyColor: '#9ba3ad',
                callbacks: { label: c => 'RSI: ' + (c.parsed.y?.toFixed(1) || '—') }
            }},
            scales: {
                x: { display: false },
                y: { position: 'right', min: 0, max: 100, grid: { color: gridCol },
                    ticks: { color: textCol, font: { size: 8 }, callback: v => v }}
            }
        }
    });
}

// ── Mobile News ───────────────────────────────────────────────────────────────
export function renderMobileNews(items) {
    const feed = document.getElementById('mob-news-feed');
    if (!feed) return;
    const list = items || window._mobNewsItems;
    if (!list || !list.length) {
        feed.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:20px;text-align:center">No news available</div>';
        return;
    }
    window._mobNewsItems = list;

    function relTime(date) {
        if (!date || isNaN(date.getTime())) return '';
        const diff = (Date.now() - date.getTime()) / 1000;
        if (diff < 60) return Math.floor(diff) + 's';
        if (diff < 3600) return Math.floor(diff / 60) + 'm';
        if (diff < 86400) return Math.floor(diff / 3600) + 'h';
        return Math.floor(diff / 86400) + 'd';
    }

    feed.innerHTML = list.map(item => `
        <a href="${item.link}" target="_blank" rel="noopener" class="mob-news-item">
            <div class="mob-news-meta">
                <span class="mob-news-time">${relTime(item.pubDate)}</span>
                ${item.source ? `<span class="mob-news-source">· ${item.source}</span>` : ''}
            </div>
            <div class="mob-news-title">${item.title}</div>
        </a>
    `).join('');
}

// ── Service worker registration ───────────────────────────────────────────────
export function registerSW() {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/Natgas/service-worker.js').then(reg => {
            dbLog('SW registered: ' + reg.scope, 'ok');
        }).catch(err => {
            dbLog('SW registration failed: ' + err.message, 'warn');
        });
    }
}

// ── Init ─────────────────────────────────────────────────────────────────────
export function initMobile() {
    if (!isMobile()) return;
    initMobileDrawer();
    initMobileNav();
    initMobileCharts();
    registerSW();
    dbLog('Mobile UI initialized', 'ok');
}
