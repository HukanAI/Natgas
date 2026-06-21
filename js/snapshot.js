// js/snapshot.js
// Builds a compact, serializable snapshot of the dashboard's *computed* state.
// Harvested once per hour by scripts/snapshot.mjs (headless Chromium in CI) and
// fed to Claude, which writes data/claude-overview.json.
//
// Reads values the app already exposes on `window` (state, _ovSignals,
// _ovTotal) plus a few rendered KPI cells, so it stays in sync with what the
// user sees on screen — no duplicated math.

import { state } from './state.js';

function txt(id) {
  const el = document.getElementById(id);
  if (!el) return null;
  const t = el.textContent.trim();
  return t && t !== '—' ? t : null;
}

// Parse a number out of a formatted string like "$3.198" or "-122,617".
function num(s) {
  if (s == null) return null;
  const v = parseFloat(String(s).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(v) ? v : null;
}

function lastClose(arr) {
  if (!Array.isArray(arr) || !arr.length) return null;
  const r = arr[arr.length - 1];
  if (r == null) return null;
  const v = r.close ?? r.value ?? r.c ?? null;
  return Number.isFinite(v) ? v : null;
}

export function buildSnapshot() {
  const ovSignals = window._ovSignals || {};
  const ovTotal = window._ovTotal || null;

  const signals = Object.entries(ovSignals).map(([key, s]) => ({
    key,
    name: s.name,
    label: s.label,
    score: s.score,
    detail: s.detail || null,
    explanation: s.explanation || null,
  }));

  // Front/next price: prefer the live tick, then the latest loaded NG=F close,
  // then the rendered Fair-Price banner. Live ticks come via flaky CORS proxies
  // that often fail from CI, so the fallbacks keep a real price available.
  const front =
    state.frontLivePrice ?? lastClose(state.stNgfData) ?? num(txt('fpv-banner-front'));
  const next =
    state.nextContractPrice ?? lastClose(state.dailyHistory?.next) ?? num(txt('fpv-banner-next'));

  return {
    generatedAt: new Date().toISOString(),
    price: {
      front,
      next,
      frontPrevClose: lastClose(state.dailyHistory?.front) ?? lastClose(state.stNgfData),
      nextPrevClose: lastClose(state.dailyHistory?.next),
      frontIsLive: state.frontLivePrice != null,
    },
    overview: {
      total: ovTotal?.total ?? null,
      max: ovTotal?.max ?? null,
      sentiment: ovTotal?.overall?.label ?? null,
      signals,
    },
    fairValue: {
      front: txt('fpv-banner-front'),
      next: txt('fpv-banner-next'),
    },
    storage: {
      value: txt('b-stor-val'),
      weekChange: txt('b-stor-wkchg'),
      deviationVs5y: txt('b-stor-dev'),
      date: txt('b-stor-date'),
      forecast: txt('b-stor-fcst'),
      surprise: txt('b-stor-surprise'),
    },
    cot: {
      mmNet: txt('b-cot-net'),
      mmNetChange: txt('b-cot-net-chg'),
      mmNetDate: txt('b-cot-net-date'),
      mmLongShortRatio: txt('b-cot-ratio'),
    },
    seasonality: {
      stats: txt('season-stats'),
      badge: txt('season-badge'),
    },
    dataCounts: {
      ngf: (state.stNgfData || []).length,
      storage: (state.stStorageData || []).length,
      cot: (state.cotData || []).length,
    },
  };
}

if (typeof window !== 'undefined') {
  window.__SNAPSHOT__ = buildSnapshot;
}
