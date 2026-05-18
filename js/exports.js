// js/exports.js  —  all CSV/TXT export functions
import { state } from './state.js';
import { dlBlob, fmtGB, fmtTs, sgn, fmtPeriod } from './utils.js';
import { st5y } from './storage5y.js';
import { peCalcSupply } from './production.js';
import { PE_LABELS, PE_NAMES, WX_REGIONS, WX_BASE } from './constants.js';

export function stExportStorage() {
  if (!state.stStorageData.length) { alert('No storage data.'); return; }
  const dates = state.stStorageData.map(d => d.date);
  const b5 = st5y(state.stStorageData, dates);
  const rows = state.stStorageData.map((d, i) => {
    const b = b5[i];
    const dv = b.avg != null ? (d.value - b.avg).toFixed(1) : 'N/A';
    const pct = (b.avg != null && b.avg !== 0) ? ((d.value - b.avg) / b.avg * 100).toFixed(2) + '%' : 'N/A';
    return fmtGB(d.date) + '\t' + Math.round(d.value) + '\t' + (b.avg != null ? Math.round(b.avg) : 'N/A') + '\t' + dv + '\t' + pct + '\t' + (b.min != null ? Math.round(b.min) : 'N/A') + '\t' + (b.max != null ? Math.round(b.max) : 'N/A');
  });
  dlBlob('natgas_storage.txt',
    'Natural Gas Storage\nSource: EIA\nExported: ' + new Date().toLocaleString('en-GB') +
    '\n\nDate\t\t\tBcf\t5yAvg\tDev\tDev%\t5yMin\t5yMax\n' + Array(70).join('-') + '\n' + rows.join('\n')
  );
}

export function stExportDev() {
  if (!state.stStorageData.length) { alert('No data.'); return; }
  const dates = state.stStorageData.map(d => d.date);
  const b5 = st5y(state.stStorageData, dates);
  const rows = [];
  state.stStorageData.forEach((d, i) => {
    const avg = b5[i].avg; if (avg == null) return;
    const dv = d.value - avg;
    rows.push(fmtGB(d.date) + '\t' + sgn(dv) + Math.round(dv) + '\t' + (dv >= 0 ? 'SURPLUS' : 'DEFICIT'));
  });
  dlBlob('natgas_deviation.txt',
    'Storage Deviation\nSource: EIA\nExported: ' + new Date().toLocaleString('en-GB') +
    '\n\nDate\t\t\tDev(Bcf)\tType\n' + Array(50).join('-') + '\n' + rows.join('\n')
  );
}

export function stExportNgf() {
  if (!state.stNgfData.length) { alert('No NGF data.'); return; }
  const rows = state.stNgfData.map(d =>
    fmtTs(d.ts) + '\t' + d.open.toFixed(3) + '\t' + d.high.toFixed(3) + '\t' + d.low.toFixed(3) + '\t' + d.close.toFixed(3)
  );
  dlBlob('ngf_ohlc.txt',
    'NG=F Weekly OHLC\nExported: ' + new Date().toLocaleString('en-GB') +
    '\n\nDate\t\t\tOpen\tHigh\tLow\tClose\n' + Array(50).join('-') + '\n' + rows.join('\n')
  );
}

export function stExportInj() {
  if (state.stStorageData.length < 2) { alert('No data.'); return; }
  const rows = ['Date\t\t\tChange(Bcf)\tType', Array(50).join('-')];
  for (let i = 1; i < state.stStorageData.length; i++) {
    const chg = state.stStorageData[i].value - state.stStorageData[i - 1].value;
    rows.push(fmtGB(state.stStorageData[i].date) + '\t' + sgn(chg) + Math.round(chg) + '\t' + (chg >= 0 ? 'INJECTION' : 'WITHDRAWAL'));
  }
  dlBlob('natgas_injection_withdrawal.txt',
    'Natural Gas Weekly Injection / Withdrawal\nSource: EIA\nExported: ' + new Date().toLocaleString('en-GB') + '\n\n' + rows.join('\n')
  );
}

export function peExport(peKey) {
  const d = state.peData[peKey]; if (!d?.length) { alert('No data.'); return; }
  function pad(s, w) { s = String(s == null ? '' : s); return s.length >= w ? s.slice(0, w - 1) + ' ' : s + ' '.repeat(w - s.length); }
  const lines = [PE_LABELS[peKey] + ' · Bcf/d', 'Source: EIA API v2', 'Exported: ' + new Date().toLocaleString('en-GB'), '', pad('Period', 10) + pad('Bcf/d', 10), '-'.repeat(22)];
  d.forEach(r => lines.push(pad(r.period, 10) + r.value.toFixed(4)));
  dlBlob(PE_NAMES[peKey] + '.txt', lines.join('\n'));
}

export function peExportSupply() {
  const s = peCalcSupply(); if (!s?.length) { alert('No data.'); return; }
  function pad(x, w) { x = String(x == null ? '' : x); return x.length >= w ? x.slice(0, w - 1) + ' ' : x + ' '.repeat(w - x.length); }
  const lines = ['Total Supply (Prod+Canada-Mexico-LNG) · Bcf/d', 'Source: EIA API v2', 'Exported: ' + new Date().toLocaleString('en-GB'), '', pad('Period', 10) + pad('Bcf/d', 10), '-'.repeat(22)];
  s.forEach(r => lines.push(pad(r.period, 10) + r.value.toFixed(4)));
  dlBlob('natgas_total_supply.txt', lines.join('\n'));
}

export function exportWxReg() {
  if (!state.wxS) return;
  const rows = ['Date\t' + WX_REGIONS.map(r => r.name + ' °C').join('\t'), Array(70).join('-')];
  state.wxS.allDates.forEach((dt, i) => {
    const cols = WX_REGIONS.map((_, ri) => { const t = state.wxS.regionTemps[i][ri]; return t != null ? t.toFixed(2) : 'N/A'; });
    rows.push(fmtGB(dt) + '\t' + cols.join('\t'));
  });
  dlBlob('natgas_wx_regional_temp.txt', 'NatGas Weather — Regional Temperatures\nSource: Open-Meteo\nExported: ' + new Date().toLocaleString('en-GB') + '\n\n' + rows.join('\n'));
}

export function exportWxTemp() {
  if (!state.wxS) return;
  const rows = ['Date\tTemp °C\t5y Avg °C\t5y Min °C\t5y Max °C', Array(50).join('-')];
  state.wxS.allDates.forEach((dt, i) => {
    const { allTemps: t, h5avg: a, h5min: mn, h5max: mx } = state.wxS;
    rows.push(fmtGB(dt) + '\t' + (t[i] != null ? t[i].toFixed(2) : 'N/A') + '\t' + (a[i] != null ? a[i].toFixed(2) : 'N/A') + '\t' + (mn[i] != null ? mn[i].toFixed(2) : 'N/A') + '\t' + (mx[i] != null ? mx[i].toFixed(2) : 'N/A'));
  });
  dlBlob('natgas_wx_temp.txt', 'NatGas Weather — Weighted Average Temperature\nSource: Open-Meteo\nExported: ' + new Date().toLocaleString('en-GB') + '\n\n' + rows.join('\n'));
}

export function exportWxDem() {
  if (!state.wxS) return;
  const regHdrs = WX_REGIONS.map(r => r.name + '_HDD\t' + r.name + '_CDD').join('\t');
  const rows = ['Date\tDemand\t5y Avg\t5y Min\t5y Max\tHDD_wtd\tCDD_wtd\t' + regHdrs, Array(80).join('-')];
  state.wxS.allDates.forEach((dt, i) => {
    const { demAll: d, dem5avg: a, dem5min: mn, dem5max: mx, hddAll: h, cddAll: cv, regionTemps: rt } = state.wxS;
    const regCols = rt?.[i]
      ? WX_REGIONS.map((_, ri) => { const t = rt[i][ri]; return t != null ? (Math.max(0, WX_BASE - t).toFixed(2) + '\t' + Math.max(0, t - WX_BASE).toFixed(2)) : 'N/A\tN/A'; }).join('\t')
      : WX_REGIONS.map(() => 'N/A\tN/A').join('\t');
    rows.push(fmtGB(dt) + '\t' + (d[i] != null ? d[i].toFixed(2) : 'N/A') + '\t' + (a[i] != null ? a[i].toFixed(2) : 'N/A') + '\t' + (mn[i] != null ? mn[i].toFixed(2) : 'N/A') + '\t' + (mx[i] != null ? mx[i].toFixed(2) : 'N/A') + '\t' + (h[i] != null ? h[i].toFixed(2) : 'N/A') + '\t' + (cv[i] != null ? cv[i].toFixed(2) : 'N/A') + '\t' + regCols);
  });
  dlBlob('natgas_wx_demand.txt', 'NatGas Weather — Total Demand Index\nSource: Open-Meteo\nExported: ' + new Date().toLocaleString('en-GB') + '\n\n' + rows.join('\n'));
}
