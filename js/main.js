// js/main.js — entry point: init + all event wiring
import { state } from './state.js';
import { tickClock, setUpdated } from './utils.js';
import { dbLog, renderDbg } from './debug.js';
import { ngfCurrent, ngfLogContracts, ngfFetchQuote, ngfNext, ngfFetchTwoDays } from './contracts.js';
import { resetZoom } from './charts.js';

import { wxLoadAll, wxForceRefresh, wxSetWindow, exportHistoricalWeekly } from './weather.js';
import { stLoadAll, stSetWindow, stUpdateSubtitles, stRenderStorChart, stRenderDevChart, stRenderInjChart } from './storage.js';
import { peLoadAll, peSetWindow, peRenderOne } from './production.js';
import { ngfRenderChart, ngfUpdateSubtitle, ngfSetWindow, ngfSetChartType, fcLoad, fcToggle, fcSilentRefresh } from './futures.js';
import { taLoadAll, taRefresh, taSilentRefresh, taSetType, taResetZoomTF } from './technical.js';
import { cotLoadAll, cotSetWindow, cotShowHelp, cotHideHelp, cotExportNet, cotExportLS, cotExportProd, cotExportSwap, cotExportChg } from './cot.js';
import { renderBiasCard } from './bias.js';
import { stExportStorage, stExportDev, stExportNgf, stExportInj, peExport, peExportSupply, exportWxReg, exportWxTemp, exportWxDem } from './exports.js';
import { startTopbarTicker, updateTopbar } from './topbar.js';
import { startWidgetTicker, initOverviewEvents, updateAllWidgets, updateFuturesTimestamp } from './widgets.js';

// ── Clock ─────────────────────────────────────────────────────────────────────
tickClock();
setInterval(tickClock, 1000);

// ── Topbar (season card + KPIs) ──────────────────────────────────────────────
startTopbarTicker();

// ── Widgets (EIA banner etc.) ─────────────────────────────────────────────────
startWidgetTicker();
initOverviewEvents();

// ── NGF live price refresh — every 60s (lightweight quote, not full history) ──
// Yahoo Finance unofficial API, no published rate limit.
// 1 req/min = 60/hour — well within safe usage. Uses 1-day/1-min bars (~KB).
async function refreshNGFPrice() {
  const cur = ngfCurrent();
  const nxt = cur ? ngfNext(cur) : null;
  if (!cur) return;
  try {
    const [qFront, qNext] = await Promise.all([
      ngfFetchTwoDays(cur.ticker, true).catch(e => { dbLog('NGF front fail: ' + e.message, 'warn'); return null; }),
      nxt ? ngfFetchTwoDays(nxt.ticker, false).catch(e => { dbLog('NGF next fail: ' + e.message, 'warn'); return null; }) : Promise.resolve(null),
    ]);
    if (qFront && qNext) {
      dbLog('NGF refresh: front $' + qFront.last.toFixed(3) + ' · next $' + qNext.last.toFixed(3), 'ok');
    } else if (qFront) {
      dbLog('NGF refresh: front $' + qFront.last.toFixed(3), 'ok');
    }
    if (qFront) {
      document.dispatchEvent(new CustomEvent('ngf:price:refresh', { detail: { last: qFront.last, prev: qFront.prev, isNext: false } }));
    }
    if (qNext) {
      state.nextContractPrice = qNext.last;
      document.dispatchEvent(new CustomEvent('ngf:price:refresh', { detail: { last: qNext.last, prev: qNext.prev, isNext: true } }));
    }
  } catch(e) {
    dbLog('NGF auto-refresh failed: ' + e.message, 'warn');
  }
}
setInterval(refreshNGFPrice, 60_000);

// ── TA auto-refresh every 2.5 minutes ────────────────────────────────────────
setTimeout(function() {
  setInterval(function() {
    taSilentRefresh().catch(function(e) { dbLog('TA auto-refresh: ' + e.message, 'warn'); });
  }, 150_000);
}, 30_000);

// ── Futures curve refresh every 15 minutes (12 req/cycle = 48 req/hour) ──────
setTimeout(function() {
  setInterval(function() {
    fcSilentRefresh().catch(function(e) { dbLog('FC auto-refresh: ' + e.message, 'warn'); });
  }, 900_000); // 15 minutes
}, 60_000); // first refresh 60s after start

// ── DOM ready ─────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function() {

  // ── Tab switching ───────────────────────────────────────────────────────────
  document.querySelectorAll('.tab-btn[data-tab]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      const id = this.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.remove('on'); });
      document.querySelectorAll('.tab-panel').forEach(function(p) { p.classList.remove('on'); });
      this.classList.add('on');
      document.getElementById('panel-' + id).classList.add('on');
    });
  });

  // ── Global refresh ──────────────────────────────────────────────────────────
  document.getElementById('btn-refresh').addEventListener('click', function() {
    dbLog('Global refresh', 'info');
    wxForceRefresh();
    stLoadAll();
    peLoadAll();
    fcLoad();
    taRefresh();
  });

  // ── Debug console ───────────────────────────────────────────────────────────
  document.getElementById('dbg-header').addEventListener('click', function() {
    const b = document.getElementById('dbg-body');
    const a = document.getElementById('dbg-arrow');
    const open = b.style.display === 'none';
    b.style.display = open ? 'block' : 'none';
    a.style.transform = open ? 'rotate(90deg)' : '';
  });
  document.getElementById('dbg-clear-btn').addEventListener('click', function(e) {
    e.stopPropagation();
    state.dbgEntries = [];
    renderDbg();
  });

  // ── Technical Analysis ──────────────────────────────────────────────────────
  document.getElementById('ta-btn-candle').addEventListener('click', function() { taSetType('candle'); });
  document.getElementById('ta-btn-line').addEventListener('click', function() { taSetType('line'); });
  document.getElementById('ta-refresh-btn').addEventListener('click', taRefresh);
  ['5m','15m','1h','4h','1d','1w'].forEach(function(tf) {
    const btn = document.getElementById('ta-reset-' + tf);
    if (btn) btn.addEventListener('click', function() { taResetZoomTF(tf); });
  });

  // ── Futures / NGF ───────────────────────────────────────────────────────────
  document.getElementById('fc-header').addEventListener('click', fcToggle);
  document.getElementById('ngf-btn-line').addEventListener('click', function() { ngfSetChartType('line'); });
  document.getElementById('ngf-btn-candle').addEventListener('click', function() { ngfSetChartType('candle'); });
  document.querySelectorAll('[data-ngf-w]').forEach(function(b) {
    b.addEventListener('click', function() { ngfSetWindow(this.dataset.ngfW); });
  });

  // ── Storage windows ─────────────────────────────────────────────────────────
  document.querySelectorAll('[data-st-w]').forEach(function(b) {
    b.addEventListener('click', function() { stSetWindow(this.dataset.stW); });
  });

  // ── Production windows ──────────────────────────────────────────────────────
  document.querySelectorAll('[data-pe-w]').forEach(function(b) {
    b.addEventListener('click', function() { peSetWindow(this.dataset.peW); });
  });

  // ── Weather windows ─────────────────────────────────────────────────────────
  document.querySelectorAll('[data-wx-w]').forEach(function(b) {
    b.addEventListener('click', function() { wxSetWindow(this.dataset.wxW); });
  });
  document.getElementById('wx-hist-btn').addEventListener('click', exportHistoricalWeekly);

  // ── COT ─────────────────────────────────────────────────────────────────────
  document.querySelectorAll('[data-cot-w]').forEach(function(b) {
    b.addEventListener('click', function() { cotSetWindow(this.dataset.cotW); });
  });
  document.getElementById('cot-refresh-btn').addEventListener('click', function() {
    state.cotData = [];
    cotLoadAll();
  });
  document.querySelectorAll('[data-cot-help]').forEach(function(btn) {
    btn.addEventListener('click', function() { cotShowHelp(this.dataset.cotHelp); });
  });
  document.getElementById('cot-popup-close').addEventListener('click', cotHideHelp);
  document.getElementById('cot-popup-overlay').addEventListener('click', function(e) {
    if (e.target === e.currentTarget) cotHideHelp();
  });
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') cotHideHelp();
  });

  // ── Zoom reset ──────────────────────────────────────────────────────────────
  document.querySelectorAll('[data-zoom]').forEach(function(b) {
    b.addEventListener('click', function() { resetZoom(this.dataset.zoom); });
  });

  // ── Exports ─────────────────────────────────────────────────────────────────
  document.getElementById('btn-export-ngf').addEventListener('click', stExportNgf);
  document.getElementById('btn-export-storage').addEventListener('click', stExportStorage);
  document.getElementById('btn-export-dev').addEventListener('click', stExportDev);
  document.getElementById('btn-export-inj').addEventListener('click', stExportInj);
  document.getElementById('btn-export-supply').addEventListener('click', peExportSupply);
  document.getElementById('btn-export-wx-reg').addEventListener('click', exportWxReg);
  document.getElementById('btn-export-wx-temp').addEventListener('click', exportWxTemp);
  document.getElementById('btn-export-wx-dem').addEventListener('click', exportWxDem);
  document.getElementById('btn-export-cot-net').addEventListener('click', cotExportNet);
  document.getElementById('btn-export-cot-ls').addEventListener('click', cotExportLS);
  document.getElementById('btn-export-cot-prod').addEventListener('click', cotExportProd);
  document.getElementById('btn-export-cot-swap').addEventListener('click', cotExportSwap);
  document.getElementById('btn-export-cot-chg').addEventListener('click', cotExportChg);
  document.querySelectorAll('[data-pe-export]').forEach(function(b) {
    b.addEventListener('click', function() { peExport(this.dataset.peExport); });
  });

  // ── Cross-module events ─────────────────────────────────────────────────────
  document.addEventListener('storage:loaded', renderBiasCard);
  document.addEventListener('weather:loaded', renderBiasCard);
  document.addEventListener('ngf:loaded', function() {
    ngfUpdateSubtitle();
    ngfRenderChart();
  });

  // Re-render overview signals whenever any data source finishes loading
  // Each event fires after its respective async fetch completes
  function refreshOverview() {
    try { updateAllWidgets(); } catch(e) { dbLog('overview refresh: ' + e.message, 'warn'); }
  }
  document.addEventListener('storage:loaded',       refreshOverview);
  document.addEventListener('weather:loaded',       refreshOverview);
  document.addEventListener('ngf:loaded',           refreshOverview);
  document.addEventListener('cot:loaded',           refreshOverview);
  document.addEventListener('pe:loaded',            refreshOverview);
  document.addEventListener('futures:loaded',       refreshOverview);
  document.addEventListener('nextcontract:loaded',  refreshOverview);

  // ── Auto weather refresh on new hour ────────────────────────────────────────
  let lastWxSlot = (function() {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), n.getDate(), n.getHours()).getTime();
  })();

  setInterval(function() {
    const n = new Date();
    const cur = new Date(n.getFullYear(), n.getMonth(), n.getDate(), n.getHours()).getTime();
    if (cur !== lastWxSlot) {
      lastWxSlot = cur;
      dbLog('New hour — refreshing weather...', 'info');
      wxForceRefresh();
    }
    try {
      const raw = localStorage.getItem('ng_wx_api_v2');
      const count = raw ? (JSON.parse(raw).count || 0) : 0;
      document.getElementById('wx-api-count').textContent = count;
    } catch(e) {}
  }, 60000);

  // ── INIT ────────────────────────────────────────────────────────────────────
  dbLog('NatGas Dashboard — init', 'info');
  ngfLogContracts();

  const cur = ngfCurrent();
  dbLog('Front month: ' + (cur ? cur.label + ' [' + cur.ticker + ']' : 'NULL'), cur ? 'ok' : 'error');

  renderBiasCard();
  ngfUpdateSubtitle();
  stUpdateSubtitles();

  wxLoadAll(false);
  stLoadAll();
  peLoadAll();
  fcLoad();
  taLoadAll();
  cotLoadAll();
});
