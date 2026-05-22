// js/debug.js
import { state } from './state.js';
import { p2, esc } from './utils.js';

const DBG_ST = {
  info:  {c:'#4493f8', i:'ℹ'},
  ok:    {c:'#3fb950', i:'✓'},
  warn:  {c:'#e3b341', i:'⚠'},
  error: {c:'#ff7b72', i:'✖'}
};

export function dbLog(msg, lvl) {
  lvl = lvl || 'info';
  const n = new Date();
  state.dbgEntries.push({
    ts: p2(n.getHours())+':'+p2(n.getMinutes())+':'+p2(n.getSeconds()),
    msg: String(msg),
    lvl
  });
  renderDbg();
}

export function renderDbg() {
  const cnt = state.dbgEntries.length;
  const log = document.getElementById('dbg-log');
  const dot = document.getElementById('dbg-dot');
  document.getElementById('dbg-count').textContent = cnt + (cnt === 1 ? ' entry' : ' entries');

  const hasErr = state.dbgEntries.some(e => e.lvl === 'error');
  const hasWrn = state.dbgEntries.some(e => e.lvl === 'warn');
  dot.style.background = hasErr ? '#ff7b72' : hasWrn ? '#e3b341' : cnt ? '#3fb950' : '#6e7681';
  dot.style.animation  = (hasErr || hasWrn) ? 'pulse .8s infinite' : '';

  if (!cnt) { log.innerHTML = '<span style="color:#6e7681">— no entries yet —</span>'; return; }
  log.innerHTML = state.dbgEntries.map(e => {
    const c = DBG_ST[e.lvl] || DBG_ST.info;
    return `<div style="display:flex;gap:10px;border-bottom:1px solid #21262d;padding:2px 0">
      <span style="color:#6e7681;flex-shrink:0">${e.ts}</span>
      <span style="color:${c.c};flex-shrink:0">${c.i}</span>
      <span style="color:${c.c};word-break:break-word">${esc(e.msg)}</span>
    </div>`;
  }).join('');
  log.scrollTop = log.scrollHeight;
}
