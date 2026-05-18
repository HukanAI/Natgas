// js/widgets.js — EIA countdown, COT gauge, Futures curve, Weather heatmap, Market Overview
import { state } from './state.js';
import { dbLog } from './debug.js';
import { getSeasonInfo } from './season.js';
import { st5y } from './storage5y.js';
import { fairPrice } from './utils.js';

function $(id) { return document.getElementById(id); }
function css(prop) { return getComputedStyle(document.documentElement).getPropertyValue(prop).trim(); }

// ═══════════════════════════════════════════════════════════════════════════════
// 1. EIA COUNTDOWN BANNER
// ═══════════════════════════════════════════════════════════════════════════════

export function updateEIABanner() {
    const banner = $('eia-banner');
    if (!banner) return;

    const now = new Date();

    function isEDT(d) {
        const yr = d.getUTCFullYear();
        const mar = new Date(Date.UTC(yr, 2, 1));
        const dstStart = new Date(Date.UTC(yr, 2, 8 + (7 - mar.getUTCDay()) % 7, 6));
        const nov = new Date(Date.UTC(yr, 10, 1));
        const dstEnd = new Date(Date.UTC(yr, 10, 1 + (7 - nov.getUTCDay()) % 7, 6));
        return d >= dstStart && d < dstEnd;
    }

    function nextEIAUtc(from) {
        const etOffsetH = isEDT(from) ? 4 : 5;
        const reportHourUTC = 10 + etOffsetH;
        let d = new Date(from);
        const daysUntilThursday = (4 - d.getUTCDay() + 7) % 7;
        d.setUTCDate(d.getUTCDate() + daysUntilThursday);
        d.setUTCHours(reportHourUTC, 30, 0, 0);
        if (d <= from) d.setUTCDate(d.getUTCDate() + 7);
        return d;
    }

    const nextReport = nextEIAUtc(now);
    const msUntil = nextReport - now;
    const hoursUntil = msUntil / 3_600_000;
    const daysUntil = msUntil / 86_400_000;

    // ── Always-visible KPI card ───────────────────────────────────────────────
    const kpiDate = $('eia-kpi-date');
    const kpiEta  = $('eia-kpi-eta');
    const kpiCard = $('eia-kpi-card');
    if (kpiDate && kpiEta) {
        // Date in Prague time: "čt 22.5. 16:30"
        const pragueShort = nextReport.toLocaleString('en-GB', {
            timeZone: 'Europe/Prague',
            weekday: 'short', day: 'numeric', month: 'numeric',
            hour: '2-digit', minute: '2-digit'
        });
        kpiDate.textContent = pragueShort;

        // Countdown
        if (hoursUntil < 1) {
            const mins = Math.round(msUntil / 60000);
            kpiEta.textContent = 'in ' + mins + 'm';
        } else if (daysUntil < 1) {
            const h = Math.floor(hoursUntil), m = Math.round((hoursUntil - h) * 60);
            kpiEta.textContent = 'in ' + h + 'h ' + m + 'm';
        } else {
            const d = Math.floor(daysUntil), h = Math.round((daysUntil - d) * 24);
            kpiEta.textContent = 'in ' + d + 'd ' + h + 'h';
        }

        // Color card when close: yellow ≤2d, red ≤2h
        if (kpiCard) {
            kpiCard.style.boxShadow = hoursUntil <= 2
                ? 'inset 3px 0 0 #ff7b72'
                : daysUntil <= 2
                    ? 'inset 3px 0 0 #e3b341'
                    : 'inset 3px 0 0 #4493f8';
            const etaColor = hoursUntil <= 2 ? '#ff7b72' : daysUntil <= 2 ? '#e3b341' : '';
            kpiEta.style.color = etaColor;
        }
    }

    // ── Banner (≤2 days) ──────────────────────────────────────────────────────
    const pragueStr = nextReport.toLocaleString('en-GB', {
        timeZone: 'Europe/Prague',
        weekday: 'long', day: 'numeric', month: 'long',
        hour: '2-digit', minute: '2-digit'
    });

    if (daysUntil > 2) {
        banner.classList.remove('show', 'soon', 'imminent');
        return;
    }

    banner.classList.add('show');

    if (hoursUntil <= 2) {
        banner.classList.remove('soon'); banner.classList.add('imminent');
        $('eia-banner-ico').textContent = '🚨';
        $('eia-banner-main').textContent = 'EIA Storage Report — TODAY';
        $('eia-banner-sub').textContent = pragueStr + ' · Expect elevated volatility';
    } else if (hoursUntil <= 24) {
        banner.classList.remove('soon'); banner.classList.add('imminent');
        $('eia-banner-ico').textContent = '⚠️';
        $('eia-banner-main').textContent = 'EIA Storage Report — TOMORROW';
        const h = Math.floor(hoursUntil), m = Math.round((hoursUntil - h) * 60);
        $('eia-banner-sub').textContent = 'in ' + h + 'h ' + m + 'm · ' + pragueStr;
    } else {
        banner.classList.remove('imminent'); banner.classList.add('soon');
        $('eia-banner-ico').textContent = '📋';
        $('eia-banner-main').textContent = 'EIA Storage Report';
        const d = Math.floor(daysUntil), h = Math.round((daysUntil - d) * 24);
        $('eia-banner-sub').textContent = 'in ' + d + 'd ' + h + 'h · ' + pragueStr;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 2. COT REPORT KPI CARD
// CFTC releases every Friday at 15:30 ET (21:30 Prague CET / 20:30 CEST)
// Shows: latest data date + how old it is
// ═══════════════════════════════════════════════════════════════════════════════

export function updateCOTKpi() {
    const dateEl = $('cot-kpi-date');
    const etaEl  = $('cot-kpi-eta');
    const card   = $('cot-kpi-card');
    if (!dateEl || !etaEl) return;

    const now = new Date();

    // Next Friday 15:30 ET in UTC (ET = UTC-5 EST / UTC-4 EDT)
    function isEDT(d) {
        const yr = d.getUTCFullYear();
        const mar = new Date(Date.UTC(yr, 2, 1));
        const dstStart = new Date(Date.UTC(yr, 2, 8 + (7 - mar.getUTCDay()) % 7, 6));
        const nov = new Date(Date.UTC(yr, 10, 1));
        const dstEnd = new Date(Date.UTC(yr, 10, 1 + (7 - nov.getUTCDay()) % 7, 6));
        return d >= dstStart && d < dstEnd;
    }

    function nextCOTUtc(from) {
        const etOffsetH = isEDT(from) ? 4 : 5;
        const reportHourUTC = 15 + etOffsetH; // 15:30 ET = 19:30 or 20:30 UTC
        let d = new Date(from);
        const daysUntilFriday = (5 - d.getUTCDay() + 7) % 7;
        d.setUTCDate(d.getUTCDate() + daysUntilFriday);
        d.setUTCHours(reportHourUTC, 30, 0, 0);
        if (d <= from) d.setUTCDate(d.getUTCDate() + 7);
        return d;
    }

    const nextRelease = nextCOTUtc(now);
    const msUntil = nextRelease - now;
    const hoursUntil = msUntil / 3_600_000;
    const daysUntil = msUntil / 86_400_000;

    // Prague display time
    const pragueShort = nextRelease.toLocaleString('en-GB', {
        timeZone: 'Europe/Prague',
        weekday: 'short', day: 'numeric', month: 'numeric',
        hour: '2-digit', minute: '2-digit'
    });
    dateEl.textContent = pragueShort;

    // Countdown
    if (hoursUntil < 1) {
        const mins = Math.round(msUntil / 60000);
        etaEl.textContent = 'in ' + mins + 'm';
    } else if (daysUntil < 1) {
        const h = Math.floor(hoursUntil), m = Math.round((hoursUntil - h) * 60);
        etaEl.textContent = 'in ' + h + 'h ' + m + 'm';
    } else {
        const d = Math.floor(daysUntil), h = Math.round((daysUntil - d) * 24);
        etaEl.textContent = 'in ' + d + 'd ' + h + 'h';
    }

    // Color: imminent (≤2h) = red, close (≤1d) = yellow, normal = purple
    if (card) {
        const accent = hoursUntil <= 2 ? '#ff7b72' : daysUntil <= 1 ? '#e3b341' : '#a371f7';
        card.style.boxShadow = 'inset 3px 0 0 ' + accent;
        etaEl.style.color = hoursUntil <= 2 ? '#ff7b72' : daysUntil <= 1 ? '#e3b341' : '';
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 3. COT PERCENTILE GAUGE
// ═══════════════════════════════════════════════════════════════════════════════

export function updateCOTGauge() {
    const fill = $('cot-gauge-fill');
    const pctEl = $('cot-gauge-pct');
    if (!fill || !pctEl) return;
    const cd = state.cotData;
    if (!cd || cd.length < 8) return;

    const latest = cd[cd.length - 1].mmNet;
    const window260 = cd.slice(-260);
    const nets = window260.map(r => r.mmNet).sort((a, b) => a - b);
    const idx = nets.findIndex(v => v >= latest);
    const pct = idx < 0 ? 100 : Math.round((idx / nets.length) * 100);

    let color, label;
    if (pct <= 15)      { color = '#3fb950'; label = pct + '% ↑contra-bull'; }
    else if (pct <= 35) { color = '#7ec97f'; label = pct + '%'; }
    else if (pct <= 65) { color = '#9ba3ad'; label = pct + '%'; }
    else if (pct <= 85) { color = '#ffb085'; label = pct + '%'; }
    else                { color = '#ff7b72'; label = pct + '% ↓contra-bear'; }

    fill.style.width = pct + '%';
    fill.style.background = color;
    pctEl.textContent = label;
    pctEl.style.color = color;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 3. FUTURES CURVE CHART
// ═══════════════════════════════════════════════════════════════════════════════

let _fwChart = null;

export function renderFuturesCurve() {
    const canvas = $('fw-chart-canvas');
    const wrap = $('fw-wrap');
    const spin = $('fw-spin');
    if (!canvas || !wrap || !spin) return;

    const data = state.fcContractsData;
    if (!data || !data.length || !data.some(c => c.price != null)) return;

    const valid = data.filter(c => c.price != null);
    if (!valid.length) return;

    spin.style.display = 'none';
    wrap.style.display = 'block';

    const textCol = css('--text3') || '#6e7681';
    const gridCol = css('--border') || '#1f242c';
    const prices = valid.map(c => c.price);
    const pointColors = valid.map(c => c.isFront ? '#e3b341' : c.isNext ? '#3fb950' : '#4493f8');
    const pointRadius = valid.map(c => (c.isFront || c.isNext) ? 6 : 3.5);

    // Fix: contango = later months MORE expensive (next > front = upward sloping)
    const frontPrice = valid.find(c => c.isFront)?.price;
    const nextPrice  = valid.find(c => c.isNext)?.price;
    const noteEl = $('fw-note');
    if (noteEl && frontPrice != null && nextPrice != null) {
        const spread = nextPrice - frontPrice;
        const isContango = spread > 0.02;
        const isBackward = spread < -0.02;
        const shape = isContango ? 'Contango' : isBackward ? 'Backwardation' : 'Flat';
        const shapeCol = isContango ? '#ff7b72' : isBackward ? '#3fb950' : '#9ba3ad';
        noteEl.textContent = shape + ' (' + (spread >= 0 ? '+' : '') + spread.toFixed(3) + ')';
        noteEl.style.color = shapeCol;
    }

    const yMin = Math.floor((Math.min(...prices) - 0.1) * 10) / 10;
    const yMax = Math.ceil((Math.max(...prices) + 0.1) * 10) / 10;

    if (_fwChart) { _fwChart.destroy(); _fwChart = null; }

    _fwChart = new Chart(canvas, {        type: 'line',
        data: { labels: valid.map(c => c.label), datasets: [{
            label: 'Price', data: prices,
            borderColor: '#4493f8', backgroundColor: 'transparent', borderWidth: 2,
            pointRadius, pointBackgroundColor: pointColors,
            pointBorderColor: '#11151c', pointBorderWidth: 1.5, tension: 0.2,
        }]},
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: '#1c2128', borderColor: 'rgba(255,255,255,0.08)',
                    borderWidth: 1, titleColor: '#e6edf3', bodyColor: '#9ba3ad', padding: 10,
                    callbacks: { label: ctx => {
                        const c = valid[ctx.dataIndex];
                        let s = '$' + ctx.parsed.y.toFixed(3);
                        if (c.isFront) s += ' · Front month';
                        else if (c.isNext) s += ' · Next contract';
                        if (c.spread != null) s += ' · spread ' + (c.spread >= 0 ? '+' : '') + c.spread.toFixed(3);
                        return s;
                    }}
                }
            },
            scales: {
                x: { grid: { color: gridCol }, ticks: { color: textCol, font: { size: 10, family: 'var(--mono, monospace)' }, maxRotation: 0, autoSkip: true } },
                y: { min: yMin, max: yMax, grid: { color: gridCol },
                    afterBuildTicks: axis => {
                        const range = yMax - yMin;
                        const step = range > 1.5 ? 0.25 : range > 0.8 ? 0.20 : 0.10;
                        const start = Math.ceil(yMin / step) * step;
                        const ticks = [];
                        for (let v = start; v <= yMax + 0.001; v += step) ticks.push({ value: Math.round(v * 100) / 100 });
                        axis.ticks = ticks;
                    },
                    ticks: { color: textCol, font: { size: 10, family: 'var(--mono, monospace)' }, callback: v => '$' + v.toFixed(2) }
                }
            }
        }
    });
    try { updateFuturesTimestamp(); } catch(e) {}
}

// ═══════════════════════════════════════════════════════════════════════════════
// 4. WEATHER DEMAND — compact bar chart (demand vs 5y avg + range band)
// ═══════════════════════════════════════════════════════════════════════════════

let _hmChart = null;

export function renderWeatherHeatmap() {
    const wrap  = $('hm-wrap');
    const spin  = $('hm-spin');
    const canvas = $('hm-canvas');
    if (!wrap || !spin || !canvas) return;

    const wx = state.wxS;
    if (!wx || !wx.demAll || !wx.dem5avg || wx.todayIdx == null) return;

    spin.style.display = 'none';
    wrap.style.display = 'block';

    const { labels, demAll, dem5avg, dem5min, dem5max, todayIdx } = wx;

    // Slice to 7 history + today + 16 forecast = 24 points
    const from = Math.max(0, todayIdx - 7);
    const to   = Math.min(demAll.length - 1, todayIdx + 16);

    const sliceLabels = labels.slice(from, to + 1);
    const sliceDem    = demAll.slice(from, to + 1);
    const sliceAvg    = dem5avg.slice(from, to + 1);
    const sliceMin    = dem5min.slice(from, to + 1);
    const sliceMax    = dem5max.slice(from, to + 1);
    const localToday  = todayIdx - from;

    const textCol = css('--text3') || '#6e7681';
    const gridCol = css('--border') || '#1f242c';

    // Bar colors: history = purple, forecast = green/red by vs 5y avg, saturated if outside 5y range
    const barColors = sliceDem.map((v, i) => {
        const isForecast = i > localToday;
        const aboveAvg = v != null && sliceAvg[i] != null && v >= sliceAvg[i];
        if (isForecast) {
            const aboveMax = v != null && sliceMax[i] != null && v > sliceMax[i];
            const belowMin = v != null && sliceMin[i] != null && v < sliceMin[i];
            if (aboveMax) return 'rgba(63,185,80,0.95)';   // sytá zelená — nad 5y range
            if (aboveAvg) return 'rgba(63,185,80,0.65)';   // normální zelená — nad avg
            if (belowMin) return 'rgba(255,123,114,0.95)'; // sytá červená — pod 5y range
            return 'rgba(255,123,114,0.65)';               // normální červená — pod avg
        }
        return aboveAvg ? 'rgba(163,113,247,0.85)' : 'rgba(163,113,247,0.5)';
    });

    // labels are in "d.m.yyyy" format (from shortDate in utils.js) — strip year
    const shortLabels = sliceLabels.map((lbl, i) => {
        if (i === localToday) return '';   // today shown via vertical line
        if (!lbl || typeof lbl !== 'string') return '';
        // Format: "16.5.2025" → "16.5."
        const parts = lbl.split('.');
        if (parts.length >= 2) return parts[0] + '.' + parts[1] + '.';
        return lbl;
    });

    if (_hmChart) { _hmChart.destroy(); _hmChart = null; }

    // Band plugin — draws 5y min/max shaded area
    const bandPlugin = {
        id: 'hmBand',
        beforeDatasetsDraw(chart) {
            const { ctx, scales: { x, y } } = chart;
            const minDs = chart.data.datasets.findIndex(d => d._k === 'dmin');
            const maxDs = chart.data.datasets.findIndex(d => d._k === 'dmax');
            if (minDs < 0 || maxDs < 0) return;
            const minData = chart.data.datasets[minDs].data;
            const maxData = chart.data.datasets[maxDs].data;
            ctx.save();
            ctx.fillStyle = 'rgba(200,200,200,0.12)';
            ctx.beginPath();
            minData.forEach((v, i) => {
                if (v == null) return;
                const px = x.getPixelForValue(i);
                const py = y.getPixelForValue(v);
                if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
            });
            for (let i = maxData.length - 1; i >= 0; i--) {
                const v = maxData[i];
                if (v == null) continue;
                ctx.lineTo(x.getPixelForValue(i), y.getPixelForValue(v));
            }
            ctx.closePath();
            ctx.fill();
            ctx.restore();
        }
    };

    // Today vertical line plugin
    const todayPlugin = {
        id: 'hmToday',
        afterDatasetsDraw(chart) {
            const { ctx, scales: { x, y } } = chart;

            // Today line — yellow
            const px = x.getPixelForValue(localToday);
            ctx.save();
            ctx.strokeStyle = '#e3b341';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(px, y.top);
            ctx.lineTo(px, y.bottom);
            ctx.stroke();
            ctx.font = '600 9px var(--mono,monospace)';
            ctx.fillStyle = '#e3b341';
            ctx.textAlign = 'right';
            ctx.fillText('today', px - 4, y.top + 11);

            // +7D line — same style, dimmer color
            const local7D = localToday + 7;
            if (local7D < shortLabels.length) {
                const px7 = x.getPixelForValue(local7D);
                ctx.strokeStyle = 'rgba(227,179,65,0.45)';
                ctx.lineWidth = 1.5;
                ctx.setLineDash([3, 3]);
                ctx.beginPath();
                ctx.moveTo(px7, y.top);
                ctx.lineTo(px7, y.bottom);
                ctx.stroke();
                ctx.font = '500 9px var(--mono,monospace)';
                ctx.fillStyle = 'rgba(227,179,65,0.6)';
                ctx.textAlign = 'right';
                ctx.fillText('+7D', px7 - 4, y.top + 11);
            }

            ctx.restore();
        }
    };

    _hmChart = new Chart(canvas, {
        type: 'bar',
        plugins: [bandPlugin, todayPlugin],
        data: {
            labels: shortLabels,
            datasets: [
                { _k: 'dem',  label: 'Demand',  data: sliceDem, backgroundColor: barColors,
                  borderColor: sliceDem.map((v, i) => {
                      if (i <= localToday) return 'rgba(163,113,247,0.9)';
                      const aboveAvg = v != null && sliceAvg[i] != null && v >= sliceAvg[i];
                      const aboveMax = v != null && sliceMax[i] != null && v > sliceMax[i];
                      const belowMin = v != null && sliceMin[i] != null && v < sliceMin[i];
                      if (aboveMax) return 'rgba(63,185,80,1.0)';
                      if (aboveAvg) return 'rgba(63,185,80,0.9)';
                      if (belowMin) return 'rgba(255,123,114,1.0)';
                      return 'rgba(255,123,114,0.9)';
                  }),
                  borderWidth: 1, order: 2, borderRadius: 2 },
                { _k: 'd5a',  label: '5y avg',  data: sliceAvg, type: 'line',
                  borderColor: 'rgba(230,237,243,0.7)', borderWidth: 2,
                  borderDash: [4, 3], pointRadius: 0, fill: false, order: 1 },
                { _k: 'dmin', label: '5y min',  data: sliceMin, type: 'line', borderColor: 'transparent', pointRadius: 0, fill: false, order: 3 },
                { _k: 'dmax', label: '5y max',  data: sliceMax, type: 'line', borderColor: 'transparent', pointRadius: 0, fill: false, order: 3 },
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: '#1c2128',
                    borderColor: 'rgba(255,255,255,0.08)',
                    borderWidth: 1,
                    titleColor: '#e6edf3',
                    bodyColor: '#9ba3ad',
                    padding: 10,
                    filter: item => item.dataset._k !== 'dmin' && item.dataset._k !== 'dmax',
                    callbacks: {
                        title: items => sliceLabels[items[0]?.dataIndex] || '',
                        label: ctx => {
                            if (ctx.dataset._k === 'dmin' || ctx.dataset._k === 'dmax') return null;
                            return ctx.dataset.label + ': ' + (ctx.parsed.y != null ? ctx.parsed.y.toFixed(1) : 'N/A');
                        },
                        afterBody: items => {
                            const i = items[0]?.dataIndex;
                            if (i == null) return [];
                            const mn = sliceMin[i], mx = sliceMax[i];
                            return (mn != null && mx != null) ? ['5y range: ' + mn.toFixed(1) + '–' + mx.toFixed(1)] : [];
                        }
                    }
                }
            },
            scales: {
                x: {
                    grid: { color: gridCol },
                    ticks: {
                        color: (ctx) => ctx.index === localToday ? '#e3b341' : textCol,
                        font: { size: 10, family: 'var(--mono, monospace)' },
                        maxRotation: 0,
                        autoSkip: true,
                        maxTicksLimit: 12,
                        callback: (val, index) => shortLabels[index] ?? '',
                    }
                },
                y: {
                    grid: { color: gridCol },
                    ticks: {
                        color: textCol,
                        font: { size: 10, family: 'var(--mono, monospace)' },
                        maxTicksLimit: 5,
                        callback: v => v.toFixed(0)
                    }
                }
            }
        }
    });
}
// ═══════════════════════════════════════════════════════════════════════════════
// 5. MARKET OVERVIEW — signal scoring panel
// ═══════════════════════════════════════════════════════════════════════════════

// Score values
const SCORE = { bullish: 1, slightly_bullish: 0.5, neutral: 0, slightly_bearish: -0.5, bearish: -1 };

function sentiment(score) {
    if (score >= 1)    return { key: 'bullish',          label: 'Bullish',          col: '#3fb950' };
    if (score >= 0.5)  return { key: 'slightly_bullish', label: 'Slightly Bullish', col: '#7ec97f' };
    if (score > -0.5)  return { key: 'neutral',          label: 'Neutral',          col: '#9ba3ad' };
    if (score > -1)    return { key: 'slightly_bearish', label: 'Slightly Bearish', col: '#ffb085' };
    return              { key: 'bearish',                label: 'Bearish',          col: '#ff7b72' };
}

// Overall score uses absolute thresholds (scale −6.5 to +6.5)
function overallSentiment(total) {
    if (total >= 3.5)  return { key: 'bullish',          label: 'Bullish',          col: '#3fb950' };
    if (total >= 1.5)  return { key: 'slightly_bullish', label: 'Slightly Bullish', col: '#7ec97f' };
    if (total > -1.5)  return { key: 'neutral',          label: 'Neutral',          col: '#9ba3ad' };
    if (total > -3.5)  return { key: 'slightly_bearish', label: 'Slightly Bearish', col: '#ffb085' };
    return              { key: 'bearish',                label: 'Bearish',          col: '#ff7b72' };
}

function demHorizonFull(from, to) {
    // Returns { pct, rangePos, outsideRange, aboveMax, belowMin, demSum, avgSum, minSum, maxSum }
    const wx = state.wxS;
    if (!wx || !wx.demAll || !wx.dem5avg || !wx.dem5min || !wx.dem5max || wx.todayIdx == null) return null;
    const { demAll, dem5avg, dem5min, dem5max, todayIdx } = wx;
    let demSum = 0, avgSum = 0, minSum = 0, maxSum = 0, n = 0;
    const start = todayIdx + from, end = Math.min(todayIdx + to, demAll.length);
    for (let i = start; i < end; i++) {
        if (demAll[i] != null && dem5avg[i] != null && dem5min[i] != null && dem5max[i] != null) {
            demSum += demAll[i]; avgSum += dem5avg[i];
            minSum += dem5min[i]; maxSum += dem5max[i]; n++;
        }
    }
    if (!n || avgSum === 0) return null;
    const pct = (demSum - avgSum) / avgSum * 100;
    const rangeSize = maxSum - minSum;
    const rangePos = rangeSize > 0 ? (demSum - minSum) / rangeSize : 0.5; // 0=at min, 0.5=at avg, 1=at max
    const aboveMax = demSum > maxSum;
    const belowMin = demSum < minSum;
    // Position within range as % of range (can be >100% or <0%)
    const rangePct = rangeSize > 0 ? ((demSum - avgSum) / rangeSize * 100) : 0;
    return { pct, rangePos, outsideRange: aboveMax || belowMin, aboveMax, belowMin, demSum, avgSum, minSum, maxSum, rangePct };
}

function signalWeatherShort() {
    const d = demHorizonFull(0, 7);
    if (!d) return { score: 0, label: 'Neutral', detail: 'No data', explanation: '', fullMethodology: [] };

    const { pct, rangePos, aboveMax, belowMin, rangePct } = d;

    let score;

    if (aboveMax) {
        // Above 5y max — historical outlier, not priced in
        score = 1;
    } else if (belowMin) {
        // Below 5y min — historical outlier bearish
        score = -1;
    } else if (pct >= 20) {
        // Top of range, strongly above avg
        score = 1;
    } else if (pct >= 10) {
        // Upper half of range, clearly above avg
        score = rangePos > 0.75 ? 1 : 0.5; // near top of range = full bull
    } else if (pct >= 0) {
        // Slightly above avg
        score = rangePos > 0.65 ? 0.5 : 0; // near upper range = slight bull
    } else if (pct >= -10) {
        // Slightly below avg
        score = rangePos < 0.35 ? -0.5 : 0; // near lower range = slight bear
    } else if (pct >= -20) {
        // Lower half of range, clearly below avg
        score = rangePos < 0.25 ? -1 : -0.5; // near bottom of range = full bear
    } else {
        score = -1;
    }

    const s = sentiment(score);
    const rangeStr = aboveMax ? 'ABOVE 5y max' : belowMin ? 'BELOW 5y min' :
        (rangePos * 100).toFixed(0) + '% of 5y range';
    const detail = `1–7D demand ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}% vs 5y avg · ${rangeStr}`;

    return { score, label: s.label, col: s.col, detail,
        explanation: `Short-term demand sum (days 1–7) vs 5-year average: ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%. ` +
            `Position in 5y range: ${rangeStr}. ` +
            (aboveMax ? 'Demand exceeds all 5y observations — strong unpriced bullish surprise.' :
             belowMin ? 'Demand below all 5y observations — strong unpriced bearish surprise.' :
             `Range position determines whether ${pct >= 0 ? 'bullish' : 'bearish'} signal is full (+1) or partial (+0.5).`),
        fullMethodology: [
            { state: 'Bullish +1',          col: '#3fb950', cond: 'Demand above 5y max (historical outlier)',         note: 'Never seen in 5y — completely unpriced, market shock' },
            { state: 'Bullish +1',          col: '#3fb950', cond: '≥ +20% vs avg OR +10–20% near top of range',      note: 'Exceptional demand — polar vortex / extreme heat wave territory' },
            { state: 'Slightly Bullish +0.5', col: '#7ec97f', cond: '+10% to +20% vs avg, mid-upper range',          note: 'Strong but within historical norms — partially priced in' },
            { state: 'Slightly Bullish +0.5', col: '#7ec97f', cond: '0% to +10% vs avg, near top of range (>65%)',   note: 'Modest demand but little upside room — surprise risk skewed down' },
            { state: 'Neutral 0',            col: '#9ba3ad', cond: '±10% vs avg, middle of 5y range',               note: 'Normal seasonal variation — no directional signal' },
            { state: 'Slightly Bearish −0.5', col: '#ffb085', cond: '−10% to 0% vs avg, near bottom of range (<35%)', note: 'Modest weakness but little downside room — surprise risk skewed up' },
            { state: 'Slightly Bearish −0.5', col: '#ffb085', cond: '−10% to −20% vs avg, mid-lower range',         note: 'Weak demand but within historical norms' },
            { state: 'Bearish −1',           col: '#ff7b72', cond: '≤ −20% vs avg OR −10–20% near bottom of range', note: 'Exceptional weakness — unusually warm winter / cold summer' },
            { state: 'Bearish −1',           col: '#ff7b72', cond: 'Demand below 5y min (historical outlier)',       note: 'Never seen in 5y — completely unpriced bearish shock' },
        ]
    };
}

function signalWeatherLong() {
    const d = demHorizonFull(7, 16);
    if (!d) return { score: 0, label: 'Neutral', detail: 'No data', explanation: '', fullMethodology: [] };

    const { pct, rangePos, aboveMax, belowMin } = d;

    // Long-term GFS (8–16D) has much lower accuracy — cap at ±0.5
    // Only trigger on truly extreme signals: outside 5y range OR ≥20% vs avg
    let score;
    if (aboveMax || pct >= 20) {
        score = 0.5;
    } else if (belowMin || pct <= -20) {
        score = -0.5;
    } else {
        score = 0; // Wide neutral band — GFS uncertainty too high for partial signals
    }

    const s = sentiment(score);
    const rangeStr = aboveMax ? 'ABOVE 5y max' : belowMin ? 'BELOW 5y min' :
        (rangePos * 100).toFixed(0) + '% of 5y range';
    const detail = `8–16D demand ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}% vs 5y avg · ${rangeStr}`;

    return { score, label: s.label, col: s.col, detail,
        explanation: `Forward demand sum (days 8–16) vs 5-year average: ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%. ` +
            `GFS at this horizon has significantly lower accuracy — only extreme signals count. ` +
            (aboveMax ? 'Demand projects above all 5y observations — if verified, strongly bullish.' :
             belowMin ? 'Demand projects below all 5y observations — if verified, strongly bearish.' :
             'Score capped at ±0.5 max — GFS uncertainty too high for stronger signal.'),
        fullMethodology: [
            { state: 'Slightly Bullish +0.5', col: '#7ec97f', cond: 'Demand above 5y max OR ≥ +20% vs avg',          note: 'Only extreme outliers count at this horizon. GFS variability still high — watch for revisions.' },
            { state: 'Neutral 0',             col: '#9ba3ad', cond: 'Demand within 5y range AND within ±20% of avg', note: 'Wide neutral band. GFS at 8–16D is often off by 10–15% vs reality. No actionable signal.' },
            { state: 'Slightly Bearish −0.5', col: '#ffb085', cond: 'Demand below 5y min OR ≤ −20% vs avg',         note: 'Only extreme outliers count. Maximum score is −0.5 regardless of severity — forecast uncertainty too high for full bearish.' },
            { state: '⚠ Note',                col: '#9ba3ad', cond: 'Score never reaches ±1 for long-term',         note: 'Even the most extreme 14D GFS forecast is discounted by traders until it enters the 1–7D window.' },
        ]
    };
}

function signalStorageTrend() {
    const sd = state.stStorageData;
    if (!sd || sd.length < 2) return { score: 0, label: 'Neutral', detail: 'No data', explanation: '', fullMethodology: [] };

    // Get deviation Bcf and 5y range for each horizon
    function getPoint(val, date) {
        const b = st5y(sd, [date])[0];
        if (!b || b.avg == null) return null;
        const dev = val - b.avg;  // deviation vs 5y avg in Bcf
        const rangeSize = (b.max != null && b.min != null) ? b.max - b.min : null;
        // rangePos: position of absolute val within 5y min–max range
        // 0 = at 5y min storage, 1 = at 5y max storage
        const rangePos = (rangeSize != null && rangeSize > 0) ? (val - b.min) / rangeSize : null;
        const aboveMax = b.max != null && val > b.max;  // above historical max storage
        const belowMin = b.min != null && val < b.min;  // below historical min storage
        return { dev, val, avg: b.avg, min: b.min, max: b.max, rangePos, aboveMax, belowMin };
    }

    const lat = sd[sd.length - 1];
    const p0  = getPoint(lat.value, lat.date);
    const p7  = state.stLastF7?.predictedLevel  != null ? getPoint(state.stLastF7.predictedLevel,  state.stLastF7.endDate)  : null;
    const p14 = state.stLastF14?.predictedLevel != null ? getPoint(state.stLastF14.predictedLevel, state.stLastF14.endDate) : null;
    const p21 = state.stLastF21?.predictedLevel != null ? getPoint(state.stLastF21.predictedLevel, state.stLastF21.endDate) : null;

    if (!p0) return { score: 0, label: 'Neutral', detail: 'No data', explanation: '', fullMethodology: [] };

    const bcfPts = [p0, p7, p14, p21].filter(Boolean).map(p => p.dev);
    if (bcfPts.length < 2) return { score: 0, label: 'Neutral', detail: 'Insufficient data', explanation: '', fullMethodology: [] };

    // Linear regression slope (Bcf/step, 1 step = 7 days)
    function linSlope(pts) {
        const n = pts.length;
        const xm = (n - 1) / 2;
        const ym = pts.reduce((a, b) => a + b) / n;
        const num = pts.reduce((s, y, i) => s + (i - xm) * (y - ym), 0);
        const den = pts.reduce((s, _, i) => s + (i - xm) ** 2, 0);
        return den > 0 ? num / den : 0;
    }

    const slopeBcf = linSlope(bcfPts); // Bcf change per 7-day step

    // Current range position (key metric)
    const rp        = p0.rangePos;   // null if no range data
    const aboveMax  = p0.aboveMax;
    const belowMin  = p0.belowMin;

    // Crossover analysis: steps until dev crosses zero within 21D window
    const nowDev = p0.dev;
    let crossoverDays = null;
    if (slopeBcf !== 0) {
        const steps = -nowDev / slopeBcf;
        if (steps > 0 && steps <= 3) crossoverDays = Math.round(steps * 7);
    }
    const crossoverSoon = crossoverDays !== null;

    // ── Scoring ───────────────────────────────────────────────────────────────
    let score;

    if (belowMin) {
        // Below 5y min — historical bullish outlier
        score = slopeBcf <= 0 ? 1 : 0.5;

    } else if (aboveMax) {
        // Above 5y max — historical bearish outlier
        score = slopeBcf >= 0 ? -1 : -0.5;

    } else if (rp !== null && rp < 0.25) {
        // Bottom quarter of range — bullish territory
        if (slopeBcf <= -15)     score = 1;    // deepening deficit / shrinking low surplus fast
        else if (slopeBcf <= 0)  score = 0.5;  // stable or improving
        else                     score = 0;    // surplus building but still low

    } else if (rp !== null && rp > 0.75) {
        // Top quarter of range — bearish territory
        if (slopeBcf <= -20)     score = 0;    // declining aggressively — improvement but still high
        else if (slopeBcf <= 0)  score = -0.5; // slow decline — high surplus persists
        else                     score = -1;   // growing from already high levels

    } else {
        // Middle of range (0.25–0.75) — trend is the primary driver
        if (crossoverSoon && slopeBcf < 0)     score = 1;    // crossing into deficit within 21D
        else if (crossoverSoon && slopeBcf > 0) score = -1;  // crossing into surplus within 21D
        else if (slopeBcf <= -20)              score = 0.5;  // declining fast toward lower half
        else if (slopeBcf <= -8)               score = 0;    // mild improvement
        else if (slopeBcf <= 8)                score = 0;    // stable
        else if (slopeBcf <= 20)               score = -0.5; // mild deterioration
        else                                   score = -1;   // building fast toward upper half
    }

    const s = sentiment(score);

    // Format detail
    const fmtDev = p => p ? (p.dev >= 0 ? '+' : '') + Math.round(p.dev) + ' Bcf' : 'N/A';
    const fmtRpShort = p => {
        if (!p) return '';
        if (p.aboveMax) return 'historically VERY HIGH';
        if (p.belowMin) return 'historically VERY LOW';
        if (p.rangePos != null) {
            const pct = p.rangePos;
            return pct > 0.75 ? 'historically HIGH' :
                   pct > 0.5  ? 'above 5y midpoint' :
                   pct > 0.25 ? 'below 5y midpoint' : 'historically LOW';
        }
        return '';
    };
    const fmtRp = p => {
        if (!p) return '';
        if (p.aboveMax) return `historically VERY HIGH (above 5y max ${Math.round(p.max)} Bcf)`;
        if (p.belowMin) return `historically VERY LOW (below 5y min ${Math.round(p.min)} Bcf)`;
        if (p.rangePos != null) {
            const pct = p.rangePos;
            const label = pct > 0.75 ? 'historically HIGH' :
                          pct > 0.5  ? 'above 5y midpoint' :
                          pct > 0.25 ? 'below 5y midpoint' : 'historically LOW';
            return `${label} (5y: ${Math.round(p.min)}–${Math.round(p.max)} Bcf)`;
        }
        return '';
    };

    const crossStr = crossoverSoon
        ? ` · crossover ~${crossoverDays}d`
        : '';

    const detail = `Now ${fmtDev(p0)} · ${fmtRpShort(p0)} · slope ${slopeBcf >= 0 ? '+' : ''}${Math.round(slopeBcf)} Bcf/wk · +21D ${fmtDev(p21)} (${fmtRpShort(p21)})${crossStr}`;

    const explanation =
        `Storage deviation vs 5y avg: ${fmtDev(p0)}, ${fmtRp(p0)}. ` +
        `Trend slope: ${slopeBcf >= 0 ? '+' : ''}${Math.round(slopeBcf)} Bcf/week. ` +
        (crossoverSoon ? `Crossover projected in ~${crossoverDays} days. ` : '') +
        `Signal combines range position (where we are vs 5y history) + slope (direction and speed) + crossover within 21D.`;

    return { score, label: s.label, col: s.col, detail, explanation,
        fullMethodology: [
            { state: 'Bullish +1',            col: '#3fb950', cond: 'Storage below 5y min + slope ≤ 0 Bcf/wk',                    note: 'Historically lowest supply in 5 years — deepening or stable deficit. Maximum bullish.' },
            { state: 'Bullish +1',            col: '#3fb950', cond: 'Storage historically LOW (bottom 25% of 5y range) + slope ≤ −15 Bcf/wk', note: 'Tight supply improving rapidly. Strong upward price pressure.' },
            { state: 'Bullish +1',            col: '#3fb950', cond: 'Storage near middle of 5y range + crossover to deficit within 21D', note: 'Imminent structural shift to deficit — market reprices sharply.' },
            { state: 'Slightly Bullish +0.5', col: '#7ec97f', cond: 'Storage below 5y min + slope > 0 (slowly recovering)',        note: 'Historically tight but deficit reducing. Still very supportive for prices.' },
            { state: 'Slightly Bullish +0.5', col: '#7ec97f', cond: 'Storage historically LOW + slope 0 to −15 Bcf/wk',           note: 'Low range position, stable or slowly improving.' },
            { state: 'Slightly Bullish +0.5', col: '#7ec97f', cond: 'Storage near middle of 5y range + slope ≤ −20 Bcf/wk',       note: 'Declining fast from middle — approaching historically tight levels.' },
            { state: 'Neutral 0',             col: '#9ba3ad', cond: 'Storage historically LOW + slope > 0 (building)',            note: 'Tight but surplus building — bullish cushion eroding.' },
            { state: 'Neutral 0',             col: '#9ba3ad', cond: 'Storage near middle of 5y range + slope −8 to +8 Bcf/wk',    note: 'No directional signal — wait for trend to develop.' },
            { state: 'Neutral 0',             col: '#9ba3ad', cond: 'Storage historically HIGH + declining fast (≤ −20 Bcf/wk)',  note: 'Improving but storage still historically high — too early to be bullish.' },
            { state: 'Slightly Bearish −0.5', col: '#ffb085', cond: 'Storage near middle + slope +8 to +20 Bcf/wk',             note: 'Building toward historically high levels — bearish pressure developing.' },
            { state: 'Slightly Bearish −0.5', col: '#ffb085', cond: 'Storage historically HIGH (top 25%) + slow decline',        note: 'High storage persists with insufficient improvement — bearish overhang.' },
            { state: 'Slightly Bearish −0.5', col: '#ffb085', cond: 'Storage above 5y max + slope < 0 (slowly improving)',       note: 'Historically highest storage in 5 years but declining — some relief.' },
            { state: 'Bearish −1',            col: '#ff7b72', cond: 'Storage near middle + crossover to surplus within 21D',     note: 'Imminent shift from deficit to surplus — sharp bearish reversal.' },
            { state: 'Bearish −1',            col: '#ff7b72', cond: 'Storage near middle + slope ≥ +20 Bcf/wk',                 note: 'Rapidly building toward historically high levels.' },
            { state: 'Bearish −1',            col: '#ff7b72', cond: 'Storage historically HIGH (top 25%) + stable or growing',  note: 'High storage not improving = persistent bearish pressure.' },
            { state: 'Bearish −1',            col: '#ff7b72', cond: 'Storage above 5y max + stable or growing',                 note: 'Historically highest storage in 5 years and worsening. Maximum bearish.' },
        ]
    };
}

function signalMMNet() {
    const cd = state.cotData;
    if (!cd || cd.length < 8) return { score: 0, label: 'Neutral', detail: 'No data', explanation: '' };

    const latest = cd[cd.length - 1].mmNet;
    const nets = cd.slice(-260).map(r => r.mmNet).sort((a, b) => a - b);
    const idx = nets.findIndex(v => v >= latest);
    const pct = idx < 0 ? 100 : Math.round((idx / nets.length) * 100);

    let score;
    if (pct <= 15)      score = 1;   // extreme net-short = contra-bull
    else if (pct >= 85) score = -1;  // extreme net-long = contra-bear
    else                score = 0;

    const s = sentiment(score);
    return { score, label: s.label, col: s.col,
        detail: `MM Net: ${latest >= 0 ? '+' : ''}${latest.toLocaleString()} contracts · ${pct}th percentile (5y)`,
        explanation: 'Managed Money net position in the 5-year trailing distribution. ≤15th percentile (extreme net-short) = contra-bullish signal. ≥85th = contra-bearish. Between = Neutral. Extreme positioning historically precedes reversals.',
        fullMethodology: [
            { state: 'Bullish',  col: '#3fb950', cond: 'MM Net percentile ≤ 15th (5y trailing)',        note: 'Extreme net-short positioning — historically a contrarian buy signal. Crowded shorts precede short-covering rallies.' },
            { state: 'Neutral',  col: '#9ba3ad', cond: 'MM Net percentile 16th–84th',                  note: 'Positioning within normal historical range — no strong contrarian signal.' },
            { state: 'Bearish',  col: '#ff7b72', cond: 'MM Net percentile ≥ 85th (5y trailing)',       note: 'Extreme net-long positioning — historically a contrarian sell signal. Crowded longs precede long liquidation.' },
        ] };
}

function signalSeason() {
    const si = getSeasonInfo();
    const { isHeating, daysLeft, daysIn, sTotal, nxtName, month } = si;
    const isCooling  = si.name === 'Cooling';
    const isShoulder = si.name === 'Shoulder';

    let score, detail, explanation;

    // ── TRANSITION WINDOWS (≤21 days to next season) ─────────────────────────
    if (daysLeft <= 21) {
        if (isHeating || isCooling) {
            // Leaving active season → entering shoulder
            if (isHeating) {
                // End of heating = aggressive bearish: traders short before shoulder
                score = -1;
                detail = `Heating ending in ${daysLeft}d → Shoulder`;
                explanation = `Within 21 days of entering Shoulder season from Heating. Traders typically sell aggressively into this transition — Bearish.`;
            } else {
                // End of cooling = less dramatic
                score = -0.5;
                detail = `Cooling ending in ${daysLeft}d → Shoulder`;
                explanation = `Within 21 days of entering Shoulder season from Cooling. Transition less dramatic than heating exit — Slightly Bearish.`;
            }
        } else {
            // Leaving shoulder → entering active season
            if (nxtName === 'Heating') {
                // Anticipation of heating = strongest bullish catalyst
                score = 1;
                detail = `Shoulder ending in ${daysLeft}d → Heating`;
                explanation = `Within 21 days of Heating season. Anticipation effect — traders buy ahead of the season. Historically the strongest seasonal catalyst — Bullish.`;
            } else {
                // Anticipation of cooling = moderately bullish
                score = 0.5;
                detail = `Shoulder ending in ${daysLeft}d → Cooling`;
                explanation = `Within 21 days of Cooling season. Cooling demand less predictable than heating — Slightly Bullish.`;
            }
        }

    // ── HEATING SEASON ────────────────────────────────────────────────────────
    } else if (isHeating) {
        const halfwayPoint = sTotal * 0.55; // past 55% = second half
        if (daysLeft > 45) {
            // First half — peak demand period
            score = 1;
            detail = `Heating season · ${daysLeft}d remaining · day ${daysIn}/${sTotal}`;
            explanation = `First half of Heating season. Peak gas demand, storage drawing down — Bullish.`;
        } else if (daysLeft > 15) {
            // Second half — still active but market looks forward
            score = 0.5;
            detail = `Heating season winding down · ${daysLeft}d remaining`;
            explanation = `Second half of Heating season. Demand still elevated but market begins pricing in shoulder. Slightly less constructive — Slightly Bullish.`;
        } else {
            // Final stretch — transition priced in
            score = 0;
            detail = `Heating season final stretch · ${daysLeft}d remaining`;
            explanation = `Last 15 days of Heating. Market already discounting shoulder transition — Neutral.`;
        }

    // ── COOLING SEASON ────────────────────────────────────────────────────────
    } else if (isCooling) {
        // June–July (early cooling, >60 days left): slightly bullish
        // August (30–60 days): neutral — peak likely passed
        // September (<30 days): slightly bearish — looking toward shoulder
        if (daysLeft > 60) {
            score = 0.5;
            detail = `Cooling season · ${daysLeft}d remaining · day ${daysIn}/${sTotal}`;
            explanation = `Early Cooling season. AC demand building, but weaker driver than heating — Slightly Bullish.`;
        } else if (daysLeft > 30) {
            score = 0;
            detail = `Cooling season mid-point · ${daysLeft}d remaining`;
            explanation = `Mid Cooling season. Peak cooling likely passed, demand plateau — Neutral.`;
        } else {
            score = -0.5;
            detail = `Cooling season fading · ${daysLeft}d remaining`;
            explanation = `Late Cooling season. AC demand fading, market looks toward October shoulder — Slightly Bearish.`;
        }

    // ── SHOULDER SEASON ───────────────────────────────────────────────────────
    } else {
        // October shoulder (month 10): near heating, storage full — ambivalent
        // March–May shoulder: pure injection, most bearish
        if (month === 10) {
            score = -0.5;
            detail = `October shoulder · ${daysLeft}d until Heating`;
            explanation = `October shoulder is ambiguous — storage typically full (bearish) but Heating season approaching (bullish catalyst). Net effect slightly bearish until Heating begins — Slightly Bearish.`;
        } else if (month <= 4) {
            // March–April: deepest injection season
            score = -1;
            detail = `Spring shoulder · ${daysLeft}d remaining · injection season`;
            explanation = `March–April shoulder — peak injection period, low demand, storage filling rapidly. Historically the most bearish seasonal window — Bearish.`;
        } else {
            // May: cooling approaching, less bearish than early spring
            score = -0.5;
            detail = `Late spring shoulder · ${daysLeft}d remaining`;
            explanation = `May shoulder — injection season continues but Cooling season is approaching. Less bearish than earlier spring — Slightly Bearish.`;
        }
    }

    const s = sentiment(score);
    return { score, label: s.label, col: s.col, detail, explanation,
        fullMethodology: [
            { state: 'Bullish',          col: '#3fb950', cond: 'Shoulder ending in ≤21d → Heating',      note: 'Strongest seasonal catalyst — traders buy ahead of heating season' },
            { state: 'Bullish',          col: '#3fb950', cond: 'Heating season, >45d remaining',          note: 'Peak demand period — gas consumption highest, storage drawing down' },
            { state: 'Slightly Bullish', col: '#7ec97f', cond: 'Shoulder ending in ≤21d → Cooling',       note: 'Cooling demand less predictable than heating — moderate anticipation' },
            { state: 'Slightly Bullish', col: '#7ec97f', cond: 'Heating season, 15–45d remaining',        note: 'Demand still elevated but market begins pricing in shoulder transition' },
            { state: 'Slightly Bullish', col: '#7ec97f', cond: 'Cooling season, >60d remaining',          note: 'Early cooling — AC demand building but weaker driver than heating' },
            { state: 'Neutral',          col: '#9ba3ad', cond: 'Heating season, <15d remaining',          note: 'Shoulder transition already priced in by the market' },
            { state: 'Neutral',          col: '#9ba3ad', cond: 'Cooling season, 30–60d remaining',        note: 'Mid cooling — peak likely passed, demand on plateau' },
            { state: 'Slightly Bearish', col: '#ffb085', cond: 'Cooling season, <30d remaining',         note: 'AC demand fading, market looks toward October shoulder' },
            { state: 'Slightly Bearish', col: '#ffb085', cond: 'Cooling ending in ≤21d → Shoulder',      note: 'Less dramatic than heating exit — moderate sentiment shift' },
            { state: 'Slightly Bearish', col: '#ffb085', cond: 'October shoulder',                       note: 'Storage full (bearish) but Heating approaching (bullish) — net slightly bearish' },
            { state: 'Slightly Bearish', col: '#ffb085', cond: 'May shoulder',                           note: 'Injection season but Cooling approaching — less bearish than early spring' },
            { state: 'Bearish',          col: '#ff7b72', cond: 'Heating ending in ≤21d → Shoulder',     note: 'Aggressive sentiment shift — traders sell into this transition historically' },
            { state: 'Bearish',          col: '#ff7b72', cond: 'March–April shoulder',                  note: 'Peak injection season — lowest demand, storage filling rapidly' },
        ]
    };
}

// ── Shared fair price scoring helper ─────────────────────────────────────────
// Band: fairMin = fp - 0.50, fairMax = fp + 0.50 (shoulder/cooling)
//                              fp + 1.90 (heating)
// Prahy jsou 1/3 downside bandu a 1/3 upside bandu
function scoreFairVsPrice(fp, price, isHeating) {
    const downBand = 0.50;                        // same both seasons
    const upBand   = isHeating ? 1.90 : 0.50;
    const fairMin  = fp - downBand;
    const fairMax  = fp + upBand;
    const diff     = fp - price; // positive = underpriced (bullish)

    let score;
    if (price < fairMin)                    score = 1;    // below entire band
    else if (diff > downBand / 3)           score = 0.5;  // lower third of downside
    else if (diff >= -(upBand / 3))         score = 0;    // middle
    else if (price < fairMax)               score = -0.5; // upper third of upside
    else                                    score = -1;   // above entire band

    return { score, diff, fp, fairMin, fairMax, downBand, upBand };
}

function signalFairPriceFront() {
    const sd = state.stStorageData;
    if (!sd || !sd.length) return { score: 0, label: 'Neutral', detail: 'No data', explanation: '', fullMethodology: [] };
    const lat  = sd[sd.length - 1];
    const band = st5y(sd, [lat.date])[0];
    if (!band || band.avg == null) return { score: 0, label: 'Neutral', detail: 'No fair price', explanation: '', fullMethodology: [] };
    const fp    = fairPrice(lat.value - band.avg);
    // Use _lastPrice.front from topbar if available (live), else fall back to state
    const front = (window._topbarLastPrice?.front)
        ?? (state.stNgfData.length ? state.stNgfData[state.stNgfData.length - 1].close : null)
        ?? (() => { const el = document.getElementById('b-ngf-cur'); const v = parseFloat((el?.textContent||'').replace('$','')); return isFinite(v) ? v : null; })();
    if (front == null) return { score: 0, label: 'Neutral', detail: 'No front price', explanation: '', fullMethodology: [] };

    const si = getSeasonInfo();
    const { score, diff, fairMin, fairMax, downBand, upBand } = scoreFairVsPrice(fp, front, si.isHeating);
    const s = sentiment(score);

    const bandDesc = si.isHeating
        ? `band $${fairMin.toFixed(2)}–$${fairMax.toFixed(2)} (heating: −$${downBand.toFixed(2)}/+$${upBand.toFixed(2)})`
        : `band $${fairMin.toFixed(2)}–$${fairMax.toFixed(2)} (±$${downBand.toFixed(2)})`;

    return { score, label: s.label, col: s.col,
        detail: `Fair $${fp.toFixed(3)} · Front $${front.toFixed(3)} · diff ${diff >= 0 ? '+' : ''}${diff.toFixed(3)}`,
        explanation: `Fair price $${fp.toFixed(3)}, ${bandDesc}. Front $${front.toFixed(3)} is ${front < fairMin ? 'BELOW band — underpriced' : front > fairMax ? 'ABOVE band — overpriced' : 'inside band'}. Thresholds adapt to season.`,
        fullMethodology: [
            { state: 'Bullish +1',            col: '#3fb950', cond: `Front below fairMin ($${fairMin.toFixed(2)})`,             note: 'Market below entire fair price band — strongly underpriced' },
            { state: 'Slightly Bullish +0.5', col: '#7ec97f', cond: `Front in lower 1/3 of band (diff > +$${(downBand/3).toFixed(2)})`, note: 'Market in lower part of fair value range' },
            { state: 'Neutral 0',             col: '#9ba3ad', cond: 'Front in middle of band',                                  note: 'Market fairly valued within the band' },
            { state: 'Slightly Bearish −0.5', col: '#ffb085', cond: `Front in upper 1/3 of band (diff < −$${(upBand/3).toFixed(2)})`, note: 'Market in upper part of fair value range' },
            { state: 'Bearish −1',            col: '#ff7b72', cond: `Front above fairMax ($${fairMax.toFixed(2)})`,             note: 'Market above entire fair price band — strongly overpriced' },
        ] };
}

function signalFairPriceNext() {
    const sd = state.stStorageData;
    if (!sd || !sd.length) return { score: 0, label: 'Neutral', detail: 'No data', explanation: '', fullMethodology: [] };
    const lat  = sd[sd.length - 1];
    const band = st5y(sd, [lat.date])[0];
    if (!band || band.avg == null) return { score: 0, label: 'Neutral', detail: 'No fair price', explanation: '', fullMethodology: [] };
    const fp   = fairPrice(lat.value - band.avg);
    const next = (window._topbarLastPrice?.next)
        ?? state.nextContractPrice
        ?? (() => { const el = document.getElementById('b-ngf-nxt'); const v = parseFloat((el?.textContent||'').replace('$','')); return isFinite(v) ? v : null; })();
    if (next == null) return { score: 0, label: 'Neutral', detail: 'No next price', explanation: '', fullMethodology: [] };

    const si = getSeasonInfo();
    const { score, diff, fairMin, fairMax, downBand, upBand } = scoreFairVsPrice(fp, next, si.isHeating);
    const s = sentiment(score);

    const bandDesc = si.isHeating
        ? `band $${fairMin.toFixed(2)}–$${fairMax.toFixed(2)} (heating: −$${downBand.toFixed(2)}/+$${upBand.toFixed(2)})`
        : `band $${fairMin.toFixed(2)}–$${fairMax.toFixed(2)} (±$${downBand.toFixed(2)})`;

    return { score, label: s.label, col: s.col,
        detail: `Fair $${fp.toFixed(3)} · Next $${next.toFixed(3)} · diff ${diff >= 0 ? '+' : ''}${diff.toFixed(3)}`,
        explanation: `Fair price $${fp.toFixed(3)}, ${bandDesc}. Next $${next.toFixed(3)} is ${next < fairMin ? 'BELOW band — underpriced' : next > fairMax ? 'ABOVE band — overpriced' : 'inside band'}. Same logic as vs Front.`,
        fullMethodology: [
            { state: 'Bullish +1',            col: '#3fb950', cond: `Next below fairMin ($${fairMin.toFixed(2)})`,              note: 'Next contract below entire fair price band — strongly underpriced' },
            { state: 'Slightly Bullish +0.5', col: '#7ec97f', cond: `Next in lower 1/3 of band (diff > +$${(downBand/3).toFixed(2)})`, note: 'Next in lower part of fair value range' },
            { state: 'Neutral 0',             col: '#9ba3ad', cond: 'Next in middle of band',                                   note: 'Next fairly valued within the band' },
            { state: 'Slightly Bearish −0.5', col: '#ffb085', cond: `Next in upper 1/3 of band (diff < −$${(upBand/3).toFixed(2)})`, note: 'Next in upper part of fair value range' },
            { state: 'Bearish −1',            col: '#ff7b72', cond: `Next above fairMax ($${fairMax.toFixed(2)})`,              note: 'Next contract above entire fair price band — strongly overpriced' },
        ] };
}

// Compute all signals and total score
function computeOverview() {
    return {
        season:        { name: 'Seasonality',              ...signalSeason() },
        weatherShort:  { name: 'Weather Short-Term',       ...signalWeatherShort() },
        weatherLong:   { name: 'Weather Long-Term',        ...signalWeatherLong() },
        storageTrend:  { name: 'Storage',            ...signalStorageTrend() },
        fairFront:     { name: 'Fair Price vs Front',      ...signalFairPriceFront() },
        fairNext:      { name: 'Fair Price vs Next',       ...signalFairPriceNext() },
        mmNet:         { name: 'MM Net Positioning',       ...signalMMNet() },
    };
}

function renderOverview() {
    const container = $('market-overview-grid');
    const totalEl   = $('market-overview-total');
    const totalLbl  = $('market-overview-total-label');
    if (!container) return;

    const signals = computeOverview();
    // Max score per signal — long-term weather is capped at 0.5
    const signalMaxMap = {
        season: 1, weatherShort: 1, weatherLong: 0.5,
        storageTrend: 1, fairFront: 1, fairNext: 1, mmNet: 1
    };
    const total = Object.values(signals).reduce((s, v) => s + v.score, 0);
    const max   = Object.keys(signals).reduce((s, k) => s + (signalMaxMap[k] ?? 1), 0);
    const overall = overallSentiment(total);

    // Store signals for popup
    window._ovSignals = signals;
    window._ovTotal = { total, max, overall };

    // Total score display
    if (totalEl) {
        totalEl.textContent = (total >= 0 ? '+' : '') + total.toFixed(1) + ' / ' + max.toFixed(1);
        totalEl.style.color = overall.col;
    }
    if (totalLbl) {
        totalLbl.textContent = overall.label;
        totalLbl.style.color = overall.col;
    }

    // Signal rows with trend arrows
    let html = '';
    for (const [key, sig] of Object.entries(signals)) {
        const dot = `<span class="ov-dot" style="background:${sig.col}"></span>`;
        html += `
          <div class="ov-row" data-key="${key}">
            <div class="ov-row-top">
              <div class="ov-name">${sig.name}</div>
              <div class="ov-signal" style="color:${sig.col}">${dot}${sig.label}</div>
            </div>
            <div class="ov-detail">${sig.detail || ''}</div>
          </div>`;
    }
    container.innerHTML = html;

}

// Popup explanation
function showOverviewPopup(key) {
    const signals = window._ovSignals;
    const ov = window._ovTotal;
    if (!signals) return;

    let popup = $('ov-popup');
    if (!popup) {
        popup = document.createElement('div');
        popup.id = 'ov-popup';
        popup.className = 'ov-popup-overlay';
        document.body.appendChild(popup);
        popup.addEventListener('click', e => { if (e.target === popup) popup.classList.remove('on'); });
    }

    const sig = key ? signals[key] : null;
    const title = sig ? sig.name : 'Market Overview — Signal Methodology';

    let body = '';
    if (sig) {
        // Single signal detail view
        const methodTable = sig.fullMethodology ? `
            <details style="margin-top:12px;border-top:1px solid var(--border2);padding-top:10px">
              <summary style="font-size:10px;text-transform:uppercase;letter-spacing:.8px;color:var(--text3);font-weight:700;cursor:pointer;list-style:none;display:flex;align-items:center;gap:6px;user-select:none">
                <span class="details-arrow" style="font-size:9px">▶</span> All possible states
              </summary>
              <table style="width:100%;border-collapse:collapse;margin-top:8px">
                ${(sig.fullMethodology || []).map(m => `
                <tr style="border-bottom:1px solid rgba(255,255,255,0.04)">
                  <td style="padding:5px 10px 5px 0;white-space:nowrap;vertical-align:top">
                    <span style="font-size:10.5px;font-weight:700;color:${m.col}">${m.state}</span>
                  </td>
                  <td style="padding:5px 10px;font-size:10.5px;color:var(--text2);font-family:var(--mono,monospace);vertical-align:top">${m.cond}</td>
                  <td style="padding:5px 0;font-size:10px;color:var(--text3);vertical-align:top">${m.note}</td>
                </tr>`).join('')}
              </table>
            </details>` : '';
        body = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
              <span style="font-size:11px;color:var(--text2)">Current state</span>
              <span style="font-size:13px;font-weight:700;color:${sig.col}">${sig.label}</span>
            </div>
            <p style="font-size:11.5px;color:var(--text2);line-height:1.7;margin-bottom:8px">${sig.explanation || ''}</p>
            <p style="font-family:var(--mono,monospace);font-size:10.5px;color:var(--text3)">${sig.detail || ''}</p>
            ${methodTable}`;
    } else {
        // All signals overview
        const scoreBar = `<div style="margin:12px 0 8px"><div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text3);font-family:var(--mono,monospace);margin-bottom:4px"><span>−${ov.max.toFixed(1)} Bearish</span><span>0</span><span>+${ov.max.toFixed(1)} Bullish</span></div><div style="height:8px;background:var(--bg3);border-radius:4px;position:relative"><div style="position:absolute;top:0;bottom:0;width:${Math.abs(ov.total)/ov.max*50}%;background:${ov.overall.col};border-radius:3px;margin-left:${ov.total>=0?'50%':((0.5-Math.abs(ov.total)/ov.max/2)*100)+'%'}"></div></div><div style="text-align:center;margin-top:6px;font-family:var(--mono,monospace);font-size:12px;color:${ov.overall.col};font-weight:700">Score: ${ov.total>=0?'+':''}${ov.total.toFixed(1)} / ${ov.max.toFixed(1)} → ${ov.overall.label}</div></div>`;
        body = scoreBar;
        for (const [k, s] of Object.entries(signals)) {
            const methodTable = s.fullMethodology ? `
              <details style="margin-top:8px">
                <summary style="font-size:10px;text-transform:uppercase;letter-spacing:.8px;color:var(--text3);font-weight:700;cursor:pointer;list-style:none;display:flex;align-items:center;gap:6px;user-select:none">
                  <span style="font-size:9px">▶</span> All possible states
                </summary>
                <table style="width:100%;border-collapse:collapse;margin-top:6px">
                  ${s.fullMethodology.map(m => `
                  <tr style="border-bottom:1px solid rgba(255,255,255,0.04)">
                    <td style="padding:4px 10px 4px 0;white-space:nowrap;vertical-align:top">
                      <span style="font-size:10px;font-weight:700;color:${m.col}">${m.state}</span>
                    </td>
                    <td style="padding:4px 8px;font-size:10px;color:var(--text2);font-family:var(--mono,monospace);vertical-align:top">${m.cond}</td>
                    <td style="padding:4px 0;font-size:9.5px;color:var(--text3);vertical-align:top">${m.note}</td>
                  </tr>`).join('')}
                </table>
              </details>` : '';
            body += `<div style="margin-bottom:16px;padding:12px 14px;background:var(--bg3);border-radius:8px;border:1px solid var(--border2)">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
                <span style="font-size:12px;font-weight:600;color:var(--text)">${s.name}</span>
                <span style="font-size:11px;font-weight:700;color:${s.col}">${s.label}</span>
              </div>
              <div style="font-size:11px;color:var(--text2);line-height:1.6">${s.explanation || ''}</div>
              <div style="font-size:10px;color:var(--text3);font-family:var(--mono,monospace);margin-top:4px">${s.detail || ''}</div>
              ${methodTable}
            </div>`;
        }
    }

    popup.innerHTML = `
      <div class="ov-popup">
        <button class="ov-popup-close" onclick="document.getElementById('ov-popup').classList.remove('on')">✕</button>
        <h3 class="ov-popup-title">${title}</h3>
        <div class="ov-popup-body">${body}</div>
      </div>`;
    popup.classList.add('on');
}

export function initOverviewEvents() {
    // Question mark button → full popup
    const helpBtn = $('ov-help-btn');
    if (helpBtn) helpBtn.addEventListener('click', () => showOverviewPopup(null));
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC
// ═══════════════════════════════════════════════════════════════════════════════

export function updateAllWidgets() {
    try { updateEIABanner(); }       catch(e) { dbLog('EIA banner: '      + e.message, 'warn'); }
    try { updateCOTKpi(); }          catch(e) { dbLog('COT KPI: '         + e.message, 'warn'); }
    try { updateCOTGauge(); }        catch(e) { dbLog('COT gauge: '       + e.message, 'warn'); }
    try { renderFuturesCurve(); }    catch(e) { dbLog('Futures curve: '   + e.message, 'warn'); }
    try { renderWeatherHeatmap(); }  catch(e) { dbLog('Heatmap: '         + e.message, 'warn'); }
    try { renderOverview(); }        catch(e) { dbLog('Overview: '        + e.message, 'warn'); }
    try { updateEIATracker(); }      catch(e) { dbLog('EIA tracker: '     + e.message, 'warn'); }
}

// ═══════════════════════════════════════════════════════════════════════════════
// FEATURE 1: HISTORICAL SCORE — localStorage sparkline
// ═══════════════════════════════════════════════════════════════════════════════


// ═══════════════════════════════════════════════════════════════════════════════
// FEATURE 2: EIA SURPRISE TRACKER
// After each EIA report, compare actual storage vs previous week's +7D forecast
// ═══════════════════════════════════════════════════════════════════════════════

const EIA_SURP_KEY = 'ng_eia_surprises_v1';

export function updateEIATracker() {
    const fcstEl     = $('b-stor-fcst');
    const surpriseEl = $('b-stor-surprise');
    if (!fcstEl || !surpriseEl) return;

    const sd = state.stStorageData;
    if (!sd || sd.length < 2) return;

    // ── Helpers ───────────────────────────────────────────────────────────────
    function isoAdd(iso, days) {
        const d = new Date(iso + 'T12:00:00Z');
        d.setUTCDate(d.getUTCDate() + days);
        return d.toISOString().slice(0, 10);
    }

    // Same cubic formula as bias.js::calcForecast
    function calcForecastBcf(startDate, endDate) {
        if (!state.wxS?.allDates || !state.wxS.demAll) return null;
        let D = 0, cnt = 0;
        for (let i = 0; i < state.wxS.allDates.length; i++) {
            const dt = state.wxS.allDates[i];
            if (dt >= startDate && dt <= endDate && state.wxS.demAll[i] != null && !isNaN(state.wxS.demAll[i])) {
                D += state.wxS.demAll[i]; cnt++;
            }
        }
        if (!cnt) return null;
        const FA = 0.0001607983, FB = -0.0460227485, FC = 0.909433429, FD = 95.0676254411;
        return FA * D * D * D + FB * D * D + FC * D + FD;
    }

    // ── Compute historical surprise (back-calculate) ─────────────────────────
    // Latest EIA report covers period [prev.date+1, lat.date]
    // Forecast from prev.date predicting that same period uses demand from weather data
    const lat  = sd[sd.length - 1];
    const prev = sd[sd.length - 2];
    const fcstStart = isoAdd(prev.date, 1);
    const fcstEnd   = lat.date;
    const predictedChange = calcForecastBcf(fcstStart, fcstEnd);

    let forecastLine, surpriseLine;
    if (predictedChange != null) {
        const actualChange = lat.value - prev.value;
        const surprise = actualChange - predictedChange;
        const col = surprise > 5 ? '#ff7b72' : surprise < -5 ? '#3fb950' : '#9ba3ad';
        const sign = surprise >= 0 ? '+' : '';
        const label = surprise > 5 ? 'Bearish' : surprise < -5 ? 'Bullish' : 'In line';
        const fcstSign = predictedChange >= 0 ? '+' : '';
        forecastLine = 'Forecast: ' + fcstSign + Math.round(predictedChange) + ' Bcf';
        surpriseLine = 'Surprise: <span style="color:' + col + ';font-weight:700">' + sign + Math.round(surprise) + ' Bcf</span><br><span style="color:' + col + '">' + label + '</span>';
    } else {
        forecastLine = 'Forecast: weather data unavailable';
        surpriseLine = 'Surprise: —';
    }

    fcstEl.textContent = forecastLine;
    surpriseEl.innerHTML = surpriseLine;
}

// ═══════════════════════════════════════════════════════════════════════════════
// FEATURE 3: SIGNAL TREND ARROWS
// Compare current signal scores to previous render
// ═══════════════════════════════════════════════════════════════════════════════


// ═══════════════════════════════════════════════════════════════════════════════
// FEATURE 4: FUTURES CURVE TIMESTAMP
// ═══════════════════════════════════════════════════════════════════════════════

let _fcLastUpdated = null;

export function updateFuturesTimestamp() {
    _fcLastUpdated = new Date();
    const el = $('fw-note');
    if (!el) return;
    const t = _fcLastUpdated;
    const hh = String(t.getHours()).padStart(2, '0');
    const mm = String(t.getMinutes()).padStart(2, '0');
    // Keep contango/backwardation text if present, add timestamp
    const existing = el.textContent;
    const base = existing.includes('Contango') || existing.includes('Backwardation') || existing.includes('Flat')
        ? existing.split('·')[0].trim()
        : '';
    // Render contango part normally, timestamp in grey
    if (base) {
        el.innerHTML = base + ' · <span style="color:var(--text4)">Updated ' + hh + ':' + mm + '</span>';
    } else {
        el.innerHTML = '<span style="color:var(--text4)">Updated ' + hh + ':' + mm + '</span>';
    }
}

export function startWidgetTicker() {
    updateEIABanner();
    updateCOTKpi();
    setInterval(() => { updateEIABanner(); updateCOTKpi(); }, 60_000);
}
