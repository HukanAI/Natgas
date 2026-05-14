// js/production.js  —  EIA production / export charts
import { ST_API_KEY, PE_WINDOWS, PE_SERIES, PE_COLORS, PE_LABELS, PE_NAMES } from './constants.js';
import { state } from './state.js';
import { dbLog } from './debug.js';
import { fmtPeriod, daysInMonth, sgn } from './utils.js';
import { killChart, baseOpts, baseTT } from './charts.js';

// ── Badge / dot ───────────────────────────────────────────────────────────────
function setDot(s)       { document.getElementById('pe-dot').className='sdot '+s; }
function setBadge(t,txt) { const el=document.getElementById('pe-badge'); el.textContent=txt; el.className='cbadge '+t; }

// ── Fetch one EIA series ──────────────────────────────────────────────────────
async function fetchOne(peKey) {
  state.peApiCount++;
  document.getElementById('pe-api-count').textContent=state.peApiCount;
  const url='https://api.eia.gov/v2/seriesid/'+PE_SERIES[peKey]+'?api_key='+ST_API_KEY+'&frequency=monthly&data[0]=value&sort[0][column]=period&sort[0][direction]=asc&length=600';
  const res=await fetch(url); if(!res.ok) throw new Error('HTTP '+res.status+' ('+PE_SERIES[peKey]+')');
  const json=await res.json(); if(json.response?.error) throw new Error(json.response.error);
  const rows=json.response?.data||[]; if(!rows.length) throw new Error('empty ('+PE_SERIES[peKey]+')');
  const out=rows.map(r=>{const v=parseFloat(r.value);if(!isFinite(v))return null;return{period:r.period,value:parseFloat((v/1000/daysInMonth(r.period)).toFixed(4))};}).filter(Boolean);
  out.sort((a,b)=>a.period<b.period?-1:1);
  return out;
}

// ── Load all ──────────────────────────────────────────────────────────────────
export async function peLoadAll() {
  setDot('loading'); setBadge('loading','Loading…');
  ['prod','can','mex','lng','supply'].forEach(pk=>{
    document.getElementById('pe-wrap-'+pk).style.display='none';
    const sp=document.getElementById('pe-spin-'+pk); sp.style.display='block'; sp.innerHTML='<span class="sp"></span>Loading…';
  });
  const peKeys=['prod','can','mex','lng'];
  const results=await Promise.allSettled(peKeys.map(pk=>fetchOne(pk)));
  const errs=[];
  results.forEach((r,i)=>{
    const pk=peKeys[i];
    if (r.status==='fulfilled') { state.peData[pk]=r.value; }
    else { errs.push(pk); dbLog('PE '+pk+' error: '+r.reason.message,'error'); state.peData[pk]=null; }
  });
  peKeys.forEach(pk=>peRenderOne(pk));
  peRenderSupply();
  if (errs.length) { setDot('err'); setBadge('err','Partial error'); }
  else             { setDot('ok');  setBadge('live','Live data'); }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function filterByWindow(series) {
  if (!series||!series.length) return [];
  if (state.peWindow==='ytd') { const yr=String(new Date().getFullYear()); return series.filter(d=>d.period.startsWith(yr)); }
  const days=PE_WINDOWS[state.peWindow]; if(!days||days>=99999) return series.slice();
  const cut=new Date(); cut.setDate(cut.getDate()-days); const cutStr=cut.toISOString().slice(0,7);
  return series.filter(d=>d.period>=cutStr);
}

export function peCalcSupply() {
  if (!state.peData.prod||!state.peData.can||!state.peData.mex||!state.peData.lng) return null;
  const maps={};
  ['prod','can','mex','lng'].forEach(pk=>{maps[pk]={};state.peData[pk].forEach(r=>{maps[pk][r.period]=r.value;});});
  const periods=Object.keys(maps.prod).filter(p=>maps.can[p]!=null&&maps.mex[p]!=null&&maps.lng[p]!=null).sort();
  if (!periods.length) return null;
  return periods.map(p=>({period:p,value:parseFloat((maps.prod[p]+maps.can[p]-maps.mex[p]-maps.lng[p]).toFixed(4))}));
}

export function peSetWindow(w) {
  if (state.peWindow===w) return;
  state.peWindow=w;
  document.querySelectorAll('[data-pe-w]').forEach(b=>b.classList.toggle('on',b.dataset.peW===w));
  Object.keys(state.peCharts).forEach(pk=>{killChart(state.peCharts[pk]); state.peCharts[pk]=null;});
  ['prod','can','mex','lng','supply'].forEach(pk=>{
    document.getElementById('pe-wrap-'+pk).style.display='none';
    document.getElementById('pe-spin-'+pk).style.display='none';
  });
  ['prod','can','mex','lng'].forEach(pk=>peRenderOne(pk));
  peRenderSupply();
  const lbl={max:'full','5y':'5-year','2y':'2-year','1y':'1-year',ytd:'YTD'}, w2=lbl[w]||w;
  ['prod','can','mex','lng'].forEach(pk=>{ document.getElementById('pe-'+pk+'-sub').textContent='Monthly · Bcf/d · '+w2+' history'; });
}

// ── Render one series ─────────────────────────────────────────────────────────
export function peRenderOne(peKey) {
  const spinEl=document.getElementById('pe-spin-'+peKey), wrapEl=document.getElementById('pe-wrap-'+peKey);
  const allData=state.peData[peKey]; if(!allData||!allData.length){spinEl.innerHTML='⚠ No data';return;}
  const filtered=filterByWindow(allData).slice().sort((a,b)=>a.period<b.period?-1:1);
  if (!filtered.length) {spinEl.innerHTML='⚠ No data for window';return;}
  spinEl.style.display='none'; wrapEl.style.display='block';
  killChart(state.peCharts[peKey]); state.peCharts[peKey]=null;
  const color=PE_COLORS[peKey], label=PE_LABELS[peKey];
  const labels=filtered.map(d=>fmtPeriod(d.period)), values=filtered.map(d=>d.value);
  const tt=Object.assign({},baseTT(),{callbacks:{
    title:items=>{const i=items[0]?.dataIndex;return i!=null?filtered[i].period:'';},
    label:c=>' '+label+': '+c.parsed.y.toFixed(2)+' Bcf/d'
  }});
  const opts=baseOpts(); opts.scales.y.ticks.callback=v=>v.toFixed(1); opts.plugins.tooltip=tt;
  state.peCharts[peKey]=new Chart(document.getElementById('pe-c-'+peKey).getContext('2d'),{
    type:'line',
    data:{labels,datasets:[{label,data:values,borderColor:color,borderWidth:2,pointRadius:filtered.length>60?0:2,pointHoverRadius:5,tension:0.3,fill:false}]},
    options:opts
  });
}

// ── Render supply (calculated) ────────────────────────────────────────────────
export function peRenderSupply() {
  const spinEl=document.getElementById('pe-spin-supply'), wrapEl=document.getElementById('pe-wrap-supply');
  spinEl.style.display='block'; wrapEl.style.display='none';
  const supply=peCalcSupply(); if(!supply||!supply.length){spinEl.innerHTML='⚠ Need all 4 series';return;}
  const filtered=filterByWindow(supply).slice().sort((a,b)=>a.period<b.period?-1:1);
  if (!filtered.length) {spinEl.innerHTML='⚠ No data for window';return;}
  const latest=filtered[filtered.length-1], prev2=filtered.length>1?filtered[filtered.length-2]:null;
  const bVal=document.getElementById('b-supply-val'); bVal.textContent=latest.value.toFixed(2)+' Bcf/d'; bVal.style.color='#e6edf3';
  document.getElementById('b-supply-date').textContent=fmtPeriod(latest.period);
  if (prev2) { const chg=latest.value-prev2.value; document.getElementById('b-supply-sub').innerHTML='<span style="color:'+(chg>=0?'#3fb950':'#ff7b72')+'">'+sgn(chg)+chg.toFixed(2)+' Bcf/d vs prev mo</span>'; }
  spinEl.style.display='none'; wrapEl.style.display='block';
  killChart(state.peCharts.supply); state.peCharts.supply=null;
  const labels=filtered.map(d=>fmtPeriod(d.period)), values=filtered.map(d=>d.value);
  const tt=Object.assign({},baseTT(),{callbacks:{
    title:items=>{const i=items[0]?.dataIndex;return i!=null?filtered[i].period:'';},
    label:c=>' Total Supply: '+c.parsed.y.toFixed(2)+' Bcf/d'
  }});
  const opts=baseOpts(); opts.scales.y.ticks.callback=v=>v.toFixed(1); opts.plugins.tooltip=tt;
  state.peCharts.supply=new Chart(document.getElementById('pe-c-supply').getContext('2d'),{
    type:'line',
    data:{labels,datasets:[{label:'Total Supply',data:values,borderColor:'#58a6ff',borderWidth:2.5,pointRadius:filtered.length>60?0:2,pointHoverRadius:5,tension:0.3,fill:false}]},
    options:opts
  });
  document.getElementById('pe-supply-sub').textContent='Monthly · Bcf/d · '+({max:'full','5y':'5-year','2y':'2-year','1y':'1-year',ytd:'YTD'}[state.peWindow]||state.peWindow)+' history';
}
