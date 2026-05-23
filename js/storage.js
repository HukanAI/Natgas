// js/storage.js
import { ST_API_KEY, ST_WINDOWS } from './constants.js';
import { state } from './state.js';
import { dbLog } from './debug.js';
import { fmtGB, fmtTs, isoAdd, setUpdated, sgn } from './utils.js';
import { st5y } from './storage5y.js';
import { stSeasonTrans } from './season.js';
import { killChart, baseX, baseY, baseTT, stBandPlugin, makeSeasonPlugin, makeTodayPlugin, zoomOpts } from './charts.js';
import { yahooFetch } from './contracts.js';

// ── Badge / dot helpers ───────────────────────────────────────────────────────

function setDot(s)       { document.getElementById('st-dot').className='sdot '+s; }
function setBadge(t,txt) { const el=document.getElementById('st-badge'); el.textContent=txt; el.className='cbadge '+t; }

// ── EIA fetch ─────────────────────────────────────────────────────────────────

async function fetchStorage() {
  state.stApiCount++;
  document.getElementById('st-api-count').textContent = state.stApiCount;
  const qs='api_key='+ST_API_KEY+'&frequency=weekly&data[0]=value&facets[series][]=NW2_EPG0_SWO_R48_BCF&sort[0][column]=period&sort[0][direction]=asc&length=1000';
  const res=await fetch('https://api.eia.gov/v2/natural-gas/stor/wkly/data?'+qs);
  if (!res.ok) throw new Error('EIA HTTP '+res.status);
  const json=await res.json();
  if (json.response?.error) throw new Error('EIA: '+json.response.error);
  const rows=json.response?.data||[];
  if (!rows.length) throw new Error('No rows from EIA');
  const out=rows.map(r=>{const v=parseFloat(r.value);return isFinite(v)?{date:r.period,value:v}:null;}).filter(Boolean);
  out.sort((a,b)=>a.date<b.date?-1:1);
  return out;
}

export async function fetchNGF() {
  state.ngfApiCount++;
  document.getElementById('ngf-api-count').textContent = state.ngfApiCount;
  const p1t=Math.floor(new Date('2010-01-01').getTime()/1000);
  const p2t=Math.floor(Date.now()/1000);
  return await yahooFetch('NG=F','period1='+p1t+'&period2='+p2t+'&interval=1wk&events=history');
}

// ── Load all ──────────────────────────────────────────────────────────────────

export async function stLoadAll() {
  setDot('loading'); setBadge('loading','Loading…');
  ['st-wrap-stor','st-wrap-dev','st-wrap-inj'].forEach(id=>document.getElementById(id).style.display='none');
  ['st-spin-stor','st-spin-dev','st-spin-inj'].forEach(id=>{
    const el=document.getElementById(id); el.style.display='block'; el.innerHTML='<span class="sp"></span>Loading…';
  });

  dbLog('Storage: fetching EIA…','info');
  const errs=[];
  try {
    state.stStorageData=await fetchStorage();
    dbLog('EIA storage: OK ('+state.stStorageData.length+' rows)','ok');
  } catch(e) { errs.push('EIA: '+e.message); dbLog('EIA error: '+e.message,'error'); }

  const ngfDot=document.getElementById('ngf-dot'), ngfBadge=document.getElementById('ngf-badge');
  ngfDot.className='sdot loading'; ngfBadge.textContent='Loading…'; ngfBadge.className='cbadge loading';
  try {
    state.stNgfData=await fetchNGF();
    ngfDot.className='sdot ok'; ngfBadge.textContent='Live data'; ngfBadge.className='cbadge live';
    // futures.js handles NGF chart render — triggered via event
    document.dispatchEvent(new CustomEvent('ngf:loaded'));
    dbLog('NG=F: OK ('+state.stNgfData.length+' rows)','ok');
  } catch(e) {
    errs.push('NGF: '+e.message); dbLog('NGF: '+e.message,'warn');
    ngfDot.className='sdot err'; ngfBadge.textContent='Unavailable'; ngfBadge.className='cbadge err';
    const sp=document.getElementById('ngf-spin'); sp.style.display='block'; sp.innerHTML='⚠ NG=F unavailable';
  }

  if (state.stStorageData.length) { stRenderStorChart(); stRenderDevChart(); stRenderInjChart(); }
  stUpdateSubtitles();
  if (!errs.length)                     { setDot('ok'); setBadge('live','Live data'); }
  else if (state.stStorageData.length)   { setDot('ok'); setBadge('live','EIA OK · NGF fail'); }
  else                                   { setDot('err'); setBadge('err','Error'); }

  // Trigger bias card render (bias.js listens or main.js calls it)
  document.dispatchEvent(new CustomEvent('storage:loaded'));
  setUpdated();
}

// ── Window helpers ────────────────────────────────────────────────────────────

export function stFilterByWindow() {
  const days=state.stWindow==='ytd'
    ?Math.floor((new Date()-new Date(new Date().getFullYear(),0,1))/864e5)
    :ST_WINDOWS[state.stWindow];
  if (!days||days>=99999) return state.stStorageData.slice();
  const cut=new Date(); cut.setDate(cut.getDate()-days);
  return state.stStorageData.filter(d=>new Date(d.date+'T12:00:00Z')>=cut);
}

export function buildFcstExt(histLabels) {
  const fcstDates=[], fcstVals=[];
  [state.stLastF7,state.stLastF14,state.stLastF21].forEach(f=>{
    if (f?.predictedLevel!=null&&f.endDate) { fcstDates.push(f.endDate); fcstVals.push(f.predictedLevel); }
  });
  return {allLabels:histLabels.concat(fcstDates.map(fmtGB)), histLen:histLabels.length, fcstDates, fcstVals};
}

export function stUpdateSubtitles() {
  const lbl={max:'full','5y':'5-year','2y':'2-year','1y':'1-year',ytd:'YTD','3m':'3-month','1m':'1-month'};
  const w=lbl[state.stWindow]||state.stWindow;
  document.getElementById('st-stor-sub').textContent='Weekly · Bcf · '+w+' history vs 5-year range';
  document.getElementById('st-dev-sub').textContent ='Weekly · Bcf · '+w+' surplus / deficit vs 5y avg';
  document.getElementById('st-inj-sub').textContent ='Weekly · Bcf · '+w+' history · injection / withdrawal';
}

export function stSetWindow(w) {
  if (state.stWindow===w) return;
  state.stWindow=w;
  document.querySelectorAll('[data-st-w]').forEach(b=>b.classList.toggle('on',b.dataset.stW===w));
  ['stor','dev','inj'].forEach(k=>{killChart(state.stCharts[k]); state.stCharts[k]=null;});
  if (state.stStorageData.length) { stRenderStorChart(); stRenderDevChart(); stRenderInjChart(); }
  stUpdateSubtitles();
}

// ── Render: Storage chart ─────────────────────────────────────────────────────

export function stRenderStorChart() {
  const filtered=stFilterByWindow(); if (!filtered.length) return;
  const dates=filtered.map(d=>d.date), values=filtered.map(d=>d.value);
  const b5=st5y(state.stStorageData,dates), histLabels=dates.map(fmtGB), trans=stSeasonTrans(dates);
  const ext=buildFcstExt(histLabels), {allLabels,histLen,fcstVals,fcstDates}=ext;
  const fcst5y=st5y(state.stStorageData,fcstDates);
  const avgsExt=b5.map(b=>b.avg).concat(fcst5y.map(b=>b.avg));
  const minsExt=b5.map(b=>b.min).concat(fcst5y.map(b=>b.min));
  const maxsExt=b5.map(b=>b.max).concat(fcst5y.map(b=>b.max));
  const fcstLine=values.map(()=>null); fcstLine[histLen-1]=values[histLen-1];
  fcstVals.forEach(v=>fcstLine.push(v));
  const fcstRadii=fcstLine.map((v,i)=>(i>=histLen&&v!=null)?3:0);

  document.getElementById('st-spin-stor').style.display='none';
  document.getElementById('st-wrap-stor').style.display='block';
  killChart(state.stCharts.stor); state.stCharts.stor=null;

  const tt=Object.assign({},baseTT(),{
    filter:item=>item.dataset._k!=='min'&&item.dataset._k!=='max',
    callbacks:{
      title:items=>items[0]?allLabels[items[0].dataIndex]:'',
      label:c=>c.parsed.y==null?null:' '+c.dataset.label+': '+Math.round(c.parsed.y).toLocaleString()+' Bcf',
      afterBody:items=>{const i=items[0]?.dataIndex;if(i==null||minsExt[i]==null)return[];return['5y range: '+Math.round(minsExt[i]).toLocaleString()+' – '+Math.round(maxsExt[i]).toLocaleString()+' Bcf'];}
    }
  });

  state.stCharts.stor=new Chart(document.getElementById('st-c-stor').getContext('2d'),{
    type:'line',
    plugins:[stBandPlugin,makeSeasonPlugin('stor',()=>trans),makeTodayPlugin('stor',()=>histLen-1)],
    data:{labels:allLabels,datasets:[
      {_k:'val', label:'Storage', data:values.concat(fcstVals.map(()=>null)),borderColor:'#4493f8',borderWidth:2,pointRadius:0,pointHoverRadius:6,tension:0.3,fill:false},
      {_k:'fcst',label:'Forecast',data:fcstLine,borderColor:'#a371f7',borderWidth:2,borderDash:[5,4],pointRadius:fcstRadii,pointHoverRadius:5,pointBackgroundColor:'#a371f7',showLine:true,tension:0,fill:false},
      {_k:'avg', label:'5y Avg', data:avgsExt,borderColor:'rgba(68,147,248,.5)',borderWidth:1.5,borderDash:[4,3],pointRadius:0,tension:0.3,fill:false},
      {_k:'min', data:minsExt,borderColor:'transparent',pointRadius:0,fill:false},
      {_k:'max', data:maxsExt,borderColor:'transparent',pointRadius:0,fill:false}
    ]},
    options:{responsive:true,maintainAspectRatio:false,animation:{duration:300},interaction:{mode:'index',intersect:false},
      plugins:{legend:{display:false},tooltip:tt,zoom:zoomOpts()},
      scales:{x:baseX(),y:baseY(v=>Math.round(v).toLocaleString())}}
  });
}

// ── Render: Deviation chart ───────────────────────────────────────────────────

export function stRenderDevChart() {
  const filtered=stFilterByWindow(); if (!filtered.length) return;
  const dates=filtered.map(d=>d.date), b5=st5y(state.stStorageData,dates);
  const devs=[], surplus=[], deficit=[];
  filtered.forEach((d,i)=>{
    const dv=b5[i].avg!=null?d.value-b5[i].avg:null;
    devs.push(dv); surplus.push(dv!=null&&dv>=0?dv:0); deficit.push(dv!=null&&dv<0?dv:0);
  });
  const histLabels=dates.map(fmtGB), trans=stSeasonTrans(dates);
  const ext=buildFcstExt(histLabels), {allLabels,histLen,fcstDates}=ext;
  const fcstDevs=fcstDates.map(d=>{
    const b=st5y(state.stStorageData,[d])[0].avg;
    const f=[state.stLastF7,state.stLastF14,state.stLastF21].find(x=>x?.endDate===d);
    if (!f||f.predictedLevel==null||b==null) return null;
    return f.predictedLevel-b;
  });
  const allDevs=devs.concat(fcstDevs);
  const zero=arr=>arr.map(()=>0);

  document.getElementById('st-spin-dev').style.display='none';
  document.getElementById('st-wrap-dev').style.display='block';
  killChart(state.stCharts.dev); state.stCharts.dev=null;

  const tt=Object.assign({},baseTT(),{callbacks:{
    title:items=>items[0]?allLabels[items[0].dataIndex]:'',
    label:c=>{const v=allDevs[c.dataIndex];if(v==null)return null;return' '+(v>=0?'Surplus':'Deficit')+': '+sgn(v)+Math.round(v).toLocaleString()+' Bcf'+(c.dataIndex>=histLen?' (forecast)':'');},
    filter:item=>{const v=allDevs[item.dataIndex];if(v==null)return false;const fc=item.dataIndex>=histLen;if(fc)return(item.dataset._k==='fcst-sur'&&v>=0)||(item.dataset._k==='fcst-def'&&v<0);return(item.dataset._k==='sur'&&v>=0)||(item.dataset._k==='def'&&v<0);}
  }});

  state.stCharts.dev=new Chart(document.getElementById('st-c-dev').getContext('2d'),{
    type:'bar',
    plugins:[makeSeasonPlugin('dev',()=>trans),makeTodayPlugin('dev',()=>histLen-1)],
    data:{labels:allLabels,datasets:[
      {_k:'sur',     label:'Surplus',     data:surplus.concat(zero(fcstDevs)),backgroundColor:'rgba(255,123,114,0.75)',borderWidth:0,borderRadius:1},
      {_k:'def',     label:'Deficit',     data:deficit.concat(zero(fcstDevs)),backgroundColor:'rgba(63,185,80,0.75)',borderWidth:0,borderRadius:1},
      {_k:'fcst-sur',label:'Fcst Surplus',data:zero(devs).concat(fcstDevs.map(v=>v!=null&&v>=0?v:0)),backgroundColor:'rgba(255,123,114,0.35)',borderColor:'rgba(255,123,114,0.8)',borderWidth:1,borderRadius:2},
      {_k:'fcst-def',label:'Fcst Deficit',data:zero(devs).concat(fcstDevs.map(v=>v!=null&&v<0?v:0)),backgroundColor:'rgba(63,185,80,0.35)',borderColor:'rgba(63,185,80,0.8)',borderWidth:1,borderRadius:2}
    ]},
    options:{responsive:true,maintainAspectRatio:false,animation:{duration:300},interaction:{mode:'index',intersect:false},
      plugins:{legend:{display:false},tooltip:tt,zoom:zoomOpts()},
      scales:{
        x:{stacked:true,grid:{color:'rgba(255,255,255,0.04)'},ticks:{color:'#6e7681',font:{family:'Inter',size:9},maxRotation:45,autoSkip:true,maxTicksLimit:16}},
        y:{stacked:true,grid:{color:'rgba(255,255,255,0.04)'},ticks:{color:'#6e7681',font:{family:'Inter',size:9},callback:v=>sgn(v)+Math.round(v).toLocaleString()}}
      }}
  });
}

// ── Render: Injection/Withdrawal chart ────────────────────────────────────────

export function stRenderInjChart() {
  const filtered=stFilterByWindow(); if (filtered.length<2) return;
  const dates=[], changes=[], injections=[], withdrawals=[];
  for (let i=1; i<filtered.length; i++) {
    const chg=filtered[i].value-filtered[i-1].value;
    dates.push(filtered[i].date); changes.push(chg);
    injections.push(chg>0?chg:0); withdrawals.push(chg<0?chg:0);
  }
  const histLabels=dates.map(fmtGB), trans=stSeasonTrans(dates);
  const ext=buildFcstExt(histLabels), {allLabels,histLen,fcstDates}=ext;
  let prevLevel=filtered[filtered.length-1].value;
  const fcstChanges=fcstDates.map(d=>{
    const f=[state.stLastF7,state.stLastF14,state.stLastF21].find(x=>x?.endDate===d);
    if (!f||f.predictedLevel==null) return null;
    const chg=f.predictedLevel-prevLevel; prevLevel=f.predictedLevel; return chg;
  });
  const allChanges=changes.concat(fcstChanges);
  const zero=arr=>arr.map(()=>0);

  document.getElementById('st-spin-inj').style.display='none';
  document.getElementById('st-wrap-inj').style.display='block';
  killChart(state.stCharts.inj); state.stCharts.inj=null;

  const tt=Object.assign({},baseTT(),{callbacks:{
    title:items=>items[0]?allLabels[items[0].dataIndex]:'',
    label:c=>{const v=allChanges[c.dataIndex];if(v==null)return null;return' '+(v>=0?'Injection':'Withdrawal')+': '+sgn(v)+Math.round(v).toLocaleString()+' Bcf'+(c.dataIndex>=histLen?' (forecast)':'');},
    filter:item=>{const v=allChanges[item.dataIndex];if(v==null)return false;const fc=item.dataIndex>=histLen;if(fc)return(item.dataset._k==='fcst-inj'&&v>=0)||(item.dataset._k==='fcst-wdr'&&v<0);return(item.dataset._k==='inj'&&v>0)||(item.dataset._k==='wdr'&&v<0);}
  }});

  state.stCharts.inj=new Chart(document.getElementById('st-c-inj').getContext('2d'),{
    type:'bar',
    plugins:[makeSeasonPlugin('inj',()=>trans),makeTodayPlugin('inj',()=>histLen-1)],
    data:{labels:allLabels,datasets:[
      {_k:'inj',     label:'Injection',  data:injections.concat(zero(fcstChanges)),backgroundColor:'rgba(255,123,114,0.75)',borderWidth:0,borderRadius:1},
      {_k:'wdr',     label:'Withdrawal', data:withdrawals.concat(zero(fcstChanges)),backgroundColor:'rgba(63,185,80,0.75)',borderWidth:0,borderRadius:1},
      {_k:'fcst-inj',label:'Fcst Inj',  data:zero(changes).concat(fcstChanges.map(v=>v!=null&&v>=0?v:0)),backgroundColor:'rgba(255,123,114,0.35)',borderColor:'rgba(255,123,114,0.8)',borderWidth:1,borderRadius:2},
      {_k:'fcst-wdr',label:'Fcst Wdr',  data:zero(changes).concat(fcstChanges.map(v=>v!=null&&v<0?v:0)),backgroundColor:'rgba(63,185,80,0.35)',borderColor:'rgba(63,185,80,0.8)',borderWidth:1,borderRadius:2}
    ]},
    options:{responsive:true,maintainAspectRatio:false,animation:{duration:300},interaction:{mode:'index',intersect:false},
      plugins:{legend:{display:false},tooltip:tt,zoom:zoomOpts()},
      scales:{
        x:{stacked:true,grid:{color:'rgba(255,255,255,0.04)'},ticks:{color:'#6e7681',font:{family:'Inter',size:9},maxRotation:45,autoSkip:true,maxTicksLimit:16}},
        y:{stacked:true,grid:{color:'rgba(255,255,255,0.04)'},ticks:{color:'#6e7681',font:{family:'Inter',size:9},callback:v=>sgn(v)+Math.round(v).toLocaleString()}}
      }}
  });
}
