// js/overview.js
// Market Overview view switcher: "Claude" (hourly AI review from
// data/claude-overview.json, produced by the claude-overview GitHub Action) vs
// "Signals" (the existing client-side computed signals in #market-overview-grid).
// The signals view keeps being rendered by widgets.js untouched — this module
// only toggles which view is visible and renders the Claude card.

const VIEW_KEY = 'ng_overview_view_v1';   // 'claude' | 'signals'
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

function renderClaude(d) {
  const box = document.getElementById('claude-overview');
  if (!box) return;

  if (!d) {
    box.innerHTML =
      '<div class="cov-empty">Claude overview not generated yet.<br>' +
      'It appears after the hourly <code>claude-overview</code> action runs.</div>';
    return;
  }

  const st = STANCE[d.stance] || { col: '#9ba3ad', label: esc(d.stance || '—') };
  const p = d.position || {};
  const drivers = Array.isArray(d.drivers) ? d.drivers : [];
  const risks = Array.isArray(d.risks) ? d.risks : [];

  const lvl = (lbl, val) =>
    `<div class="cov-lvl"><span class="cov-lvl-lbl">${lbl}</span>` +
    `<span class="cov-lvl-val">${esc(val ?? 'n/a')}</span></div>`;

  box.innerHTML = `
    <div class="cov-top">
      <span class="cov-stance" style="background:${st.col}1a;color:${st.col};border-color:${st.col}55">${st.label}</span>
      <span class="cov-conv">${esc(d.conviction || '')} conviction</span>
    </div>
    <div class="cov-headline">${esc(d.headline || '')}</div>
    <div class="cov-summary">${esc(d.summary || '')}</div>

    <div class="cov-pos">
      <div class="cov-pos-head">Suggested position
        <span class="cov-pos-dir">${esc(p.direction || '')}${p.size ? ' · ' + esc(p.size) : ''}</span>
      </div>
      <div class="cov-lvls">
        ${lvl('Entry', p.entry)}
        ${lvl('Stop', p.stop)}
        ${lvl('Target', p.target)}
      </div>
      ${p.rationale ? `<div class="cov-pos-rat">${esc(p.rationale)}</div>` : ''}
    </div>

    ${drivers.length ? `<div class="cov-sec"><div class="cov-sec-h">Key drivers</div>
      <ul class="cov-list">${drivers.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
    ${risks.length ? `<div class="cov-sec"><div class="cov-sec-h">Risks</div>
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
  // Refresh the Claude file periodically (the action updates it hourly).
  setInterval(loadClaude, 10 * 60 * 1000);
}
