// js/ai.js
import { GROQ_URL, GROQ_MODEL, TA_TFS } from './constants.js';
import { state } from './state.js';
import { dbLog } from './debug.js';
import { esc, sgn, isoAdd, fmtShort, fmtPeriod, fairPrice } from './utils.js';
import { getSeasonInfo } from './season.js';
import { st5y } from './storage5y.js';
import { ngfCurrent, ngfNext } from './contracts.js';
import { peCalcSupply } from './production.js';
import { taEMA, taBB, taRSI, taMACD } from './technical.js';
import { PE_LABELS, PE_COLORS } from './constants.js';

// ── Low-level Groq call ───────────────────────────────────────────────────────

async function callGroq(messages, maxTokens = 1024) {
  const resp = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: GROQ_MODEL, max_tokens: maxTokens, messages })
  });
  if (!resp.ok) { const et = await resp.text(); throw new Error('HTTP ' + resp.status + ': ' + et.slice(0, 300)); }
  const data = await resp.json();
  let text = '';
  if (data.choices?.[0]) {
    const c = data.choices[0].message;
    if (c && typeof c.content === 'string') text = c.content.trim();
    else if (c && Array.isArray(c.content)) text = c.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
  }
  if (!text && data.content?.[0]) text = (data.content[0].text || '').trim();
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
  bbl.innerHTML = isLoading ? '<span class="sp"></span><span style="color:#8b949e">Thinking…</span>' : msgHtml(text);
  wrap.appendChild(bbl);
  msgs.appendChild(wrap);
  msgs.scrollTop = msgs.scrollHeight;
  return bbl;
}

// ── TA context builder ────────────────────────────────────────────────────────

function getTAContext() {
  const lines = ['\n--- TECHNICAL ANALYSIS ---'];
  const tfLabels = { '1h': '1 Hour', '4h': '4 Hour', '1d': '1 Day', '1w': '1 Week' };
  let hasAny = false;
  TA_TFS.forEach(tf => {
    const candles = state.taData[tf];
    if (!candles?.length) return;
    hasAny = true;
    const n = candles.length, last = candles[n - 1];
    const closes = candles.map(c => c.close);
    const ema50 = taEMA(closes, 50), ema200 = taEMA(closes, 200);
    const bb = taBB(closes, 20, 2), rsi = taRSI(closes, 14), macdObj = taMACD(closes, 12, 26, 9);
    const e50 = ema50[n-1], e200 = ema200[n-1];
    const bbU = bb.upper[n-1], bbM = bb.mid[n-1], bbL = bb.lower[n-1];
    const rsiVal = rsi[n-1], macdVal = macdObj.macd[n-1], sigVal = macdObj.signal[n-1], histVal = macdObj.hist[n-1];
    const signals = [];
    if (e50 != null && e200 != null) {
      signals.push(last.close > e50 ? 'Price>EMA50(bullish)' : 'Price<EMA50(bearish)');
      signals.push(e50 > e200 ? 'EMA50>EMA200 golden cross(bullish)' : 'EMA50<EMA200 death cross(bearish)');
    }
    if (bbU != null && bbL != null && bbM != null) {
      const bbPos = (last.close - bbL) / (bbU - bbL) * 100;
      signals.push('BB position: ' + bbPos.toFixed(0) + '% (0=lower,100=upper band)');
    }
    if (rsiVal != null) signals.push('RSI: ' + rsiVal.toFixed(1) + ' → ' + (rsiVal > 70 ? 'overbought' : rsiVal < 30 ? 'oversold' : 'neutral'));
    if (histVal != null) signals.push('MACD hist: ' + histVal.toFixed(4) + (histVal > 0 ? ' (bullish momentum)' : ' (bearish momentum)'));
    lines.push('\n[' + tfLabels[tf] + '] Last close: $' + last.close.toFixed(3));
    if (e50 != null)   lines.push('  EMA50: $' + e50.toFixed(3) + '  EMA200: ' + (e200 != null ? '$' + e200.toFixed(3) : 'N/A'));
    if (bbU != null)   lines.push('  BB: Upper $' + bbU.toFixed(3) + ' / Mid $' + bbM.toFixed(3) + ' / Lower $' + bbL.toFixed(3));
    if (rsiVal != null) lines.push('  RSI(14): ' + rsiVal.toFixed(1));
    if (macdVal != null) lines.push('  MACD: ' + macdVal.toFixed(4) + ' | Signal: ' + (sigVal != null ? sigVal.toFixed(4) : 'N/A') + ' | Hist: ' + (histVal != null ? histVal.toFixed(4) : 'N/A'));
    if (signals.length) lines.push('  Signals: ' + signals.join(' | '));
  });
  if (!hasAny) return '\n--- TECHNICAL ANALYSIS ---\nNot loaded yet.';
  return lines.join('\n');
}

// ── Season context builder ────────────────────────────────────────────────────

function getSeasonContext(si) {
  const m = si.month;
  const lines = ['- ' + si.icon + ' ' + si.name + ' (den ' + si.daysIn + '/' + si.sTotal + ', zbývá ' + si.daysLeft + 'd) → příští: ' + si.nxtIcon + ' ' + si.nxtName];
  if (si.name === 'Heating') {
    lines.push('- Charakter: čisté čerpání zásob (withdrawals). Storage deficit má 2-3× větší cenový dopad než v jiných sezónách.');
    lines.push('- Primary drivers: HDD/cold snaps (bullish katalyst), LNG exports, pipeline freeze-offs (bullish risk).');
    lines.push('- Typický end-of-season target (konec března): 1,500–1,800 Bcf.');
  } else if (si.name === 'Cooling') {
    lines.push('- Charakter: CDD-driven power burn demand. Hurricane sezóna ohrožuje GoM offshore produkci.');
    lines.push('- Primary drivers: Heat domes/heat waves (bullish), hurikány GoM (bullish), mírné léto (bearish).');
    lines.push('- Power burn (gas-fired generation) = dominantní demand sektor v létě.');
  } else if (m >= 3 && m <= 5) {
    lines.push('- Jarní shoulder: konec withdrawals → start injekcí. Total demand klesá.');
    lines.push('- Riziko: "widow maker" Mar/Apr (H/J) spread; nízký demand = trh citlivý na supply změny.');
  } else {
    lines.push('- Podzimní shoulder: konec injection sezóny, příprava na heating.');
    lines.push('- Trh oceňuje očekávanou heating sezónu — back-month (zimní) kontrakty mají premium.');
  }
  return lines;
}

// ── Full context builder (for quick chat) ────────────────────────────────────

export function getContext() {
  const si = getSeasonInfo();
  const lines = ['=== NATGAS LIVE DATA ==='];
  lines.push('Date: ' + new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }));
  lines.push('\n--- SEASON ---');
  getSeasonContext(si).forEach(l => lines.push(l));

  if (state.stStorageData.length) {
    const lat = state.stStorageData[state.stStorageData.length - 1];
    const prev = state.stStorageData.length > 1 ? state.stStorageData[state.stStorageData.length - 2] : null;
    const band = st5y(state.stStorageData, [lat.date])[0], avg5 = band.avg;
    const devBcf = avg5 != null ? lat.value - avg5 : null;
    const devPct = (avg5 && avg5 !== 0 && devBcf != null) ? devBcf / avg5 * 100 : null;
    lines.push('\n--- STORAGE ---');
    lines.push('Latest: ' + Math.round(lat.value).toLocaleString() + ' Bcf | Report: ' + fmtShort(isoAdd(lat.date, 6)));
    if (prev) lines.push('W/W: ' + sgn(lat.value - prev.value) + Math.round(lat.value - prev.value) + ' Bcf');
    if (avg5 != null) lines.push('5y avg: ' + Math.round(avg5).toLocaleString() + ' Bcf | vs 5y: ' + sgn(devBcf) + Math.round(devBcf) + ' Bcf (' + sgn(devPct) + devPct.toFixed(1) + '%)');
    if (devBcf != null) { const fp = fairPrice(devBcf); lines.push('FAIR PRICE NOW: $' + fp.toFixed(3) + ' [Min $' + (fp - 0.5).toFixed(3) + ' / Max $' + (si.isHeating ? fp + 1.9 : fp + 0.5).toFixed(3) + ']'); }
    [state.stLastF7, state.stLastF14, state.stLastF21].forEach((f, fi) => {
      if (!f?.predictedLevel) return;
      const lbl = ['7D', '14D', '21D'][fi];
      const b = st5y(state.stStorageData, [f.endDate])[0].avg;
      lines.push(lbl + ' fcst: ' + Math.round(f.predictedLevel) + ' Bcf');
      if (b != null) { const dv = f.predictedLevel - b; lines.push('  vs 5y: ' + sgn(dv) + Math.round(dv) + ' Bcf | Fair: $' + fairPrice(dv).toFixed(3)); }
    });
  }

  if (state.stNgfData.length) {
    const lngf = state.stNgfData[state.stNgfData.length - 1];
    const curC = ngfCurrent(), nxtC = curC ? ngfNext(curC) : null;
    const l52 = state.stNgfData.slice(-52);
    lines.push('\n--- FUTURES ---');
    lines.push('FRONT MONTH PRICE (' + (curC ? curC.label : '?') + '): $' + lngf.close.toFixed(3) + '/MMBtu');
    if (nxtC && state.nextContractPrice != null) {
      const sp = state.nextContractPrice - lngf.close;
      lines.push('NEXT CONTRACT (' + nxtC.label + '): $' + state.nextContractPrice.toFixed(3) + ' | Spread: ' + sgn(sp) + sp.toFixed(3) + ' → ' + (sp >= 0 ? 'Contango' : 'Backwardation'));
    }
    lines.push('52w H: $' + Math.max(...l52.map(d => d.high)).toFixed(3) + ' / 52w L: $' + Math.min(...l52.map(d => d.low)).toFixed(3));
  }

  if (state.fcContractsData.length) {
    lines.push('\n--- FUTURES CURVE ---');
    state.fcContractsData.filter(c => c.price != null).forEach(c => {
      let s = '  ' + c.label + (c.isFront ? ' [FRONT]' : c.isNext ? ' [NEXT]' : '') + ': $' + c.price.toFixed(3);
      if (c.spread != null) s += ' (' + sgn(c.spread) + c.spread.toFixed(3) + ')';
      lines.push(s);
    });
  }

  const supply = peCalcSupply();
  if (supply?.length) { const sl = supply[supply.length - 1]; lines.push('\n--- SUPPLY ---'); lines.push('Total Supply (' + sl.period + '): ' + sl.value.toFixed(2) + ' Bcf/d'); }
  ['prod', 'can', 'mex', 'lng'].forEach(pk => {
    const d = state.peData[pk]; if (!d || d.length < 2) return;
    const last = d[d.length - 1], p2v = d[d.length - 2], chg = last.value - p2v.value;
    lines.push('  ' + PE_LABELS[pk] + ': ' + last.value.toFixed(2) + ' Bcf/d (MoM ' + sgn(chg) + chg.toFixed(2) + ')');
  });

  if (state.wxS) {
    const ti = state.wxS.todayIdx;
    const demSum = days => { let s = 0, lim = Math.min(ti + days, state.wxS.demAll.length); for (let j = ti; j < lim; j++) s += state.wxS.demAll[j] || 0; return s; };
    const dem5Sum = days => { let s = 0, lim = Math.min(ti + days, state.wxS.dem5avg.length); for (let j = ti; j < lim; j++) s += state.wxS.dem5avg[j] || 0; return s; };
    lines.push('\n--- WEATHER & DEMAND ---');
    [4, 7, 10, 13, 16].forEach(d => {
      const dem = demSum(d), dem5 = dem5Sum(d), dev = dem - dem5, pct = dem5 > 0.5 ? dev / dem5 * 100 : 0;
      lines.push(d + 'D: ' + dem.toFixed(0) + ' | ' + (dem5 > 0.5 ? sgn(dev) + dev.toFixed(0) + ' (' + sgn(pct) + pct.toFixed(1) + '%) vs 5y' : 'N/A') + ' | Ø ' + (dem / d).toFixed(1) + '/d');
    });
    let hF = 0, cF = 0, l16 = Math.min(ti + 16, state.wxS.hddAll.length);
    for (let k = ti; k < l16; k++) { hF += state.wxS.hddAll[k] || 0; cF += state.wxS.cddAll[k] || 0; }
    lines.push('HDD 16D: ' + hF.toFixed(1) + ' | CDD 16D: ' + cF.toFixed(1));
  }

  lines.push(getTAContext());
  lines.push('\n=== END ===');
  return lines.join('\n');
}

// ── Report prompt builder ─────────────────────────────────────────────────────

function getReportPrompt() {
  const si = getSeasonInfo();
  const seasonLines = getSeasonContext(si);
  const storLines = []; let fpNow = null, devBcfNow = null;

  if (state.stStorageData.length) {
    const lat = state.stStorageData[state.stStorageData.length - 1];
    const prev = state.stStorageData.length > 1 ? state.stStorageData[state.stStorageData.length - 2] : null;
    const band = st5y(state.stStorageData, [lat.date])[0], avg5 = band.avg;
    devBcfNow = avg5 != null ? lat.value - avg5 : null;
    const devPctNow = (avg5 && avg5 !== 0 && devBcfNow != null) ? devBcfNow / avg5 * 100 : null;
    storLines.push('- Aktuální zásoby: ' + Math.round(lat.value).toLocaleString() + ' Bcf (report: ' + fmtShort(isoAdd(lat.date, 6)) + ')');
    if (prev) storLines.push('- W/W změna: ' + sgn(lat.value - prev.value) + Math.round(lat.value - prev.value) + ' Bcf');
    if (avg5 != null) storLines.push('- 5y průměr: ' + Math.round(avg5).toLocaleString() + ' Bcf');
    if (devBcfNow != null) storLines.push('- Deviation vs 5y: ' + sgn(devBcfNow) + Math.round(devBcfNow).toLocaleString() + ' Bcf (' + sgn(devPctNow) + devPctNow.toFixed(1) + '%) → ' + (devBcfNow >= 0 ? 'SURPLUS (bearish)' : 'DEFICIT (bullish)'));
    if (devBcfNow != null) { fpNow = fairPrice(devBcfNow); storLines.push('- FAIR PRICE NOW (model): $' + fpNow.toFixed(3) + '/MMBtu'); }
    if (state.stStorageData.length >= 5) {
      const recent = state.stStorageData.slice(-5), wchanges = [];
      for (let wi = 1; wi < recent.length; wi++) wchanges.push(recent[wi].value - recent[wi - 1].value);
      storLines.push('- Posledních 4 týdnů (Bcf): ' + wchanges.map(c => sgn(c) + Math.round(c)).join(', '));
    }
  }

  const fcstLines = []; const fpFcst = {};
  if (state.stStorageData.length && state.wxS) {
    [[state.stLastF7, 7, '7D'], [state.stLastF14, 14, '14D'], [state.stLastF21, 21, '21D']].forEach(([f, dk, lbl]) => {
      if (!f?.predictedLevel) { fcstLines.push('- ' + lbl + ' fcst: N/A'); return; }
      const b = st5y(state.stStorageData, [f.endDate])[0].avg;
      let line = '- ' + lbl + ' fcst: ' + Math.round(f.predictedLevel).toLocaleString() + ' Bcf @ ' + fmtShort(f.endDate) + ' (D-index: ' + f.D.toFixed(1) + ')';
      if (b != null) { const dv = f.predictedLevel - b, pv = b !== 0 ? dv / b * 100 : 0, fp = fairPrice(dv); fpFcst[dk] = fp; line += ' | Dev: ' + sgn(dv) + Math.round(dv) + ' Bcf (' + sgn(pv) + pv.toFixed(1) + '%) | FAIR PRICE: $' + fp.toFixed(3); }
      fcstLines.push(line);
    });
  }

  const priceLines = []; let frontMktPrice = null;
  if (state.stNgfData.length) {
    const lngf = state.stNgfData[state.stNgfData.length - 1], lngfPrev = state.stNgfData.length > 1 ? state.stNgfData[state.stNgfData.length - 2] : null;
    frontMktPrice = lngf.close;
    const curC = ngfCurrent(), nxtC = curC ? ngfNext(curC) : null;
    const l52 = state.stNgfData.slice(-52);
    const h52 = Math.max(...l52.map(d => d.high)), l52v = Math.min(...l52.map(d => d.low));
    const pos52 = h52 > l52v ? ((frontMktPrice - l52v) / (h52 - l52v) * 100) : 50;
    priceLines.push('- *** FRONT MONTH PRICE (' + (curC ? curC.label : '?') + '): $' + frontMktPrice.toFixed(3) + '/MMBtu *** ← TRŽNÍ CENA');
    priceLines.push('  W/W: ' + (lngfPrev ? sgn(frontMktPrice - lngfPrev.close) + (frontMktPrice - lngfPrev.close).toFixed(3) : 'N/A'));
    priceLines.push('  52w High: $' + h52.toFixed(3) + ' | 52w Low: $' + l52v.toFixed(3) + ' | Pozice v 52w pásmu: ' + pos52.toFixed(0) + '%');
    if (state.nextContractPrice != null && nxtC) {
      const sp = state.nextContractPrice - frontMktPrice;
      priceLines.push('- *** NEXT CONTRACT (' + nxtC.label + '): $' + state.nextContractPrice.toFixed(3) + ' *** Spread: ' + sgn(sp) + sp.toFixed(3) + ' → ' + (sp >= 0 ? 'CONTANGO' : 'BACKWARDATION'));
    }
    if (fpNow != null) {
      priceLines.push('### MISPRICING: Front Month ($' + frontMktPrice.toFixed(3) + ') vs Fair Price:');
      const mn = frontMktPrice - fpNow, mnp = fpNow !== 0 ? mn / fpNow * 100 : 0;
      priceLines.push('- vs Fair NOW ($' + fpNow.toFixed(3) + '): ' + sgn(mn) + mn.toFixed(3) + ' (' + sgn(mnp) + mnp.toFixed(1) + '%) → ' + (mn < -0.10 ? 'PODHODNOCENO → bullish edge' : mn > 0.10 ? 'NADHODNOCENO → bearish edge' : 'FAIR PRICED'));
      [7, 14, 21].forEach(dk => {
        if (fpFcst[dk] == null) return;
        const m2 = frontMktPrice - fpFcst[dk], m2p = fpFcst[dk] !== 0 ? m2 / fpFcst[dk] * 100 : 0;
        priceLines.push('- vs Fair ' + dk + 'D ($' + fpFcst[dk].toFixed(3) + '): ' + sgn(m2) + m2.toFixed(3) + ' (' + sgn(m2p) + m2p.toFixed(1) + '%) → ' + (m2 < -0.10 ? 'forward bullish edge' : m2 > 0.10 ? 'forward bearish edge' : 'fair'));
      });
    }
  }

  const curveLines = [];
  if (state.fcContractsData?.length) {
    state.fcContractsData.filter(c => c.price != null).forEach(c => { let s = '  ' + c.label + (c.isFront ? ' [FRONT]' : c.isNext ? ' [NEXT]' : '') + ': $' + c.price.toFixed(3); if (c.spread != null) s += ' (spread ' + sgn(c.spread) + c.spread.toFixed(3) + ')'; curveLines.push(s); });
    const prices = state.fcContractsData.filter(c => c.price != null).map(c => c.price);
    if (prices.length >= 6) { const sl6 = prices[5] - prices[0]; curveLines.push('- 6M slope: ' + sgn(sl6) + sl6.toFixed(3) + ' → ' + (sl6 > 0.20 ? 'STRONG CONTANGO' : sl6 < -0.20 ? 'STRONG BACKWARDATION' : 'flat')); }
  }

  const supLines = [];
  const supply = peCalcSupply();
  if (supply?.length >= 3) {
    const sl = supply[supply.length - 1], sl2 = supply[supply.length - 2], sMoM = sl.value - sl2.value;
    supLines.push('- Total Supply (' + fmtPeriod(sl.period) + '): ' + sl.value.toFixed(2) + ' Bcf/d | MoM: ' + sgn(sMoM) + sMoM.toFixed(2) + ' → ' + (sMoM < 0 ? 'KLESÁ (bullish)' : 'ROSTE (bearish)'));
  }
  ['prod', 'can', 'mex', 'lng'].forEach(pk => {
    const d = state.peData[pk]; if (!d || d.length < 3) return;
    const last = d[d.length - 1], p2v = d[d.length - 2], chg = last.value - p2v.value;
    supLines.push('- ' + PE_LABELS[pk] + ': ' + last.value.toFixed(2) + ' Bcf/d (MoM ' + sgn(chg) + chg.toFixed(2) + ')');
  });

  const wxLines = [];
  if (state.wxS) {
    const ti = state.wxS.todayIdx;
    const rds = days => { let s = 0, lim = Math.min(ti + days, state.wxS.demAll.length); for (let j = ti; j < lim; j++) s += state.wxS.demAll[j] || 0; return s; };
    const rd5s = days => { let s = 0, lim = Math.min(ti + days, state.wxS.dem5avg.length); for (let j = ti; j < lim; j++) s += state.wxS.dem5avg[j] || 0; return s; };
    [4, 7, 10, 13, 16].forEach(d => {
      const dem = rds(d), dem5 = rd5s(d), dev = dem - dem5, pct = dem5 > 0.5 ? dev / dem5 * 100 : 0;
      wxLines.push('- ' + d + 'D: ' + dem.toFixed(0) + ' (Ø ' + (dem / d).toFixed(1) + '/d) | vs 5y: ' + (dem5 > 0.5 ? sgn(dev) + dev.toFixed(0) + ' (' + sgn(pct) + pct.toFixed(1) + '%) → ' + (dev > 0 ? 'bullish demand' : 'bearish demand') : 'N/A'));
    });
    let hF = 0, cF = 0, l16 = Math.min(ti + 16, state.wxS.hddAll.length);
    for (let k = ti; k < l16; k++) { hF += state.wxS.hddAll[k] || 0; cF += state.wxS.cddAll[k] || 0; }
    const totF = hF + cF;
    wxLines.push('- 16D HDD: ' + hF.toFixed(1) + ' | CDD: ' + cF.toFixed(1) + ' | Driver: ' + (totF < 0.5 ? 'No demand' : hF >= cF ? 'HDD ' + Math.round(hF / totF * 100) + '%' : 'CDD ' + Math.round(cF / totF * 100) + '%'));
  }

  return [
    'Jsi seniorní komoditní analytik hedge fondu specializující se na Henry Hub Natural Gas (NG=F).',
    'Vytvoř KOMPLEXNÍ analytický report zohledňující VŠECHNA níže uvedená data.',
    '',
    '⚠️ KRITICKÉ ROZLIŠENÍ: FRONT MONTH PRICE = skutečná tržní cena NYMEX | FAIR PRICE = model, ne kotace | Mispricing = Front vs Fair = trading edge',
    '',
    '### SEZÓNA', seasonLines.join('\n'),
    '### 1. STORAGE', storLines.join('\n'),
    '### 2. FORWARD FORECASTS', fcstLines.join('\n'),
    '### 3. TRŽNÍ CENY + MISPRICING', priceLines.join('\n'),
    '### 4. FUTURES KŘIVKA', curveLines.join('\n'),
    '### 5. SUPPLY', supLines.join('\n'),
    '### 6. WEATHER & DEMAND', wxLines.join('\n'),
    '### 7. TECHNICKÁ ANALÝZA', getTAContext(),
    '',
    '## POŽADOVANÝ VÝSTUP',
    '1. Executive Summary (4–6 vět s čísly)',
    '2. Mispricing analýza (Front vs Fair NOW/7D/14D/21D — povinně s čísly)',
    '3. Storage analýza (aktuální + forecasts + sezónní interpretace)',
    '4. Futures křivka (contango/backwardation, 6M slope)',
    '5. Supply analýza',
    '6. Weather & Demand',
    '7. Technická analýza (multi-timeframe: 1W→1D→4H→1H)',
    '8. ⚡ FINÁLNÍ SENTIMENT: BULLISH / SLIGHTLY BULLISH / NEUTRAL / SLIGHTLY BEARISH / BEARISH',
    '   + Confidence 1–10 | Top 3 bullish/bearish drivery | Cílová cenová pásma 1–2T a 1M',
    '',
    'Jazyk: česky. Styl: hedge fund report. Čísla všude. Žádná vata.'
  ].join('\n');
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function aiSend() {
  const input = document.getElementById('ai-input'), msg = input.value.trim(); if (!msg) return;
  input.value = '';
  const btn = document.getElementById('ai-send-btn'); btn.disabled = true;
  appendBubble('user', msg, false);
  state.aiHistory.push({ role: 'user', content: msg });
  const loadBbl = appendBubble('assistant', '', true);

  const sys = [
    'Jsi seniorní komoditní analytik hedge fondu specializující se na Henry Hub Natural Gas (NG=F).',
    'Odpovídej česky, hedge fund stylem, s konkrétními čísly.',
    'KRITICKÉ: FRONT MONTH PRICE = tržní cena NYMEX | FAIR PRICE = model | Mispricing = trading edge.',
    '', 'AKTUÁLNÍ DATA:\n' + getContext()
  ].join('\n');

  try {
    const text = await callGroq([{ role: 'system', content: sys }, ...state.aiHistory.slice(-10)], 1024);
    loadBbl.innerHTML = msgHtml(text || '⚠ Empty response.');
    state.aiHistory.push({ role: 'assistant', content: text });
    dbLog('AI: OK (' + text.length + ' chars)', 'ok');
  } catch(err) {
    loadBbl.innerHTML = '<span style="color:#ff7b72">⚠ Error: ' + esc(err.message) + '</span>';
    dbLog('AI error: ' + err.message, 'error');
  }
  btn.disabled = false;
  document.getElementById('ai-messages').scrollTop = 99999;
}

export async function aiSendReport() {
  if (!state.stStorageData.length) { alert('Storage data not loaded yet.'); return; }
  const btn = document.getElementById('ai-report-btn'); btn.disabled = true; btn.textContent = '⏳ Generating…';
  appendBubble('user', '📊 Generate Analytical Report', false);
  const reportPrompt = getReportPrompt();
  state.aiHistory.push({ role: 'user', content: reportPrompt });
  const loadBbl = appendBubble('assistant', '', true);

  const sys = [
    'Jsi seniorní komoditní analytik hedge fondu specializující se na Henry Hub Natural Gas (NG=F).',
    'Odpovídej česky, hedge fund stylem, s konkrétními čísly.',
    'Report MUSÍ končit jedním z 5 stupňů: BULLISH / SLIGHTLY BULLISH / NEUTRAL / SLIGHTLY BEARISH / BEARISH',
    's confidence 1–10, top 3 bullish/bearish drivery a cílovými cenovými pásmy.'
  ].join('\n');

  try {
    const text = await callGroq([{ role: 'system', content: sys }, ...state.aiHistory.slice(-12)], 3000);
    loadBbl.innerHTML = msgHtml(text || '⚠ Empty response.');
    state.aiHistory.push({ role: 'assistant', content: text });
    dbLog('AI report: OK (' + text.length + ' chars)', 'ok');
  } catch(err) {
    loadBbl.innerHTML = '<span style="color:#ff7b72">⚠ Error: ' + esc(err.message) + '</span>';
    dbLog('AI report error: ' + err.message, 'error');
  }
  btn.disabled = false; btn.textContent = '📊 Generate Analytical Report';
  document.getElementById('ai-messages').scrollTop = 99999;
}

export function aiClear() {
  state.aiHistory = [];
  document.getElementById('ai-messages').innerHTML =
    '<div style="text-align:center;color:#6e7681;font-size:11px;font-family:var(--mono);padding:20px 0">🤖 NatGas AI Analyst — ask anything about current market data</div>';
}
