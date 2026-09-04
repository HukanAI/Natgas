// js/storage5y.js — 5-year average / band calculation (shared by storage + bias)

const DAY = 864e5;

/**
 * Average / min / max of the same calendar window in each of the previous
 * `years` years: for every reference date, take the same calendar date one
 * through five years back and collect every observation within `windowDays`
 * of those anchors.
 *
 * The window used to be matched with `month*30 + day`, which had three faults:
 * it never wrapped across 31 Dec, so an early-January reference silently lost
 * every peer from the preceding December — 2016-01-01 averaged 5 observations
 * instead of 10 and came out 138 Bcf off; the nominal ±7 days was really 10-15
 * days wide depending on month length; and 31 Jan collided with 1 Feb. 22% of
 * all weeks were affected by more than 1 Bcf. The band feeds fairPrice(), where
 * 138 Bcf moves fair value by roughly $0.18/MMBtu.
 *
 * Anchoring on real dates fixes all three: December peers of a January
 * reference are picked up naturally, the window is always exactly ±windowDays,
 * and current-season data can never leak in because every anchor is at least a
 * year back.
 */
export function st5y(all, dates, windowDays = 7, years = 5) {
  return dates.map(date => {
    const ref = new Date(date + 'T12:00:00Z');
    const anchors = [];
    for (let back = 1; back <= years; back++) {
      anchors.push(Date.UTC(
        ref.getUTCFullYear() - back, ref.getUTCMonth(), ref.getUTCDate(), 12
      ));
    }

    const peers = [];
    all.forEach(r => {
      if (!isFinite(r.value)) return;
      const t = new Date(r.date + 'T12:00:00Z').getTime();
      // An observation can only ever be near one anchor — they are a year apart.
      for (const a of anchors) {
        if (Math.abs(t - a) / DAY <= windowDays) { peers.push(r.value); break; }
      }
    });

    if (peers.length < 2) return { avg: null, min: null, max: null };
    const avg = peers.reduce((a, b) => a + b) / peers.length;
    return { avg, min: Math.min(...peers), max: Math.max(...peers) };
  });
}
