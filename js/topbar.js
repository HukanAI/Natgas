// js/topbar.js — Topbar updater
// Keeps the season card + KPI strip in sync with state.
// Called from bias.js, cot.js, production.js, weather.js after their data lands.

import { state } from './state.js';
import { getSeasonInfo } from './season.js';
import { ngfCurrent, ngfNext } from './contracts.js';
import { dbLog } from './debug.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function $(id) { return document.getElementById(id); }

function setText(id, txt) {
    const el = $(id);
    if (el && el.textContent !== txt) el.textContent = txt;
}

function setHTML(id, html) {
    const el = $(id);
    if (el && el.innerHTML !== html) el.innerHTML = html;
}

function setTone(id, tone /* 'up' | 'down' | 'neu' */) {
    const el = $(id);
    if (!el) return;
    el.classList.remove('up', 'down', 'neu');
    el.classList.add(tone);
}

function fmtSigned(n, digits) {
    digits = digits == null ? 2 : digits;
    return (n >= 0 ? '+' : '') + n.toFixed(digits);
}

function toneOf(n) {
    if (n > 0) return 'up';
    if (n < 0) return 'down';
    return 'neu';
}

// ── Season card ──────────────────────────────────────────────────────────────

function updateSeason() {
    const si = getSeasonInfo();
    if (!si) return;
    setText('season-ico', si.icon || '');
    // Show current season name next to title
    const curNameEl = document.getElementById('season-cur-name');
    if (curNameEl) {
        curNameEl.textContent = si.name || '—';
        curNameEl.style.color = si.col || 'var(--text)';
    }
    setText('season-next-ico', si.nxtIcon || '');

    // Build next season label: "Cooling Mon 01/06"
    // Next season starts the DAY AFTER current season ends → today + daysLeft + 1
    if (si.daysLeft != null) {
        const targetDate = new Date();
        targetDate.setDate(targetDate.getDate() + si.daysLeft + 1);
        const dayShort = targetDate.toLocaleString('en-GB', { weekday: 'short' });
        const dateShort = String(targetDate.getDate()).padStart(2, '0') + '/' + String(targetDate.getMonth() + 1).padStart(2, '0');
        setText('season-next-name', (si.nxtName || '') + ' ' + dayShort + ' ' + dateShort);
        setText('season-next-eta', 'in ' + (si.daysLeft + 1) + 'd');
    } else {
        setText('season-next-name', si.nxtName || '—');
        setText('season-next-eta', '—');
    }
}

// ── KPI: Front Month + Next Contract (mirror from bias DOM) ─────────────────
// These are already populated by bias.js into b-ngf-cur / b-ngf-cur-chg etc.
// We mirror them into kpi-ngf-* and colorize.

function colorizeFromText(id) {
    const el = $(id);
    if (!el) return;
    const t = (el.textContent || '').trim();
    el.classList.remove('up', 'down', 'neu');
    if (/^[+]|▲|↑/.test(t) && !/^[-−]/.test(t)) el.classList.add('up');
    else if (/^[-−]|▼|↓/.test(t)) el.classList.add('down');
    else el.classList.add('neu');
}

// Track last fetched prices in memory — used by updatePrices as source of truth
// Also exposed as window._topbarLastPrice for Market Overview fair price signals
const _lastPrice = { front: null, next: null };
window._topbarLastPrice = _lastPrice;

function mirrorOne(srcId, dstId, colorize) {
    const s = $(srcId), d = $(dstId);
    if (!s || !d) return;
    if (d.textContent !== s.textContent) d.textContent = s.textContent;
    if (colorize) colorizeFromText(dstId);
}

function updatePrices() {
    const elFront = $('kpi-ngf-cur');
    if (elFront) elFront.textContent = _lastPrice.front != null ? '$' + _lastPrice.front.toFixed(3) : $('b-ngf-cur')?.textContent || '—';

    const elNext = $('kpi-ngf-nxt');
    if (elNext) elNext.textContent = _lastPrice.next != null ? '$' + _lastPrice.next.toFixed(3) : $('b-ngf-nxt')?.textContent || '—';

    // Ticker codes (e.g. NGM26 / NGN26)
    try {
        const cur = ngfCurrent();
        const nxt = cur ? ngfNext(cur) : null;
        if (cur) setText('kpi-ngf-cur-ticker', cur.ticker || '');
        if (nxt) setText('kpi-ngf-nxt-ticker', nxt.ticker || '');
    } catch (_) {}
}

// ── Realized Volatility 20D ───────────────────────────────────────────────────
// Standard 20-day annualized RV from daily log returns of front month (NG=F).
// Note: includes rollover gaps — NG can legitimately move 25%+ in a day,
// so we don't filter outliers. RV may spike around roll dates; that's expected.

function calcRV20D() {
    // Use TA 1d data (front month, NG=F) if available
    const bars = state.taData && state.taData['1d'];
    if (!bars || bars.length < 22) return null;

    // Calculate log returns
    const returns = [];
    for (let i = 1; i < bars.length; i++) {
        const c0 = bars[i - 1].close;
        const c1 = bars[i].close;
        if (c0 > 0 && c1 > 0) returns.push(Math.log(c1 / c0));
    }
    if (returns.length < 20) return null;

    // Helper: compute annualized RV from a window of N daily returns
    function rvFromWindow(window) {
        const mean = window.reduce((a, b) => a + b, 0) / window.length;
        const variance = window.reduce((acc, r) => acc + (r - mean) ** 2, 0) / (window.length - 1);
        const stdev = Math.sqrt(variance);
        return stdev * Math.sqrt(252) * 100; // annualized in %
    }

    // Current RV20D = last 20 returns
    const currentWindow = returns.slice(-20);
    const current = rvFromWindow(currentWindow);

    // Compute historical RV20D for last 5y (or available) — rolling window
    const history = [];
    for (let i = 20; i <= returns.length; i++) {
        history.push(rvFromWindow(returns.slice(i - 20, i)));
    }

    // Percentile rank — what % of historical RV values were ≤ current
    history.sort((a, b) => a - b);
    let rank = 0;
    for (let i = 0; i < history.length; i++) {
        if (history[i] <= current) rank = i + 1;
        else break;
    }
    const pct = Math.round((rank / history.length) * 100);

    return { value: current, rank: pct, samples: history.length };
}

function updateRV20D() {
    const rv = calcRV20D();
    const valEl = $('rv20d-val');
    const rankEl = $('rv20d-rank');
    if (!valEl || !rankEl) return;
    if (!rv) {
        valEl.textContent = '—';
        rankEl.textContent = '—';
        return;
    }
    valEl.textContent = rv.value.toFixed(1) + '%';
    rankEl.textContent = 'rank ' + rv.rank + '/100';

    // Color rank: high vol = orange/red, low vol = blue, normal = white
    let rankColor = '#e6edf3';                       // normal — white
    if (rv.rank >= 80) rankColor = '#ff7b72';        // extreme high
    else if (rv.rank >= 60) rankColor = '#ffa657';   // elevated
    else if (rv.rank <= 20) rankColor = '#4493f8';   // low
    rankEl.style.color = rankColor;
}

// ── Sidebar API counters mirror ──────────────────────────────────────────────

function updateSidebarCounters() {
    const pairs = [
        ['st-api-count', 'sb-api-eia'],
        ['ngf-api-count','sb-api-ngf'],
        ['ta-api-count', 'sb-api-ta'],
        ['cot-api-count','sb-api-cot'],
        ['wx-api-count', 'sb-api-wx']
    ];
    pairs.forEach(p => mirrorOne(p[0], p[1]));
}

// ── Public API ────────────────────────────────────────────────────────────────

export function updateTopbar() {
    try { updateSeason(); }           catch(_) {}
    try { updatePrices(); }           catch(_) {}
    try { updateSidebarCounters(); }  catch(_) {}
}

function flashLine(lineId, oldVal, newVal) {
    const el = document.getElementById(lineId);
    if (!el) return;
    // Skip very first load (no previous price yet)
    if (oldVal === null) return;
    // Color: green = up, red = down, blue = unchanged (confirms refresh happened)
    const color = newVal > oldVal ? '#3fb950' : newVal < oldVal ? '#ff7b72' : '#4493f8';
    el.style.background = color;
    el.classList.remove('active');
    void el.offsetWidth;
    el.classList.add('active');
    setTimeout(() => el.classList.remove('active'), 5000);
}

// Returns close of the most recent daily bar that is NOT today's bar
// (i.e. yesterday's daily settlement close)
function previousDayClose(kind) {
    const bars = (kind === 'next' ? state.dailyHistory.next : state.dailyHistory.front) || [];
    if (bars.length === 0) return null;
    const now = new Date();
    const todayPrague = now.toLocaleDateString('sv-SE', { timeZone: 'Europe/Prague' });
    for (let i = bars.length - 1; i >= 0; i--) {
        const barDate = new Date(bars[i].ts).toLocaleDateString('sv-SE', { timeZone: 'Europe/Prague' });
        if (barDate !== todayPrague) return bars[i].close;
    }
    return null;
}

// Live NGF price refresh — update KPI strip immediately when quote arrives
document.addEventListener('ngf:price:refresh', function(e) {
    if (!e.detail) return;
    const { last, isNext } = e.detail;
    // Always use dailyHistory for prev close — more accurate than ngfFetchTwoDays.prev
    // Falls back to null if dailyHistory not yet loaded (change shows as — until loaded)
    const prev = previousDayClose(isNext ? 'next' : 'front');
    if (last == null) return;

    // Format change string from prev close
    function fmtChange(cur, prv) {
        if (prv == null || prv === 0) return null;
        const chg = cur - prv;
        const pct = chg / prv * 100;
        const sign = chg >= 0 ? '+' : '';
        return sign + chg.toFixed(3) + ' (' + sign + pct.toFixed(2) + '%)';
    }

    if (!isNext) {
        const oldVal = _lastPrice.front;
        _lastPrice.front = last;
        const elVal = document.getElementById('kpi-ngf-cur');
        const elB   = document.getElementById('b-ngf-cur');
        if (elVal) elVal.textContent = '$' + last.toFixed(3);
        if (elB)   elB.textContent   = '$' + last.toFixed(3);
        flashLine('kpi-ngf-cur-flash', oldVal, last);
        // Update chg
        const chgStr = fmtChange(last, prev);
        if (chgStr) {
            const elChg = document.getElementById('kpi-ngf-cur-chg');
            if (elChg) { elChg.textContent = chgStr; colorizeFromText('kpi-ngf-cur-chg'); }
            const elBChg = document.getElementById('b-ngf-cur-chg');
            if (elBChg) elBChg.innerHTML = '<span style="color:' + (last >= prev ? '#3fb950' : '#ff7b72') + '">' + chgStr + '</span>';
        }
    } else {
        const oldVal = _lastPrice.next;
        _lastPrice.next = last;
        const elVal = document.getElementById('kpi-ngf-nxt');
        const elB   = document.getElementById('b-ngf-nxt');
        if (elVal) elVal.textContent = '$' + last.toFixed(3);
        if (elB)   elB.textContent   = '$' + last.toFixed(3);
        flashLine('kpi-ngf-nxt-flash', oldVal, last);
        // Update chg
        const chgStr = fmtChange(last, prev);
        if (chgStr) {
            const elChg = document.getElementById('kpi-ngf-nxt-chg');
            if (elChg) { elChg.textContent = chgStr; colorizeFromText('kpi-ngf-nxt-chg'); }
            const elBChg = document.getElementById('b-ngf-nxt-chg');
            if (elBChg) elBChg.innerHTML = '<span style="color:' + (last >= prev ? '#3fb950' : '#ff7b72') + '">' + chgStr + '</span>';
        }
    }
});

// When dailyHistory finishes loading, re-emit synthetic refresh to update the change display
document.addEventListener('daily:history:loaded', function() {
    if (_lastPrice.front != null) {
        document.dispatchEvent(new CustomEvent('ngf:price:refresh', { detail: { last: _lastPrice.front, prev: null, isNext: false } }));
    }
    if (_lastPrice.next != null) {
        document.dispatchEvent(new CustomEvent('ngf:price:refresh', { detail: { last: _lastPrice.next, prev: null, isNext: true } }));
    }
});

let _started = false;
export function startTopbarTicker() {
    if (_started) return;
    _started = true;
    setInterval(updateTopbar, 1500);
    document.addEventListener('DOMContentLoaded', updateTopbar);
}
