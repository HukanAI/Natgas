// scripts/update-history.mjs
// Runs on GitHub Actions (no browser, no app open). Once per hour it:
//   1. fetches the 16-day daily forecast for each region from Open-Meteo,
//   2. computes the SUM of weighted HDD / CDD / Demand across all 16 forecast
//      days (today .. today+15),
//   3. computes the 5-YEAR NORMAL of that same summed demand for the same
//      calendar window (avg of the past 5 years from the archive API),
//   4. appends a single timestamped record (with the covered date range) to
//      data/history.json.
//
// The per-day math mirrors weather.js / constants.js exactly:
//   daily avg temp = (tmax + tmin) / 2
//   HDD = max(0, BASE - t),  CDD = max(0, t - BASE),  BASE = 18 deg C
//   weighted across regions by each region's weight w.
// We then SUM these per-day weighted values over the whole forecast window.

import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

// -- Config (kept in sync with js/constants.js) ------------------------------
const WX_BASE = 18;
const WX_FCST_DAYS = 16;
const WX_REGIONS = [
  { name: 'Northeast', lat: 39.95,  lon: -75.17,  w: 0.35 },
  { name: 'Midwest',   lat: 41.85,  lon: -87.65,  w: 0.32 },
  { name: 'S.Central', lat: 32.78,  lon: -96.80,  w: 0.18 },
  { name: 'Southeast', lat: 33.75,  lon: -84.39,  w: 0.10 },
  { name: 'West',      lat: 39.74,  lon: -104.98, w: 0.05 },
];

// Past N years used for the "5-year normal".
const NORMAL_YEARS = 5;

const HISTORY_PATH = 'data/history.json';
// Records older than the live window move here and are never fetched by the
// browser. NDJSON (one record per line) so each hourly run appends lines rather
// than rewriting a growing array — git stores that as a small delta.
const ARCHIVE_PATH = 'data/history-archive.ndjson';
// The dashboard filters to the last 7 days (WINDOW_DAYS in forecast-trend2.js)
// and throws the rest away, yet downloaded the whole file on every page load,
// on mobile too. 14 days is double what the chart reads.
const RETAIN_DAYS = 14;

// -- Helpers -----------------------------------------------------------------
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

// Returns { temps: [16 daily means], dates: [16 ISO date strings] }. Index 0 = today.
async function fetchFcst(lat, lon) {
  const url =
    'https://api.open-meteo.com/v1/forecast?latitude=' + lat +
    '&longitude=' + lon +
    '&daily=temperature_2m_max,temperature_2m_min&forecast_days=' + WX_FCST_DAYS +
    '&timezone=UTC';
  const j = await fetchRetry(url);
  const temps = [];
  for (let d = 0; d < WX_FCST_DAYS; d++) {
    const mx = j.daily?.temperature_2m_max?.[d];
    const mn = j.daily?.temperature_2m_min?.[d];
    temps.push(mx != null && mn != null ? (mx + mn) / 2 : null);
  }
  return { temps, dates: j.daily?.time || [] };
}

// Fetch archived daily mean temps for one region over [start,end] (ISO dates).
// Returns an array of daily means (may contain nulls for missing days).
async function fetchArchive(lat, lon, start, end) {
  const url =
    'https://archive-api.open-meteo.com/v1/archive?latitude=' + lat +
    '&longitude=' + lon +
    '&start_date=' + start + '&end_date=' + end +
    '&daily=temperature_2m_max,temperature_2m_min&timezone=UTC';
  const j = await fetchRetry(url);
  const mx = j.daily?.temperature_2m_max || [];
  const mn = j.daily?.temperature_2m_min || [];
  const out = [];
  for (let i = 0; i < mx.length; i++) {
    out.push(mx[i] != null && mn[i] != null ? (mx[i] + mn[i]) / 2 : null);
  }
  return out;
}

// Shift an ISO date (YYYY-MM-DD) by a whole number of years.
function shiftYear(iso, deltaYears) {
  const [y, m, d] = iso.split('-').map(Number);
  // Use UTC to avoid TZ drift; clamp Feb 29 -> Feb 28 implicitly via Date.
  const dt = new Date(Date.UTC(y + deltaYears, m - 1, d));
  return dt.toISOString().slice(0, 10);
}

// Given per-region daily temps for one window, return the SUM of weighted
// demand across the window (same math as the forecast path).
// `days` is the list of day offsets the forecast actually covered. Passing a
// bare count instead summed the historical window's FIRST n days, so a gap
// anywhere but the end compared the forecast's days against a different set of
// calendar days — e.g. forecast {0,1,2,4..15} against history {0..14}. 8 of the
// last 48 hourly runs came back with an incomplete window, so this is not a
// theoretical path.
function windowDemandSum(regionDaily, days) {
  let sumDem = 0, used = 0;
  for (const d of days) {
    let hW = 0, cW = 0, wSum = 0;
    WX_REGIONS.forEach((r, ri) => {
      const t = regionDaily[ri] ? regionDaily[ri][d] : null;
      if (t == null || Number.isNaN(t)) return;
      hW += r.w * hdd(t);
      cW += r.w * cdd(t);
      wSum += r.w;
    });
    if (wSum < 0.01) continue;
    const sc = 1 / wSum;
    sumDem += (hW + cW) * sc;
    used++;
  }
  return used > 0 ? sumDem : null;
}

// 5-year normal of the summed demand for the window [from,to] (this year's
// dates). For each of the past NORMAL_YEARS years we fetch the same calendar
// window from the archive, compute the summed demand, then average the years.
async function fetch5yNormal(fromISO, toISO, days) {
  const thisYear = Number(fromISO.slice(0, 4));
  const yearSums = [];
  for (let k = 1; k <= NORMAL_YEARS; k++) {
    const yStart = shiftYear(fromISO, -k);
    const yEnd = shiftYear(toISO, -k);
    // Fetch all regions for this past year's window.
    const regionDaily = [];
    let ok = true;
    for (const r of WX_REGIONS) {
      try {
        regionDaily.push(await fetchArchive(r.lat, r.lon, yStart, yEnd));
      } catch (e) {
        ok = false;
        regionDaily.push(null);
      }
      await sleep(250);
    }
    if (!ok) continue;
    const s = windowDemandSum(regionDaily, days);
    if (s != null) yearSums.push(s);
  }
  if (!yearSums.length) return null;
  const avg = yearSums.reduce((a, b) => a + b, 0) / yearSums.length;
  // Keep the individual years, not just their mean. The dashboard ranks the
  // current outlook against them, which is the context the "% vs 5y" figure was
  // standing in for — and that percentage is badly distorted in shoulder season,
  // where the baseline collapses toward zero around the 18 C base.
  return {
    dem5y: +avg.toFixed(3),
    years: yearSums.length,
    yearSums: yearSums.map((v) => +v.toFixed(1)),
  };
}

// -- Main --------------------------------------------------------------------
async function main() {
  // Fetch forecast per region, sequentially (gentle on the free API).
  const regionDaily = [];
  let forecastDates = [];
  for (const r of WX_REGIONS) {
    const f = await fetchFcst(r.lat, r.lon);
    regionDaily.push(f.temps);
    if (f.dates.length > forecastDates.length) forecastDates = f.dates; // keep the date axis
    await sleep(300);
  }

  // SUM weighted HDD/CDD/demand across ALL 16 forecast days (include today).
  let sumHdd = 0, sumCdd = 0, sumDem = 0;
  const usableDays = [];
  for (let d = 0; d < WX_FCST_DAYS; d++) {
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
    usableDays.push(d);
  }
  const nDays = usableDays.length;
  if (nDays === 0) throw new Error('No valid forecast days returned');

  const fromISO = forecastDates[0] || null;
  const toISO = forecastDates[forecastDates.length - 1] || null;

  // 5-year normal for the same window (best-effort; null if archive fails).
  let normal = null;
  if (fromISO && toISO) {
    try {
      normal = await fetch5yNormal(fromISO, toISO, usableDays);
    } catch (e) {
      console.error('5y normal failed (continuing without it):', e.message);
    }
  }

  const record = {
    ts: new Date().toISOString(),       // snapshot time (UTC)
    from: fromISO,                      // first forecast day (today)
    to: toISO,                          // last forecast day (today+15)
    hdd: +sumHdd.toFixed(3),            // SUM of weighted HDD over the window
    cdd: +sumCdd.toFixed(3),            // SUM of weighted CDD over the window
    dem: +sumDem.toFixed(3),            // SUM of weighted total demand over the window
    dem5y: normal ? normal.dem5y : null,// 5-year normal of the summed demand
    dem5yYears: normal ? normal.yearSums : null, // the individual years behind it
    days: nDays,                        // forecast days summed (normally 16)
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

  // Split the live window from the archive.
  const cutoff = Date.now() - RETAIN_DAYS * 86400000;
  const keep = [], retire = [];
  for (const r of history) {
    const t = Date.parse(r?.ts);
    (Number.isFinite(t) && t >= cutoff ? keep : retire).push(r);
  }

  await mkdir(dirname(HISTORY_PATH), { recursive: true });
  if (retire.length) {
    await appendFile(ARCHIVE_PATH, retire.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  }
  await writeFile(HISTORY_PATH, JSON.stringify(keep) + '\n', 'utf8');

  console.log('Appended:', JSON.stringify(record));
  console.log(`Live window: ${keep.length} records (${RETAIN_DAYS}d), archived this run: ${retire.length}`);
}

main().catch((err) => {
  console.error('update-history failed:', err.message);
  process.exit(1);
});
