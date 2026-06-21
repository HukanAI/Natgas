// js/overview.js
// Market Overview view switcher: "Claude" (hourly independent AI assessment from
// data/claude-overview.json) vs "Signals" (the existing client-side signals in
// #market-overview-grid). The signals view keeps being rendered by widgets.js
// untouched — this module only toggles which view is visible, injects its own
// styles and renders the Claude card (overall state + long-term & short-term
// trade ideas).

const VIEW_KEY = 'ng_overview_view_v1'; // 'claude' | 'signals'
const DATA_URL = 'data/claude-overview.json';

const STANCE = {
  LONG:  { col: '#3fb950', label: 'LONG' },
  SHORT: { col: '#ff7b72', label: 'SHORT' },
  WAIT:  { col: '#d29922', label: 'WAIT' },
};

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function relTime(iso) {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + ' min ago';
  const h = Math.floor(mins / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

function injectStyles() {
  if (document.getElementById('cov-styles')) return;
  const css = `
  #claude-overview{font-size:12px}
  .cov-empty{color:var(--text3);font-size:11px;line-height:1.6;text-align:center;margin:auto;padding:20px}
  .cov-empty code{font-family:var(--mono);color:var(--text2)}
  .cov-state{font-size:12px;font-weight:700;color:var(--text);line-height:1.4}
  .cov-summary{font-size:11px;color:var(--text2);line-height:1.6}
  .cov-trade{background:var(--bg3);border:1px solid var(--border2);border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:8px}
  .cov-trade-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .cov-trade-title{font-size:10px;text-transform:uppercase;letter-spacing:.8px;color:var(--text3);font-weight:700}
  .cov-horizon{font-size:10px;color:var(--text3);font-family:var(--mono)}
  .cov-badge{font-size:11px;font-weight:800;letter-spacing:.5px;padding:2px 9px;border-radius:5px;border:1px solid;margin-left:auto}
  .cov-conv{font-size:9.5px;text-transform:uppercase;letter-spacing:.5px;color:var(--text3);font-weight:700}
  .cov-lvls{display:flex;gap:6px}
  .cov-lvl{flex:1;background:var(--bg2);border:1px solid var(--border2);border-radius:6px;padding:5px 4px;text-align:center}
  .cov-lvl-lbl{display:block;font-size:8.5px;text-transform:uppercase;letter-spacing:.5px;color:var(--text3);font-weight:700;margin-bottom:2px}
  .cov-lvl-val{display:block;font-family:var(--mono);font-size:11.5px;font-weight:700;color:var(--text)}
  .cov-trade-meta{font-size:10px;color:var(--text2);font-family:var(--mono)}
  .cov-trade-trigger{font-size:10.5px;color:#d29922;line-height:1.5}
  .cov-trade-rat{font-size:10.5px;color:var(--text2);line-height:1.55}
  .cov-inval{font-size:9.5px;color:#ff7b72;line-height:1.45}
  .cov-sec-h{font-size:10px;text-transform:uppercase;letter-spacing:.8px;color:var(--text3);font-weight:700;margin-bottom:4px}
  .cov-list{margin:0;padding-left:15px;display:flex;flex-direction:column;gap:2px}
  .cov-list li{font-size:10.5px;color:var(--text2);line-height:1.45}
  .cov-list-risk li{color:#ffb085}
  .cov-foot{margin-top:auto;padding-top:8px;border-top:1px solid var(--border2);display:flex;flex-direction:column;gap:3px;font-size:9px;color:var(--text3);font-family:var(--mono)}
  .cov-disc{font-style:italic}`;
  const el = document.createElement('style');
  el.id = 'cov-styles';
  el.textContent = css;
  document.head.appendChild(el);
}

function setView(view) {
  const card = document.querySelector('.ov-card');
  if (!card) return;
  const v = view === 'signals' ? 'signals' : 'claude';
  card.setAttribute('data-view', v);
  try { localStorage.setItem(VIEW_KEY, v); } catch (_) {}
  card.querySelectorAll('.ov-toggle-btn').forEach((b) => {
    b.classList.toggle('on', b.dataset.view === v);
  });
}

function lvl(label, val) {
  return `<div class="cov-lvl"><span class="cov-lvl-lbl">${label}</span>` +
    `<span class="cov-lvl-val">${esc(val ?? 'n/a')}</span></div>`;
}

function tradeBlock(title, t) {
  if (!t) return '';
  const st = STANCE[t.stance] || { col: '#9ba3ad', label: esc(t.stance || '—') };
  const wait = t.stance === 'WAIT';
  const meta = [t.riskReward ? 'R:R ' + esc(t.riskReward) : '', t.sizing ? esc(t.sizing) : '']
    .filter(Boolean).join(' · ');
  const levels = wait ? '' :
    `<div class="cov-lvls">${lvl('Entry', t.entry)}${lvl('Stop', t.stop)}${lvl('TP1', t.tp1)}${lvl('TP2', t.tp2)}</div>` +
    (meta ? `<div class="cov-trade-meta">${meta}</div>` : '');
  const trig = wait && t.trigger ? `<div class="cov-trade-trigger">⏳ Waiting for: ${esc(t.trigger)}</div>` : '';
  return `
    <div class="cov-trade">
      <div class="cov-trade-head">
        <span class="cov-trade-title">${title}</span>
        <span class="cov-horizon">${esc(t.horizon || '')}</span>
        <span class="cov-badge" style="background:${st.col}1a;color:${st.col};border-color:${st.col}55">${st.label}</span>
        <span class="cov-conv">${esc(t.conviction || '')}</span>
      </div>
      ${levels}
      ${trig}
      ${t.rationale ? `<div class="cov-trade-rat">${esc(t.rationale)}</div>` : ''}
      ${t.invalidation ? `<div class="cov-inval">✕ ${esc(t.invalidation)}</div>` : ''}
    </div>`;
}

function renderClaude(d) {
  const box = document.getElementById('claude-overview');
  if (!box) return;

  if (!d || (!d.longTerm && !d.shortTerm && !d.summary)) {
    box.innerHTML =
      '<div class="cov-empty">Claude overview not generated yet.<br>' +
      'It appears after the hourly <code>claude-overview</code> action runs.</div>';
    return;
  }

  const drivers = Array.isArray(d.keyDrivers) ? d.keyDrivers : [];
  const risks = Array.isArray(d.risks) ? d.risks : [];

  box.innerHTML = `
    ${d.marketState ? `<div class="cov-state">${esc(d.marketState)}</div>` : ''}
    ${d.summary ? `<div class="cov-summary">${esc(d.summary)}</div>` : ''}
    ${tradeBlock('Long-term', d.longTerm)}
    ${tradeBlock('Short-term', d.shortTerm)}
    ${drivers.length ? `<div><div class="cov-sec-h">Key drivers</div>
      <ul class="cov-list">${drivers.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
    ${risks.length ? `<div><div class="cov-sec-h">Risks</div>
      <ul class="cov-list cov-list-risk">${risks.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
    <div class="cov-foot">
      <span>Updated ${relTime(d.generatedAt)}${d.frontPrice != null ? ' · front $' + esc(d.frontPrice) : ''}</span>
      <span class="cov-disc">${esc(d.disclaimer || 'Informational only, not financial advice.')}</span>
    </div>`;
}

async function loadClaude() {
  try {
    const r = await fetch(DATA_URL + '?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) { renderClaude(null); return; }
    renderClaude(await r.json());
  } catch (_) {
    renderClaude(null);
  }
}

export function initOverviewToggle() {
  injectStyles();

  let saved = 'claude';
  try { saved = localStorage.getItem(VIEW_KEY) || 'claude'; } catch (_) {}
  setView(saved);

  const card = document.querySelector('.ov-card');
  if (card) {
    card.querySelectorAll('.ov-toggle-btn').forEach((b) => {
      b.addEventListener('click', () => setView(b.dataset.view));
    });
  }

  loadClaude();
  setInterval(loadClaude, 10 * 60 * 1000);
}
