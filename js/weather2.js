// js/weather.js
import { WX_BASE, WX_FCST_DAYS, WX_HIST_YRS, WX_REGIONS, WX_TW, WX_LS_CACHE, WX_LS_API, REG_COLORS } from './constants.js';
import { state } from './state.js';
import { dbLog } from './debug.js';
import { isoDate, isoAdd, shortDate, p2, esc, sleep, wxFmtExp, getFriday, dlBlob } from './utils.js';
import { getSeasonTransitions, getSeasonInfo } from './season.js';
import { killChart, baseOpts, baseTT, makeBandPlugin, makeTodayPlugin, makeAnomalyPlugin, makeSeasonPlugin } from './charts.js';
import { updateTopbar } from './topbar.js';
import { updateAllWidgets } from './widgets.js';

// ── Weighted average helpers ──────────────────────────────────────────────────

function wAvg(vals) {
  return WX_REGIONS.reduce((s,r,i) => s + r.w*(vals[i]||0), 0);
}
function hdd(t) { return Math.max(0, WX_BASE-t); }
function cdd(t) { return Math.max(0, t-WX_BASE); }

function weightedDemand(rt) {
  let hW=0, cW=0, wSum=0;
  WX_REGIONS.forEach((r,ri) => {
    const t=rt[ri]; if(t==null||isNaN(t)) return;
    hW+=r.w*hdd(t); cW+=r.w*cdd(t); wSum+=r.w;
  });
  if (wSum<0.01) return {hdd:null,cdd:null,dem:null};
  const sc=1/wSum;
  return {hdd:hW*sc, cdd:cW*sc, dem:(hW+cW)*sc};
}

// ── API count / cache ─────────────────────────────────────────────────────────

function todayKey() { const d=new Date(); return d.getFullYear()+'-'+p2(d.getMonth()+1)+'-'+p2(d.getDate()); }
function getApiCount() {
  try { const r=localStorage.getItem(WX_LS_API); if(!r) return{date:todayKey(),count:0}; const o=JSON.parse(r); return o.date!==todayKey()?{date:todayKey(),count:0}:o; }
  catch(e) { return{date:todayKey(),count:0}; }
}
function incrApi() {
  try { const o=getApiCount(); o.count++; localStorage.setItem(WX_LS_API,JSON.stringify(o)); document.getElementById('wx-api-count').textContent=o.count; }
  catch(e) {}
}
export function wxSlot() { const n=new Date(); return new Date(n.getFullYear(),n.getMonth(),n.getDate(),n.getHours()).getTime(); }
function cacheKey(w) { return WX_LS_CACHE+'_'+w+'_'+wxSlot(); }
function loadCache(w) {
  try { const r=localStorage.getItem(cacheKey(w)); if(!r) return null; const o=JSON.parse(r); return o.slot!==wxSlot()?null:o.data; }
  catch(e) { return null; }
}
function clearOldCache() {
  try {
    const toDelete=[];
    for (let i=0;i<localStorage.length;i++) { const k=localStorage.key(i); if(k&&k.indexOf(WX_LS_CACHE)===0) toDelete.push(k); }
    toDelete.forEach(k=>localStorage.removeItem(k));
    dbLog('Cache: cleared '+toDelete.length+' old wx entries','info');
  } catch(e) { dbLog('Cache clear error: '+e.message,'warn'); }
}
function saveCache(w,data) {
  const payload=JSON.stringify({slot:wxSlot(),savedAt:Date.now(),data});
  try { localStorage.setItem(cacheKey(w),payload); }
  catch(e) {
    dbLog('Cache quota exceeded — clearing old entries…','warn');
    clearOldCache();
    try { localStorage.setItem(cacheKey(w),payload); dbLog('Cache: saved after cleanup','ok'); }
    catch(e2) { dbLog('Cache: skipped (too large — '+Math.round(payload.length/1024)+'KB)','warn'); }
  }
}
function cachedAt(w) { try { const r=localStorage.getItem(cacheKey(w)); return r?JSON.parse(r).savedAt:null; } catch(e) { return null; } }
function nextHour() { const d=new Date(); d.setHours(d.getHours()+1,0,0,0); return p2(d.getHours())+':00:00'; }

// ── Badge / dot ───────────────────────────────────────────────────────────────

function setDot(s)       { document.getElementById('wx-dot').className='sdot '+s; }
function setBadge(t,txt) { const el=document.getElementById('wx-badge'); el.textContent=txt; el.className='cbadge '+t; }

// ── API fetch helpers ─────────────────────────────────────────────────────────

async function fetchRetry(url, tries=4, delay=1500) {
  for (let i=0; i<=tries; i++) {
    try {
      const r=await fetch(url);
      if (r.status===429) { if(i===tries) throw new Error('Rate limit'); await sleep(delay*Math.pow(2,i)); continue; }
      if (!r.ok) throw new Error('HTTP '+r.status);
      incrApi(); return await r.json();
    } catch(e) { if(i===tries) throw e; await sleep(delay*Math.pow(2,i)); }
  }
}
async function batch(tasks, bs=5, delay=400) {
  let out=[];
  for (let i=0; i<tasks.length; i+=bs) {
    const br=await Promise.all(tasks.slice(i,i+bs).map(t=>t()));
    out=out.concat(br);
    if (i+bs<tasks.length) await sleep(delay);
  }
  return out;
}
async function fetchFcst(lat,lon) {
  // Use DAILY max/min (not hourly averages): a day's max/min are fixed for that
  // calendar day, so the computed demand stays stable whether you look in the
  // morning or afternoon. Hourly averaging drifted through the day as past hours
  // filled in with real (cooler) values. This also matches how history is built.
  const j=await fetchRetry('https://api.open-meteo.com/v1/forecast?latitude='+lat+'&longitude='+lon+'&daily=temperature_2m_max,temperature_2m_min&forecast_days='+WX_FCST_DAYS+'&timezone=UTC');
  const res=[];
  for (let d=0;d<WX_FCST_DAYS;d++) {
    const mx=j.daily?.temperature_2m_max?.[d], mn=j.daily?.temperature_2m_min?.[d];
    res.push((mx!=null&&mn!=null)?(mx+mn)/2:null);
  }
  return res;
}
async function fetchArchive(lat, lon, startDate, endDate) {
  const params = '?latitude='+lat+'&longitude='+lon+'&daily=temperature_2m_max,temperature_2m_min&start_date='+startDate+'&end_date='+endDate+'&timezone=UTC';
  // archive-api.open-meteo.com is the only source for ERA5 data
  // Use longer timeout (15s) and more retries for resilience during outages
  const url = 'https://archive-api.open-meteo.com/v1/archive' + params;
  return await fetchRetry(url, 5, 3000);
}
async function fetchHist(lat,lon,s,e) {
  const j=await fetchArchive(lat,lon,s,e);
  return j.daily.time.map((dt,i)=>({date:dt,avg:(j.daily.temperature_2m_max[i]+j.daily.temperature_2m_min[i])/2}));
}

// ── Process raw data ──────────────────────────────────────────────────────────

function processWx(raw) {
  const {hDates,fDates,byY,HD,hTR,fTR,byYR} = raw;
  const total=HD+WX_FCST_DAYS;
  const h5avg=[], h5min=[], h5max=[];
  for (let d=0;d<total;d++) {
    const v=byY.map(yr=>yr[d]).filter(x=>x!=null&&!isNaN(x));
    if (!v.length) { h5avg.push(null);h5min.push(null);h5max.push(null); continue; }
    const av=v.reduce((a,b)=>a+b)/v.length;
    h5avg.push(av); h5min.push(Math.min(...v)); h5max.push(Math.max(...v));
  }
  const allDates=hDates.concat(fDates);
  const hTemps=hDates.map((_,di)=>wAvg(WX_REGIONS.map((_,ri)=>hTR[ri]?hTR[ri][di]:null)));
  const fTemps=fDates.map((_,di)=>wAvg(WX_REGIONS.map((_,ri)=>fTR[ri]?fTR[ri][di]:null)));
  const allTemps=hTemps.concat(fTemps);
  const todayIdx=HD;

  const allRT=[];
  for (let d2=0;d2<HD;d2++)        allRT.push(WX_REGIONS.map((_,ri)=>hTR[ri]?hTR[ri][d2]:null));
  for (let d3=0;d3<WX_FCST_DAYS;d3++) allRT.push(WX_REGIONS.map((_,ri)=>fTR[ri]?fTR[ri][d3]:null));

  const hddAll=[], cddAll=[], demAll=[];
  allRT.forEach(rt=>{const wd=weightedDemand(rt);hddAll.push(wd.hdd);cddAll.push(wd.cdd);demAll.push(wd.dem);});

  const dem5avg=[], dem5min=[], dem5max=[];
  for (let d4=0;d4<total;d4++) {
    const yds=byY.map((_,yi)=>{
      const rt=WX_REGIONS.map((_2,ri)=>byYR[yi]&&byYR[yi][ri]?byYR[yi][ri][d4]:null);
      return weightedDemand(rt).dem;
    }).filter(x=>x!=null&&!isNaN(x));
    if (!yds.length) { dem5avg.push(null);dem5min.push(null);dem5max.push(null); continue; }
    const av2=yds.reduce((a,b)=>a+b)/yds.length;
    dem5avg.push(av2); dem5min.push(Math.min(...yds)); dem5max.push(Math.max(...yds));
  }

  return {
    labels:allDates.map(shortDate), allDates, allTemps, todayIdx,
    h5avg, h5min, h5max, hddAll, cddAll, demAll,
    dem5avg, dem5min, dem5max,
    seasonTransitions:getSeasonTransitions(allDates),
    regionTemps:allRT
  };
}

// ── Load all ──────────────────────────────────────────────────────────────────

export async function wxLoadAll(force=false) {
  setDot('loading'); setBadge('loading','Checking cache…');
  document.getElementById('wx-api-count').textContent = getApiCount().count;

  if (!force) {
    const cached=loadCache(state.wxWindow);
    if (cached) {
      state.wxS=cached;
      const ct=cachedAt(state.wxWindow), cs=ct?new Date(ct).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}):'—';
      document.getElementById('wx-upd').textContent='Cached '+cs+' · next at '+nextHour();
      setBadge('cached','Cached '+cs); setDot('ok');
      wxRenderAll();
      document.dispatchEvent(new CustomEvent('weather:loaded'));
      dbLog('Weather: from cache ('+state.wxWindow+')','info');
      return;
    }
  }

  setBadge('loading','Fetching…'); dbLog('Weather: fetching ('+state.wxWindow+')…','info');
  ['wx-spin1','wx-spin3','wx-spin-reg'].forEach(id=>{const el=document.getElementById(id);el.style.display='block';el.innerHTML='<span class="sp"></span>Fetching data…';});
  ['wx-wrap1','wx-wrap3','wx-wrap-reg'].forEach(id=>document.getElementById(id).style.display='none');

  try {
    const HD=(()=>{
      if (state.wxWindow==='ytd') { const n=new Date(); return Math.max(1,Math.floor((n-new Date(n.getFullYear(),0,1))/864e5)); }
      return WX_TW[state.wxWindow]||365;
    })();
    const hS=isoDate(-HD), hE=isoDate(-1);

    const hPR=await batch(WX_REGIONS.map(r=>()=>fetchHist(r.lat,r.lon,hS,hE)),5,200);
    const hDates=hPR[0].map(d=>d.date);
    const hTR=hPR.map(rh=>rh.map(d=>d.avg));

    const fPR=await batch(WX_REGIONS.map(r=>()=>fetchFcst(r.lat,r.lon)),5,200);
    const fDates=[]; for(let ii=0;ii<WX_FCST_DAYS;ii++) fDates.push(isoDate(ii));
    const fTR=fPR.map(rf=>rf.slice());

    const flat=await batch(WX_HIST_YRS.reduce((acc,yr)=>
      acc.concat(WX_REGIONS.map(r=>()=>fetchHist(r.lat,r.lon,isoDate(-HD,yr),isoDate(WX_FCST_DAYS-1,yr)))),[]),5,200);

    const byY=WX_HIST_YRS.map((_,yi)=>{
      const pr=flat.slice(yi*WX_REGIONS.length,(yi+1)*WX_REGIONS.length);
      const nd=pr[0].length, arr=[];
      for (let d=0;d<nd;d++) arr.push(wAvg(pr.map(rh=>rh[d]?rh[d].avg:null)));
      return arr;
    });
    const byYR=WX_HIST_YRS.map((_,yi)=>{
      const pr=flat.slice(yi*WX_REGIONS.length,(yi+1)*WX_REGIONS.length);
      return pr.map(rh=>rh.map(d=>d.avg));
    });

    state.wxS=processWx({hDates,fDates,byY,HD,hTR,fTR,byYR});
    saveCache(state.wxWindow,state.wxS);
    document.getElementById('wx-upd').textContent='Live · next at '+nextHour();
    setBadge('live','Live data'); setDot('ok');
    wxRenderAll();
    document.dispatchEvent(new CustomEvent('weather:loaded'));
    dbLog('Weather: OK ('+HD+'d+'+WX_FCST_DAYS+'d fcst)','ok');
  } catch(err) {
    setDot('err'); setBadge('err','Error');
    document.getElementById('wx-upd').textContent='Error: '+err.message;
    ['wx-spin1','wx-spin3','wx-spin-reg'].forEach(id=>{const el=document.getElementById(id);el.style.display='block';el.innerHTML='⚠ '+esc(err.message);});
    dbLog('Weather error: '+err.message,'error');
  }
}

// Headless loader for the mobile page: same data + processWx() as wxLoadAll,
// but touches no DOM, no cache, and no rendering. Returns the wxS object (or
// throws). Uses a short history window (default 7 days) since the demand
// heatmap only ever shows todayIdx-7 .. todayIdx+16.
export async function wxLoadHeadless(histDays=7) {
  const HD = histDays;
  const hS = isoDate(-HD), hE = isoDate(-1);

  const hPR = await batch(WX_REGIONS.map(r=>()=>fetchHist(r.lat,r.lon,hS,hE)),5,200);
  const hDates = hPR[0].map(d=>d.date);
  const hTR = hPR.map(rh=>rh.map(d=>d.avg));

  const fPR = await batch(WX_REGIONS.map(r=>()=>fetchFcst(r.lat,r.lon)),5,200);
  const fDates=[]; for(let ii=0;ii<WX_FCST_DAYS;ii++) fDates.push(isoDate(ii));
  const fTR = fPR.map(rf=>rf.slice());

  const flat = await batch(WX_HIST_YRS.reduce((acc,yr)=>
    acc.concat(WX_REGIONS.map(r=>()=>fetchHist(r.lat,r.lon,isoDate(-HD,yr),isoDate(WX_FCST_DAYS-1,yr)))),[]),5,200);

  const byY = WX_HIST_YRS.map((_,yi)=>{
    const pr=flat.slice(yi*WX_REGIONS.length,(yi+1)*WX_REGIONS.length);
    const nd=pr[0].length, arr=[];
    for (let d=0;d<nd;d++) arr.push(wAvg(pr.map(rh=>rh[d]?rh[d].avg:null)));
    return arr;
  });
  const byYR = WX_HIST_YRS.map((_,yi)=>{
    const pr=flat.slice(yi*WX_REGIONS.length,(yi+1)*WX_REGIONS.length);
    return pr.map(rh=>rh.map(d=>d.avg));
  });

  return processWx({hDates,fDates,byY,HD,hTR,fTR,byYR});
}

export function wxForceRefresh() {
  state.wxS=null;
  killChart(state.wxCh1); killChart(state.wxCh3); killChart(state.wxChReg);
  state.wxCh1=state.wxCh3=state.wxChReg=null;
  ['wx-wrap1','wx-wrap3','wx-wrap-reg'].forEach(id=>document.getElementById(id).style.display='none');
  ['wx-spin1','wx-spin3','wx-spin-reg'].forEach(id=>{const el=document.getElementById(id);el.style.display='block';el.innerHTML='<span class="sp"></span>Fetching data…';});
  wxLoadAll(true);
}

export function wxSetWindow(w) {
  if (state.wxWindow===w) return;
  state.wxWindow=w;
  document.querySelectorAll('[data-wx-w]').forEach(b=>b.classList.toggle('on',b.dataset.wxW===w));
  wxForceRefresh();
}

function getHistDays() {
  if (state.wxWindow==='ytd') { const n=new Date(); return Math.max(1,Math.floor((n-new Date(n.getFullYear(),0,1))/864e5)); }
  return WX_TW[state.wxWindow]||365;
}
function pointR() { const hd=getHistDays(); return hd>=365?0:hd>=90?1:hd>=30?2:3; }

// ── Render all ────────────────────────────────────────────────────────────────

export function wxRenderAll() {
  if (!state.wxS) return;
  wxRenderMetrics();
  wxRenderRegionalChart();
  wxRenderTempChart();
  wxRenderDemandChart();
  wxUpdateSubs();
  // Weather feeds Weather + Storage Trend factors + 7D/16D demand KPIs
  try { updateTopbar(); }     catch(e) { dbLog('topbar update failed: '+e.message, 'warn'); }
  try { updateAllWidgets(); } catch(e) { dbLog('widgets update failed: '+e.message, 'warn'); }
}

function wxUpdateSubs() {
  const lbl={ytd:'YTD','1m':'1-month','3m':'3-month','1y':'1-year','2y':'2-year'}, w=lbl[state.wxWindow]||state.wxWindow;
  document.getElementById('wx-reg-sub').textContent=w+' history + 16-day forecast · °C';
  document.getElementById('wx-temp-sub').textContent=w+' history + 16-day GFS forecast vs 5-year range';
  document.getElementById('wx-dem-sub').textContent=w+' history + 16-day forecast vs 5-year average';
}

export function wxRenderMetrics() {
  // Demand metric boxes removed from UI — function kept to avoid import errors
}

export function wxRenderRegionalChart() {
  document.getElementById('wx-spin-reg').style.display='none';
  document.getElementById('wx-wrap-reg').style.display='block';
  killChart(state.wxChReg); state.wxChReg=null;
  const labels=state.wxS.labels, pr=pointR(), sTrans=state.wxS.seasonTransitions.slice();
  const tt=Object.assign({},baseTT(),{callbacks:{
    title:items=>{const i=items[0]?.dataIndex;return i!=null?state.wxS.allDates[i]:'';},
    label:c=>' '+c.dataset.label+': '+c.parsed.y.toFixed(1)+'°C'
  }});
  const opts=baseOpts(); opts.scales.y.ticks.callback=v=>v.toFixed(0)+'°'; opts.plugins.tooltip=tt;
  state.wxChReg=new Chart(document.getElementById('wx-c-reg').getContext('2d'),{
    type:'line',
    plugins:[makeTodayPlugin('reg',()=>state.wxS?.todayIdx??null), makeSeasonPlugin('reg',()=>sTrans)],
    data:{labels,datasets:WX_REGIONS.map((r,ri)=>({
      label:r.name+' ('+Math.round(r.w*100)+'%)',
      data:state.wxS.regionTemps.map(rt=>rt[ri]!=null?rt[ri]:null),
      borderColor:REG_COLORS[ri],borderWidth:1.5,pointRadius:pr,pointHoverRadius:pr+3,tension:0.3,fill:false
    }))},
    options:opts
  });
}

export function wxRenderTempChart() {
  document.getElementById('wx-spin1').style.display='none';
  document.getElementById('wx-wrap1').style.display='block';
  killChart(state.wxCh1); state.wxCh1=null;
  const {labels,allTemps,h5avg,h5min,h5max,seasonTransitions,todayIdx}=state.wxS;
  const pr=pointR(), sTrans=seasonTransitions.slice();
  const opts=baseOpts(); opts.scales.y.ticks.callback=v=>v.toFixed(0)+'°';
  opts.plugins.tooltip=Object.assign({},baseTT(),{
    filter:item=>item.dataset._k!=='min'&&item.dataset._k!=='max',
    callbacks:{
      label:c=>c.dataset.label+': '+c.parsed.y.toFixed(1)+'°C',
      afterBody:items=>{const i=items[0]?.dataIndex;if(i==null)return[];const mn=h5min[i],mx=h5max[i];return(mn!=null&&mx!=null)?['5y range: '+mn.toFixed(1)+'–'+mx.toFixed(1)+'°C']:[];}
    }
  });
  state.wxCh1=new Chart(document.getElementById('wx-c1').getContext('2d'),{
    type:'line',
    plugins:[makeBandPlugin('wxB','min','max','rgba(68,147,248,0.09)'), makeTodayPlugin('wx1',()=>state.wxS?.todayIdx??null), makeAnomalyPlugin(()=>state.wxS?.todayIdx??null), makeSeasonPlugin('wx1',()=>sTrans)],
    data:{labels,datasets:[
      {_k:'fcst',label:'Temp',  data:allTemps,borderColor:'#f0883e',borderWidth:2,pointRadius:pr,pointHoverRadius:pr+4,tension:.3,fill:false},
      {_k:'avg', label:'5y Avg',data:h5avg,   borderColor:'rgba(68,147,248,.7)',borderWidth:1.5,borderDash:[5,3],pointRadius:0,tension:.3,fill:false},
      {_k:'min', label:'5y Min',data:h5min,   borderColor:'transparent',pointRadius:0,fill:false},
      {_k:'max', label:'5y Max',data:h5max,   borderColor:'transparent',pointRadius:0,fill:false}
    ]},
    options:opts
  });
}

export function wxRenderDemandChart() {
  document.getElementById('wx-spin3').style.display='none';
  document.getElementById('wx-wrap3').style.display='block';
  killChart(state.wxCh3); state.wxCh3=null;
  const {labels,demAll,dem5avg,dem5min,dem5max,seasonTransitions}=state.wxS;
  const sTrans=seasonTransitions.slice();
  const barColors=demAll.map((v,i)=>{if(v==null||dem5avg[i]==null)return'rgba(163,113,247,.4)';return v>=dem5avg[i]?'rgba(163,113,247,.8)':'rgba(163,113,247,.3)';});
  const opts=baseOpts();
  opts.plugins.tooltip=Object.assign({},baseTT(),{
    filter:item=>item.dataset._k!=='dmin'&&item.dataset._k!=='dmax',
    callbacks:{
      label:c=>{if(c.dataset._k==='dmin'||c.dataset._k==='dmax')return null;return c.dataset.label+': '+c.parsed.y.toFixed(1);},
      afterBody:items=>{const i=items[0]?.dataIndex;if(i==null)return[];const mn=dem5min[i],mx=dem5max[i];return(mn!=null&&mx!=null)?['5y range: '+mn.toFixed(1)+'–'+mx.toFixed(1)]:[];}
    }
  });
  state.wxCh3=new Chart(document.getElementById('wx-c3').getContext('2d'),{
    type:'bar',
    plugins:[makeBandPlugin('wxBD','dmin','dmax','rgba(163,113,247,0.09)'), makeTodayPlugin('wx3',()=>state.wxS?.todayIdx??null), makeSeasonPlugin('wx3',()=>sTrans)],
    data:{labels,datasets:[
      {_k:'dem',label:'Demand',data:demAll,backgroundColor:barColors,order:2},
      {_k:'d5a',label:'5y avg',data:dem5avg,type:'line',borderColor:'rgba(163,113,247,.75)',borderWidth:1.5,borderDash:[4,3],pointRadius:0,fill:false,order:1},
      {_k:'dmin',data:dem5min,borderColor:'transparent',pointRadius:0,fill:false,order:3},
      {_k:'dmax',data:dem5max,borderColor:'transparent',pointRadius:0,fill:false,order:3}
    ]},
    options:opts
  });
}

// ── Historical export ─────────────────────────────────────────────────────────

export async function exportHistoricalWeekly() {
  const btn=document.getElementById('wx-hist-btn'); btn.disabled=true;
  const today=new Date(), todayISO=today.toISOString().slice(0,10);
  dbLog('Historical weekly export started…','info');
  try {
    const allReg=[];
    for (let ri=0;ri<WX_REGIONS.length;ri++) {
      const r=WX_REGIONS[ri]; btn.textContent='⏳ '+r.name+' ('+(ri+1)+'/'+WX_REGIONS.length+')…';
      const dd=await fetchArchive(r.lat, r.lon, '2010-01-01', todayISO);
      if (!dd?.daily?.time) throw new Error('No data for '+r.name);
      allReg.push(dd.daily); if(ri<WX_REGIONS.length-1) await sleep(600);
    }
    btn.textContent='⚙️ Processing…'; await sleep(10);
    const baseDates=allReg[0].time;
    const daily=baseDates.map((dt,di)=>{
      const regTemps=WX_REGIONS.map((rg,ri2)=>{const mx=allReg[ri2].temperature_2m_max[di],mn=allReg[ri2].temperature_2m_min[di];return(mx!=null&&mn!=null)?(mx+mn)/2:null;});
      let wt=0,ws=0; regTemps.forEach((t,ri2)=>{if(t!=null){wt+=WX_REGIONS[ri2].w*t;ws+=WX_REGIONS[ri2].w;}});
      const avgTemp=ws>0?wt/ws:null;
      let hW=0,cW=0,wSum=0;
      regTemps.forEach((t,ri2)=>{if(t==null)return;hW+=WX_REGIONS[ri2].w*Math.max(0,WX_BASE-t);cW+=WX_REGIONS[ri2].w*Math.max(0,t-WX_BASE);wSum+=WX_REGIONS[ri2].w;});
      const scale=wSum>0?1/wSum:0;
      return{avgTemp,regTemps,hdd:hW*scale,cdd:cW*scale,dem:(hW+cW)*scale};
    });
    const wkMap={};
    baseDates.forEach((dt,di)=>{
      const dy=daily[di]; if(!dy||dy.avgTemp==null) return;
      let fri=getFriday(dt); if(fri>todayISO) fri=todayISO;
      if(!wkMap[fri]) wkMap[fri]={sTemp:0,hdd:0,cdd:0,dem:0,n:0,regS:WX_REGIONS.map(()=>0),regN:WX_REGIONS.map(()=>0)};
      const wk=wkMap[fri]; wk.sTemp+=dy.avgTemp;wk.hdd+=dy.hdd;wk.cdd+=dy.cdd;wk.dem+=dy.dem;wk.n++;
      dy.regTemps.forEach((t,ri2)=>{if(t!=null){wk.regS[ri2]+=t;wk.regN[ri2]++;}});
    });
    const keys=Object.keys(wkMap).sort();
    function pad(str,w){str=String(str==null?'':str);return str.length>=w?str.slice(0,w-1)+' ':str+' '.repeat(w-str.length);}
    const regHdr=WX_REGIONS.map(rg=>pad(rg.name+'°C',12)).join('');
    const lines=['NatGas Weather — Weekly Temperature & Demand','Source: Open-Meteo Archive API','Exported: '+wxFmtExp(todayISO)+', '+today.toLocaleTimeString(),'',
      pad('Date',16)+pad('WgtAvg°C',12)+pad('HDD',8)+pad('CDD',8)+pad('Demand',10)+regHdr,'-'.repeat(16+12+8+8+10+WX_REGIONS.length*12)];
    keys.forEach(fri=>{
      const wk=wkMap[fri]; if(!wk.n) return;
      const avg=wk.sTemp/wk.n,h=wk.hdd/wk.n,cv=wk.cdd/wk.n,dem=wk.dem/wk.n;
      const regCols=WX_REGIONS.map((_,ri2)=>pad(wk.regN[ri2]>0?(wk.regS[ri2]/wk.regN[ri2]).toFixed(2):'N/A',12)).join('');
      lines.push(pad(wxFmtExp(fri),16)+pad(avg.toFixed(2),12)+pad(h.toFixed(2),8)+pad(cv.toFixed(2),8)+pad(dem.toFixed(2),10)+regCols);
    });
    lines.push('','Total weeks: '+keys.length,'Period: 01 Jan 2010 – '+wxFmtExp(todayISO));
    dlBlob('natgas_weekly_temp_demand_2010_today.txt',lines.join('\n'));
    btn.textContent='✅ Done! ('+keys.length+' weeks)';
    dbLog('Historical export: '+keys.length+' weeks','ok');
    setTimeout(()=>{btn.textContent='📥 Weekly Temp 2010–today';btn.disabled=false;},3000);
  } catch(err) {
    btn.textContent='⚠ Error'; btn.disabled=false;
    dbLog('Historical export error: '+err.message,'error');
  }
}
