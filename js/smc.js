// ═══════════════════════════════════════════════════════════════════════════════
// smc.js — Smart Money Concepts + Sigmoid Trailing Stop
// Port of LuxAlgo TradingView indicator
// ═══════════════════════════════════════════════════════════════════════════════

const COL_BULL = '#089981';
const COL_BEAR = '#F23645';
const COL_GRAY = '#878b94';

// ─────────────────────────────────────────────────────────────────────────────
// ATR (simple moving average of True Range)
// ─────────────────────────────────────────────────────────────────────────────
function calcATR(candles, length) {
  const n = candles.length;
  const tr = new Array(n);
  for (let i = 0; i < n; i++) {
    if (i === 0) {
      tr[i] = candles[i].high - candles[i].low;
    } else {
      const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
      tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    }
  }
  const atr = new Array(n).fill(null);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += tr[i];
    if (i >= length) sum -= tr[i - length];
    if (i >= length - 1) atr[i] = sum / length;
  }
  return atr;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pine Script leg() — detects swing legs
// Returns array of leg states (0=bearish leg, 1=bullish leg) for each bar
// ─────────────────────────────────────────────────────────────────────────────
function calcLegs(candles, size) {
  const n = candles.length;
  const legs = new Array(n).fill(0);
  let curLeg = 0;
  for (let i = size; i < n; i++) {
    // newLegHigh = high[size] > ta.highest(size)  — highest over previous `size` bars excluding [i-size]
    let highestPrev = -Infinity, lowestPrev = Infinity;
    for (let j = i - size + 1; j <= i; j++) {
      if (candles[j].high > highestPrev) highestPrev = candles[j].high;
      if (candles[j].low < lowestPrev)   lowestPrev  = candles[j].low;
    }
    const newLegHigh = candles[i - size].high > highestPrev;
    const newLegLow  = candles[i - size].low  < lowestPrev;
    if (newLegHigh) curLeg = 0;       // BEARISH_LEG
    else if (newLegLow) curLeg = 1;   // BULLISH_LEG
    legs[i] = curLeg;
  }
  return legs;
}

// ─────────────────────────────────────────────────────────────────────────────
// Detect swing pivots and BOS/CHoCH events to track swingTrend bias
// Returns { swingTrendByBar, trailing snapshots per bar }
// ─────────────────────────────────────────────────────────────────────────────
function calcSwingStructure(candles, swingLen) {
  const n = candles.length;
  const legs = calcLegs(candles, swingLen);

  let swingHighLevel = null, swingHighIdx = null, swingHighCrossed = false;
  let swingLowLevel  = null, swingLowIdx  = null, swingLowCrossed  = false;
  let swingTrend = 0; // 0 = unknown, +1 = bullish, -1 = bearish

  // trailing extremes
  let topLevel = -Infinity, topIdx = 0;
  let botLevel = Infinity,  botIdx = 0;
  let lastTopBarIdx = 0, lastBotBarIdx = 0;
  let lastPivotBarIdx = 0; // last swing pivot bar (used as left edge for P/D zones)

  const swingTrendByBar = new Array(n).fill(0);
  const trailingByBar = new Array(n); // { top, bottom, lastTopBarIdx, lastBotBarIdx, lastPivotBarIdx, swingTrend }

  for (let i = 0; i < n; i++) {
    // 1. Detect new pivot (start of new leg)
    if (i > 0 && legs[i] !== legs[i - 1] && i - swingLen >= 0) {
      const pivotIdx = i - swingLen;
      if (legs[i] === 1) {
        // Bullish leg started -> previous extreme was a swing LOW at pivotIdx
        swingLowLevel = candles[pivotIdx].low;
        swingLowIdx   = pivotIdx;
        swingLowCrossed = false;
        botLevel = swingLowLevel;
        botIdx   = pivotIdx;
        lastBotBarIdx = pivotIdx;
        lastPivotBarIdx = pivotIdx;
      } else {
        // Bearish leg started -> previous extreme was a swing HIGH at pivotIdx
        swingHighLevel = candles[pivotIdx].high;
        swingHighIdx   = pivotIdx;
        swingHighCrossed = false;
        topLevel = swingHighLevel;
        topIdx   = pivotIdx;
        lastTopBarIdx = pivotIdx;
        lastPivotBarIdx = pivotIdx;
      }
    }

    // 2. Check BOS/CHoCH crosses
    const c = candles[i].close;
    if (swingHighLevel !== null && !swingHighCrossed) {
      const prevClose = i > 0 ? candles[i - 1].close : c;
      if (prevClose <= swingHighLevel && c > swingHighLevel) {
        swingHighCrossed = true;
        swingTrend = +1;
      }
    }
    if (swingLowLevel !== null && !swingLowCrossed) {
      const prevClose = i > 0 ? candles[i - 1].close : c;
      if (prevClose >= swingLowLevel && c < swingLowLevel) {
        swingLowCrossed = true;
        swingTrend = -1;
      }
    }

    // 3. Update trailing extremes (running max/min between pivots)
    if (candles[i].high > topLevel) { topLevel = candles[i].high; lastTopBarIdx = i; }
    if (candles[i].low  < botLevel) { botLevel = candles[i].low;  lastBotBarIdx = i; }

    swingTrendByBar[i] = swingTrend;
    trailingByBar[i] = {
      top: topLevel,
      bottom: botLevel,
      lastTopBarIdx,
      lastBotBarIdx,
      lastPivotBarIdx,
      swingTrend,
    };
  }

  return { swingTrendByBar, trailingByBar };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sigmoid Trailing Stop
// ─────────────────────────────────────────────────────────────────────────────
function sigmoid(t) {
  const tt = Math.max(0, Math.min(1, t));
  const x = -6 + 12 * tt;
  const sMin = 1 / (1 + Math.exp(6));
  const sMax = 1 / (1 + Math.exp(-6));
  const sig  = 1 / (1 + Math.exp(-x));
  return (sig - sMin) / (sMax - sMin);
}

function calcSigmoidTS(candles, opts = {}) {
  const {
    atrLength   = 200,
    atrMult     = 3.0,
    sigLength   = 20,
    sigAmpMult  = 3.0,
    minDistMult = 0.5,
  } = opts;

  const n = candles.length;
  const atr = calcATR(candles, atrLength);

  const stop      = new Array(n).fill(null);
  const direction = new Array(n).fill(1);
  const adjusting = new Array(n).fill(false);

  let stsStop = null;
  let stsDir = 1;
  let stsAdj = false;
  let stsSigCounter = 0;
  let stsStartLevel = null;
  let stsTargetOff = 0;

  for (let i = 0; i < n; i++) {
    const c = candles[i];
    const a = atr[i];
    const upperBand = c.high + atrMult * (a || 0);
    const lowerBand = c.low  - atrMult * (a || 0);

    if (stsStop === null || a === null) {
      stsStop = stsDir === 1 ? lowerBand : upperBand;
    } else {
      if (stsDir === 1) {
        if (c.close < stsStop) {
          stsDir = -1;
          stsStop = upperBand;
          stsAdj = false;
          stsSigCounter = 0;
        }
      } else {
        if (c.close > stsStop) {
          stsDir = 1;
          stsStop = lowerBand;
          stsAdj = false;
          stsSigCounter = 0;
        }
      }
    }

    const stsDist  = stsDir === 1 ? c.close - stsStop : stsStop - c.close;
    const stsKDist = atrMult * ((a && a > 0) ? a : 1.0);
    const stsMinD  = minDistMult * ((a && a > 0) ? a : 1.0);

    if (!stsAdj && stsDist > stsKDist) {
      stsAdj = true;
      stsSigCounter = 0;
      stsStartLevel = stsStop;
      stsTargetOff = sigAmpMult * (a || 0);
    }

    if (stsAdj) {
      stsSigCounter += 1;
      const t = stsSigCounter / sigLength;
      const sigFactor = sigmoid(t);
      const adjustment = stsTargetOff * sigFactor;
      const candidate = stsDir === 1 ? stsStartLevel + adjustment : stsStartLevel - adjustment;
      const newDist = stsDir === 1 ? c.close - candidate : candidate - c.close;
      if (newDist < stsMinD || stsSigCounter >= sigLength) {
        stsAdj = false;
      } else {
        if (stsDir === 1) stsStop = Math.max(stsStop, candidate);
        else              stsStop = Math.min(stsStop, candidate);
      }
    }

    stop[i] = stsStop;
    direction[i] = stsDir;
    adjusting[i] = stsAdj;
  }

  return { stop, direction, adjusting };
}

// ─────────────────────────────────────────────────────────────────────────────
// Build overlay datasets for Chart.js
// candlesPadded = original candles + PADDING null bars at end (matching labels length)
// Returns { datasets, annotations } to be merged into price chart
// ─────────────────────────────────────────────────────────────────────────────
export function buildSMCOverlays(candles, totalLength, opts = {}) {
  const {
    showHighLow = true,
    showZones   = true,
    showSTS     = true,
    swingLen    = 50,
  } = opts;

  const n = candles.length;
  const PAD = totalLength - n;

  const datasets = [];
  const plugins = []; // chart.js plugins for custom labels

  let lastState = null;

  // ── Strong/Weak high/low + Zones share the trailing structure ─────────────
  if (showHighLow || showZones) {
    const { trailingByBar } = calcSwingStructure(candles, swingLen);
    lastState = trailingByBar[n - 1];
    if (!lastState) lastState = { top: 0, bottom: 0, lastTopBarIdx: 0, lastBotBarIdx: 0, lastPivotBarIdx: 0, swingTrend: 0 };

    const { top, bottom, lastTopBarIdx, lastBotBarIdx, lastPivotBarIdx, swingTrend } = lastState;
    const rangeSize = top - bottom;

    // ── Strong/Weak High/Low lines ───────────────────────────────────────────
    if (showHighLow && top > bottom) {
      const topIsStrong = swingTrend === -1; // bearish trend → top is strong high
      const topLabel = topIsStrong ? 'Strong High' : 'Weak High';
      const botLabel = swingTrend === 1 ? 'Strong Low' : 'Weak Low';
      const topColor = COL_BEAR;
      const botColor = COL_BULL;

      // Top line — null until lastTopBarIdx, then top value
      const topData = new Array(totalLength).fill(null);
      for (let i = lastTopBarIdx; i < totalLength; i++) topData[i] = top;
      datasets.push({
        _k: 'smc_top',
        label: topLabel,
        data: topData,
        borderColor: topColor,
        borderWidth: 1.5,
        borderDash: [],
        pointRadius: 0,
        fill: false,
        order: 50,
      });

      const botData = new Array(totalLength).fill(null);
      for (let i = lastBotBarIdx; i < totalLength; i++) botData[i] = bottom;
      datasets.push({
        _k: 'smc_bot',
        label: botLabel,
        data: botData,
        borderColor: botColor,
        borderWidth: 1.5,
        borderDash: [],
        pointRadius: 0,
        fill: false,
        order: 50,
      });

      // Label plugin
      plugins.push({
        type: 'label', y: top, color: topColor, text: topLabel, position: 'above'
      });
      plugins.push({
        type: 'label', y: bottom, color: botColor, text: botLabel, position: 'below'
      });
    }

    // ── Premium/Equilibrium/Discount Zones ───────────────────────────────────
    if (showZones && rangeSize > 0) {
      const premiumTop = top;
      const premiumBot = 0.95 * top + 0.05 * bottom;
      const equiTop    = 0.525 * top + 0.475 * bottom;
      const equiBot    = 0.525 * bottom + 0.475 * top;
      const discTop    = 0.95 * bottom + 0.05 * top;
      const discBot    = bottom;

      const startIdx = lastPivotBarIdx;
      function bandData(yTop, yBot) {
        const dTop = new Array(totalLength).fill(null);
        const dBot = new Array(totalLength).fill(null);
        for (let i = startIdx; i < totalLength; i++) { dTop[i] = yTop; dBot[i] = yBot; }
        return { dTop, dBot };
      }

      const prem = bandData(premiumTop, premiumBot);
      const equi = bandData(equiTop, equiBot);
      const disc = bandData(discTop, discBot);

      // Premium (red, fill between top and bottom of band)
      datasets.push({
        _k: 'smc_prem_top', data: prem.dTop, borderColor: 'transparent',
        pointRadius: 0, fill: '+1', backgroundColor: 'rgba(242,54,69,0.18)', order: 60,
      });
      datasets.push({
        _k: 'smc_prem_bot', data: prem.dBot, borderColor: 'transparent',
        pointRadius: 0, fill: false, order: 61,
      });
      // Equilibrium (gray)
      datasets.push({
        _k: 'smc_equi_top', data: equi.dTop, borderColor: 'transparent',
        pointRadius: 0, fill: '+1', backgroundColor: 'rgba(135,139,148,0.20)', order: 62,
      });
      datasets.push({
        _k: 'smc_equi_bot', data: equi.dBot, borderColor: 'transparent',
        pointRadius: 0, fill: false, order: 63,
      });
      // Discount (green)
      datasets.push({
        _k: 'smc_disc_top', data: disc.dTop, borderColor: 'transparent',
        pointRadius: 0, fill: '+1', backgroundColor: 'rgba(8,153,129,0.18)', order: 64,
      });
      datasets.push({
        _k: 'smc_disc_bot', data: disc.dBot, borderColor: 'transparent',
        pointRadius: 0, fill: false, order: 65,
      });

      // Zone labels (centered horizontally in zone)
      const labelX = Math.round((startIdx + (totalLength - 1)) / 2);
      plugins.push({ type: 'zoneLabel', x: labelX, y: (premiumTop + premiumBot) / 2, text: 'Premium',     color: COL_BEAR });
      plugins.push({ type: 'zoneLabel', x: labelX, y: (equiTop + equiBot) / 2,       text: 'Equilibrium', color: COL_GRAY });
      plugins.push({ type: 'zoneLabel', x: labelX, y: (discTop + discBot) / 2,       text: 'Discount',    color: COL_BULL });
    }
  }

  // ── Sigmoid Trailing Stop ───────────────────────────────────────────────
  if (showSTS) {
    const { stop, direction } = calcSigmoidTS(candles);

    // Insert null at flip points to BREAK the line (avoid ugly vertical jump line)
    // When direction[i] !== direction[i-1], set stop[i-1] = null OR stop[i] = null
    const stopBroken = stop.slice();
    for (let i = 1; i < n; i++) {
      if (direction[i] !== direction[i - 1]) {
        stopBroken[i - 1] = null; // break the line between previous and current bar
      }
    }
    const stopPadded = [...stopBroken, ...new Array(PAD).fill(null)];
    const dirPadded  = [...direction,   ...new Array(PAD).fill(null)];

    datasets.push({
      _k: 'smc_sts',
      label: 'Sigmoid TS',
      data: stopPadded,
      borderWidth: 2,
      pointRadius: 0,
      fill: false,
      order: 40,
      segment: {
        borderColor: ctx => {
          const di = dirPadded[ctx.p1DataIndex];
          return di === 1 ? COL_BULL : di === -1 ? COL_BEAR : COL_GRAY;
        }
      },
      borderColor: COL_BULL, // fallback
      spanGaps: false,        // don't bridge null gaps
    });

    // Flip dots (where direction changes) — colored by NEW direction
    const flipData = new Array(totalLength).fill(null);
    for (let i = 1; i < n; i++) {
      if (direction[i] !== direction[i - 1]) flipData[i] = stop[i];
    }
    datasets.push({
      _k: 'smc_sts_flip',
      label: 'STS Flip',
      data: flipData,
      borderColor: 'transparent',
      backgroundColor: ctx => {
        const i = ctx.dataIndex;
        return i < n && direction[i] === 1 ? COL_BULL : COL_BEAR;
      },
      pointRadius: 4,
      pointHoverRadius: 5,
      showLine: false,
      order: 39,
    });
  }

  return { datasets, plugins, lastState };
}

// ─────────────────────────────────────────────────────────────────────────────
// Chart.js custom plugin to render zone labels and side-aligned high/low labels
// ─────────────────────────────────────────────────────────────────────────────
export function smcLabelPlugin(getLabels) {
  return {
    id: 'smcLabels',
    afterDatasetsDraw(chart) {
      const labels = getLabels();
      if (!labels || !labels.length) return;
      const { ctx, scales: { x, y }, chartArea } = chart;
      if (!chartArea) return;
      ctx.save();
      ctx.font = '600 9px var(--mono, monospace)';

      for (const lbl of labels) {
        if (lbl.type === 'label') {
          // right-aligned price label, offset above or below the line
          const lineY = y.getPixelForValue(lbl.y);
          if (lineY < chartArea.top || lineY > chartArea.bottom) continue;
          const OFFSET = 9; // px above/below the line
          const py = lbl.position === 'above' ? lineY - OFFSET
                  : lbl.position === 'below' ? lineY + OFFSET
                  : lineY;
          const text = lbl.text;
          const w = ctx.measureText(text).width + 8;
          const px = chartArea.right - 2;
          ctx.fillStyle = lbl.color + '20'; // background fade
          ctx.fillRect(px - w, py - 7, w, 14);
          ctx.fillStyle = lbl.color;
          ctx.textAlign = 'right';
          ctx.textBaseline = 'middle';
          ctx.fillText(text, px - 4, py);
        } else if (lbl.type === 'zoneLabel') {
          const px = x.getPixelForValue(lbl.x);
          const py = y.getPixelForValue(lbl.y);
          if (px < chartArea.left || px > chartArea.right) continue;
          if (py < chartArea.top || py > chartArea.bottom) continue;
          ctx.fillStyle = lbl.color;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(lbl.text, px, py);
        }
      }
      ctx.restore();
    }
  };
}

