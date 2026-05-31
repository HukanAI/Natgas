// js/futures.js  —  NGF price chart + futures curve strip
import { ST_WINDOWS } from './constants.js';
import { state } from './state.js';
import { dbLog } from './debug.js';
import { fmtTs, fmtGB, sgn, esc, fmtChg, fairPrice } from './utils.js';
import { getSeasonTransitions } from './season.js';
import { st5y } from './storage5y.js';
import { killChart, baseX, baseY, baseTT, makeSeasonPlugin, zoomOpts } from './charts.js';
import { ngfCurrent, ngfNext, ngfFetchTwoDays, fcBuildContractList } from './contracts.js';
import { MONTHS } from './constants.js';
import { renderFuturesCurve } from './widgets.js';

// ── Subtitle + window ─────────────────────────────────────────────────────────

export function ngfUpdateSubtitle() {
  const lbl={max:'full','5y':'5-year','2y':'2-year','1y':'1-year',ytd:'YTD','3m':'3-month','1m':'1-month'};
  const el=document.getElementById('ngf-chart-sub');
  if (el) el.textContent='Weekly · $/MMBtu · Yahoo Finance · '+(lbl[state.ngfWindow]||state.ngfWindow)+' history';
}

function ngfFilterData() {
  const days=state.ngfWindow==='ytd'
    ?Math.floor((new Date()-new Date(new Date().getFullYear(),0,1))/864e5)
    :ST_WINDOWS[state.ngfWindow];
  if (!days||days>=99999) return state.stNgfData.slice();
  const cut=new Date(); cut.setDate(cut.getDate()-days);
  return state.stNgfData.filter(d=>new Date(d.ts)>=cut);
}

export function ngfSetWindow(w) {
  if (state.ngfWindow===w) return;
  state.ngfWindow=w;
  document.querySelectorAll('[data-ngf-w]').forEach(b=>b.classList.toggle('on',b.dataset.ngfW===w));
  if (state.stNgfData.length) ngfRenderChart();
  ngfUpdateSubtitle();
}

export function ngfSetChartType(type) {
  state.ngfChartType=type;
  document.getElementById('ngf-btn-line').className='tbtn'+(type==='line'?' on':'');
  document.getElementById('ngf-btn-candle').className='tbtn'+(type==='candle'?' on':'');
  if (state.stNgfData.length) ngfRenderChart();
}

// ── Historical fair price series ──────────────────────────────────────────────
// For each NGF week, forward-fills the most recent storage-derived fair price.
// Band offsets mirror the bias card: heating → fp-0.5 / fp+1.9, else fp-0.5 / fp+0.5.
// Heating season = Nov 1 – Feb 28 (months 11,12,1,2).

export function buildFairPriceSeries(isoDates) {
  const sd = state.stStorageData;
  if (!sd || !sd.length) return null;

  // 5y avg for every storage week (single pass)
  const bands = st5y(sd, sd.map(r => r.date));
  // Build sorted historical fair-price points keyed by storage date
  const fpPoints = [];
  sd.forEach((r, i) => {
    const avg = bands[i]?.avg;
    if (avg == null) return;
    const fp = fairPrice(r.value - avg);
    const mo = +r.date.slice(5, 7);
    const isH = (mo === 11 || mo === 12 || mo === 1 || mo === 2);
    fpPoints.push({ date: r.date, fp, mn: fp - 0.5, mx: isH ? fp + 1.9 : fp + 0.5 });
  });
  if (!fpPoints.length) return null;
  // already sorted ascending (storage data is sorted), but be safe
  fpPoints.sort((a, b) => a.date < b.date ? -1 : 1);

  // Forward-fill onto each NGF date
  const fair = [], mins = [], maxs = [];
  let ptr = 0, last = null;
  isoDates.forEach(d => {
    while (ptr < fpPoints.length && fpPoints[ptr].date <= d) { last = fpPoints[ptr]; ptr++; }
    fair.push(last ? last.fp : null);
    mins.push(last ? last.mn : null);
    maxs.push(last ? last.mx : null);
  });
  if (fair.every(v => v == null)) return null;
  return { fair, mins, maxs };
}

// ── NGF main chart ────────────────────────────────────────────────────────────

export function ngfRenderChart() {
  const filtered=ngfFilterData(); if (!filtered.length) return;
  document.getElementById('ngf-spin').style.display='none';
  document.getElementById('ngf-wrap').style.display='block';
  killChart(state.ngfChart); state.ngfChart=null;

  const labels=filtered.map(d=>fmtTs(d.ts));
  const closes=filtered.map(d=>d.close);
  const isoDates=filtered.map(d=>new Date(d.ts).toISOString().slice(0,10));
  const fps=buildFairPriceSeries(isoDates);
  const trans=state.ngfWindow==='max'?[]:getSeasonTransitions(isoDates);
  const ctx=document.getElementById('ngf-canvas').getContext('2d');
  const tt=Object.assign({},baseTT());

  // Shared historical fair-price datasets (line + min/max band) for both chart types
  const fpDatasets = fps ? [
    { _fp:'max', label:'FP max', data:fps.maxs, fill:'+1', backgroundColor:'rgba(68,147,248,0.10)', borderColor:'transparent', pointRadius:0, tension:0.3, order:20 },
    { _fp:'min', label:'FP min', data:fps.mins, fill:false, borderColor:'transparent', backgroundColor:'transparent', pointRadius:0, tension:0.3, order:21 },
    { _fp:'fair',label:'Fair price', data:fps.fair, borderColor:'#4493f8', borderWidth:1.5, borderDash:[6,3], pointRadius:0, pointHoverRadius:5, tension:0.3, fill:false, order:19 },
  ] : [];
  const fpTipLine = c => {
    if (c.dataset._fp==='min'||c.dataset._fp==='max') return null;
    if (c.dataset._fp==='fair') return c.parsed.y==null?null:' Fair price: $'+c.parsed.y.toFixed(3);
    return undefined; // not an fp dataset → let caller's own callback handle
  };

  if (state.ngfChartType==='candle') {
    let hi=-Infinity,lo=Infinity;
    filtered.forEach(d=>{if(d.high>hi)hi=d.high;if(d.low<lo)lo=d.low;});
    if (fps) { fps.maxs.forEach(v=>{if(v!=null&&v>hi)hi=v;}); fps.mins.forEach(v=>{if(v!=null&&v<lo)lo=v;}); }
    const cPlug={id:'cPlug',afterDatasetsDraw(chart){
      const cx=chart.ctx,x=chart.scales.x,y=chart.scales.y,nf=filtered.length; if(!nf) return;
      const rawW=nf>1?Math.abs(x.getPixelForValue(1)-x.getPixelForValue(0)):8;
      const barW=Math.max(1.5,Math.min(rawW*0.65,14)),half=barW/2;
      cx.save();
      filtered.forEach((d,idx)=>{
        const xc=x.getPixelForValue(idx),yO=y.getPixelForValue(d.open),yC=y.getPixelForValue(d.close);
        const yH=y.getPixelForValue(d.high),yL=y.getPixelForValue(d.low);
        const bull=d.close>=d.open,col=bull?'#3fb950':'#ff7b72';
        cx.strokeStyle=col;cx.lineWidth=1;cx.beginPath();cx.moveTo(xc,yH);cx.lineTo(xc,yL);cx.stroke();
        cx.fillStyle=col;cx.fillRect(xc-half,Math.min(yO,yC),barW,Math.max(1,Math.abs(yO-yC)));
      });
      cx.restore();
    }};
    tt.callbacks={
      title:items=>{const i=items[0]?.dataIndex;return i!=null?labels[i]:'';},
      label:c=>{const fl=fpTipLine(c);if(fl!==undefined)return fl;const d=filtered[c.dataIndex];if(!d)return null;return[' O: $'+d.open.toFixed(3),' H: $'+d.high.toFixed(3),' L: $'+d.low.toFixed(3),' C: $'+d.close.toFixed(3)];}
    };
    state.ngfChart=new Chart(ctx,{
      type:'line',plugins:[cPlug,makeSeasonPlugin('ngf',()=>trans)],
      data:{labels,datasets:[{data:closes,borderColor:'transparent',pointRadius:0,fill:false},...fpDatasets]},
      options:{responsive:true,maintainAspectRatio:false,animation:{duration:200},interaction:{mode:'index',intersect:false},
        plugins:{legend:{display:false},tooltip:tt,zoom:zoomOpts()},
        scales:{x:baseX(),y:{min:lo*0.99,max:hi*1.01,grid:{color:'rgba(255,255,255,0.04)'},ticks:{color:'#6e7681',font:{family:'Inter',size:9},callback:v=>'$'+v.toFixed(2)}}}}
    });
  } else {
    tt.callbacks={
      title:items=>{const i=items[0]?.dataIndex;return i!=null?labels[i]:'';},
      label:c=>{const fl=fpTipLine(c);if(fl!==undefined)return fl;return' NG=F: $'+c.parsed.y.toFixed(3)+'/MMBtu';}
    };
    state.ngfChart=new Chart(ctx,{
      type:'line',plugins:[makeSeasonPlugin('ngf',()=>trans)],
      data:{labels,datasets:[{label:'NG=F',data:closes,borderColor:'#e3b341',borderWidth:2,pointRadius:0,pointHoverRadius:6,tension:0.2,fill:false},...fpDatasets]},
      options:{responsive:true,maintainAspectRatio:false,animation:{duration:300},interaction:{mode:'index',intersect:false},
        plugins:{legend:{display:false},tooltip:tt,zoom:zoomOpts()},
        scales:{x:baseX(),y:baseY(v=>'$'+v.toFixed(2))}}
    });
  }

  // Keep the price − fair price spread chart in sync with the NG=F window
  try { renderFpSpreadChart(); } catch(e) { dbLog('fp spread chart: '+e.message,'warn'); }
}

// ── Spread chart: NG=F price − fair price ─────────────────────────────────────

export function renderFpSpreadChart() {
  const wrap = document.getElementById('fpspread-wrap');
  const spin = document.getElementById('fpspread-spin');
  const canvas = document.getElementById('fpspread-canvas');
  if (!canvas || typeof Chart === 'undefined') return;

  const filtered = ngfFilterData();
  const isoDates = filtered.map(d => new Date(d.ts).toISOString().slice(0, 10));
  const fps = filtered.length ? buildFairPriceSeries(isoDates) : null;

  // Need both price and fair price to compute a spread
  if (!filtered.length || !fps) {
    if (spin) { spin.style.display = 'block'; spin.innerHTML = 'Waiting for storage + price data…'; }
    if (wrap) wrap.style.display = 'none';
    killChart(state.fpSpreadChart); state.fpSpreadChart = null;
    return;
  }

  const labels = filtered.map(d => fmtTs(d.ts));
  const spread = filtered.map((d, i) => fps.fair[i] != null ? d.close - fps.fair[i] : null);
  const trans = state.ngfWindow === 'max' ? [] : getSeasonTransitions(isoDates);

  if (spin) spin.style.display = 'none';
  if (wrap) wrap.style.display = 'block';
  killChart(state.fpSpreadChart); state.fpSpreadChart = null;

  const tt = Object.assign({}, baseTT(), {
    callbacks: {
      title: items => items[0] ? labels[items[0].dataIndex] : '',
      label: c => {
        const v = spread[c.dataIndex];
        if (v == null) return null;
        return ' ' + (v >= 0 ? 'Over' : 'Under') + ' fair: ' + sgn(v) + '$' + Math.abs(v).toFixed(3);
      },
      filter: item => item.dataset._k === 'spread' && spread[item.dataIndex] != null
    }
  });

  state.fpSpreadChart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    plugins: [makeSeasonPlugin('fpspread', () => trans)],
    data: { labels, datasets: [
      // spread line, filled to the zero baseline; coloured per-segment by sign
      {
        _k: 'spread', label: 'Spread', data: spread,
        borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 5, tension: 0.2,
        fill: { value: 0 },
        backgroundColor: 'rgba(163,113,247,0.12)',
        borderColor: '#a371f7',
        segment: {
          borderColor: ctx => (ctx.p0.parsed.y >= 0 || ctx.p1.parsed.y >= 0) ? '#ff7b72' : '#3fb950'
        }
      },
      // zero baseline
      { _k: 'zero', data: spread.map(() => 0), borderColor: 'rgba(255,255,255,0.25)', borderWidth: 1, borderDash: [4, 3], pointRadius: 0, fill: false, tension: 0 }
    ]},
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false }, tooltip: tt, zoom: zoomOpts() },
      scales: { x: baseX(), y: baseY(v => sgn(v) + '$' + Math.abs(v).toFixed(2)) }
    }
  });
}


export function fcToggle() {
  state.fcBodyOpen=!state.fcBodyOpen;
  const body=document.getElementById('fc-body'), arrow=document.getElementById('fc-arrow');
  body.style.display=state.fcBodyOpen?'block':'none';
  arrow.style.transform=state.fcBodyOpen?'rotate(90deg)':'';
}

export async function fcLoad() {
  if (state.fcLoading) return;
  state.fcLoading=true;
  const spin=document.getElementById('fc-spin'), grid=document.getElementById('fc-grid'), status=document.getElementById('fc-status');
  spin.style.display='block'; grid.style.display='none'; status.textContent='Loading…';

  const contracts=fcBuildContractList(12), cur=ngfCurrent(), nxt=cur?ngfNext(cur):null;
  const sub=document.getElementById('fc-subtitle');
  if (sub&&cur) sub.textContent='Front: '+cur.label+' · D/D change · spread vs front';
  dbLog('FC: front='+(cur?cur.label:'?'),'info');

  const results=await Promise.allSettled(contracts.map(c=>ngfFetchTwoDays(c.ticker,c.isFront)));
  const frontPrice=(results[0]?.status==='fulfilled')?results[0].value.last:null;

  state.fcContractsData=contracts.map((c,i)=>{
    const r=results[i], pd=(r.status==='fulfilled')?r.value:null;
    return{
      label:c.label, ticker:c.ticker,
      isFront:!!(cur&&c.ticker===cur.ticker),
      isNext:!!(nxt&&c.ticker===nxt.ticker),
      price:pd?pd.last:null, prev:pd?pd.prev:null,
      spread:(pd&&frontPrice!=null&&i>0)?pd.last-frontPrice:null
    };
  });

  let loaded=0, html='<div class="fc-grid-wrap">';
  results.forEach((r,i)=>{
    const c=contracts[i], isFront=cur&&c.ticker===cur.ticker, isNext=nxt&&c.ticker===nxt.ticker;
    const pd=(r.status==='fulfilled')?r.value:null, price=pd?pd.last:null, prevP=pd?pd.prev:null;
    if (price!=null) loaded++;
    const spread=(price!=null&&frontPrice!=null&&i>0)?price-frontPrice:null;
    const dayChg=(price!=null&&prevP!=null)?price-prevP:null;
    const dayPct=(dayChg!=null&&prevP!=null&&prevP!==0)?dayChg/prevP*100:null;
    html+='<div class="fc-card"><div class="fc-lbl"><span>'+esc(c.label)+'</span>';
    if (isFront) html+='<span class="fc-badge front">Front</span>';
    else if (isNext) html+='<span class="fc-badge next">Next</span>';
    html+='</div>';
    if (price!=null) {
      html+='<div class="fc-price">$'+price.toFixed(3)+'</div>';
      if (dayChg!=null&&dayPct!=null) { const cf=fmtChg(dayChg,dayPct); html+='<div class="fc-row" style="color:'+cf.color+'">'+esc(cf.text)+' D/D</div>'; }
      if (spread!=null) { const sc=spread>=0?'#ff7b72':'#3fb950'; html+='<div class="fc-row" style="color:'+sc+'">'+esc(sgn(spread)+spread.toFixed(3))+' vs front</div>'; }
    } else {
      html+='<div class="fc-price" style="color:#6e7681;font-size:13px">N/A</div><div class="fc-row" style="color:#6e7681">'+esc(r.reason?.message||'unavailable')+'</div>';
    }
    html+='</div>';
  });
  html+='</div>';
  grid.innerHTML=html; spin.style.display='none'; grid.style.display='block';
  status.textContent=loaded+'/'+contracts.length+' loaded';
  dbLog('FC: '+loaded+'/'+contracts.length+' fetched',loaded>0?'ok':'warn');
  state.fcLoading=false;

  // Notify bias card that contract data is ready
  document.dispatchEvent(new CustomEvent('futures:loaded'));

  // Update always-visible futures curve widget
  try { renderFuturesCurve(); } catch(e) { dbLog('futures curve widget: '+e.message,'warn'); }
}

// Silent background refresh — updates prices without showing spinners
export async function fcSilentRefresh() {
  if (state.fcLoading) return;
  const contracts = fcBuildContractList(12);
  const cur = ngfCurrent(), nxt = cur ? ngfNext(cur) : null;
  const results = await Promise.allSettled(contracts.map(c => ngfFetchTwoDays(c.ticker, c.isFront)));
  const frontPrice = (results[0]?.status === 'fulfilled') ? results[0].value.last : null;
  state.fcContractsData = contracts.map((c, i) => {
    const r = results[i], pd = (r.status === 'fulfilled') ? r.value : null;
    return {
      label: c.label, ticker: c.ticker,
      isFront: !!(cur && c.ticker === cur.ticker),
      isNext:  !!(nxt && c.ticker === nxt.ticker),
      price: pd ? pd.last : null, prev: pd ? pd.prev : null,
      spread: (pd && frontPrice != null && i > 0) ? pd.last - frontPrice : null
    };
  });
  const loaded = results.filter(r => r.status === 'fulfilled').length;
  const status = document.getElementById('fc-status');
  if (status) status.textContent = loaded + '/' + contracts.length + ' loaded';
  dbLog('FC silent refresh: ' + loaded + '/' + contracts.length, loaded > 0 ? 'ok' : 'warn');
  document.dispatchEvent(new CustomEvent('futures:loaded'));
  try { renderFuturesCurve(); } catch(e) { dbLog('futures curve widget: ' + e.message, 'warn'); }
}
