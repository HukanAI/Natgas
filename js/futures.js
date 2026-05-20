// js/futures.js  —  NGF price chart + futures curve strip
import { ST_WINDOWS } from './constants.js';
import { state } from './state.js';
import { dbLog } from './debug.js';
import { fmtTs, fmtGB, sgn, esc, fmtChg } from './utils.js';
import { getSeasonTransitions } from './season.js';
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

// ── NGF main chart ────────────────────────────────────────────────────────────

export function ngfRenderChart() {
  const filtered=ngfFilterData(); if (!filtered.length) return;
  document.getElementById('ngf-spin').style.display='none';
  document.getElementById('ngf-wrap').style.display='block';
  killChart(state.ngfChart); state.ngfChart=null;

  const labels=filtered.map(d=>fmtTs(d.ts));
  const closes=filtered.map(d=>d.close);
  const isoDates=filtered.map(d=>new Date(d.ts).toISOString().slice(0,10));
  const trans=state.ngfWindow==='max'?[]:getSeasonTransitions(isoDates);
  const ctx=document.getElementById('ngf-canvas').getContext('2d');
  const tt=Object.assign({},baseTT());

  if (state.ngfChartType==='candle') {
    let hi=-Infinity,lo=Infinity;
    filtered.forEach(d=>{if(d.high>hi)hi=d.high;if(d.low<lo)lo=d.low;});
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
      label:c=>{const d=filtered[c.dataIndex];if(!d)return null;return[' O: $'+d.open.toFixed(3),' H: $'+d.high.toFixed(3),' L: $'+d.low.toFixed(3),' C: $'+d.close.toFixed(3)];}
    };
    state.ngfChart=new Chart(ctx,{
      type:'line',plugins:[cPlug,makeSeasonPlugin('ngf',()=>trans)],
      data:{labels,datasets:[{data:closes,borderColor:'transparent',pointRadius:0,fill:false}]},
      options:{responsive:true,maintainAspectRatio:false,animation:{duration:200},interaction:{mode:'index',intersect:false},
        plugins:{legend:{display:false},tooltip:tt,zoom:zoomOpts()},
        scales:{x:baseX(),y:{min:lo*0.99,max:hi*1.01,grid:{color:'rgba(255,255,255,0.04)'},ticks:{color:'#6e7681',font:{family:'Inter',size:9},callback:v=>'$'+v.toFixed(2)}}}}
    });
  } else {
    tt.callbacks={
      title:items=>{const i=items[0]?.dataIndex;return i!=null?labels[i]:'';},
      label:c=>' NG=F: $'+c.parsed.y.toFixed(3)+'/MMBtu'
    };
    state.ngfChart=new Chart(ctx,{
      type:'line',plugins:[makeSeasonPlugin('ngf',()=>trans)],
      data:{labels,datasets:[{label:'NG=F',data:closes,borderColor:'#e3b341',borderWidth:2,pointRadius:0,pointHoverRadius:6,tension:0.2,fill:false}]},
      options:{responsive:true,maintainAspectRatio:false,animation:{duration:300},interaction:{mode:'index',intersect:false},
        plugins:{legend:{display:false},tooltip:tt,zoom:zoomOpts()},
        scales:{x:baseX(),y:baseY(v=>'$'+v.toFixed(2))}}
    });
  }
}

// ── Future Contracts strip ────────────────────────────────────────────────────

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
