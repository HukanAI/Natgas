// scripts/snapshot.mjs
// Runs in GitHub Actions. Loads the dashboard in headless Chromium, waits until
// the Market Overview signals have been computed, then harvests
// window.__SNAPSHOT__() into data/snapshot.json. This reuses every computation
// the live app does (no duplicated math), so the snapshot matches the UI.

import { chromium } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';

const URL = process.env.DASH_URL || 'http://localhost:8080/index.html';
const OUT = process.env.SNAPSHOT_OUT || 'data/snapshot.json';
const WAIT_MS = Number(process.env.SNAPSHOT_WAIT_MS || 60000);
const SETTLE_MS = Number(process.env.SNAPSHOT_SETTLE_MS || 8000);

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage();

const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e?.message || e)));

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

await mkdir('data', { recursive: true });
await writeFile(OUT, JSON.stringify(snap, null, 2) + '\n', 'utf8');

const sigCount = snap.overview?.signals?.length || 0;
console.log(`Wrote ${OUT} — sentiment="${snap.overview?.sentiment}", ${sigCount} signals, front=${snap.price?.front}`);
if (pageErrors.length) console.log('Page errors:', pageErrors.slice(0, 8));
