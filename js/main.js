// js/main.js — entry point: init + all event wiring
import { state } from './state.js';
import { tickClock, setUpdated } from './utils.js';

// Expose state on window for browser console debugging
if (typeof window !== 'undefined') window.state = state;
import { dbLog, renderDbg } from './debug.js';
import { ngfCurrent, ngfLogContracts, ngfFetchQuote, ngfNext, ngfFetchTwoDays, fetchDailyHistory } from './contracts.js';
import { resetZoom } from './charts.js';

import { wxLoadAll, wxForceRefresh, wxSetWindow, exportHistoricalWeekly } from './weather2.js';
import { stLoadAll, stSetWindow, stUpdateSubtitles, stRenderStorChart, stRenderDevChart, stRenderInjChart } from './storage.js';
import { peLoadAll, peSetWindow, peRenderOne } from './production.js';
import { ngfRenderChart, ngfUpdateSubtitle, ngfSetWindow, ngfSetChartType, fcLoad, fcToggle, fcSilentRefresh } from './futures2.js';
import { renderSeasonChart, renderSeasonChartOverview, renderSeasonStats, seasonSetMode, fwCardSetMode, seasonOvSetYear } from './seasonality.js';
import { taLoadAll, taRefresh, taSilentRefresh, taSetType, taSetTicker, taResetZoomTF, taRenderTF } from './technical.js';
import { cotLoadAll, cotSetWindow, cotShowHelp, cotHideHelp, cotExportNet, cotExportLS, cotExportProd, cotExportSwap, cotExportChg } from './cot.js';
import { renderBiasCard, refreshFairPricesOnly } from './bias.js';
import { stExportStorage, stExportDev, stExportNgf, stExportInj, peExport, peExportSupply, exportWxReg, exportWxTemp, exportWxDem } from './exports.js';
import { startTopbarTicker, updateTopbar } from './topbar.js';
import { startWidgetTicker, initOverviewEvents, updateAllWidgets, updateFuturesTimestamp, renderFuturesCurve } from './widgets.js';
import { newsLoad, newsPauseHover, newsAutoRefresh } from './news.js';
import { initForecastTrend } from './forecast-trend2.js';

// ── Clock ─────────────────────────────────────────────────────────────────────
tickClock();
setInterval(tickClock, 1000);

// ── Topbar (season card + KPIs) ──────────────────────────────────────────────
startTopbarTicker();

// ── Widgets (EIA banner etc.) ─────────────────────────────────────────────────
startWidgetTicker();
initOverviewEvents();

// ── NGF live price refresh — every 60s ───────────────────────────────────────
// Uses direct contract tickers (NGM26.NYM etc.), not NG=F continuous.
// Roll detection: when T212 roll date passes, triggers full reload.

let _lastKnownFrontTicker = null;

async function refreshNGFPrice() {
  const cur = ngfCurrent();
  const nxt = cur ? ngfNext(cur) : null;
  if (!cur) return;

  // Detect roll: if front ticker changed since last check → reload everything
  if (_lastKnownFrontTicker && _lastKnownFrontTicker !== cur.ticker) {
    dbLog('🔄 Contract roll detected: ' + _lastKnownFrontTicker + ' → ' + cur.ticker, 'ok');
    _lastKnownFrontTicker = cur.ticker;
    // Clear TA data so it reloads for new contract
    state.taData = {};
    // Reload daily history for new contracts
    loadDailyHistory();
    // Reload TA charts
    taLoadAll();
    // Refresh bias card
    renderBiasCard();
  }
  _lastKnownFrontTicker = cur.ticker;

  try {
    const [qFront, qNext] = await Promise.all([
      ngfFetchTwoDays(cur.ticker, false).catch(e => { dbLog('NGF front fail: ' + e.message, 'warn'); return null; }),
      nxt ? ngfFetchTwoDays(nxt.ticker, false).catch(e => { dbLog('NGF next fail: ' + e.message, 'warn'); return null; }) : Promise.resolve(null),
    ]);
    if (qFront && qNext) {
      dbLog('NGF refresh: ' + cur.ticker + ' $' + qFront.last.toFixed(3) + ' · ' + nxt.ticker + ' $' + qNext.last.toFixed(3), 'ok');
    } else if (qFront) {
      dbLog('NGF refresh: ' + cur.ticker + ' $' + qFront.last.toFixed(3), 'ok');
    }
    if (qFront) {
      state.frontLivePrice = qFront.last;
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
      // Charts measured while their panel was hidden can size wrong — re-render on open
      if (id === 'seasonality') { try { renderSeasonChart(); } catch (e) { dbLog('season chart on tab open: ' + e.message, 'warn'); } }
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
  document.getElementById('ta-btn-front').addEventListener('click', function() { taSetTicker('front'); });
  document.getElementById('ta-btn-next').addEventListener('click', function() { taSetTicker('next'); });
  document.getElementById('ta-refresh-btn').addEventListener('click', taRefresh);

  // Sidebar collapse toggle (with localStorage persistence; default: collapsed)
  const SIDEBAR_KEY = 'ng_sidebar_collapsed_v1';
  try {
    const stored = localStorage.getItem(SIDEBAR_KEY);
    if (stored === null || stored === '1') document.body.classList.add('sidebar-collapsed');
  } catch (e) {
    document.body.classList.add('sidebar-collapsed');
  }
  const sbBtn = document.getElementById('sidebar-collapse-btn');
  if (sbBtn) sbBtn.addEventListener('click', function() {
    const nowCollapsed = !document.body.classList.contains('sidebar-collapsed');
    document.body.classList.toggle('sidebar-collapsed', nowCollapsed);
    try { localStorage.setItem(SIDEBAR_KEY, nowCollapsed ? '1' : '0'); } catch (e) {}
    // Resize charts after layout settles
    setTimeout(function() {
      window.dispatchEvent(new Event('resize'));
    }, 250);
  });

  // SMC toggles — re-render all TA timeframes when changed
  function smcToggleHandler(key, id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', function() {
      state.smcFlags[key] = el.checked;
      // Re-render all TA charts with new SMC flags
      ['5m', '15m', '1h', '4h', '1d', '1w'].forEach(function(tf) {
        if (state.taData[tf]) {
          try { taRenderTF(tf, state.taData[tf]); } catch(e) { dbLog('SMC re-render ' + tf + ': ' + e.message, 'warn'); }
        }
      });
    });
  }
  smcToggleHandler('highLow', 'smc-toggle-hl');
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

  // ── Seasonality mode (% / $) ────────────────────────────────────────────────
  document.querySelectorAll('[data-season-mode]').forEach(function(b) {
    b.addEventListener('click', function() { seasonSetMode(this.dataset.seasonMode); });
  });

  // ── Seasonal stats help popup ───────────────────────────────────────────────
  var seasonHelpBtn = document.getElementById('season-help-btn');
  var seasonOverlay = document.getElementById('season-popup-overlay');
  var seasonClose = document.getElementById('season-popup-close');
  if (seasonHelpBtn && seasonOverlay) seasonHelpBtn.addEventListener('click', function() { seasonOverlay.classList.add('on'); });
  if (seasonClose && seasonOverlay)   seasonClose.addEventListener('click', function() { seasonOverlay.classList.remove('on'); });
  if (seasonOverlay) seasonOverlay.addEventListener('click', function(e) { if (e.target === e.currentTarget) seasonOverlay.classList.remove('on'); });

  var seasonChartHelpBtn = document.getElementById('fw-season-help-btn');
  var seasonChartOverlay = document.getElementById('season-chart-popup-overlay');
  var seasonChartClose = document.getElementById('season-chart-popup-close');
  if (seasonChartHelpBtn && seasonChartOverlay) seasonChartHelpBtn.addEventListener('click', function() { seasonChartOverlay.classList.add('on'); });
  if (seasonChartClose && seasonChartOverlay)   seasonChartClose.addEventListener('click', function() { seasonChartOverlay.classList.remove('on'); });
  if (seasonChartOverlay) seasonChartOverlay.addEventListener('click', function(e) { if (e.target === e.currentTarget) seasonChartOverlay.classList.remove('on'); });

  // ── Overview futures card: Curve ↔ Seasonality ──────────────────────────────
  var fwTabCurve = document.getElementById('fw-tab-curve');
  var fwTabSeason = document.getElementById('fw-tab-season');
  if (fwTabCurve)  fwTabCurve.addEventListener('click', function() {
    fwCardSetMode('curve');
    try { renderFuturesCurve(); } catch (e) { dbLog('futures curve: ' + e.message, 'warn'); }
  });
  if (fwTabSeason) fwTabSeason.addEventListener('click', function() { fwCardSetMode('season'); });

  var fwYearSel = document.getElementById('fw-season-year');
  if (fwYearSel) fwYearSel.addEventListener('change', function() { seasonOvSetYear(this.value); });

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
    if (e.key === 'Escape') {
      cotHideHelp();
      var so = document.getElementById('season-popup-overlay');
      if (so) so.classList.remove('on');
      var sco = document.getElementById('season-chart-popup-overlay');
      if (sco) sco.classList.remove('on');
    }
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
  document.addEventListener('storage:loaded', function() {
    // storage drives the historical fair-price line on the NGF chart
    try { if (state.stNgfData && state.stNgfData.length) ngfRenderChart(); } catch (e) { dbLog('ngf re-render after storage load: ' + e.message, 'warn'); }
    // ...and the fair-price overlay on the seasonality charts
    try { renderSeasonChart(); } catch (e) { dbLog('season re-render after storage load: ' + e.message, 'warn'); }
    if (state.fwCardMode === 'season') { try { renderSeasonChartOverview(); } catch (e) { dbLog('season overview after storage load: ' + e.message, 'warn'); } }
  });
  document.addEventListener('weather:loaded', renderBiasCard);
  document.addEventListener('ngf:price:refresh', refreshFairPricesOnly);
  document.addEventListener('ngf:price:refresh', refreshOverview);
  document.addEventListener('ngf:price:refresh', function() {
    try { renderSeasonStats(); } catch (e) { dbLog('season stats live refresh: ' + e.message, 'warn'); }
  });
  document.addEventListener('ngf:loaded', function() {
    ngfUpdateSubtitle();
    ngfRenderChart();
    try { renderSeasonChart(); } catch (e) { dbLog('season chart on ngf load: ' + e.message, 'warn'); }
    if (state.fwCardMode === 'season') { try { renderSeasonChartOverview(); } catch (e) { dbLog('season overview on ngf load: ' + e.message, 'warn'); } }
    // Ensure 1w TA chart uses freshly loaded NGF (stNgfData) when available
    try {
      if (state.taData && state.taData['1w']) taRenderTF('1w', state.taData['1w']);
    } catch (e) { dbLog('ta re-render 1w after NGF load: ' + e.message, 'warn'); }
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

  // Initialize lastKnownFrontTicker so first refreshNGFPrice doesn't trigger false roll
  if (cur) _lastKnownFrontTicker = cur.ticker;

  renderBiasCard();
  ngfUpdateSubtitle();
  stUpdateSubtitles();

  // Fetch prices immediately on startup (don't wait 60s for first interval)
  refreshNGFPrice();

  wxLoadAll(false);
  stLoadAll();
  peLoadAll();
  fcLoad();
  taLoadAll();
  cotLoadAll();

  // News ticker
  newsLoad();
  newsPauseHover();
  newsAutoRefresh();

  // Daily history for prev-day close (Front + Next) — fetched once at start, refreshed every 4h
  loadDailyHistory();
  setInterval(loadDailyHistory, 4 * 60 * 60 * 1000);
});

async function loadDailyHistory() {
  const cur = ngfCurrent();
  if (!cur) return;
  const nxt = ngfNext(cur);
  const [front, next] = await Promise.all([
    fetchDailyHistory(cur.ticker).catch(e => { dbLog('Daily history front fail: ' + e.message, 'warn'); return null; }),
    nxt ? fetchDailyHistory(nxt.ticker).catch(e => { dbLog('Daily history next fail: ' + e.message, 'warn'); return null; }) : Promise.resolve(null),
  ]);
  if (front) state.dailyHistory.front = front;
  if (next)  state.dailyHistory.next  = next;
  if (front || next) {
    dbLog('Daily history loaded: ' + cur.ticker + ' ' + (front?.length||0) + ' bars · ' + (nxt?.ticker||'—') + ' ' + (next?.length||0) + ' bars', 'ok');
    document.dispatchEvent(new CustomEvent('daily:history:loaded'));
  }
}

// ── Forecast trend toggle (Weather Demand card) ──────────────────────────────
initForecastTrend();
