// ══════════════════════════════════════════════════════════════════════════════
// sessions.js — NG futures session detection and marker rendering
//
// Boundaries are given in each market's OWN local time, so they follow that
// market's daylight saving instead of drifting:
//   Asian:    08:00–17:00 Tokyo     (JST never shifts, so this is fixed in UTC)
//   European: 08:00–14:00 London    (GMT / BST)
//   US RTH:   09:00–17:00 New York  (EST / EDT) — 17:00 is the NYMEX electronic
//             close; the 17:00–18:00 maintenance break carries no marker of its
//             own and is folded into the Asian block, as before.
//
// They used to be hard-coded as UTC hours (14:00–22:00 for US RTH and so on).
// Those values are the winter mapping: in summer 14:00 UTC is 10:00 in New York,
// an hour after the real open, and 08:00 UTC is 09:00 in London. Every marker
// sat an hour late for the ~8 months of DST.
//
// Markers are drawn at the bar where a session BEGINS.
// ══════════════════════════════════════════════════════════════════════════════

const _hourFmt = {};
function hourIn(tz, d) {
  const f = _hourFmt[tz] || (_hourFmt[tz] = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', hourCycle: 'h23',
  }));
  return Number(f.format(d));
}

// Every zone involved is a whole number of hours from UTC, so the session can
// only change on a UTC hour boundary. Memoising per hour keeps the Intl calls
// to a handful per chart instead of two per candle.
const _sessionByHour = new Map();

function sessionAt(ts) {
  const hourKey = Math.floor(ts / 3600000);
  const hit = _sessionByHour.get(hourKey);
  if (hit) return hit;

  const d = new Date(ts);
  let s;
  const ny = hourIn('America/New_York', d);
  if (ny >= 9 && ny < 17) s = 'rth';
  else {
    const london = hourIn('Europe/London', d);
    // London and New York are contiguous by construction (London 14:00 is
    // New York 09:00 in both winter and summer), and RTH is tested first, so
    // the one-hour overlap that DST opens up resolves to the session that has
    // actually started.
    s = (london >= 8 && london < 14) ? 'eu' : 'asian';
  }

  if (_sessionByHour.size > 20000) _sessionByHour.clear();
  _sessionByHour.set(hourKey, s);
  return s;
}

const SESSION_INFO = {
  asian: { label: 'Asian',    color: 'rgba(155, 89, 182, 0.95)', line: 'rgba(155, 89, 182, 0.22)' },
  eu:    { label: 'European', color: 'rgba(52, 152, 219, 0.95)', line: 'rgba(52, 152, 219, 0.22)' },
  rth:   { label: 'US',       color: 'rgba(46, 204, 113, 0.95)', line: 'rgba(46, 204, 113, 0.22)' },
  pause: { label: '',         color: '',                          line: '' },
};

// Returns array of session start markers
// Each: { dataIndex, key, label }
// dataIndex = position in candles array where the new session begins
export function buildSessionMarkers(candles) {
  if (!candles || candles.length === 0) return [];
  const markers = [];
  let prevSession = null;
  for (let i = 0; i < candles.length; i++) {
    const s = sessionAt(candles[i].ts);
    if (s !== prevSession) {
      markers.push({ dataIndex: i, key: s, label: SESSION_INFO[s].label });
      prevSession = s;
    }
  }
  return markers;
}

// Chart.js plugin that draws session marker lines and labels
// getMarkers: function returning array from buildSessionMarkers
export function sessionMarkerPlugin(getMarkers) {
  return {
    id: 'sessionMarkers',
    afterDatasetsDraw(chart) {
      const markers = getMarkers();
      if (!markers || markers.length === 0) return;
      const { ctx, chartArea, scales } = chart;
      const x = scales.x;
      if (!x) return;

      ctx.save();
      ctx.font = '9px JetBrains Mono, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';

      for (const m of markers) {
        const info = SESSION_INFO[m.key];
        if (!info) continue;
        // Get x pixel for this dataIndex
        const px = x.getPixelForValue(m.dataIndex);
        if (px < chartArea.left || px > chartArea.right) continue;

        // Vertical line (thin, subtle)
        ctx.strokeStyle = info.line;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(px, chartArea.top);
        ctx.lineTo(px, chartArea.bottom);
        ctx.stroke();

        // Label NEXT TO line (not over), upper area
        const labelX = px + 3;
        const labelY = chartArea.top + 4;
        // Backdrop for legibility
        const txt = info.label;
        const tw = ctx.measureText(txt).width + 4;
        ctx.fillStyle = 'rgba(13, 17, 23, 0.6)';
        ctx.fillRect(labelX - 1, labelY - 1, tw, 12);
        // Text
        ctx.fillStyle = info.color;
        ctx.fillText(txt, labelX + 1, labelY);
      }
      ctx.restore();
    }
  };
}
