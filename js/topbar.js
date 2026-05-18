// js/topbar.js — Topbar updater
// Keeps the season card + KPI strip in sync with state.
// Called from bias.js, cot.js, production.js, weather.js after their data lands.

import { state } from './state.js';
import { getSeasonInfo } from './season.js';
import { peCalcSupply } from './production.js';

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
    setText('season-name', si.name || '—');
    setText('season-next-ico', si.nxtIcon || '');
    setText('season-next-name', si.nxtName || '—');
    const eta = si.daysLeft != null ? 'in ' + si.daysLeft + 'd' : '—';
    setText('season-next-eta', eta);

    // Subtle accent color on season-card (left border via inline style)
    const card = $('season-card');
    if (card && si.col) {
        card.style.boxShadow = 'inset 3px 0 0 ' + si.col;
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
    // Always use _lastPrice as source of truth once set — never let mirrorOne overwrite with stale DOM value
    const elFront = $('kpi-ngf-cur');
    if (elFront) elFront.textContent = _lastPrice.front != null ? '$' + _lastPrice.front.toFixed(3) : $('b-ngf-cur')?.textContent || '—';
    mirrorOne('b-ngf-cur-chg', 'kpi-ngf-cur-chg', true);

    const elNext = $('kpi-ngf-nxt');
    if (elNext) elNext.textContent = _lastPrice.next != null ? '$' + _lastPrice.next.toFixed(3) : $('b-ngf-nxt')?.textContent || '—';
    mirrorOne('b-ngf-nxt-chg', 'kpi-ngf-nxt-chg', true);
}

// ── KPI: Total Supply (latest Bcf/d + M/M + Y/Y) ─────────────────────────────

function updateSupply() {
    const supply = peCalcSupply();
    if (!supply || !supply.length) return;

    const n = supply.length;
    const cur = supply[n - 1];
    const prevMo = n >= 2 ? supply[n - 2] : null;
    const prevYr = n >= 13 ? supply[n - 13] : null;

    setText('kpi-supply', cur.value.toFixed(1) + ' Bcf/d');

    if (prevMo) {
        const dM = cur.value - prevMo.value;
        const pM = prevMo.value !== 0 ? (dM / prevMo.value * 100) : 0;
        setHTML('kpi-supply-mom',
            '<span class="kpi-chg-lbl">M/M</span>' + fmtSigned(dM, 2) + ' (' + fmtSigned(pM, 1) + '%)');
        setTone('kpi-supply-mom', toneOf(dM));
    }
    if (prevYr) {
        const dY = cur.value - prevYr.value;
        const pY = prevYr.value !== 0 ? (dY / prevYr.value * 100) : 0;
        setHTML('kpi-supply-yoy',
            '<span class="kpi-chg-lbl">Y/Y</span>' + fmtSigned(dY, 2) + ' (' + fmtSigned(pY, 1) + '%)');
        setTone('kpi-supply-yoy', toneOf(dY));
    }
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
    try { updateSupply(); }           catch(_) {}
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

// Live NGF price refresh — update KPI strip immediately when quote arrives
document.addEventListener('ngf:price:refresh', function(e) {
    if (!e.detail) return;
    const { last, prev, isNext } = e.detail;
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

let _started = false;
export function startTopbarTicker() {
    if (_started) return;
    _started = true;
    setInterval(updateTopbar, 1500);
    document.addEventListener('DOMContentLoaded', updateTopbar);
}
