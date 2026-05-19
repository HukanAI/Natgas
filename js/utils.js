// js/utils.js
import { MONTHS, DAYS } from './constants.js';

export function p2(n)  { return String(n).padStart(2,'0'); }
export function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
export function sgn(v) { return v >= 0 ? '+' : ''; }
export function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export function isoDate(off, yr) {
  const d = new Date();
  if (yr) d.setFullYear(d.getFullYear() - yr);
  d.setDate(d.getDate() + off);
  return d.toISOString().slice(0,10);
}
export function isoAdd(iso, n) {
  const d = new Date(iso+'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0,10);
}
export function fmtGB(iso) {
  return new Date(iso+'T12:00:00Z').toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'});
}
export function fmtShort(iso) {
  const d = new Date(iso+'T12:00:00Z');
  return d.getUTCDate()+' '+MONTHS[d.getUTCMonth()]+' '+d.getUTCFullYear();
}
export function fmtTs(ts) {
  return new Date(ts).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'});
}
export function fmtPeriod(p) {
  return MONTHS[parseInt(p.slice(5,7))-1]+' '+p.slice(0,4);
}
export function shortDate(iso) {
  const d = new Date(iso+'T12:00:00Z');
  return d.getUTCDate()+'.'+(d.getUTCMonth()+1)+'.'+d.getUTCFullYear();
}
export function daysInMonth(yyyymm) {
  const yr = parseInt(yyyymm.slice(0,4)), mo = parseInt(yyyymm.slice(5,7));
  return new Date(yr, mo, 0).getDate();
}
// wAvg is weather-specific — lives in weather.js with WX_REGIONS in scope
export function hdd(t, base = 18) { return Math.max(0, base - t); }
export function cdd(t, base = 18) { return Math.max(0, t - base); }
export function fairPrice(dev)    { return -0.0013 * dev + 3.1564; }

export function dlBlob(name, txt) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([txt], {type:'text/plain;charset=utf-8'}));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(a.href);
}
export function setUpdated() {
  const n = new Date();
  document.getElementById('hdr-upd').textContent =
    'Updated '+p2(n.getHours())+':'+p2(n.getMinutes())+':'+p2(n.getSeconds())+' ·';
}
export function fmtChg(chg, pct) {
  return {
    text:  sgn(chg)+chg.toFixed(3)+' ('+sgn(pct)+pct.toFixed(1)+'%)',
    color: chg >= 0 ? '#3fb950' : '#ff7b72'
  };
}
export function tickClock() {
  const n = new Date();
  document.getElementById('hdr-clock').textContent =
    p2(n.getHours())+':'+p2(n.getMinutes())+':'+p2(n.getSeconds());
  document.getElementById('hdr-date').textContent =
    DAYS[n.getDay()]+' '+n.getDate()+' '+MONTHS[n.getMonth()]+' '+n.getFullYear();
  document.getElementById('ftr-upd').textContent =
    'Last refresh '+p2(n.getHours())+':'+p2(n.getMinutes());
}
export function getFriday(iso) {
  const d = new Date(iso+'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + (5 - d.getUTCDay() + 7) % 7);
  return d.toISOString().slice(0,10);
}
export function wxFmtExp(iso) {
  const EXP_MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sept','Oct','Nov','Dec'];
  const d = new Date(iso+'T12:00:00Z');
  return p2(d.getUTCDate())+' '+EXP_MON[d.getUTCMonth()]+' '+d.getUTCFullYear();
}
