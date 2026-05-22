// js/cot.js  —  CFTC Commitment of Traders
import { COT_WINDOWS } from './constants.js';
import { state } from './state.js';
import { dbLog } from './debug.js';
import { fmtGB, fmtShort, sgn } from './utils.js';
import { killChart, baseX, baseY, baseTT, zoomOpts } from './charts.js';
import { updateTopbar } from './topbar.js';
import { updateAllWidgets } from './widgets.js';

function setDot(s)       { document.getElementById('cot-dot').className='sdot '+s; }
function setBadge(t,txt) { const el=document.getElementById('cot-badge'); el.textContent=txt; el.className='cbadge '+t; }

// ── Fetch (JSON API) ──────────────────────────────────────────────────────────

async function cotFetch() {
  state.cotApiCount++;
  document.getElementById('cot-api-count').textContent=state.cotApiCount;

  // CFTC Socrata API — filter by contract market code (NYMEX Henry Hub)
  const url='https://publicreporting.cftc.gov/resource/72hh-3qpy.json'
    +'?cftc_contract_market_code=023651&$order=report_date_as_yyyy_mm_dd%20DESC&$limit=520';
  const res=await fetch(url,{headers:{'Accept':'application/json'}});
  if (!res.ok) throw new Error('CFTC Socrata HTTP '+res.status);
  const records=await res.json();
  if (!records.length) throw new Error('No COT records returned');
  dbLog('COT: '+records.length+' records, latest: '+records[0]?.report_date_as_yyyy_mm_dd?.slice(0,10),'info');
  const out=records.map(f=>({
    date:(f.report_date_as_yyyy_mm_dd||'').slice(0,10),
    mmLong:  parseInt(f.m_money_positions_long_all||0),
    mmShort: parseInt(f.m_money_positions_short_all||0),
    mmSpread:parseInt(f.m_money_positions_spread_all||0),
    prodLong: parseInt(f.prod_merc_positions_long||f.prod_merc_positions_long_all||0),
    prodShort:parseInt(f.prod_merc_positions_short||f.prod_merc_positions_short_all||0),
    swapLong: parseInt(f.swap_positions_long_all||0),
    swapShort:parseInt(f.swap__positions_short_all||f.swap_positions_short_all||0),
    openInterest:parseInt(f.open_interest_all||0)
  })).filter(r=>r.date);
  out.sort((a,b)=>a.date<b.date?-1:1);
  out.forEach(r=>{
    r.mmNet=r.mmLong-r.mmShort;
    r.prodNet=r.prodLong-r.prodShort;
    r.swapNet=r.swapLong-r.swapShort;
    r.mmRatio=r.mmShort>0?(r.mmLong/r.mmShort):null;
  });
  if (!out.length) throw new Error('COT data parsed to 0 rows');
  return out;
}

// ── CSV fallback ──────────────────────────────────────────────────────────────

async function cotFetchCSV() {
  const txtUrl='https://corsproxy.io/?url='+encodeURIComponent('https://www.cftc.gov/dea/newcot/f_disagg.txt');
  const res=await fetch(txtUrl); if(!res.ok) throw new Error('CFTC CSV HTTP '+res.status);
  const text=await res.text();
  const lines=text.split('\n');
  const header=lines[0].split(',').map(h=>h.trim().replace(/"/g,'').toLowerCase());
  const idx=k=>header.findIndex(h=>h.includes(k));
  const iDate=idx('report_date_as_yyyy_mm_dd'),iCode=idx('cftc_commodity_code');
  const iMML=idx('m_money_positions_long'),iMMS=idx('m_money_positions_short');
  const iPL=idx('prod_merc_positions_long'),iPS=idx('prod_merc_positions_short');
  const iSL=idx('swap_positions_long');
  const iSS=header.findIndex(h=>h.includes('swap__positions_short')||h.includes('swap_positions_short'));
  const iOI=idx('open_interest');
  const rows=[];
  for (let i=1;i<lines.length;i++){
    const cols=lines[i].split(','); if(!cols[iCode]) continue;
    if(cols[iCode].replace(/"/g,'').trim()!=='023651') continue;
    rows.push({date:(cols[iDate]||'').replace(/"/g,'').trim(),mmLong:parseInt(cols[iMML])||0,mmShort:parseInt(cols[iMMS])||0,prodLong:parseInt(cols[iPL])||0,prodShort:parseInt(cols[iPS])||0,swapLong:parseInt(cols[iSL])||0,swapShort:parseInt(cols[iSS])||0,openInterest:parseInt(cols[iOI])||0});
  }
  if (!rows.length) throw new Error('No NG rows found in CFTC CSV');
  rows.sort((a,b)=>a.date<b.date?-1:1);
  rows.forEach(r=>{r.mmNet=r.mmLong-r.mmShort;r.prodNet=r.prodLong-r.prodShort;r.swapNet=r.swapLong-r.swapShort;r.mmRatio=r.mmShort>0?(r.mmLong/r.mmShort):null;});
  return rows;
}

// ── Load ──────────────────────────────────────────────────────────────────────

export async function cotLoadAll() {
  setDot('loading'); setBadge('loading','Loading…');
  ['net','ls','prod','swap','chg'].forEach(k=>{
    document.getElementById('cot-spin-'+k).style.display='block';
    document.getElementById('cot-spin-'+k).innerHTML='<span class="sp"></span>Loading…';
    document.getElementById('cot-wrap-'+k).style.display='none';
  });
  dbLog('COT: fetching CFTC…','info');
  try {
    state.cotData=await cotFetch();
    dbLog('COT: OK ('+state.cotData.length+' weeks, latest: '+state.cotData[state.cotData.length-1].date+')','ok');
    setDot('ok'); setBadge('live','Live data');
    cotUpdateBias(); cotRenderAll();
  } catch(e) {
    dbLog('COT primary fetch failed: '+e.message+' — trying CSV fallback…','warn');
    try {
      state.cotData=await cotFetchCSV();
      dbLog('COT CSV fallback: OK ('+state.cotData.length+' weeks)','ok');
      setDot('ok'); setBadge('cached','CSV fallback');
      cotUpdateBias(); cotRenderAll();
    } catch(e2) {
      setDot('err'); setBadge('err','Error');
      ['net','ls','prod','swap','chg'].forEach(k=>{ document.getElementById('cot-spin-'+k).innerHTML='⚠ '+e2.message; });
      dbLog('COT CSV fallback also failed: '+e2.message,'error');
    }
  }
}

// ── Filter ────────────────────────────────────────────────────────────────────

function filterByWindow(data) {
  if (!data?.length) return [];
  if (state.cotWindow==='ytd') { const yr=String(new Date().getFullYear()); return data.filter(d=>d.date.startsWith(yr)); }
  const days=COT_WINDOWS[state.cotWindow];
  if (!days||days>=99999) return data.slice();
  const cut=new Date(); cut.setDate(cut.getDate()-days); const cutStr=cut.toISOString().slice(0,10);
  return data.filter(d=>d.date>=cutStr);
}

export function cotSetWindow(w) {
  if (state.cotWindow===w) return;
  state.cotWindow=w;
  document.querySelectorAll('[data-cot-w]').forEach(b=>b.classList.toggle('on',b.dataset.cotW===w));
  Object.keys(state.cotCharts).forEach(k=>{killChart(state.cotCharts[k]);state.cotCharts[k]=null;});
  if (state.cotData.length) cotRenderAll();
}

// ── Bias card update ──────────────────────────────────────────────────────────

export function cotUpdateBias() {
  if (!state.cotData.length) return;
  const lat=state.cotData[state.cotData.length-1], prev=state.cotData.length>1?state.cotData[state.cotData.length-2]:null;
  const netEl=document.getElementById('b-cot-net');
  netEl.textContent=(lat.mmNet>=0?'+':'')+lat.mmNet.toLocaleString(); netEl.style.color=lat.mmNet>=0?'#3fb950':'#ff7b72';
  if (prev){const chg=lat.mmNet-prev.mmNet;document.getElementById('b-cot-net-chg').innerHTML='<span style="color:'+(chg>=0?'#3fb950':'#ff7b72')+'">'+(chg>=0?'+':'')+chg.toLocaleString()+' W/W</span>';}
  document.getElementById('b-cot-net-date').textContent=fmtShort(lat.date);
  const ratioEl=document.getElementById('b-cot-ratio');
  if (lat.mmRatio!=null){
    ratioEl.textContent=lat.mmRatio.toFixed(2)+'x'; ratioEl.style.color=lat.mmRatio>=1.5?'#3fb950':lat.mmRatio<=0.7?'#ff7b72':'#e3b341';
    document.getElementById('b-cot-ratio-sub').textContent=lat.mmRatio>=1.5?'Bullish positioning':lat.mmRatio<=0.7?'Bearish positioning':'Neutral positioning';
  }
  document.getElementById('cot-mm-net').textContent=(lat.mmNet>=0?'+':'')+lat.mmNet.toLocaleString(); document.getElementById('cot-mm-net').style.color=lat.mmNet>=0?'#3fb950':'#ff7b72';
  if(prev){
    const nc=lat.mmNet-prev.mmNet;document.getElementById('cot-mm-net-chg').innerHTML='<span style="color:'+(nc>=0?'#3fb950':'#ff7b72')+'">'+(nc>=0?'+':'')+nc.toLocaleString()+' W/W</span>';
    const lc=lat.mmLong-prev.mmLong,sc=lat.mmShort-prev.mmShort;
    document.getElementById('cot-mm-long-chg').innerHTML='<span style="color:'+(lc>=0?'#3fb950':'#ff7b72')+'">'+(lc>=0?'+':'')+lc.toLocaleString()+' W/W</span>';
    document.getElementById('cot-mm-short-chg').innerHTML='<span style="color:'+(sc<=0?'#3fb950':'#ff7b72')+'">'+(sc>=0?'+':'')+sc.toLocaleString()+' W/W</span>';
    const pnc=lat.prodNet-prev.prodNet,snc=lat.swapNet-prev.swapNet;
    document.getElementById('cot-prod-net-chg').innerHTML='<span style="color:'+(pnc>=0?'#3fb950':'#ff7b72')+'">'+(pnc>=0?'+':'')+pnc.toLocaleString()+' W/W</span>';
    document.getElementById('cot-swap-net-chg').innerHTML='<span style="color:'+(snc>=0?'#3fb950':'#ff7b72')+'">'+(snc>=0?'+':'')+snc.toLocaleString()+' W/W</span>';
  }
  document.getElementById('cot-mm-net-date').textContent=fmtShort(lat.date);
  document.getElementById('cot-mm-long').textContent=lat.mmLong.toLocaleString(); document.getElementById('cot-mm-long').style.color='#3fb950';
  document.getElementById('cot-mm-short').textContent=lat.mmShort.toLocaleString(); document.getElementById('cot-mm-short').style.color='#ff7b72';
  document.getElementById('cot-prod-net').textContent=(lat.prodNet>=0?'+':'')+lat.prodNet.toLocaleString(); document.getElementById('cot-prod-net').style.color=lat.prodNet>=0?'#3fb950':'#ff7b72';
  document.getElementById('cot-swap-net').textContent=(lat.swapNet>=0?'+':'')+lat.swapNet.toLocaleString(); document.getElementById('cot-swap-net').style.color=lat.swapNet>=0?'#3fb950':'#ff7b72';
  if(lat.mmRatio!=null){document.getElementById('cot-mm-ratio').textContent=lat.mmRatio.toFixed(2)+'x';document.getElementById('cot-mm-ratio').style.color=lat.mmRatio>=1.5?'#3fb950':lat.mmRatio<=0.7?'#ff7b72':'#e3b341';document.getElementById('cot-mm-ratio-sub').textContent='Long / Short ratio';}

  try { updateTopbar(); }       catch(e) { dbLog('topbar update failed: '+e.message, 'warn'); }
  try { updateAllWidgets(); }   catch(e) { dbLog('widgets update failed: '+e.message, 'warn'); }
  document.dispatchEvent(new CustomEvent('cot:loaded'));
}

// ── Render all charts ─────────────────────────────────────────────────────────

export function cotRenderAll() {
  const filtered=filterByWindow(state.cotData); if(!filtered.length) return;
  const labels=filtered.map(d=>fmtGB(d.date));
  function show(spinId,wrapId){document.getElementById(spinId).style.display='none';document.getElementById(wrapId).style.display='block';}

  // 1. Net position bar
  killChart(state.cotCharts.net); state.cotCharts.net=null; show('cot-spin-net','cot-wrap-net');
  const netData=filtered.map(d=>d.mmNet);
  const netColors=netData.map(v=>v>=0?'rgba(63,185,80,0.75)':'rgba(255,123,114,0.75)');
  const netTT=Object.assign({},baseTT(),{callbacks:{title:items=>items[0]?labels[items[0].dataIndex]:'',label:c=>' MM Net: '+(c.parsed.y>=0?'+':'')+Math.round(c.parsed.y).toLocaleString()+' contracts'}});
  state.cotCharts.net=new Chart(document.getElementById('cot-c-net').getContext('2d'),{
    type:'bar',
    data:{labels,datasets:[{label:'MM Net',data:netData,backgroundColor:netColors,borderWidth:0,borderRadius:1,order:2},{label:'Zero',data:filtered.map(()=>0),type:'line',borderColor:'rgba(255,255,255,0.15)',borderWidth:1,pointRadius:0,fill:false,order:1}]},
    options:{responsive:true,maintainAspectRatio:false,animation:{duration:300},interaction:{mode:'index',intersect:false},plugins:{legend:{display:false},tooltip:netTT,zoom:zoomOpts()},scales:{x:baseX(),y:baseY(v=>(v>=0?'+':'')+Math.round(v/1000)+'k')}}
  });

  // 2. MM Long/Short
  killChart(state.cotCharts.ls); state.cotCharts.ls=null; show('cot-spin-ls','cot-wrap-ls');
  const lsTT=Object.assign({},baseTT(),{callbacks:{title:items=>items[0]?labels[items[0].dataIndex]:'',label:c=>' '+c.dataset.label+': '+Math.round(c.parsed.y).toLocaleString()+' contracts'}});
  state.cotCharts.ls=new Chart(document.getElementById('cot-c-ls').getContext('2d'),{
    type:'bar',
    data:{labels,datasets:[{label:'MM Long',data:filtered.map(d=>d.mmLong),backgroundColor:'rgba(63,185,80,0.7)',borderWidth:0,borderRadius:1},{label:'MM Short',data:filtered.map(d=>-d.mmShort),backgroundColor:'rgba(255,123,114,0.7)',borderWidth:0,borderRadius:1}]},
    options:{responsive:true,maintainAspectRatio:false,animation:{duration:300},interaction:{mode:'index',intersect:false},plugins:{legend:{display:false},tooltip:lsTT,zoom:zoomOpts()},scales:{x:baseX(),y:baseY(v=>Math.round(Math.abs(v)/1000)+'k')}}
  });

  // 3. Producer
  killChart(state.cotCharts.prod); state.cotCharts.prod=null; show('cot-spin-prod','cot-wrap-prod');
  const prodTT=Object.assign({},baseTT(),{callbacks:{title:items=>items[0]?labels[items[0].dataIndex]:'',label:c=>' '+c.dataset.label+': '+Math.round(c.parsed.y).toLocaleString()+' contracts'}});
  state.cotCharts.prod=new Chart(document.getElementById('cot-c-prod').getContext('2d'),{
    type:'line',
    data:{labels,datasets:[{label:'Prod Long',data:filtered.map(d=>d.prodLong),borderColor:'#4493f8',borderWidth:2,pointRadius:0,tension:0.3,fill:false},{label:'Prod Short',data:filtered.map(d=>d.prodShort),borderColor:'#e3b341',borderWidth:2,pointRadius:0,tension:0.3,fill:false}]},
    options:{responsive:true,maintainAspectRatio:false,animation:{duration:300},interaction:{mode:'index',intersect:false},plugins:{legend:{display:false},tooltip:prodTT,zoom:zoomOpts()},scales:{x:baseX(),y:baseY(v=>Math.round(v/1000)+'k')}}
  });

  // 4. Swap dealer
  killChart(state.cotCharts.swap); state.cotCharts.swap=null; show('cot-spin-swap','cot-wrap-swap');
  const swapTT=Object.assign({},baseTT(),{callbacks:{title:items=>items[0]?labels[items[0].dataIndex]:'',label:c=>' '+c.dataset.label+': '+Math.round(c.parsed.y).toLocaleString()+' contracts'}});
  state.cotCharts.swap=new Chart(document.getElementById('cot-c-swap').getContext('2d'),{
    type:'line',
    data:{labels,datasets:[{label:'Swap Long',data:filtered.map(d=>d.swapLong),borderColor:'#a371f7',borderWidth:2,pointRadius:0,tension:0.3,fill:false},{label:'Swap Short',data:filtered.map(d=>d.swapShort),borderColor:'#f0883e',borderWidth:2,pointRadius:0,tension:0.3,fill:false}]},
    options:{responsive:true,maintainAspectRatio:false,animation:{duration:300},interaction:{mode:'index',intersect:false},plugins:{legend:{display:false},tooltip:swapTT,zoom:zoomOpts()},scales:{x:baseX(),y:baseY(v=>Math.round(v/1000)+'k')}}
  });

  // 5. W/W change
  killChart(state.cotCharts.chg); state.cotCharts.chg=null; show('cot-spin-chg','cot-wrap-chg');
  const chgData=filtered.map((d,i)=>i===0?0:d.mmNet-filtered[i-1].mmNet);
  const chgColors=chgData.map(v=>v>=0?'rgba(63,185,80,0.75)':'rgba(255,123,114,0.75)');
  const chgTT=Object.assign({},baseTT(),{callbacks:{title:items=>items[0]?labels[items[0].dataIndex]:'',label:c=>' W/W change: '+(c.parsed.y>=0?'+':'')+Math.round(c.parsed.y).toLocaleString()+' contracts'}});
  state.cotCharts.chg=new Chart(document.getElementById('cot-c-chg').getContext('2d'),{
    type:'bar',
    data:{labels,datasets:[{label:'W/W Change',data:chgData,backgroundColor:chgColors,borderWidth:0,borderRadius:1}]},
    options:{responsive:true,maintainAspectRatio:false,animation:{duration:300},interaction:{mode:'index',intersect:false},plugins:{legend:{display:false},tooltip:chgTT,zoom:zoomOpts()},scales:{x:baseX(),y:baseY(v=>(v>=0?'+':'')+Math.round(v/1000)+'k')}}
  });

  const lbl={'max':'full','5y':'5-year','2y':'2-year','1y':'1-year','ytd':'YTD','6m':'6-month','3m':'3-month'};
  document.getElementById('cot-net-sub').textContent='Weekly · contracts · CFTC Disaggregated · '+(lbl[state.cotWindow]||state.cotWindow)+' history';
}

// ── COT help popup ────────────────────────────────────────────────────────────

const COT_HELP = {
  net:{title:'📊 Managed Money — Net Position (Long − Short)',body:['<p><strong>Co je Net Position?</strong><br>Net pozice = počet long kontraktů minus short kontraktů, které drží kategorie <strong>Managed Money</strong> (hedgeové fondy, CTA, CPO). Ukazuje čistý spekulativní sentiment trhu.</p>','<p><strong>Jak číst graf:</strong></p>','<p>🟢 <strong>Zelené sloupce (kladné)</strong> — fondy drží více longů než shortů → <em>bullish positioning</em><br>🔴 <strong>Červené sloupce (záporné)</strong> — fondy drží více shortů než longů → <em>bearish positioning</em></p>','<p><strong>Signály pro trading:</strong></p>','<span class="tag bull">Extrémní net long = contrarian bearish</span><span class="tag bear">Extrémní net short = contrarian bullish</span><span class="tag neu">Rychlý obrat net = momentum signal</span>','<p style="margin-top:10px"><strong>Proč je to důležité?</strong><br>Managed Money je dominantní spekulativní síla v NG futures. Extrémní pozice (historická maxima/minima) bývají předzvěstí cenových obratů — trh je "přeplněn" na jedné straně a i malý katalyzátor spustí short-covering nebo long-liquidation.</p>','<p><strong>Zdroj:</strong> CFTC Disaggregated COT Report — Futures Only (dataset 72hh-3qpy), publikován každý pátek za předchozí úterý.</p>']},
  ls:{title:'📊 Managed Money — Long vs Short (stacked)',body:['<p><strong>Co zobrazuje tento graf?</strong><br>Absolutní počty <strong>long</strong> a <strong>short</strong> kontraktů kategorie Managed Money zobrazené zrcadlově — longy nad nulou (zelené), shorty pod nulou (červené).</p>','<p><strong>Rozdíl oproti Net Position:</strong><br>Net Position skryje detail — např. net = 0 může znamenat malé longy a malé shorty (nízká angažovanost) nebo obrovské longy i shorty současně (hedgování). Tento graf ukáže obě složky zvlášť.</p>','<span class="tag bull">Longy na historickém maximu = overextended long = riziko sell-off</span>','<span class="tag bear">Shorty na historickém maximu = short squeeze potential</span>']},
  prod:{title:'🏭 Producer / Merchant / Processor / User — Long vs Short',body:['<p><strong>Kdo jsou Producenti?</strong><br>Tato kategorie zahrnuje firmy, které <strong>fyzicky obchodují</strong> se zemním plynem — producenti (E&P firmy), utility, pipeline operátoři, LNG exportéři. Používají futures primárně k <strong>hedgování</strong> fyzických pozic, ne ke spekulaci.</p>','<span class="tag bear">Rekordní short producentů = masivní hedging = bearish pro cenu</span>','<span class="tag bull">Pokles shortu producentů = redukce hedgingu = bullish signal</span>']},
  swap:{title:'🔄 Swap Dealer — Long vs Short',body:['<p><strong>Kdo jsou Swap Dealers?</strong><br>Banky a finanční instituce, které uzavírají <strong>OTC swapové kontrakty</strong> se svými klienty a hedgují tato OTC rizika v burzovních futures.</p>','<span class="tag neu">Swap Dealers jsou typicky protistrana Managed Money</span>','<span class="tag bull">Dealer net short + MM net short = extrémní bearish crowding = contrarian bullish</span>']},
  chg:{title:'📈 Managed Money — Týdenní změna Net Position (W/W Change)',body:['<p><strong>Co zobrazuje tento graf?</strong><br>Týdenní změna čisté pozice Managed Money — o kolik kontraktů se net position zvýšila nebo snížila oproti předchozímu týdnu.</p>','<span class="tag bull">Velký zelený spike po dlouhém poklesu = bottom formation, short-covering rally</span>','<span class="tag bear">Velký červený spike po růstu = top formation, long liquidation</span>']}
};

export function cotShowHelp(key) {
  const data=COT_HELP[key]; if(!data) return;
  document.getElementById('cot-popup-title').textContent=data.title;
  document.getElementById('cot-popup-body').innerHTML=data.body.join('');
  document.getElementById('cot-popup-overlay').classList.add('on');
}
export function cotHideHelp() {
  document.getElementById('cot-popup-overlay').classList.remove('on');
}

// ── Export ────────────────────────────────────────────────────────────────────

function pad(s,w){s=String(s==null?'':s);return s.length>=w?s.slice(0,w-1)+' ':s+' '.repeat(w-s.length);}
function _dlBlob(name,txt){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([txt],{type:'text/plain;charset=utf-8'}));a.download=name;document.body.appendChild(a);a.click();document.body.removeChild(a);URL.revokeObjectURL(a.href);}

export function cotExportNet() {
  if (!state.cotData.length){alert('No COT data.');return;}
  const lines=['COT Natural Gas — Managed Money Net Position','Source: CFTC','Exported: '+new Date().toLocaleString('en-GB'),'',
    pad('Date',14)+pad('MM Long',12)+pad('MM Short',12)+pad('MM Net',12)+pad('MM Ratio',10)+pad('Prod Net',12)+pad('Swap Net',12),'-'.repeat(80)];
  state.cotData.forEach(r=>{
    lines.push(pad(r.date,14)+pad(r.mmLong.toLocaleString(),12)+pad(r.mmShort.toLocaleString(),12)+pad((r.mmNet>=0?'+':'')+r.mmNet.toLocaleString(),12)+pad(r.mmRatio!=null?r.mmRatio.toFixed(2):'N/A',10)+pad((r.prodNet>=0?'+':'')+r.prodNet.toLocaleString(),12)+pad((r.swapNet>=0?'+':'')+r.swapNet.toLocaleString(),12));
  });
  _dlBlob('natgas_cot_net.txt',lines.join('\n'));
}

export function cotExportLS() {
  if (!state.cotData.length){alert('No COT data.');return;}
  const lines=['COT Natural Gas — Managed Money Long vs Short','Source: CFTC','Exported: '+new Date().toLocaleString('en-GB'),'',
    pad('Date',14)+pad('MM Long',12)+pad('MM Short',12)+pad('MM Net',12)+pad('L/S Ratio',12),'-'.repeat(62)];
  state.cotData.forEach(r=>{
    lines.push(pad(r.date,14)+pad(r.mmLong.toLocaleString(),12)+pad(r.mmShort.toLocaleString(),12)+pad((r.mmNet>=0?'+':'')+r.mmNet.toLocaleString(),12)+pad(r.mmRatio!=null?r.mmRatio.toFixed(2)+'x':'N/A',12));
  });
  _dlBlob('natgas_cot_ls.txt',lines.join('\n'));
}

export function cotExportProd() {
  if (!state.cotData.length){alert('No COT data.');return;}
  const lines=['COT Natural Gas — Producer/Merchant Long vs Short','Source: CFTC','Exported: '+new Date().toLocaleString('en-GB'),'',
    pad('Date',14)+pad('Prod Long',12)+pad('Prod Short',12)+pad('Prod Net',12),'-'.repeat(52)];
  state.cotData.forEach(r=>{
    lines.push(pad(r.date,14)+pad(r.prodLong.toLocaleString(),12)+pad(r.prodShort.toLocaleString(),12)+pad((r.prodNet>=0?'+':'')+r.prodNet.toLocaleString(),12));
  });
  _dlBlob('natgas_cot_prod.txt',lines.join('\n'));
}

export function cotExportSwap() {
  if (!state.cotData.length){alert('No COT data.');return;}
  const lines=['COT Natural Gas — Swap Dealer Long vs Short','Source: CFTC','Exported: '+new Date().toLocaleString('en-GB'),'',
    pad('Date',14)+pad('Swap Long',12)+pad('Swap Short',12)+pad('Swap Net',12),'-'.repeat(52)];
  state.cotData.forEach(r=>{
    lines.push(pad(r.date,14)+pad(r.swapLong.toLocaleString(),12)+pad(r.swapShort.toLocaleString(),12)+pad((r.swapNet>=0?'+':'')+r.swapNet.toLocaleString(),12));
  });
  _dlBlob('natgas_cot_swap.txt',lines.join('\n'));
}

export function cotExportChg() {
  if (!state.cotData.length){alert('No COT data.');return;}
  const lines=['COT Natural Gas — Managed Money Weekly Change in Net Position','Source: CFTC','Exported: '+new Date().toLocaleString('en-GB'),'',
    pad('Date',14)+pad('MM Net',12)+pad('W/W Change',12),'-'.repeat(40)];
  state.cotData.forEach((r,i)=>{
    const chg=i===0?0:r.mmNet-state.cotData[i-1].mmNet;
    lines.push(pad(r.date,14)+pad((r.mmNet>=0?'+':'')+r.mmNet.toLocaleString(),12)+pad((chg>=0?'+':'')+chg.toLocaleString(),12));
  });
  _dlBlob('natgas_cot_chg.txt',lines.join('\n'));
}
