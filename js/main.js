// js/main.js  —  entry point: init + all event wiring
import { TA_TFS } from './constants.js';
import { state } from './state.js';
import { tickClock, setUpdated } from './utils.js';
import { dbLog, renderDbg } from './debug.js';
import { ngfCurrent, ngfLogContracts } from './contracts.js';
import { resetZoom } from './charts.js';

import { wxLoadAll, wxForceRefresh, wxSetWindow, exportHistoricalWeekly } from './weather.js';
import { stLoadAll, stSetWindow, stUpdateSubtitles, stRenderStorChart, stRenderDevChart, stRenderInjChart } from './storage.js';
import { peLoadAll, peSetWindow, peRenderOne } from './production.js';
import { ngfRenderChart, ngfUpdateSubtitle, ngfSetWindow, ngfSetChartType, fcLoad, fcToggle } from './futures.js';
import { taLoadAll, taRefresh, taSetType, taResetZoomTF } from './technical.js';
import { cotLoadAll, cotSetWindow, cotShowHelp, cotHideHelp, cotExportNet, cotExportLS, cotExportProd, cotExportSwap, cotExportChg } from './cot.js';
import { renderBiasCard } from './bias.js';
import { aiSend, aiSendReport, aiClear } from './ai.js';
import {
  stExportStorage, stExportDev, stExportNgf, stExportInj,
  peExport, peExportSupply, exportWxReg, exportWxTemp, exportWxDem
} from './exports.js';

// ── Clock ─────────────────────────────────────────────────────────────────────
tickClock();
setInterval(tickClock, 1000);

// ── DOM ready ─────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {

  // ── Tab switching ───────────────────────────────────────────────────────────
  document.querySelectorAll('.tab-btn[data-tab]').forEach(btn => {
    btn.addEventListener('click', function () {
      const id = this.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('on'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('on'));
      this.classList.add('on');
      document.getElementById('panel-' + id).classList.add('on');
    });
  });

  // ── Global refresh ──────────────────────────────────────────────────────────
  document.getElementById('btn-refresh').addEventListener('click', () => {
    dbLog('Global refresh', 'info');
    wxForceRefresh();
    stLoadAll();
    peLoadAll();
    fcLoad();
    taRefresh();
  });

  // ── Debug console ───────────────────────────────────────────────────────────
  document.getElementById('dbg-header').addEventListener('click', () => {
    const b = document.getElementById('dbg-body'), a = document.getElementById('dbg-arrow');
    const open = b.style.display === 'none';
    b.style.display = open ? 'block' : 'none';
    a.style.transform = open ? 'rotate(90deg)' : '';
  });
  document.getElementById('dbg-clear-btn').addEventListener('click', e => {
    e.stopPropagation();
    state.dbgEntries = [];
    renderDbg();
  });

  // ── AI ──────────────────────────────────────────────────────────────────────
  document.getElementById('ai-send-btn').addEventListener('click', aiSend);
  document.getElementById('ai-clear-btn').addEventListener('click', aiClear);
  document.getElementById('ai-report-btn').addEventListener('click', aiSendReport);
  document.getElementById('ai-input').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); aiSend(); } });
  document.getElementById('ai-input').addEventListener('focus', function () { this.style.borderColor = '#4493f8'; });
  document.getElementById('ai-input').addEventListener('blur',  function () { this.style.borderColor = '#30363d'; });

  // ── Technical Analysis ──────────────────────────────────────────────────────
  // TA buttons
  document.getElementById('ta-btn-candle').addEventListener('click', function() { taSetType('candle'); });
  document.getElementById('ta-btn-line').addEventListener('click', function() { taSetType('line'); });
  document.getElementById('ta-refresh-btn').addEventListener('click', taRefresh);

  // TA reset — explicitně všechny TF
  ['5m','15m','1h','4h','1d','1w'].forEach(function(tf) {
    const btn = document.getElementById('ta-reset-' + tf);
    if (btn) btn.addEventListener('click', function() { taResetZoomTF(tf); });
  });

  // ── Futures / NGF ───────────────────────────────────────────────────────────
  document.getElementById('fc-header').addEventListener('click', fcToggle);
  document.getElementById('ngf-btn-line').addEventListener('click',   () => ngfSetChartType('line'));
  document.getElementById('ngf-btn-candle').addEventListener('click', () => ngfSetChartType('candle'));
  document.querySelectorAll('[data-ngf-w]').forEach(b => b.addEventListener('click', function () { ngfSetWindow(this.dataset.ngfW); }));

  // ── Storage windows ─────────────────────────────────────────────────────────
  document.querySelectorAll('[data-st-w]').forEach(b => b.addEventListener('click', function () { stSetWindow(this.dataset.stW); }));

  // ── Production windows ──────────────────────────────────────────────────────
  document.querySelectorAll('[data-pe-w]').forEach(b => b.addEventListener('click', function () { peSetWindow(this.dataset.peW); }));

  // ── Weather windows ─────────────────────────────────────────────────────────
  document.querySelectorAll('[data-wx-w]').forEach(b => b.addEventListener('click', function () { wxSetWindow(this.dataset.wxW); }));
  document.getElementById('wx-hist-btn').addEventListener('click', exportHistoricalWeekly);

  // ── COT windows + help popup ────────────────────────────────────────────────
  document.querySelectorAll('[data-cot-w]').forEach(b => b.addEventListener('click', function () { cotSetWindow(this.dataset.cotW); }));
  document.getElementById('cot-refresh-btn').addEventListener('click', () => { state.cotData = []; cotLoadAll(); });
  document.querySelectorAll('[data-cot-help]').forEach(btn => btn.addEventListener('click', function () { cotShowHelp(this.dataset.cotHelp); }));
  document.getElementById('cot-popup-close').addEventListener('click', cotHideHelp);
  document.getElementById('cot-popup-overlay').addEventListener('click', e => { if (e.target === e.currentTarget) cotHideHelp(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') cotHideHelp(); });

  // ── Zoom reset buttons ──────────────────────────────────────────────────────
  document.querySelectorAll('[data-zoom]').forEach(b => b.addEventListener('click', function () { resetZoom(this.dataset.zoom); }));

  // ── Export buttons ──────────────────────────────────────────────────────────
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
  document.querySelectorAll('[data-pe-export]').forEach(b => b.addEventListener('click', function () { peExport(this.dataset.peExport); }));

  // ── Cross-module event listeners (decouple storage ↔ bias ↔ futures) ───────
  document.addEventListener('storage:loaded', renderBiasCard);
  document.addEventListener('weather:loaded', renderBiasCard);
  document.addEventListener('ngf:loaded', () => { ngfUpdateSubtitle(); ngfRenderChart(); });

  // ── Auto weather refresh on new hour ────────────────────────────────────────
  let lastWxSlot = Date.now();
  setInterval(() => {
    const now = new Date(), cur = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours()).getTime();
    if (cur !== lastWxSlot) { lastWxSlot = cur; dbLog('New hour — refreshing weather…', 'info'); wxForceRefresh(); }
    try { document.getElementById('wx-api-count').textContent = JSON.parse(localStorage.getItem('ng_wx_api_v2') || '{}').count || 0; } catch(e) {}
  }, 60000);

  // ── INIT ────────────────────────────────────────────────────────────────────
  dbLog('NatGas Dashboard v16 — init', 'info');
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
