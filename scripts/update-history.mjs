// scripts/update-history.mjs
// Runs on GitHub Actions (no browser, no app open). Once per hour it:
//   1. fetches the 16-day daily forecast for each region from Open-Meteo,
//   2. computes ONE weighted HDD / CDD / Demand value for the forecast window
//      (tomorrow .. end of the 16-day forecast),
//   3. appends a single timestamped record to data/history.json.
//
// The math mirrors weather.js / constants.js exactly:
//   daily avg temp = (tmax + tmin) / 2
//   HDD = max(0, BASE - t),  CDD = max(0, t - BASE),  BASE = 18 °C
//   weighted across regions by each region's weight w.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

// ── Config (kept in sync with js/constants.js) ──────────────────────────────
const WX_BASE = 18;
const WX_FCST_DAYS = 16;
const WX_REGIONS = [
  { name: 'Northeast', lat: 39.95,  lon: -75.17,  w: 0.35 },
  { name: 'Midwest',   lat: 41.85,  lon: -87.65,  w: 0.32 },
  { name: 'S.Central', lat: 32.78,  lon: -96.80,  w: 0.18 },
  { name: 'Southeast', lat: 33.75,  lon: -84.39,  w: 0.10 },
  { name: 'West',      lat: 39.74,  lon: -104.98, w: 0.05 },
];

const HISTORY_PATH = 'data/history.json';
// Keep ~60 days of hourly records (1440/month-ish). The chart only shows the
// last 7 days, but we retain more so you can widen the window later if you want.
const MAX_RECORDS = 4320;

// ── Helpers ─────────────────────────────────────────────────────────────────
const hdd = (t) => Math.max(0, WX_BASE - t);
const cdd = (t) => Math.max(0, t - WX_BASE);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchRetry(url, tries = 4, delay = 1500) {
  for (let i = 0; i <= tries; i++) {
    try {
      const r = await fetch(url);
      if (r.status === 429) {
        if (i === tries) throw new Error('Rate limit');
        await sleep(delay * 2 ** i);
        continue;
      }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      if (i === tries) throw e;
      await sleep(delay * 2 ** i);
    }
  }
}

// Returns array of WX_FCST_DAYS daily mean temps. Index 0 = today.
async function fetchFcst(lat, lon) {
  const url =
    'https://api.open-meteo.com/v1/forecast?latitude=' + lat +
    '&longitude=' + lon +
    '&daily=temperature_2m_max,temperature_2m_min&forecast_days=' + WX_FCST_DAYS +
    '&timezone=UTC';
  const j = await fetchRetry(url);
  const res = [];
  for (let d = 0; d < WX_FCST_DAYS; d++) {
    const mx = j.daily?.temperature_2m_max?.[d];
    const mn = j.daily?.temperature_2m_min?.[d];
    res.push(mx != null && mn != null ? (mx + mn) / 2 : null);
  }
  return res;
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  // Fetch forecast per region, sequentially (gentle on the free API).
  const regionDaily = [];
  for (const r of WX_REGIONS) {
    regionDaily.push(await fetchFcst(r.lat, r.lon));
    await sleep(300);
  }

  // For each forecast day, weight HDD/CDD/demand across regions, then average
  // over days 1..end (skip index 0 = today → "from the day following today").
  let sumHdd = 0, sumCdd = 0, sumDem = 0, nDays = 0;
  for (let d = 1; d < WX_FCST_DAYS; d++) {
    let hW = 0, cW = 0, wSum = 0;
    WX_REGIONS.forEach((r, ri) => {
      const t = regionDaily[ri][d];
      if (t == null || Number.isNaN(t)) return;
      hW += r.w * hdd(t);
      cW += r.w * cdd(t);
      wSum += r.w;
    });
    if (wSum < 0.01) continue;
    const sc = 1 / wSum;
    sumHdd += hW * sc;
    sumCdd += cW * sc;
    sumDem += (hW + cW) * sc;
    nDays++;
  }
  if (nDays === 0) throw new Error('No valid forecast days returned');

  const record = {
    ts: new Date().toISOString(),       // snapshot time (UTC)
    hdd: +(sumHdd / nDays).toFixed(3),  // avg daily HDD across the 16-day outlook
    cdd: +(sumCdd / nDays).toFixed(3),  // avg daily CDD across the 16-day outlook
    dem: +(sumDem / nDays).toFixed(3),  // avg daily total demand across the outlook
    days: nDays,                        // forecast days that went into the average
  };

  // Load existing history (tolerate missing / empty / corrupt file).
  let history = [];
  try {
    const parsed = JSON.parse(await readFile(HISTORY_PATH, 'utf8'));
    if (Array.isArray(parsed)) history = parsed;
  } catch {
    history = [];
  }

  history.push(record);
  if (history.length > MAX_RECORDS) history = history.slice(history.length - MAX_RECORDS);

  await mkdir(dirname(HISTORY_PATH), { recursive: true });
  await writeFile(HISTORY_PATH, JSON.stringify(history) + '\n', 'utf8');

  console.log('Appended:', JSON.stringify(record));
  console.log('Total records:', history.length);
}

main().catch((err) => {
  console.error('update-history failed:', err.message);
  process.exit(1);
});
