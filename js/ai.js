// js/ai.js
import { GROQ_URL, GROQ_MODEL, TA_TFS } from './constants.js';
import { state } from './state.js';
import { dbLog } from './debug.js';
import { esc, sgn, isoAdd, fmtShort, fmtPeriod, fairPrice } from './utils.js';
import { getSeasonInfo } from './season.js';
import { st5y } from './storage5y.js';
import { ngfCurrent, ngfNext } from './contracts.js';
import { peCalcSupply } from './production.js';
import { taEMA, taRSI } from './technical.js';
import { PE_LABELS } from './constants.js';

// ── Constants ─────────────────────────────────────────────────────────────────
const AI_MEMORY_KEY = 'ng_ai_memory_v1';

// ── Low-level Groq call ───────────────────────────────────────────────────────
async function callGroq(messages, maxTokens) {
    maxTokens = maxTokens || 1024;
    const resp = await fetch(GROQ_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: GROQ_MODEL, max_tokens: maxTokens, messages: messages })
    });
    if (!resp.ok) {
        const et = await resp.text();
        throw new Error('HTTP ' + resp.status + ': ' + et.slice(0, 300));
    }
    const data = await resp.json();
    let text = '';
    if (data.choices && data.choices[0]) {
        const c = data.choices[0].message;
        if (c && typeof c.content === 'string') text = c.content.trim();
        else if (c && Array.isArray(c.content)) {
            text = c.content.filter(function(b) { return b.type === 'text'; }).map(function(b) { return b.text; }).join('').trim();
        }
    }
    if (!text && data.content && data.content[0]) text = (data.content[0].text || '').trim();
    if (!text) dbLog('Groq: empty response', 'warn');
    return text;
}

// ── Bubble helpers ────────────────────────────────────────────────────────────
function msgHtml(text) {
    return esc(text)
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/`([^`]+)`/g, '<code style="background:#1c2128;padding:1px 4px;border-radius:3px;font-family:var(--mono);font-size:11px">$1</code>')
        .replace(/#{1,6} (.+)/g, '<strong>$1</strong>')
        .replace(/\n/g, '<br>');
}

function appendBubble(role, text, isLoading) {
    const msgs = document.getElementById('ai-messages');
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;align-items:' + (role === 'user' ? 'flex-end' : 'flex-start');
    const bbl = document.createElement('div');
    bbl.className = role === 'user' ? 'ai-bubble-user' : 'ai-bubble-bot';
    bbl.innerHTML = isLoading
        ? '<span class="sp"></span><span style="color:#8b949e">Thinking...</span>'
        : msgHtml(text);
    wrap.appendChild(bbl);
    msgs.appendChild(wrap);
    msgs.scrollTop = msgs.scrollHeight;
    return bbl;
}

// ── AI Memory ─────────────────────────────────────────────────────────────────
function saveAIMemory(sentiment, confidence, stRange, mtRange, driver, fearPremium) {
    try {
        const curPrice = state.stNgfData.length ? state.stNgfData[state.stNgfData.length - 1].close : null;
        const curDev = (function() {
            if (!state.stStorageData.length) return null;
            const lat = state.stStorageData[state.stStorageData.length - 1];
            const b = st5y(state.stStorageData, [lat.date])[0];
            return b.avg != null ? Math.round(lat.value - b.avg) : null;
        })();
        const mem = {
            date: new Date().toISOString().slice(0, 10),
            timestamp: Date.now(),
            sentiment: sentiment,
            confidence: confidence,
            stRange: stRange,
            mtRange: mtRange,
            driver: driver,
            fearPremium: fearPremium,
            frontPrice: curPrice,
            storageDevBcf: curDev
        };
        localStorage.setItem(AI_MEMORY_KEY, JSON.stringify(mem));
        dbLog('AI memory saved', 'info');
    } catch(e) {
        dbLog('AI memory save failed: ' + e.message, 'warn');
    }
}

function getAIMemoryContext() {
    try {
        const raw = localStorage.getItem(AI_MEMORY_KEY);
        if (!raw) return '';
        const mem = JSON.parse(raw);
        const daysAgo = Math.round((Date.now() - mem.timestamp) / 864e5);
        if (daysAgo > 30) return '';
        const lines = [
            'Previous analysis (' + daysAgo + ' day' + (daysAgo !== 1 ? 's' : '') + ' ago — ' + mem.date + '):'
        ];
        lines.push('  Sentiment: ' + mem.sentiment + ' | Confidence: ' + mem.confidence + '/10');
        if (mem.stRange) lines.push('  Short-term target was: ' + mem.stRange);
        if (mem.mtRange) lines.push('  Medium-term target was: ' + mem.mtRange);
        if (mem.driver)  lines.push('  Primary driver was: ' + mem.driver);
        if (mem.fearPremium) lines.push('  Fear premium: ' + mem.fearPremium);
        const curPrice = state.stNgfData.length ? state.stNgfData[state.stNgfData.length - 1].close : null;
        if (mem.frontPrice && curPrice) {
            const chg = curPrice - mem.frontPrice;
            lines.push('  Price change since: ' + sgn(chg) + chg.toFixed(3) + ' ($' + mem.frontPrice.toFixed(3) + ' -> $' + curPrice.toFixed(3) + ')');
        }
        const curDev = (function() {
            if (!state.stStorageData.length) return null;
            const lat = state.stStorageData[state.stStorageData.length - 1];
            const b = st5y(state.stStorageData, [lat.date])[0];
            return b.avg != null ? Math.round(lat.value - b.avg) : null;
        })();
        if (mem.storageDevBcf != null && curDev != null) {
            const devChg = curDev - mem.storageDevBcf;
            lines.push('  Storage deviation change: ' + sgn(devChg) + devChg + ' Bcf (' + mem.storageDevBcf + ' -> ' + curDev + ' Bcf)');
        }
        lines.push('  NOTE: Assess if previous thesis is playing out or needs revision.');
        return lines.join('\n');
    } catch(e) {
        return '';
    }
}

// ── Datetime context ──────────────────────────────────────────────────────────
function getDatetimeContext() {
    const now = new Date();
    const cetStr = now.toLocaleString('en-GB', { timeZone: 'Europe/Prague', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
    const etStr  = now.toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

    const etNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const dow = etNow.getDay();
    const timeDecimal = etNow.getHours() + etNow.getMinutes() / 60;
    let marketStatus = 'CLOSED';
    if (dow === 0 && timeDecimal >= 18) marketStatus = 'OPEN';
    else if (dow >= 1 && dow <= 4) marketStatus = 'OPEN';
    else if (dow === 5 && timeDecimal < 17) marketStatus = 'OPEN';

    let daysToEIA = (4 - dow + 7) % 7;
    if (daysToEIA === 0 && timeDecimal >= 10.5) daysToEIA = 7;

    const curC = ngfCurrent();
    let daysToExpiry = null;
    if (curC) {
        let pm = curC.m0 - 1, py = curC.yr;
        if (pm < 0) { pm = 11; py--; }
        const expD = new Date(py, pm + 1, 0);
        while (expD.getDay() === 0 || expD.getDay() === 6) expD.setDate(expD.getDate() - 1);
        let bdays = 0;
        while (bdays < 3) { expD.setDate(expD.getDate() - 1); if (expD.getDay() !== 0 && expD.getDay() !== 6) bdays++; }
        daysToExpiry = Math.ceil((expD - now) / 864e5);
    }

    const lines = [
        'Current datetime:',
        '  CET: ' + cetStr,
        '  ET (New York): ' + etStr,
        '  NYMEX status: ' + marketStatus,
        '  Front month: ' + (curC ? curC.label : '?') + (daysToExpiry != null ? ' -> expires in ' + daysToExpiry + ' days' + (daysToExpiry <= 5 ? ' WARNING: ROLLOVER RISK — elevated volatility near expiry' : '') : ''),
        '  Next EIA storage report: ' + (daysToEIA === 0 ? 'TODAY at 10:30 ET' : 'in ' + daysToEIA + ' day' + (daysToEIA > 1 ? 's' : '') + ' (Thursday 10:30 ET)'),
    ];
    if (daysToEIA <= 1) lines.push('  WARNING: EIA REPORT IMMINENT — market positioning now, expect elevated pre-report volatility');
    lines.push('  COT data lag: 3 days (latest report covers Tuesday)');
    lines.push('  Storage data lag: 7 days (latest report covers prior week)');
    return lines.join('\n');
}

// ── Data freshness ────────────────────────────────────────────────────────────
function getDataFreshnessContext() {
    const lines = [
        'DATA FRESHNESS & UNCERTAINTY:',
        '  Prices: 15-min delay intraday | historical: accurate | Confidence: HIGH direction, MEDIUM exact levels',
    ];
    if (state.stStorageData.length) {
        const lat = state.stStorageData[state.stStorageData.length - 1];
        lines.push('  Storage (EIA): covers week ending ' + fmtShort(lat.date) + ' | lag: ~7 days | Confidence: HIGH');
    }
    if (state.cotData && state.cotData.length) {
        const lat = state.cotData[state.cotData.length - 1];
        lines.push('  COT (CFTC): covers Tuesday ' + lat.date + ' | lag: 3 days | Confidence: HIGH positioning, MEDIUM current levels');
    }
    if (state.peData && state.peData.lng && state.peData.lng.length) {
        const lat = state.peData.lng[state.peData.lng.length - 1];
        lines.push('  LNG exports (EIA): latest ' + fmtPeriod(lat.period) + ' | lag: 2-3 months | Use for TREND only, not current state');
    }
    lines.push('  Weather (GFS): days 1-7 HIGH | days 8-10 MEDIUM | days 11-16 LOW confidence');
    lines.push('  TA: 5m/15m have 15-min delay | 1h+ historical accurate');
    return lines.join('\n');
}

// ── Fair price context ────────────────────────────────────────────────────────
function getFairPriceContext() {
    if (!state.stStorageData.length) return '';
    const si = getSeasonInfo();
    const lat = state.stStorageData[state.stStorageData.length - 1];
    const band = st5y(state.stStorageData, [lat.date])[0];
    if (!band || band.avg == null) return '';
    const devBcf = lat.value - band.avg;
    const fp = fairPrice(devBcf);
    const mn = fp - 0.5;
    const mx = si.isHeating ? fp + 1.9 : fp + 0.5;
    const lines = [
        'Fair Price Model:',
        '  Formula: -0.0013 x storage_deviation + 3.1564',
        '  Storage deviation: ' + sgn(devBcf) + Math.round(devBcf) + ' Bcf vs 5y avg',
        '  FAIR PRICE center: $' + fp.toFixed(3),
        '  FAIR PRICE range: $' + mn.toFixed(3) + ' (min) -- $' + mx.toFixed(3) + ' (max)',
        '  Season: ' + si.icon + ' ' + si.name + ' -> range is ' + (si.isHeating ? 'WIDE (heating: large upside risk, +$1.90 above fair)' : 'NARROW (non-heating: +$0.50 above fair)'),
        '  Price targets should stay within this range unless strong fear premium justifies breach.',
    ];
    [[state.stLastF7, '7D'], [state.stLastF14, '14D'], [state.stLastF21, '21D']].forEach(function(p) {
        const f = p[0], lbl = p[1];
        if (!f || f.predictedLevel == null) return;
        const b = st5y(state.stStorageData, [f.endDate])[0];
        if (!b || b.avg == null) return;
        const dv = f.predictedLevel - b.avg;
        const ffp = fairPrice(dv);
        const fmn = ffp - 0.5;
        const fmx = si.isHeating ? ffp + 1.9 : ffp + 0.5;
        lines.push('  Fair Price ' + lbl + ': $' + ffp.toFixed(3) + ' (range: $' + fmn.toFixed(3) + ' -- $' + fmx.toFixed(3) + ')');
    });
    return lines.join('\n');
}

// ── Price history & momentum ──────────────────────────────────────────────────
function getPriceHistoryContext() {
    const daily  = state.taData && state.taData['1d'] && state.taData['1d'].length >= 20 ? state.taData['1d'] : null;
    const weekly = state.stNgfData && state.stNgfData.length >= 4 ? state.stNgfData : null;
    if (!daily && !weekly) return 'Price history: insufficient data';
    const src = daily || weekly;
    const last = src[src.length - 1].close;
    const lines = ['Price history (' + (daily ? 'daily, ' + src.length + ' bars' : 'weekly') + '):'];

    function pctChg(from) {
        if (!from || from === 0) return 'N/A';
        const chg = last - from;
        return sgn(chg) + chg.toFixed(3) + ' (' + sgn(chg) + (chg / from * 100).toFixed(1) + '%)';
    }
    function barsAgo(n) { const idx = src.length - 1 - n; return idx >= 0 ? src[idx] : null; }

    lines.push('  Current: $' + last.toFixed(3));
    var shortPeriods = daily
        ? [{n:1,lbl:'1 day'},{n:2,lbl:'2 days'},{n:3,lbl:'3 days'},{n:5,lbl:'1 week'}]
        : [{n:1,lbl:'1 week'},{n:2,lbl:'2 weeks'}];
    shortPeriods.forEach(function(p) {
        const b = barsAgo(p.n); if (!b) return;
        lines.push('  ' + p.lbl + ' ago: $' + b.close.toFixed(3) + ' (' + pctChg(b.close) + ')');
    });

    var longPeriods = daily
        ? [{n:10,lbl:'2 weeks'},{n:21,lbl:'1 month'},{n:42,lbl:'2 months'},{n:63,lbl:'3 months'},{n:126,lbl:'6 months'},{n:252,lbl:'1 year'}]
        : [{n:4,lbl:'1 month'},{n:8,lbl:'2 months'},{n:13,lbl:'3 months'},{n:26,lbl:'6 months'},{n:52,lbl:'1 year'}];
    longPeriods.forEach(function(p) {
        const b = barsAgo(p.n); if (!b) return;
        lines.push('  ' + p.lbl + ' ago: $' + b.close.toFixed(3) + ' (' + pctChg(b.close) + ')');
    });

    const now = new Date();
    const ytdStart = src.find(function(r) { return new Date(r.ts).getFullYear() === now.getFullYear(); });
    if (ytdStart) lines.push('  YTD start: $' + ytdStart.close.toFixed(3) + ' -> YTD: ' + pctChg(ytdStart.close));

    if (weekly && weekly.length >= 4) {
        const l52 = weekly.slice(-52);
        const h52  = Math.max.apply(null, l52.map(function(x) { return x.high; }));
        const lo52 = Math.min.apply(null, l52.map(function(x) { return x.low; }));
        const pos52 = h52 > lo52 ? ((last - lo52) / (h52 - lo52) * 100).toFixed(0) : 'N/A';
        lines.push('  52w High: $' + h52.toFixed(3) + ' | 52w Low: $' + lo52.toFixed(3) + ' | Position: ' + pos52 + '% of range');
        if (weekly.length >= 104) {
            const h2y  = Math.max.apply(null, weekly.slice(-104).map(function(x) { return x.high; }));
            const lo2y = Math.min.apply(null, weekly.slice(-104).map(function(x) { return x.low; }));
            lines.push('  2y High: $' + h2y.toFixed(3) + ' | 2y Low: $' + lo2y.toFixed(3));
        }
        if (weekly.length >= 260) {
            const h5y  = Math.max.apply(null, weekly.slice(-260).map(function(x) { return x.high; }));
            const lo5y = Math.min.apply(null, weekly.slice(-260).map(function(x) { return x.low; }));
            lines.push('  5y High: $' + h5y.toFixed(3) + ' | 5y Low: $' + lo5y.toFixed(3));
        }
    }

    lines.push('  Momentum:');
    if (daily) {
        [{n:5,lbl:'1w'},{n:10,lbl:'2w'},{n:21,lbl:'1m'},{n:63,lbl:'3m'}].forEach(function(p) {
            const b = barsAgo(p.n); if (!b) return;
            const chg = last - b.close;
            const pct = b.close > 0 ? chg / b.close * 100 : 0;
            lines.push('    ' + p.lbl + ': ' + sgn(chg) + chg.toFixed(3) + ' (' + sgn(pct) + pct.toFixed(1) + '%) -> ' +
                (pct > 5 ? 'STRONG UP' : pct > 1 ? 'UP' : pct < -5 ? 'STRONG DOWN' : pct < -1 ? 'DOWN' : 'FLAT'));
        });
        const b5 = barsAgo(5), b10 = barsAgo(10);
        if (b5 && b10) {
            const accel = (last - b5.close) - (b5.close - b10.close);
            lines.push('    Acceleration: ' + sgn(accel) + accel.toFixed(3) + ' -> ' +
                (accel > 0.05 ? 'ACCELERATING UP' : accel < -0.05 ? 'ACCELERATING DOWN' : 'STABLE'));
        }
        const r10 = src.slice(-10);
        const avgRange = r10.reduce(function(s, r) { return s + (r.high - r.low); }, 0) / r10.length;
        lines.push('  Volatility (10d avg range): $' + avgRange.toFixed(3) + ' | implied 1w: +/-$' + (avgRange * 2.5).toFixed(3) + ' | 1m: +/-$' + (avgRange * 5).toFixed(3));
        const r20 = src.slice(-20);
        const rh = Math.max.apply(null, r20.map(function(x) { return x.high; }));
        const rl = Math.min.apply(null, r20.map(function(x) { return x.low; }));
        lines.push('  20d High: $' + rh.toFixed(3) + ' | 20d Low: $' + rl.toFixed(3) + ' | vs 20d High: ' + ((last-rh)/rh*100).toFixed(1) + '% | vs 20d Low: +' + ((last-rl)/rl*100).toFixed(1) + '%');
    } else {
        const b4 = barsAgo(4), b8 = barsAgo(8);
        if (b4) lines.push('    4w: ' + pctChg(b4.close));
        if (b4 && b8) {
            const accel = (last - b4.close) - (b4.close - b8.close);
            lines.push('    Acceleration: ' + sgn(accel) + accel.toFixed(3) + ' -> ' + (accel > 0.1 ? 'ACCELERATING UP' : accel < -0.1 ? 'ACCELERATING DOWN' : 'STABLE'));
        }
    }
    return lines.join('\n');
}

// ── Storage pace ──────────────────────────────────────────────────────────────
function getStoragePaceContext() {
    if (!state.stStorageData || state.stStorageData.length < 10) return '';
    const data = state.stStorageData;
    const n = data.length;
    const curChg = n >= 2 ? data[n-1].value - data[n-2].value : null;
    const curDate = new Date(data[n-1].date + 'T12:00:00Z');
    const curDOY = curDate.getMonth() * 30 + curDate.getDate();
    const peerChanges = [];
    for (let i = 1; i < data.length - 1; i++) {
        const d = new Date(data[i].date + 'T12:00:00Z');
        const diff = curDate.getFullYear() - d.getFullYear();
        if (diff < 1 || diff > 5) continue;
        if (Math.abs(d.getMonth() * 30 + d.getDate() - curDOY) <= 10) {
            peerChanges.push(data[i].value - data[i-1].value);
        }
    }
    const lines = ['Storage injection/withdrawal pace:'];
    if (curChg != null) lines.push('  Current W/W: ' + sgn(curChg) + Math.round(curChg) + ' Bcf (' + (curChg >= 0 ? 'injection' : 'withdrawal') + ')');
    if (peerChanges.length >= 2) {
        const avg5y = peerChanges.reduce(function(a,b){return a+b;}) / peerChanges.length;
        lines.push('  5y avg this week: ' + sgn(avg5y) + Math.round(avg5y) + ' Bcf');
        if (curChg != null) {
            const vs = curChg - avg5y;
            lines.push('  vs 5y norm: ' + sgn(vs) + Math.round(vs) + ' Bcf -> ' +
                (vs > 20  ? 'SIGNIFICANTLY ABOVE seasonal pace (BEARISH)' :
                 vs < -20 ? 'SIGNIFICANTLY BELOW seasonal pace (BULLISH)' :
                 vs > 5   ? 'slightly above seasonal pace (mildly bearish)' :
                 vs < -5  ? 'slightly below seasonal pace (mildly bullish)' : 'IN LINE with seasonal pace'));
        }
    }
    if (n >= 6) {
        const chgs = [];
        for (let i = n-4; i < n; i++) chgs.push(data[i].value - data[i-1].value);
        lines.push('  Last 4 weeks: ' + chgs.map(function(c){return sgn(c)+Math.round(c);}).join(', ') + ' Bcf');
        const trend = chgs[chgs.length-1] - chgs[0];
        lines.push('  Trend: ' + (trend > 20 ? 'ACCELERATING INJECTION (bearish)' : trend < -20 ? 'DECELERATING injection (bullish)' : 'stable'));
    }
    return lines.join('\n');
}

// ── End of season ─────────────────────────────────────────────────────────────
function getEndOfSeasonContext() {
    if (!state.stStorageData.length) return '';
    const si = getSeasonInfo();
    const curStorage = state.stStorageData[state.stStorageData.length - 1].value;
    const now = new Date();
    let target = null, targetLabel = '', daysLeft = si.daysLeft;

    if (si.name === 'Heating') {
        target = { low: 1500, mid: 1700, high: 1900 };
        targetLabel = 'End-of-heating target (Mar 1)';
    } else {
        target = { low: 3700, mid: 3850, high: 4050 };
        targetLabel = 'End-of-injection target (Nov 1)';
        const nov1 = new Date(now.getFullYear(), 10, 1);
        if (nov1 < now) nov1.setFullYear(now.getFullYear() + 1);
        daysLeft = Math.ceil((nov1 - now) / 864e5);
    }

    const lines = ['End-of-season tracking:',
        '  ' + targetLabel + ': low ' + target.low.toLocaleString() + ' / mid ' + target.mid.toLocaleString() + ' / high ' + target.high.toLocaleString() + ' Bcf',
        '  Current: ' + Math.round(curStorage).toLocaleString() + ' Bcf | Days remaining: ' + daysLeft,
    ];

    const weeksLeft = daysLeft / 7;
    if (weeksLeft > 0) {
        const neededMid = (target.mid - curStorage) / weeksLeft;
        lines.push('  Required weekly rate (mid target): ' + sgn(neededMid) + Math.round(neededMid) + ' Bcf/week');
        if (state.stStorageData.length >= 5) {
            const recent = state.stStorageData.slice(-5);
            let sum = 0;
            for (let i = 1; i < recent.length; i++) sum += recent[i].value - recent[i-1].value;
            const actualRate = sum / 4;
            lines.push('  Actual 4w avg rate: ' + sgn(actualRate) + Math.round(actualRate) + ' Bcf/week');
            const diff = actualRate - neededMid;
            const projected = curStorage + actualRate * weeksLeft;
            lines.push('  Projected end-of-season: ' + Math.round(projected).toLocaleString() + ' Bcf -> ' +
                (projected >= target.high ? 'WELL SUPPLIED (bearish)' :
                 projected >= target.mid  ? 'COMFORTABLE (neutral)' :
                 projected >= target.low  ? 'ADEQUATE (slight bullish)' : 'BELOW TARGET (bullish)'));
            if (si.name !== 'Heating') {
                lines.push('  Tracking: ' + (diff > 10 ? 'AHEAD of target (bearish)' : diff < -10 ? 'BEHIND target (bullish)' : 'ON TRACK'));
            }
        }
    }
    return lines.join('\n');
}

// ── Spread analysis ───────────────────────────────────────────────────────────
function getSpreadContext() {
    if (!state.fcContractsData || state.fcContractsData.length < 3) return 'Spread analysis: insufficient data';
    const contracts = state.fcContractsData.filter(function(c) { return c.price != null; });
    if (contracts.length < 3) return 'Spread analysis: insufficient data';
    const front = contracts[0], next = contracts[1];
    const lines = ['Futures spread analysis:'];
    if (front && next) {
        const sp = next.price - front.price;
        lines.push('  Front-Next (' + front.label + '/' + next.label + '): ' + sgn(sp) + sp.toFixed(3) + ' -> ' +
            (sp > 0.05 ? 'CONTANGO' : sp < -0.05 ? 'BACKWARDATION' : 'FLAT'));
    }
    if (contracts.length >= 6) {
        const strip = contracts.slice(0, Math.min(12, contracts.length));
        const avg = strip.reduce(function(s, c) { return s + c.price; }, 0) / strip.length;
        lines.push('  ' + strip.length + 'M strip avg: $' + avg.toFixed(3) + ' vs front $' + front.price.toFixed(3) + ' (' + sgn(avg - front.price) + (avg - front.price).toFixed(3) + ')');
    }
    const sumCs = contracts.filter(function(c) { return /Jun|Jul|Aug/.test(c.label); });
    const winCs = contracts.filter(function(c) { return /Dec|Jan|Feb/.test(c.label); });
    if (sumCs.length && winCs.length) {
        const sumAvg = sumCs.reduce(function(s, c) { return s + c.price; }, 0) / sumCs.length;
        const winAvg = winCs.reduce(function(s, c) { return s + c.price; }, 0) / winCs.length;
        const sw = winAvg - sumAvg;
        lines.push('  Summer avg: $' + sumAvg.toFixed(3) + ' | Winter avg: $' + winAvg.toFixed(3));
        lines.push('  Winter-Summer spread: ' + sgn(sw) + sw.toFixed(3) + ' -> ' +
            (sw > 0.30 ? 'LARGE winter premium (heating scarcity fear)' :
             sw > 0.10 ? 'moderate winter premium (normal seasonal)' :
             sw < -0.10 ? 'summer premium (unusual)' : 'flat seasonal spread'));
    }
    if (contracts.length >= 6) {
        const sl6 = contracts[5].price - contracts[0].price;
        lines.push('  6M slope: ' + sgn(sl6) + sl6.toFixed(3) + ' -> ' +
            (sl6 > 0.30 ? 'STEEP CONTANGO (bearish forward expectation)' :
             sl6 > 0.10 ? 'mild contango' :
             sl6 < -0.30 ? 'STEEP BACKWARDATION (bullish / fear)' :
             sl6 < -0.10 ? 'mild backwardation' : 'flat curve'));
    }
    const marC = contracts.find(function(c) { return /Mar/.test(c.label); });
    const aprC = contracts.find(function(c) { return /Apr/.test(c.label); });
    if (marC && aprC) {
        const wm = aprC.price - marC.price;
        lines.push('  Mar-Apr Widow Maker: ' + sgn(wm) + wm.toFixed(3) + (Math.abs(wm) > 0.15 ? ' WARNING: ELEVATED rollover risk' : ' (normal)'));
    }
    return lines.join('\n');
}

// ── RSI Divergence ────────────────────────────────────────────────────────────
function getRSIDivergence() {
    const lines = ['RSI Divergence:'];
    let found = false;
    ['1d', '4h', '1w'].forEach(function(tf) {
        const candles = state.taData && state.taData[tf];
        if (!candles || candles.length < 30) { lines.push('  ' + tf + ': insufficient data'); return; }
        const closes = candles.map(function(c) { return c.close; });
        const rsi = taRSI(closes, 14);
        const n = candles.length;
        function findSwings(data, type, lb) {
            const swings = [];
            for (let i = lb; i < n - 2; i++) {
                const slice = data.slice(i - lb, i + lb + 1).filter(function(v) { return v != null; });
                if (!slice.length) continue;
                const val = data[i];
                if (val == null) continue;
                if (type === 'high' && val === Math.max.apply(null, slice)) swings.push({idx:i, val:val});
                if (type === 'low'  && val === Math.min.apply(null, slice)) swings.push({idx:i, val:val});
            }
            return swings.slice(-3);
        }
        const pH = findSwings(closes, 'high', 5);
        const pL = findSwings(closes, 'low',  5);
        const rH = findSwings(rsi,    'high', 5);
        const rL = findSwings(rsi,    'low',  5);
        let tfFound = false;
        if (pH.length >= 2 && rH.length >= 2) {
            const ph1=pH[pH.length-2], ph2=pH[pH.length-1], rh1=rH[rH.length-2], rh2=rH[rH.length-1];
            if (ph2.val > ph1.val && rh2.val < rh1.val) {
                lines.push('  BEARISH DIVERGENCE (' + tf + '): Price HH ($' + ph1.val.toFixed(3) + '->' + ph2.val.toFixed(3) + ') but RSI LH (' + rh1.val.toFixed(1) + '->' + rh2.val.toFixed(1) + ') -> momentum weakening');
                found = true; tfFound = true;
            }
        }
        if (pL.length >= 2 && rL.length >= 2) {
            const pl1=pL[pL.length-2], pl2=pL[pL.length-1], rl1=rL[rL.length-2], rl2=rL[rL.length-1];
            if (pl2.val < pl1.val && rl2.val > rl1.val) {
                lines.push('  BULLISH DIVERGENCE (' + tf + '): Price LL ($' + pl1.val.toFixed(3) + '->' + pl2.val.toFixed(3) + ') but RSI HL (' + rl1.val.toFixed(1) + '->' + rl2.val.toFixed(1) + ') -> selling pressure waning');
                found = true; tfFound = true;
            }
        }
        if (!tfFound) lines.push('  ' + tf + ': no divergence');
    });
    if (!found) lines.push('  No significant RSI divergences detected');
    return lines.join('\n');
}

// ── Support / Resistance ──────────────────────────────────────────────────────
function getSupportResistance() {
    const daily  = state.taData && state.taData['1d'];
    const weekly = state.stNgfData;
    if (!daily || daily.length < 20) return 'Support/Resistance: insufficient data';
    const closes = daily.map(function(c) { return c.close; });
    const n = daily.length;
    const last = closes[n - 1];
    const lines = ['Key Support & Resistance:'];
    const lookback = Math.min(n, 120);
    const slice = daily.slice(-lookback);
    const resistances = [], supports = [];
    for (let i = 3; i < slice.length - 3; i++) {
        const hi = slice[i].high, lo = slice[i].low;
        const isHigh = slice.slice(i-3,i).every(function(c){return c.high<=hi;}) && slice.slice(i+1,i+4).every(function(c){return c.high<=hi;});
        const isLow  = slice.slice(i-3,i).every(function(c){return c.low>=lo;})  && slice.slice(i+1,i+4).every(function(c){return c.low>=lo;});
        if (isHigh) resistances.push(hi);
        if (isLow)  supports.push(lo);
    }
    const ema50  = taEMA(closes, 50);
    const ema200 = taEMA(closes, 200);
    if (ema50[n-1]  != null) { if (ema50[n-1]  > last) resistances.push(ema50[n-1]);  else supports.push(ema50[n-1]);  }
    if (ema200[n-1] != null) { if (ema200[n-1] > last) resistances.push(ema200[n-1]); else supports.push(ema200[n-1]); }
    if (weekly && weekly.length >= 52) {
        const l52 = weekly.slice(-52);
        resistances.push(Math.max.apply(null, l52.map(function(c){return c.high;})));
        supports.push(Math.min.apply(null, l52.map(function(c){return c.low;})));
    }
    function dedup(arr, threshold) {
        arr.sort(function(a,b){return a-b;});
        const out = [];
        arr.forEach(function(v) { if (!out.length || Math.abs(v - out[out.length-1]) > threshold) out.push(v); });
        return out;
    }
    const res = dedup(resistances.filter(function(v){return v > last+0.02;}), 0.05).slice(0, 4);
    const sup = dedup(supports.filter(function(v){return v < last-0.02;}), 0.05).reverse().slice(0, 4);
    if (res.length) lines.push('  Resistance: ' + res.map(function(v){return '$'+v.toFixed(3);}).join(' | '));
    if (sup.length) lines.push('  Support:    ' + sup.map(function(v){return '$'+v.toFixed(3);}).join(' | '));
    const nearRes = res[0], nearSup = sup[0];
    if (nearRes) lines.push('  To nearest resistance: +$' + (nearRes-last).toFixed(3) + ' (+' + ((nearRes-last)/last*100).toFixed(1) + '%)');
    if (nearSup) lines.push('  To nearest support:    -$' + (last-nearSup).toFixed(3) + ' (-' + ((last-nearSup)/last*100).toFixed(1) + '%)');
    if (nearRes && nearSup) {
        const rr = (nearRes-last) / (last-nearSup);
        lines.push('  R/R (to nearest R vs S): ' + rr.toFixed(2) + 'x -> ' + (rr > 1.5 ? 'FAVORABLE for longs' : rr < 0.67 ? 'FAVORABLE for shorts' : 'neutral'));
    }
    if (ema50[n-1] != null && ema200[n-1] != null) {
        lines.push('  EMA50: $' + ema50[n-1].toFixed(3) + ' | EMA200: $' + ema200[n-1].toFixed(3));
        lines.push('  Structure: ' + (last>ema50[n-1]&&last>ema200[n-1] ? 'ABOVE both EMAs (bullish)' : last<ema50[n-1]&&last<ema200[n-1] ? 'BELOW both EMAs (bearish)' : 'BETWEEN EMAs (transitional)'));
    }
    return lines.join('\n');
}

// ── Open Interest ─────────────────────────────────────────────────────────────
function getOpenInterestContext() {
    if (!state.cotData || state.cotData.length < 2) return 'Open Interest: insufficient data';
    const lat  = state.cotData[state.cotData.length - 1];
    const prev = state.cotData[state.cotData.length - 2];
    if (!lat.openInterest || lat.openInterest === 0) return 'Open Interest: not available';
    const oiChg = lat.openInterest - prev.openInterest;
    const oiPct = prev.openInterest > 0 ? oiChg / prev.openInterest * 100 : 0;
    const lines = [
        'Open Interest:',
        '  Current: ' + lat.openInterest.toLocaleString() + ' contracts',
        '  W/W: ' + sgn(oiChg) + oiChg.toLocaleString() + ' (' + sgn(oiPct) + oiPct.toFixed(1) + '%)',
    ];
    const lngf = state.stNgfData;
    if (lngf && lngf.length >= 2) {
        const priceChg = lngf[lngf.length-1].close - lngf[lngf.length-2].close;
        if (oiChg > 0 && priceChg > 0)  lines.push('  Signal: Rising OI + Rising price = NEW LONGS -> SUSTAINABLE RALLY (bullish confirmation)');
        else if (oiChg > 0 && priceChg < 0) lines.push('  Signal: Rising OI + Falling price = NEW SHORTS -> SUSTAINED DOWNTREND (bearish confirmation)');
        else if (oiChg < 0 && priceChg > 0) lines.push('  Signal: Falling OI + Rising price = SHORT COVERING -> less sustainable, watch for exhaustion');
        else if (oiChg < 0 && priceChg < 0) lines.push('  Signal: Falling OI + Falling price = LONG LIQUIDATION -> potential capitulation');
    }
    return lines.join('\n');
}

// ── COT context ───────────────────────────────────────────────────────────────
function getCOTContext() {
    if (!state.cotData || !state.cotData.length) return 'COT data: not available';
    const lat  = state.cotData[state.cotData.length - 1];
    const prev = state.cotData.length > 1 ? state.cotData[state.cotData.length - 2] : null;
    const hist = state.cotData.slice(-52);
    const nets = hist.map(function(d) { return d.mmNet; });
    const maxNet = Math.max.apply(null, nets), minNet = Math.min.apply(null, nets);
    const range = maxNet - minNet;
    const pctile = range > 0 ? Math.round((lat.mmNet - minNet) / range * 100) : 'N/A';
    const lines = [
        'COT (CFTC Disaggregated) — report date: ' + lat.date,
        '  MM Net: ' + sgn(lat.mmNet) + lat.mmNet.toLocaleString() + ' | Long: ' + lat.mmLong.toLocaleString() + ' | Short: ' + lat.mmShort.toLocaleString(),
        '  L/S Ratio: ' + (lat.mmRatio != null ? lat.mmRatio.toFixed(2) + 'x -> ' + (lat.mmRatio >= 1.5 ? 'BULLISH' : lat.mmRatio <= 0.7 ? 'BEARISH' : 'NEUTRAL') : 'N/A'),
        '  Net 1y percentile: ' + pctile + '% (0%=max short, 100%=max long)',
        '  1y range: ' + minNet.toLocaleString() + ' / ' + maxNet.toLocaleString(),
    ];
    if (prev) {
        const chg = lat.mmNet - prev.mmNet;
        lines.push('  W/W change: ' + sgn(chg) + chg.toLocaleString() + ' -> ' + (chg > 5000 ? 'AGGRESSIVE BUYING' : chg < -5000 ? 'AGGRESSIVE SELLING' : 'moderate'));
    }
    lines.push('  Producer net: ' + sgn(lat.prodNet) + lat.prodNet.toLocaleString() + ' | Swap dealer net: ' + sgn(lat.swapNet) + lat.swapNet.toLocaleString());
    if (typeof pctile === 'number') {
        if (pctile >= 80) lines.push('  CONTRARIAN: CROWDED LONG -> potential long liquidation risk (bearish)');
        else if (pctile <= 20) lines.push('  CONTRARIAN: CROWDED SHORT -> potential short squeeze (bullish)');
    }
    return lines.join('\n');
}

// ── COT percentiles ───────────────────────────────────────────────────────────
function getCOTPercentiles() {
    if (!state.cotData || state.cotData.length < 10) return '';
    const data = state.cotData;
    const lat = data[data.length - 1];
    const nets = data.map(function(d) { return d.mmNet; });
    function pctile(arr, val) {
        const sorted = arr.slice().sort(function(a,b){return a-b;});
        let rank = 0;
        for (let i = 0; i < sorted.length; i++) { if (sorted[i] <= val) rank = i+1; }
        return Math.round(rank / sorted.length * 100);
    }
    const lines = ['COT MM Net — historical percentiles:'];
    [{label:'1y',n:52},{label:'2y',n:104},{label:'5y',n:260}].forEach(function(w) {
        if (data.length < w.n) return;
        const slice = nets.slice(-w.n);
        const p = pctile(slice, lat.mmNet);
        const mn = Math.min.apply(null, slice), mx = Math.max.apply(null, slice);
        lines.push('  vs ' + w.label + ' [' + mn.toLocaleString() + '/' + mx.toLocaleString() + ']: ' + p + '% -> ' +
            (p >= 85 ? 'HISTORICALLY CROWDED LONG (contrarian bearish)' :
             p >= 65 ? 'elevated long' :
             p <= 15 ? 'HISTORICALLY CROWDED SHORT (contrarian bullish / short squeeze)' :
             p <= 35 ? 'elevated short' : 'NEUTRAL'));
    });
    if (lat.mmRatio != null) {
        const ratios = data.slice(-52).map(function(d){return d.mmRatio;}).filter(function(v){return v!=null;});
        if (ratios.length > 0) {
            const rp = pctile(ratios, lat.mmRatio);
            lines.push('  L/S Ratio ' + lat.mmRatio.toFixed(2) + 'x -> ' + rp + '% of 1y (' + (rp >= 80 ? 'crowded long' : rp <= 20 ? 'crowded short' : 'neutral') + ')');
        }
    }
    return lines.join('\n');
}

// ── Weather-Storage coherence ─────────────────────────────────────────────────
function getWeatherStorageCoherence() {
    if (!state.wxS || !state.stStorageData.length) return '';
    const ti = state.wxS.todayIdx;
    function demsum(days) { let s=0,lim=Math.min(ti+days,state.wxS.demAll.length); for(let j=ti;j<lim;j++) s+=state.wxS.demAll[j]||0; return s; }
    function dem5sum(days){ let s=0,lim=Math.min(ti+days,state.wxS.dem5avg.length); for(let j=ti;j<lim;j++) s+=state.wxS.dem5avg[j]||0; return s; }
    const dem16   = demsum(16), dem5_16 = dem5sum(16);
    const aboveNorm = dem16 > dem5_16;
    const lat = state.stStorageData[state.stStorageData.length - 1];
    const band = st5y(state.stStorageData, [lat.date])[0];
    if (!band || band.avg == null) return '';
    const devBcf = lat.value - band.avg;
    const tight = devBcf < 0;
    let f21dev = null;
    if (state.stLastF21 && state.stLastF21.predictedLevel != null) {
        const b = st5y(state.stStorageData, [state.stLastF21.endDate])[0];
        if (b && b.avg != null) f21dev = state.stLastF21.predictedLevel - b.avg;
    }
    const deficitWidening = f21dev != null && f21dev < devBcf;
    const lines = [
        'Weather-Storage coherence:',
        '  16D demand vs 5y: ' + (aboveNorm ? 'ABOVE (+' + (dem16-dem5_16).toFixed(0) + ')' : 'BELOW (' + (dem16-dem5_16).toFixed(0) + ')'),
        '  Storage vs 5y: ' + sgn(devBcf) + Math.round(devBcf) + ' Bcf (' + (tight ? 'DEFICIT' : 'SURPLUS') + ')',
    ];
    if (f21dev != null) lines.push('  21D forecast: ' + sgn(f21dev) + Math.round(f21dev) + ' Bcf (' + (deficitWidening ? 'deficit WIDENING' : 'narrowing') + ')');
    if (aboveNorm && tight && deficitWidening) lines.push('  Assessment: FULLY COHERENT BULLISH — demand + storage + forecast all aligned');
    else if (!aboveNorm && !tight && !deficitWidening) lines.push('  Assessment: FULLY COHERENT BEARISH — all signals aligned bearish');
    else if (!aboveNorm && tight) lines.push('  Assessment: DIVERGENT — deficit despite low demand -> supply-driven, not weather. Investigate supply side.');
    else if (aboveNorm && !tight) lines.push('  Assessment: PARTIAL — demand above normal but storage still in surplus. Watch deficit trend.');
    else lines.push('  Assessment: MIXED — signals not fully aligned, weigh individually.');
    return lines.join('\n');
}

// ── TA context ────────────────────────────────────────────────────────────────
function getTAContext() {
    const lines = ['Technical Analysis:'];
    const tfLabels = {'5m':'5 Min','15m':'15 Min','1h':'1 Hour','4h':'4 Hour','1d':'1 Day','1w':'1 Week'};
    let hasAny = false;
    TA_TFS.forEach(function(tf) {
        const candles = state.taData[tf];
        if (!candles || !candles.length) return;
        hasAny = true;
        const n = candles.length;
        const last = candles[n-1];
        const closes = candles.map(function(c){return c.close;});
        const ema50  = taEMA(closes, 50);
        const ema200 = taEMA(closes, 200);
        const rsiArr = taRSI(closes, 14);
        const e50=ema50[n-1], e200=ema200[n-1], rsiVal=rsiArr[n-1];
        const signals = [];
        if (e50!=null&&e200!=null) {
            signals.push(last.close>e50 ? 'Price>EMA50(bullish)' : 'Price<EMA50(bearish)');
            signals.push(e50>e200 ? 'Golden cross(bullish)' : 'Death cross(bearish)');
        }
        if (rsiVal!=null) signals.push('RSI:' + rsiVal.toFixed(1) + ' (' + (rsiVal>70?'overbought':rsiVal<30?'oversold':'neutral') + ')');
        lines.push('  [' + tfLabels[tf] + '] Close:$' + last.close.toFixed(3) +
            (e50!=null  ? ' EMA50:$'+e50.toFixed(3) : '') +
            (e200!=null ? ' EMA200:$'+e200.toFixed(3) : '') +
            (signals.length ? ' | ' + signals.join(' | ') : ''));
    });
    if (!hasAny) return 'Technical Analysis: not loaded yet';
    return lines.join('\n');
}

// ── Season context ────────────────────────────────────────────────────────────
function getSeasonContext(si) {
    const m = si.month;
    const lines = [si.icon + ' ' + si.name + ' (day ' + si.daysIn + '/' + si.sTotal + ', ' + si.daysLeft + 'd left) -> next: ' + si.nxtIcon + ' ' + si.nxtName];
    if (si.name === 'Heating') {
        lines.push('Heating season: withdrawals dominant. Storage deficit 2-3x more price impact than other seasons.');
        lines.push('Primary drivers: HDD/cold snaps (bullish), LNG exports, pipeline freeze-offs.');
        lines.push('End-of-season target (Mar 1): 1,500-1,800 Bcf.');
    } else if (si.name === 'Cooling') {
        lines.push('Cooling season: CDD-driven power burn demand. Hurricane season risk.');
        lines.push('Primary drivers: heat waves (bullish), mild summer (bearish), hurricane GoM (bullish).');
        lines.push('End-of-injection target (Nov 1): 3,700-4,000 Bcf.');
    } else if (m >= 3 && m <= 5) {
        lines.push('Spring shoulder: end of withdrawals -> start of injections. Low demand.');
        lines.push('Primary drivers: injection pace vs 5y avg, legacy heating balance.');
        lines.push('Risk: Widow Maker Mar/Apr (H/J) spread volatility.');
    } else {
        lines.push('Fall shoulder: end of injection season, pre-heating positioning.');
        lines.push('Primary drivers: pre-winter storage adequacy, early cold forecasts.');
    }
    return lines;
}

// ── Full context (quick chat) ─────────────────────────────────────────────────
export function getContext() {
    const si = getSeasonInfo();
    const lines = ['=== NATGAS LIVE DATA ==='];
    lines.push('Date: ' + new Date().toLocaleString('en-GB', {timeZone:'Europe/Prague'}));
    lines.push('\n--- SEASON ---');
    getSeasonContext(si).forEach(function(l){lines.push(l);});
    if (state.stStorageData.length) {
        const lat = state.stStorageData[state.stStorageData.length-1];
        const prev = state.stStorageData.length>1 ? state.stStorageData[state.stStorageData.length-2] : null;
        const band = st5y(state.stStorageData,[lat.date])[0];
        const avg5 = band ? band.avg : null;
        const devBcf = avg5!=null ? lat.value-avg5 : null;
        const devPct = (avg5&&avg5!==0&&devBcf!=null) ? devBcf/avg5*100 : null;
        lines.push('\n--- STORAGE ---');
        lines.push('Latest: '+Math.round(lat.value).toLocaleString()+' Bcf | Report: '+fmtShort(isoAdd(lat.date,6)));
        if (prev) lines.push('W/W: '+sgn(lat.value-prev.value)+Math.round(lat.value-prev.value)+' Bcf');
        if (avg5!=null) lines.push('5y avg: '+Math.round(avg5).toLocaleString()+' Bcf | vs 5y: '+sgn(devBcf)+Math.round(devBcf)+' Bcf ('+sgn(devPct)+devPct.toFixed(1)+'%)');
        if (devBcf!=null) { const fp=fairPrice(devBcf); lines.push('Fair price: $'+fp.toFixed(3)+' (range: $'+(fp-0.5).toFixed(3)+' - $'+(si.isHeating?fp+1.9:fp+0.5).toFixed(3)+')'); }
        [state.stLastF7,state.stLastF14,state.stLastF21].forEach(function(f,fi){
            if (!f||f.predictedLevel==null) return;
            const lbl=['7D','14D','21D'][fi];
            const b=st5y(state.stStorageData,[f.endDate])[0];
            lines.push(lbl+' fcst: '+Math.round(f.predictedLevel)+' Bcf');
            if (b&&b.avg!=null){const dv=f.predictedLevel-b.avg;lines.push('  vs 5y: '+sgn(dv)+Math.round(dv)+' Bcf | fair: $'+fairPrice(dv).toFixed(3));}
        });
    }
    if (state.stNgfData.length) {
        const lngf=state.stNgfData[state.stNgfData.length-1];
        const curC=ngfCurrent(), nxtC=curC?ngfNext(curC):null;
        lines.push('\n--- FUTURES ---');
        lines.push('Front ('+( curC?curC.label:'?')+'): $'+lngf.close.toFixed(3));
        if (nxtC&&state.nextContractPrice!=null){const sp=state.nextContractPrice-lngf.close;lines.push('Next ('+nxtC.label+'): $'+state.nextContractPrice.toFixed(3)+' | Spread: '+sgn(sp)+sp.toFixed(3)+' -> '+(sp>=0?'Contango':'Backwardation'));}
    }
    if (state.fcContractsData.length) {
        lines.push('\n--- CURVE ---');
        state.fcContractsData.filter(function(c){return c.price!=null;}).forEach(function(c){
            lines.push('  '+c.label+(c.isFront?' [FRONT]':c.isNext?' [NEXT]':'')+': $'+c.price.toFixed(3)+(c.spread!=null?' ('+sgn(c.spread)+c.spread.toFixed(3)+')':''));
        });
    }
    const supply=peCalcSupply();
    if (supply&&supply.length){const sl=supply[supply.length-1];lines.push('\n--- SUPPLY ---');lines.push('Total ('+sl.period+'): '+sl.value.toFixed(2)+' Bcf/d');}
    if (state.wxS) {
        const ti=state.wxS.todayIdx;
        function ds(d){let s=0,lim=Math.min(ti+d,state.wxS.demAll.length);for(let j=ti;j<lim;j++)s+=state.wxS.demAll[j]||0;return s;}
        function d5s(d){let s=0,lim=Math.min(ti+d,state.wxS.dem5avg.length);for(let j=ti;j<lim;j++)s+=state.wxS.dem5avg[j]||0;return s;}
        lines.push('\n--- WEATHER ---');
        [4,7,16].forEach(function(d){const dem=ds(d),dem5=d5s(d),dev=dem-dem5;lines.push(d+'D: '+dem.toFixed(0)+' | vs 5y: '+sgn(dev)+dev.toFixed(0));});
    }
    lines.push('\n'+getTAContext());
    lines.push('\n=== END ===');
    return lines.join('\n');
}

// ── Report prompt ─────────────────────────────────────────────────────────────
function getReportPrompt() {
    const si = getSeasonInfo();
    const seasonLines = getSeasonContext(si);

    // Storage
    const storLines = [];
    let fpNow = null, devBcfNow = null;
    if (state.stStorageData.length) {
        const lat = state.stStorageData[state.stStorageData.length-1];
        const prev = state.stStorageData.length>1 ? state.stStorageData[state.stStorageData.length-2] : null;
        const band = st5y(state.stStorageData,[lat.date])[0];
        const avg5 = band ? band.avg : null;
        devBcfNow = avg5!=null ? lat.value-avg5 : null;
        const devPct = (avg5&&avg5!==0&&devBcfNow!=null) ? devBcfNow/avg5*100 : null;
        storLines.push('Current: '+Math.round(lat.value).toLocaleString()+' Bcf (report: '+fmtShort(isoAdd(lat.date,6))+')');
        if (prev) storLines.push('W/W: '+sgn(lat.value-prev.value)+Math.round(lat.value-prev.value)+' Bcf');
        if (avg5!=null) storLines.push('5y avg: '+Math.round(avg5).toLocaleString()+' Bcf | deviation: '+sgn(devBcfNow)+Math.round(devBcfNow)+' Bcf ('+sgn(devPct)+devPct.toFixed(1)+'%) -> '+(devBcfNow>=0?'SURPLUS (bearish)':'DEFICIT (bullish)'));
        if (devBcfNow!=null){fpNow=fairPrice(devBcfNow);storLines.push('Fair price now: $'+fpNow.toFixed(3)+'  range: $'+(fpNow-0.5).toFixed(3)+' -- $'+(si.isHeating?fpNow+1.9:fpNow+0.5).toFixed(3));}
        if (state.stStorageData.length>=5){const r=state.stStorageData.slice(-5);const wc=[];for(let i=1;i<r.length;i++)wc.push(r[i].value-r[i-1].value);storLines.push('Last 4 weeks: '+wc.map(function(c){return sgn(c)+Math.round(c);}).join(', ')+' Bcf');}
    }

    // Forecasts
    const fcstLines = [];
    const fpFcst = {};
    if (state.stStorageData.length && state.wxS) {
        fcstLines.push('NOTE: Fair prices below are approximations from projected storage deviation.');
        [[state.stLastF7,7,'7D'],[state.stLastF14,14,'14D'],[state.stLastF21,21,'21D']].forEach(function(p){
            const f=p[0],dk=p[1],lbl=p[2];
            if (!f||f.predictedLevel==null){fcstLines.push(lbl+': N/A');return;}
            const b=st5y(state.stStorageData,[f.endDate])[0];
            let line=lbl+': '+Math.round(f.predictedLevel).toLocaleString()+' Bcf @ '+fmtShort(f.endDate)+' (D-index:'+f.D.toFixed(1)+')';
            if (b&&b.avg!=null){const dv=f.predictedLevel-b.avg,pv=b.avg!==0?dv/b.avg*100:0,fp=fairPrice(dv);fpFcst[dk]=fp;line+=' | vs 5y: '+sgn(dv)+Math.round(dv)+' Bcf ('+sgn(pv)+pv.toFixed(1)+'%) | approx fair: $'+fp.toFixed(3);}
            fcstLines.push(line);
        });
    }

    // Prices + mispricing
    const priceLines = [];
    let frontMktPrice = null;
    if (state.stNgfData.length) {
        const lngf=state.stNgfData[state.stNgfData.length-1];
        const lngfPrev=state.stNgfData.length>1?state.stNgfData[state.stNgfData.length-2]:null;
        frontMktPrice=lngf.close;
        const curC=ngfCurrent(),nxtC=curC?ngfNext(curC):null;
        const l52=state.stNgfData.slice(-52);
        const h52=Math.max.apply(null,l52.map(function(x){return x.high;}));
        const lo52=Math.min.apply(null,l52.map(function(x){return x.low;}));
        const pos52=h52>lo52?((frontMktPrice-lo52)/(h52-lo52)*100).toFixed(0):'N/A';
        priceLines.push('FRONT ('+(curC?curC.label:'?')+'): $'+frontMktPrice.toFixed(3));
        priceLines.push('  W/W: '+(lngfPrev?sgn(frontMktPrice-lngfPrev.close)+(frontMktPrice-lngfPrev.close).toFixed(3):'N/A'));
        priceLines.push('  52w High: $'+h52.toFixed(3)+' | 52w Low: $'+lo52.toFixed(3)+' | Position: '+pos52+'%');
        if (state.nextContractPrice!=null&&nxtC){const sp=state.nextContractPrice-frontMktPrice;priceLines.push('NEXT ('+(nxtC.label)+'): $'+state.nextContractPrice.toFixed(3)+' | Spread: '+sgn(sp)+sp.toFixed(3)+' -> '+(sp>=0?'CONTANGO':'BACKWARDATION'));}
        if (fpNow!=null){
            priceLines.push('');
            priceLines.push('=== MISPRICING TABLE ===');
            priceLines.push('Each contract vs its OWN fair price. Overvalued=bearish edge, Undervalued=bullish edge.');
            const mn=frontMktPrice-fpNow,mnp=fpNow!==0?mn/fpNow*100:0;
            priceLines.push('Front $'+frontMktPrice.toFixed(3)+' vs fair now $'+fpNow.toFixed(3)+': '+sgn(mn)+mn.toFixed(3)+' ('+sgn(mnp)+mnp.toFixed(1)+'%) -> '+(mn<-0.10?'UNDERVALUED (bullish edge)':mn>0.10?'OVERVALUED (bearish edge)':'FAIRLY PRICED'));
            if (state.nextContractPrice!=null){
                [7,14,21].forEach(function(dk){
                    if (!fpFcst[dk]) return;
                    const m2=state.nextContractPrice-fpFcst[dk],m2p=fpFcst[dk]!==0?m2/fpFcst[dk]*100:0;
                    priceLines.push('Next $'+state.nextContractPrice.toFixed(3)+' vs fair '+dk+'D $'+fpFcst[dk].toFixed(3)+': '+sgn(m2)+m2.toFixed(3)+' ('+sgn(m2p)+m2p.toFixed(1)+'%) -> '+(m2<-0.10?'UNDERVALUED':m2>0.10?'OVERVALUED':'FAIRLY PRICED'));
                });
            }
            priceLines.push('Pattern: Front UNDER+Next OVER=fear premium | Front OVER+Next OVER=broad bearish | Front UNDER+Next UNDER=broad bullish | Both FAIR=TA decides');
        }
    }

    // Supply
    const supLines = [];
    const supply = peCalcSupply();
    if (supply&&supply.length>=3){
        const sl=supply[supply.length-1],sl2=supply[supply.length-2],sl3=supply[supply.length-3];
        const m1=sl.value-sl2.value,m2=sl2.value-sl3.value;
        supLines.push('Total Supply ('+fmtPeriod(sl.period)+'): '+sl.value.toFixed(2)+' Bcf/d | MoM: '+sgn(m1)+m1.toFixed(2)+' | Prev MoM: '+sgn(m2)+m2.toFixed(2)+' -> '+(m1<0&&m2<0?'SUSTAINED DECLINE (bullish)':m1>0&&m2>0?'SUSTAINED GROWTH (bearish)':'mixed'));
    }
    ['prod','can','mex','lng'].forEach(function(pk){
        const d=state.peData[pk]; if(!d||d.length<3) return;
        const last=d[d.length-1],p2v=d[d.length-2],chg=last.value-p2v.value;
        supLines.push(PE_LABELS[pk]+': '+last.value.toFixed(2)+' Bcf/d (MoM '+sgn(chg)+chg.toFixed(2)+')');
    });

    // Weather
    const wxLines = [];
    if (state.wxS) {
        const ti=state.wxS.todayIdx;
        function rds(d){let s=0,lim=Math.min(ti+d,state.wxS.demAll.length);for(let j=ti;j<lim;j++)s+=state.wxS.demAll[j]||0;return s;}
        function rd5s(d){let s=0,lim=Math.min(ti+d,state.wxS.dem5avg.length);for(let j=ti;j<lim;j++)s+=state.wxS.dem5avg[j]||0;return s;}
        [4,7,10,13,16].forEach(function(d){
            const dem=rds(d),dem5=rd5s(d),dev=dem-dem5,pct=dem5>0.5?dev/dem5*100:0;
            wxLines.push(d+'D: '+dem.toFixed(0)+' (avg '+(dem/d).toFixed(1)+'/d) | vs 5y: '+(dem5>0.5?sgn(dev)+dev.toFixed(0)+' ('+sgn(pct)+pct.toFixed(1)+'%) -> '+(dev>5?'ABOVE NORMAL (bullish)':dev<-5?'BELOW NORMAL (bearish)':'near normal'):'N/A'));
        });
        let hF=0,cF=0,l16=Math.min(ti+16,state.wxS.hddAll.length);
        for(let k=ti;k<l16;k++){hF+=state.wxS.hddAll[k]||0;cF+=state.wxS.cddAll[k]||0;}
        const totF=hF+cF;
        wxLines.push('16D HDD: '+hF.toFixed(1)+' | CDD: '+cF.toFixed(1)+' | Driver: '+(totF<0.5?'no demand':hF>=cF?'heating '+Math.round(hF/totF*100)+'%':'cooling '+Math.round(cF/totF*100)+'%'));
    }

    // Assemble prompt — skip empty sections
    const sections = [
        '=== NATGAS HENRY HUB MARKET ANALYSIS ===',
        '',
        'You are a senior commodity analyst at a hedge fund specializing in Henry Hub Natural Gas (NG=F, NYMEX).',
        'Analyze ALL data below. Deliver a FINAL VERDICT with specific trade setup.',
        '',
        '=== STEP BY STEP REASONING (before writing) ===',
        '1. FAIR PRICE RANGE: What is fair price center and min/max for current season?',
        '2. FUNDAMENTALS: Storage deviation + injection pace vs seasonal norm. 21D forecast.',
        '3. CURVE: Contango/backwardation? Structural (seasonal) or anomalous (fear)?',
        '4. MISPRICING: Front vs fair now. Next vs its own fair. Pattern?',
        '5. FEAR PREMIUM: Back-month contracts above fair max -> extreme fear. Above center -> moderate.',
        '6. COT: Crowded? Contrarian risk? OI signal?',
        '7. RSI DIVERGENCE: Confirming or contradicting price action?',
        '8. S/R LEVELS: Where are key levels? R/R for trade setup?',
        '9. TRADE SETUP: Use S/R + fair price range. Entry near S/R. Stop beyond S/R. Target at next S/R or fair price. Only if R/R >= 1.5x.',
        '10. TIME HORIZON:',
        '    SHORT (1-2W): TA + momentum + COT + weather 7D (high confidence only)',
        '    MEDIUM (1M): Storage 21D + curve + fair price range + supply',
        '',
        '=== FEAR PREMIUM CONCEPT ===',
        'Markets price EXPECTED FUTURE SCARCITY, not just today fundamentals.',
        'DETECTION: Back-month contracts ABOVE fair price model = fear premium. Backwardation anomalous for season = market expects future tightness. Aggressive MM buying despite adequate storage = speculation.',
        '',
        '=== MISPRICING LOGIC ===',
        'Each contract has its OWN fair price. Compare independently, then find PATTERN:',
        'Front UNDER + Next OVER -> fear premium (bullish fundamental, forward speculative)',
        'Front UNDER + Next UNDER -> broad undervaluation -> bullish edge',
        'Front OVER  + Next OVER  -> broad overvaluation -> bearish edge',
        'Both FAIR -> momentum/TA decides',
        '',
        '=== STRUCTURAL vs ANOMALOUS CURVE ===',
        'STRUCTURAL: normal seasonal shape. Does NOT indicate fear.',
        'ANOMALOUS: back months above fair price despite no seasonal reason = FEAR PREMIUM.',
        'Current season: ' + si.icon + ' ' + si.name + ' — use to classify curve shape.',
        '',
        '=== SIGNAL PRIORITY ===',
        'SHORT (1-2W): 1. TA weekly | 2. COT + OI | 3. RSI divergence | 4. Weather 7D | 5. Front mispricing | 6. S/R levels',
        'MEDIUM (1M):  1. Storage 21D forecast | 2. Curve + fear premium | 3. Mispricing pattern | 4. Supply | 5. Weather 16D | 6. TA weekly',
        '',
        '=== MARKET DATA ===',
    ];

    const mem = getAIMemoryContext();
    if (mem) { sections.push('--- PREVIOUS ANALYSIS ---'); sections.push(mem); sections.push(''); }

    sections.push('--- DATETIME ---');
    sections.push(getDatetimeContext());
    sections.push('');
    sections.push('--- DATA FRESHNESS ---');
    sections.push(getDataFreshnessContext());
    sections.push('');
    sections.push('--- FAIR PRICE MODEL ---');
    sections.push(getFairPriceContext() || 'Fair price: insufficient data');
    sections.push('');
    sections.push('--- END-OF-SEASON TRACKING ---');
    sections.push(getEndOfSeasonContext() || 'End-of-season: insufficient data');
    sections.push('');
    sections.push('--- SEASON ---');
    seasonLines.forEach(function(l){sections.push(l);});
    sections.push('');
    sections.push('--- STORAGE ---');
    sections.push(storLines.length ? storLines.join('\n') : 'No storage data');
    sections.push('');
    sections.push('--- STORAGE FORECASTS ---');
    sections.push(fcstLines.length ? fcstLines.join('\n') : 'No forecast data');
    sections.push('');
    sections.push('--- STORAGE PACE ---');
    sections.push(getStoragePaceContext() || 'No pace data');
    sections.push('');
    sections.push('--- MARKET PRICES + MISPRICING ---');
    sections.push(priceLines.length ? priceLines.join('\n') : 'No price data');
    sections.push('');
    sections.push('--- FUTURES CURVE + SPREADS ---');
    sections.push(getSpreadContext());
    sections.push('');
    sections.push('--- SUPPLY ---');
    sections.push(supLines.length ? supLines.join('\n') : 'No supply data');
    sections.push('');
    sections.push('--- WEATHER & DEMAND ---');
    sections.push(wxLines.length ? wxLines.join('\n') : 'No weather data');
    sections.push('Weather reliability: days 1-7 HIGH | 8-10 MEDIUM | 11-16 LOW');
    sections.push('');
    sections.push('--- COT POSITIONING ---');
    sections.push(getCOTContext());
    sections.push('');
    sections.push('--- COT HISTORICAL PERCENTILES ---');
    sections.push(getCOTPercentiles() || 'Insufficient COT history');
    sections.push('');
    sections.push('--- OPEN INTEREST ---');
    sections.push(getOpenInterestContext());
    sections.push('');
    sections.push('--- PRICE HISTORY & MOMENTUM ---');
    sections.push(getPriceHistoryContext());
    sections.push('');
    sections.push('--- TECHNICAL ANALYSIS ---');
    sections.push(getTAContext());
    sections.push('');
    sections.push('--- RSI DIVERGENCE ---');
    sections.push(getRSIDivergence());
    sections.push('');
    sections.push('--- SUPPORT & RESISTANCE ---');
    sections.push(getSupportResistance());
    sections.push('');
    sections.push('--- WEATHER-STORAGE COHERENCE ---');
    sections.push(getWeatherStorageCoherence() || 'Insufficient data');
    sections.push('');
    sections.push('=== REQUIRED OUTPUT (in Czech) ===');
    sections.push('');
    sections.push('## FINALNI STANOVISKO (write FIRST)');
    sections.push('**SENTIMENT:** BULLISH / SLIGHTLY BULLISH / NEUTRAL / SLIGHTLY BEARISH / BEARISH');
    sections.push('**Confidence:** X/10');
    sections.push('**Fair price range:** $X.XX -- $X.XX');
    sections.push('**Krátkodobý výhled (1-2 týdny):** $X.XX -- $X.XX');
    sections.push('**Střednědobý výhled (1 měsíc):** $X.XX -- $X.XX');
    sections.push('**Primární driver:** [one sentence]');
    sections.push('**Fear premium:** [none / moderate / significant] + why');
    sections.push('**Momentum:** [accelerating up / stable / accelerating down]');
    sections.push('**Trade idea:** [LONG/SHORT/NO TRADE] entry ~$X.XXX | target $X.XXX | stop $X.XXX | R/R X.Xx');
    sections.push('');
    sections.push('## 1. MISPRICING ANALYZA');
    sections.push('Front vs fair now. Next vs fair 7D/14D/21D. Pattern. Fear premium?');
    sections.push('');
    sections.push('## 2. STORAGE A FORECASTS');
    sections.push('Current deviation + trend + pace vs seasonal norm. 7D/14D/21D. End-of-season tracking.');
    sections.push('');
    sections.push('## 3. FUTURES KRIVKA — STRUKTURALNI VS ANOMALNI');
    sections.push('Structural or anomalous? Fear premium magnitude? Spread analysis.');
    sections.push('');
    sections.push('## 4. COT + OPEN INTEREST');
    sections.push('MM net + percentiles (1y/2y/5y). OI signal. Contrarian risk?');
    sections.push('');
    sections.push('## 5. SUPPLY');
    sections.push('Total supply trend. LNG exports. Production.');
    sections.push('');
    sections.push('## 6. WEATHER A DEMAND');
    sections.push('16D demand vs 5y (weight 1-7d heavily, 11-16d lightly). HDD/CDD. Coherence with storage.');
    sections.push('');
    sections.push('## 7. TECHNICKA ANALYZA');
    sections.push('1W trend -> 1D confirmation -> 4H/1H entry. RSI divergence. Key levels.');
    sections.push('');
    sections.push('## 8. KATALYZATORY A RIZIKA');
    sections.push('Top 3 bullish catalysts (with price impact $). Top 3 bearish catalysts. What changes the verdict?');
    sections.push('');
    sections.push('## 9. TRADE SETUP');
    sections.push('**PRIMARY SETUP:**');
    sections.push('Direction: LONG / SHORT / NO TRADE');
    sections.push('Entry: $X.XXX [condition: pullback to support / break above resistance / at market]');
    sections.push('Target 1: $X.XXX (+X.X%) — partial profit at first resistance');
    sections.push('Target 2: $X.XXX (+X.X%) — full target at fair price / next S/R');
    sections.push('Stop Loss: $X.XXX (-X.X%) — beyond key S/R level');
    sections.push('Risk/Reward: X.Xx (must be >= 1.5x or recommend NO TRADE)');
    sections.push('Timeframe: short-term (1-2W) / medium-term (1M)');
    sections.push('Conviction: LOW / MEDIUM / HIGH');
    sections.push('Trigger: [specific price/event that confirms entry]');
    sections.push('');
    sections.push('**ALTERNATIVE SETUP:**');
    sections.push('Direction: LONG / SHORT | Entry: $X.XXX | Target: $X.XXX | Stop: $X.XXX');
    sections.push('Trigger: [what invalidates primary and activates this]');
    sections.push('');
    sections.push('**INVALIDATION:**');
    sections.push('Long invalidated if: [price level or event]');
    sections.push('Short invalidated if: [price level or event]');
    sections.push('');
    sections.push('Rules: Entry at S/R. Stop beyond S/R. Target within fair price range. R/R >= 1.5x. State trigger. Consider rollover if expiry <= 5 days.');
    sections.push('');
    sections.push('Language: Czech. Style: hedge fund research note. Numbers everywhere. No filler.');

    return sections.join('\n');
}

// ── Public API ────────────────────────────────────────────────────────────────
export async function aiSend() {
    const input = document.getElementById('ai-input');
    const msg = input.value.trim();
    if (!msg) return;
    input.value = '';
    const btn = document.getElementById('ai-send-btn');
    btn.disabled = true;
    appendBubble('user', msg, false);
    state.aiHistory.push({ role: 'user', content: msg });
    const loadBbl = appendBubble('assistant', '', true);
    const sys = [
        'You are a senior commodity analyst specializing in Henry Hub Natural Gas.',
        'Answer in Czech. Hedge fund style. Specific numbers.',
        'CRITICAL: FRONT MONTH PRICE = market price NYMEX | FAIR PRICE = model estimate | Mispricing = trading edge.',
        '', 'CURRENT DATA:', getContext()
    ].join('\n');
    try {
        const text = await callGroq([{role:'system',content:sys}].concat(state.aiHistory.slice(-10)), 1024);
        loadBbl.innerHTML = msgHtml(text || 'No response.');
        state.aiHistory.push({ role: 'assistant', content: text });
        dbLog('AI: OK (' + text.length + ' chars)', 'ok');
    } catch(err) {
        loadBbl.innerHTML = '<span style="color:#ff7b72">Error: ' + esc(err.message) + '</span>';
        dbLog('AI error: ' + err.message, 'error');
    }
    btn.disabled = false;
    document.getElementById('ai-messages').scrollTop = 99999;
}

export async function aiSendReport() {
    if (!state.stStorageData.length) { alert('Storage data not loaded yet.'); return; }
    const btn = document.getElementById('ai-report-btn');
    btn.disabled = true; btn.textContent = 'Generating...';
    appendBubble('user', 'Full Analytical Report', false);
    const prompt = getReportPrompt();
    state.aiHistory.push({ role: 'user', content: prompt });
    const loadBbl = appendBubble('assistant', '', true);
    const sys = [
        'You are a senior commodity analyst at a hedge fund specializing in Henry Hub Natural Gas.',
        'Think step by step before writing. Output in Czech. Hedge fund research note style.',
        'Start with FINALNI STANOVISKO. Include specific trade setup with entry/target/stop.',
        'End with one of: BULLISH / SLIGHTLY BULLISH / NEUTRAL / SLIGHTLY BEARISH / BEARISH'
    ].join('\n');
    try {
        const text = await callGroq([{role:'system',content:sys}].concat(state.aiHistory.slice(-12)), 3500);
        const output = text || 'No response.';
        loadBbl.innerHTML = msgHtml(output);
        state.aiHistory.push({ role: 'assistant', content: output });
        dbLog('AI report: OK (' + output.length + ' chars)', 'ok');
        // Auto-save memory
        const sm = output.match(/\*\*SENTIMENT:\*\*\s*([^\n*<]+)/i);
        const cm = output.match(/\*\*Confidence:\*\*\s*(\d+)/i);
        const stm = output.match(/krátkodob[^:*]*\*\*[^$]*(\$[^\n<]+)/i);
        const mtm = output.match(/střednědob[^:*]*\*\*[^$]*(\$[^\n<]+)/i);
        const dm  = output.match(/primární driver[^:*]*\*\*[^:]*:\*\*\s*([^\n<*]+)/i);
        const fm  = output.match(/fear premium[^:*]*\*\*[^:]*:\*\*\s*([^\n<*]+)/i);
        saveAIMemory(
            sm ? sm[1].trim() : 'N/A',
            cm ? cm[1].trim() : 'N/A',
            stm ? stm[1].trim() : null,
            mtm ? mtm[1].trim() : null,
            dm  ? dm[1].trim()  : null,
            fm  ? fm[1].trim()  : null
        );
    } catch(err) {
        loadBbl.innerHTML = '<span style="color:#ff7b72">Error: ' + esc(err.message) + '</span>';
        dbLog('AI report error: ' + err.message, 'error');
    }
    btn.disabled = false; btn.textContent = 'Full Report';
    document.getElementById('ai-messages').scrollTop = 99999;
}

export async function aiSendQuickBrief() {
    if (!state.stStorageData.length) { alert('Storage data not loaded yet.'); return; }
    const btn = document.getElementById('ai-brief-btn');
    btn.disabled = true; btn.textContent = 'Generating...';
    appendBubble('user', 'Quick Brief', false);
    const si = getSeasonInfo();
    const lat = state.stStorageData.length ? state.stStorageData[state.stStorageData.length-1] : null;
    const band = lat ? st5y(state.stStorageData,[lat.date])[0] : null;
    const avg5 = band ? band.avg : null;
    const devBcf = (lat&&avg5) ? lat.value-avg5 : null;
    const fpNow = devBcf!=null ? fairPrice(devBcf) : null;
    const lngf = state.stNgfData.length ? state.stNgfData[state.stNgfData.length-1] : null;
    const briefData = [
        'QUICK BRIEF context:',
        'Date: ' + new Date().toLocaleString('en-GB',{timeZone:'Europe/Prague'}),
        'Season: ' + si.icon + ' ' + si.name + ' (day '+si.daysIn+'/'+si.sTotal+', '+si.daysLeft+'d left)',
        lat  ? 'Storage: '+Math.round(lat.value).toLocaleString()+' Bcf | vs 5y: '+(devBcf!=null?sgn(devBcf)+Math.round(devBcf)+' Bcf ('+( devBcf>=0?'surplus':'deficit')+')':'N/A') : '',
        fpNow ? 'Fair price: $'+fpNow.toFixed(3)+' (range: $'+(fpNow-0.5).toFixed(3)+' -- $'+(si.isHeating?fpNow+1.9:fpNow+0.5).toFixed(3)+')' : '',
        lngf  ? 'Front month: $'+lngf.close.toFixed(3) : '',
        state.nextContractPrice ? 'Next contract: $'+state.nextContractPrice.toFixed(3) : '',
        getEndOfSeasonContext(),
        getSpreadContext(),
        getSupportResistance(),
        getTAContext(),
        getCOTContext(),
    ].filter(function(l){return l&&l.trim();}).join('\n');
    const sys = 'You are a senior NatGas analyst. Write ultra-concise daily brief in Czech. ' +
        '5-7 bullet points max. Start with sentiment emoji (green=bullish, yellow=neutral, red=bearish). ' +
        'Always include one bullet: trade idea LONG/SHORT/NO TRADE + entry/target/stop. ' +
        'Last line: Cíl: $X.XX-$X.XX (1-2T) | Driver: [one word] | Trade: LONG/SHORT/NO TRADE';
    state.aiHistory.push({ role: 'user', content: briefData });
    const loadBbl = appendBubble('assistant', '', true);
    try {
        const text = await callGroq([{role:'system',content:sys},{role:'user',content:briefData}], 600);
        loadBbl.innerHTML = msgHtml(text || 'No response.');
        state.aiHistory.push({ role: 'assistant', content: text });
        dbLog('AI brief: OK (' + text.length + ' chars)', 'ok');
    } catch(err) {
        loadBbl.innerHTML = '<span style="color:#ff7b72">Error: ' + esc(err.message) + '</span>';
        dbLog('AI brief error: ' + err.message, 'error');
    }
    btn.disabled = false; btn.textContent = 'Quick Brief';
    document.getElementById('ai-messages').scrollTop = 99999;
}

export function aiClear() {
    state.aiHistory = [];
    document.getElementById('ai-messages').innerHTML =
        '<div style="text-align:center;color:#6e7681;font-size:11px;font-family:var(--mono);padding:20px 0">NatGas AI Analyst — ask anything about current market data</div>';
}
