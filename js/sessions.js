// ═══════════════════════════════════════════════════════════════════════════════
// sessions.js — NG futures session detection and marker rendering
//
// Sessions (in UTC):
//   Asian:        23:00 – 08:00  (purple)
//   European:     08:00 – 14:00  (blue)
//   US RTH:       14:00 – 22:00  (green)
//   Daily pause:  22:00 – 23:00  (grey)
//
// Markers are drawn at the bar where a session BEGINS.
// Labels are shown in Prague local time (handled automatically via Intl).
// ═══════════════════════════════════════════════════════════════════════════════

// Returns session key for a given UTC timestamp (ms)
function sessionAtUTC(ts) {
  const d = new Date(ts);
  const h = d.getUTCHours();
  if (h >= 14 && h < 22) return 'rth';
  if (h >= 8 && h < 14)  return 'eu';
  // 22-24 or 0-8 — merge pause hour into Asian (no visible marker for the 1h pause)
  return 'asian';
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
    const s = sessionAtUTC(candles[i].ts);
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
