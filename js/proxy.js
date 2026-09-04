// js/proxy.js — shared CORS-proxy layer for every cross-origin fetch.
//
// Yahoo Finance and Google News don't send CORS headers, so browser requests
// have to go through a public proxy. Those proxies are the most fragile part of
// the whole dashboard: they get rate-limited, start demanding API keys, or have
// their domain expire — usually without warning. This module centralises that
// risk so the rest of the app just asks for a URL.
//
// What it does beyond a plain fetch():
//   • Ordered proxy list with health tracking — a proxy that fails is benched
//     for a cooldown period instead of being retried on every single request.
//   • Per-proxy concurrency caps. The dashboard fires ~20 requests at startup
//     (12 futures contracts + 6 TA timeframes + quotes). Free proxies collapse
//     under that burst and return CORS-less error pages, which is exactly how
//     "all proxies failed" happened even while the proxies were technically up.
//   • In-flight de-duplication + short-lived response cache, so the same
//     ticker requested by two modules costs one network round-trip.
//   • A sticky "last known good" proxy in localStorage, so a page reload starts
//     with the proxy that worked last time instead of re-discovering it.

import { dbLog } from './debug.js';

// ── Proxy definitions ─────────────────────────────────────────────────────────
// `limit` = max concurrent requests this proxy tolerates before it starts
// failing. `timeout` = how long to wait; the slow ones genuinely need it.
//
// Measured 2026-09-04 from the production origin:
//   proxy.cors.sh      8/8 concurrent OK,  ~210ms   ← fastest, highest capacity
//   allorigins /raw    1/1 OK ~4.6s, 0/8 concurrent ← usable only serialised
//   corsproxy.io       HTTP 401 — now requires an API key
//   thingproxy         DNS no longer resolves
//   codetabs           times out
// The dead three were removed; keeping them only added ~8s of retries per call.

const PROXIES = [
  {
    id: 'cors.sh',
    build: u => 'https://proxy.cors.sh/' + u,
    limit: 6,
    timeout: 12000,
  },
  {
    id: 'allorigins-raw',
    build: u => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u),
    limit: 2,
    timeout: 20000,
  },
  {
    id: 'allorigins-get',
    build: u => 'https://api.allorigins.win/get?url=' + encodeURIComponent(u),
    limit: 2,
    timeout: 20000,
    // /get wraps the payload: {"contents":"<the real body>", ...}
    unwrap: text => {
      try {
        const j = JSON.parse(text);
        return typeof j.contents === 'string' ? j.contents : text;
      } catch (e) { return text; }
    },
  },
];

// A self-hosted proxy always wins when configured — see worker/cors-proxy.js.
// Set it from the browser console with:
//   localStorage.setItem('ng_proxy_self', 'https://your-worker.workers.dev/')
const SELF_KEY = 'ng_proxy_self';

function selfProxy() {
  let base;
  try { base = localStorage.getItem(SELF_KEY); } catch (e) { return null; }
  if (!base) return null;
  if (!/^https?:\/\//.test(base)) return null;
  if (!base.endsWith('/')) base += '/';
  return {
    id: 'self-hosted',
    build: u => base + '?url=' + encodeURIComponent(u),
    limit: 8,
    timeout: 12000,
    isSelf: true,
  };
}

function proxyList() {
  const self = selfProxy();
  return self ? [self, ...PROXIES] : PROXIES.slice();
}

// ── Health tracking ───────────────────────────────────────────────────────────
// A proxy that fails repeatedly is benched, so we stop paying its timeout on
// every request. The bench is short — these services do come back.

const BENCH_MS = 3 * 60 * 1000;   // how long a failing proxy sits out
const FAILS_TO_BENCH = 3;         // consecutive failures before benching

const health = new Map(); // id -> {fails, benchedUntil}

function h(id) {
  let e = health.get(id);
  if (!e) { e = { fails: 0, benchedUntil: 0 }; health.set(id, e); }
  return e;
}

function markOk(id) {
  const e = h(id);
  e.fails = 0;
  e.benchedUntil = 0;
  rememberBest(id);
}

function markFail(id) {
  const e = h(id);
  e.fails++;
  if (e.fails >= FAILS_TO_BENCH) {
    e.benchedUntil = Date.now() + BENCH_MS;
    e.fails = 0;
    dbLog('Proxy benched for 3 min: ' + id, 'warn');
  }
}

function isBenched(id) { return h(id).benchedUntil > Date.now(); }

// Sticky preferred proxy — survives reloads so we don't re-probe every time.
const BEST_KEY = 'ng_proxy_best_v1';
const BEST_TTL = 30 * 60 * 1000;

function rememberBest(id) {
  try { localStorage.setItem(BEST_KEY, JSON.stringify({ id, ts: Date.now() })); } catch (e) {}
}

function preferredId() {
  try {
    const raw = localStorage.getItem(BEST_KEY);
    if (!raw) return null;
    const { id, ts } = JSON.parse(raw);
    return (Date.now() - ts < BEST_TTL) ? id : null;
  } catch (e) { return null; }
}

// Order: never-benched proxies first, the remembered winner ahead of them all.
function orderedProxies() {
  const pref = preferredId();
  const list = proxyList();
  const live = list.filter(p => !isBenched(p.id));
  const pool = live.length ? live : list; // everything benched → try anyway
  return pool.slice().sort((a, b) => {
    if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
    if (a.id === pref) return -1;
    if (b.id === pref) return 1;
    return 0;
  });
}

// ── Per-proxy concurrency limiter ─────────────────────────────────────────────
// Free proxies fail hard when hammered. Each one gets its own queue so a slow
// proxy can't block a fast one.

const gates = new Map(); // id -> {active, queue[]}

function gate(id) {
  let g = gates.get(id);
  if (!g) { g = { active: 0, queue: [] }; gates.set(id, g); }
  return g;
}

function acquire(p) {
  const g = gate(p.id);
  if (g.active < p.limit) { g.active++; return Promise.resolve(); }
  return new Promise(resolve => g.queue.push(resolve));
}

function release(p) {
  const g = gate(p.id);
  const next = g.queue.shift();
  if (next) next();      // hand the slot straight to the next waiter
  else g.active--;
}

// ── Response cache + in-flight de-duplication ─────────────────────────────────
// Two modules asking for the same ticker in the same second should cost one
// request. `ttl` is per call site — intraday quotes want seconds, the 10-year
// weekly history wants half an hour.

const cache = new Map();    // url -> {ts, text}
const inflight = new Map(); // url -> Promise<string>

function cacheGet(url, ttl) {
  if (!ttl) return null;
  const e = cache.get(url);
  if (!e) return null;
  if (Date.now() - e.ts > ttl) { cache.delete(url); return null; }
  return e.text;
}

function cacheSet(url, text, ttl) {
  if (!ttl) return;
  cache.set(url, { ts: Date.now(), text });
  // Keep the map from growing without bound over a long session.
  if (cache.size > 120) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) cache.delete(oldest[0]);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch `url` through the healthiest available CORS proxy.
 *
 * @param {string} url            absolute URL to fetch
 * @param {object} [opts]
 * @param {number} [opts.ttl=0]   cache/de-dupe window in ms
 * @param {string} [opts.key]     cache key; defaults to `url`. Pass a
 *                                normalised URL when the real one carries a
 *                                cache-busting timestamp.
 * @param {function} [opts.validate] receives the body text; return false to
 *                                reject this proxy's response and try the next
 *                                one. Catches proxies that answer HTTP 200 with
 *                                an error page or a quota message.
 * @returns {Promise<string>} the response body
 */
export async function proxyFetch(url, opts = {}) {
  const ttl = opts.ttl || 0;
  // Callers append `_t=<now>` to bust proxy-side caches. That would make every
  // URL unique and defeat our own cache and de-duplication, so the bookkeeping
  // key ignores it while the request still carries it.
  const key = opts.key || url;

  const cached = cacheGet(key, ttl);
  if (cached != null) return cached;

  if (inflight.has(key)) return inflight.get(key);

  const run = (async () => {
    const proxies = orderedProxies();
    let lastErr = null;

    for (const p of proxies) {
      await acquire(p);
      try {
        const res = await fetch(p.build(url), {
          signal: AbortSignal.timeout(p.timeout),
          cache: 'no-store',
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);

        let text = await res.text();
        if (p.unwrap) text = p.unwrap(text);
        if (!text) throw new Error('empty body');
        if (opts.validate && !opts.validate(text)) throw new Error('invalid payload');

        markOk(p.id);
        cacheSet(key, text, ttl);
        return text;
      } catch (e) {
        lastErr = e;
        markFail(p.id);
      } finally {
        release(p);
      }
    }
    throw new Error('All proxies failed: ' + (lastErr?.message || 'unknown'));
  })();

  inflight.set(key, run);
  try { return await run; }
  finally { inflight.delete(key); }
}

/** Same as proxyFetch but parses JSON, validating before accepting a proxy. */
export async function proxyFetchJSON(url, opts = {}) {
  const text = await proxyFetch(url, {
    ...opts,
    validate: t => {
      const c = t.trimStart()[0];
      if (c !== '{' && c !== '[') return false;      // HTML error page
      if (opts.validate) {
        try { return opts.validate(JSON.parse(t)); } catch (e) { return false; }
      }
      return true;
    },
  });
  return JSON.parse(text);
}

/** Diagnostics for the debug panel / console. */
export function proxyStatus() {
  return proxyList().map(p => ({
    id: p.id,
    limit: p.limit,
    inFlight: gate(p.id).active,
    queued: gate(p.id).queue.length,
    benched: isBenched(p.id),
    preferred: p.id === preferredId(),
  }));
}

/** Point the app at a self-hosted proxy (see worker/). Pass null to clear. */
export function setSelfProxy(baseUrl) {
  try {
    if (baseUrl) localStorage.setItem(SELF_KEY, baseUrl);
    else localStorage.removeItem(SELF_KEY);
  } catch (e) {}
  health.clear();
  cache.clear();
}

if (typeof window !== 'undefined') {
  window.ngProxy = { status: proxyStatus, setSelf: setSelfProxy };
}
