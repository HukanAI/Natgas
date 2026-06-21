// scripts/snapshot.mjs
// Runs in GitHub Actions. Loads the dashboard in headless Chromium, waits until
// the Market Overview signals have been computed, then harvests
// window.__SNAPSHOT__() into data/snapshot.json. This reuses every computation
// the live app does (no duplicated math), so the snapshot matches the UI.
//
// It also records per-host network results, failed requests and console
// errors into snap.diagnostics, so we can see exactly which data feed failed
// (block vs timeout vs HTTP error) when feeds come back empty.

import { chromium } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';

const URL = process.env.DASH_URL || 'http://localhost:8080/index.html';
const OUT = process.env.SNAPSHOT_OUT || 'data/snapshot.json';
const WAIT_MS = Number(process.env.SNAPSHOT_WAIT_MS || 60000);
const SETTLE_MS = Number(process.env.SNAPSHOT_SETTLE_MS || 8000);

function hostOf(u) {
  try { return new URL(u).host; } catch { return '?'; }
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage();

const pageErrors = [];
const consoleMsgs = [];
const failedRequests = [];
const byHost = {}; // host -> { ok, err, statuses: {code: count} }

function rec(host) {
  return (byHost[host] = byHost[host] || { ok: 0, err: 0, statuses: {} });
}

page.on('pageerror', (e) => pageErrors.push(String(e?.message || e).slice(0, 300)));

page.on('console', (msg) => {
  const type = msg.type();
  if (type === 'error' || type === 'warning') {
    consoleMsgs.push(`[${type}] ${msg.text()}`.slice(0, 300));
  }
});

page.on('requestfailed', (req) => {
  const host = hostOf(req.url());
  if (host.startsWith('localhost')) return;
  rec(host).err++;
  failedRequests.push({
    host,
    url: req.url().slice(0, 200),
    error: req.failure()?.errorText || 'failed',
  });
});

page.on('response', (resp) => {
  const host = hostOf(resp.url());
  if (host.startsWith('localhost')) return;
  const r = rec(host);
  const code = resp.status();
  r.statuses[code] = (r.statuses[code] || 0) + 1;
  if (code >= 200 && code < 400) r.ok++;
  else r.err++;
});

console.log('Loading', URL);
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => {
  console.error('goto warning:', e.message);
});

// Wait until the overview has been computed at least once.
await page
  .waitForFunction(
    () => window._ovTotal && window._ovSignals && Object.keys(window._ovSignals).length > 0,
    { timeout: WAIT_MS }
  )
  .catch(() => console.error('Overview not fully computed before timeout — capturing partial snapshot.'));

// Let slower async sources (COT, storage, production) settle.
await page.waitForTimeout(SETTLE_MS);

const snap = await page.evaluate(() => (window.__SNAPSHOT__ ? window.__SNAPSHOT__() : null));
await browser.close();

if (!snap) {
  console.error('FATAL: window.__SNAPSHOT__ produced nothing.');
  process.exit(1);
}

snap.pageErrors = pageErrors.slice(0, 8);
snap.diagnostics = {
  network: byHost,
  failedRequests: failedRequests.slice(0, 40),
  console: consoleMsgs.slice(0, 40),
};

await mkdir('data', { recursive: true });
await writeFile(OUT, JSON.stringify(snap, null, 2) + '\n', 'utf8');

const sigCount = snap.overview?.signals?.length || 0;
console.log(`Wrote ${OUT} — sentiment="${snap.overview?.sentiment}", ${sigCount} signals, front=${snap.price?.front}`);
console.log('Network by host:', JSON.stringify(byHost));
if (failedRequests.length) console.log('Failed requests:', JSON.stringify(failedRequests.slice(0, 40)));
if (consoleMsgs.length) console.log('Console errors/warnings:', JSON.stringify(consoleMsgs.slice(0, 40)));
