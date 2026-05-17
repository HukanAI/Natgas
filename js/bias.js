// js/bias.js  —  top "Natural Gas Bias" card
import { state } from './state.js';
import { isoAdd, fmtShort, sgn, fmtChg, esc, fairPrice } from './utils.js';
import { getSeasonInfo } from './season.js';
import { st5y } from './storage5y.js';
import { ngfCurrent, ngfNext, ngfFetchTwoDays } from './contracts.js';
import { dbLog } from './debug.js';
import { stRenderStorChart, stRenderDevChart, stRenderInjChart } from './storage.js';
import { updateTopbar } from './topbar.js';

// ── Date helper: d.m. format (no year) ───────────────────────────────────────
function fmtDM(iso) {
  if (!iso) return '—';
  const d = new Date(iso + 'T12:00:00Z');
  return d.getUTCDate() + '.' + (d.getUTCMonth() + 1) + '.';
}

// ── Fair price chart ──────────────────────────────────────────────────────────

let _fpChart = null;

function renderFairPriceChart() {
  const canvas = document.getElementById('fp-chart-canvas');
  if (!canvas || typeof Chart === 'undefined') return;

  const sd = state.stStorageData;
  if (!sd || !sd.length) return;

  const labels = ['Now', '+7D', '+14D', '+21D'];
  const si = getSeasonInfo();
  const isH = si.isHeating;

  function fpData(devBcf) {
    const fp = fairPrice(devBcf);
    return { fp, mn: fp - 0.5, mx: isH ? fp + 1.9 : fp + 0.5 };
  }

  const lat = sd[sd.length - 1];
  const band0 = st5y(sd, [lat.date])[0];
  const d0 = band0?.avg != null ? fpData(lat.value - band0.avg) : null;

  function fHorizon(fcst) {
    if (!fcst?.predictedLevel || !fcst.endDate) return null;
    const b = st5y(sd, [fcst.endDate])[0];
    return b?.avg != null ? fpData(fcst.predictedLevel - b.avg) : null;
  }

  const d7  = fHorizon(state.stLastF7);
  const d14 = fHorizon(state.stLastF14);
  const d21 = fHorizon(state.stLastF21);

  const points = [d0, d7, d14, d21];
  if (points.every(p => p === null)) return;

  const fair = points.map(p => p?.fp ?? null);
  const mins = points.map(p => p?.mn ?? null);
  const maxs = points.map(p => p?.mx ?? null);

  const front = state.stNgfData.length ? state.stNgfData[state.stNgfData.length - 1].close : null;
  const next  = state.nextContractPrice;

  const allVals = [...fair, ...mins, ...maxs, front, next].filter(v => v != null);
  const yMin = Math.floor((Math.min(...allVals) - 0.15) * 20) / 20;
  const yMax = Math.ceil((Math.max(...allVals) + 0.15) * 20) / 20;

  const textCol = getComputedStyle(document.documentElement).getPropertyValue('--text3').trim() || '#6e7681';
  const gridCol = getComputedStyle(document.documentElement).getPropertyValue('--border').trim() || '#1f242c';

  const datasets = [
    { label: 'Max range', data: maxs, fill: '+1', backgroundColor: 'rgba(68,147,248,0.12)', borderColor: 'transparent', pointRadius: 0, order: 4, tension: 0.3 },
    { label: 'Min range', data: mins, fill: false, borderColor: 'transparent', backgroundColor: 'transparent', pointRadius: 0, order: 5, tension: 0.3 },
    { label: 'Fair price', data: fair, borderColor: '#4493f8', backgroundColor: 'transparent', borderWidth: 2.5, pointRadius: 5, pointBackgroundColor: '#4493f8', pointBorderColor: '#11151c', pointBorderWidth: 2, order: 1, tension: 0.3 },
  ];
  if (front != null) datasets.push({ label: 'Front month', data: labels.map(() => front), borderColor: '#ff7b72', backgroundColor: 'transparent', borderWidth: 1.5, borderDash: [5, 4], pointRadius: 0, order: 2, tension: 0 });
  if (next  != null) datasets.push({ label: 'Next contract', data: labels.map(() => next), borderColor: '#3fb950', backgroundColor: 'transparent', borderWidth: 1.5, borderDash: [2, 3], pointRadius: 0, order: 3, tension: 0 });

  if (_fpChart) { _fpChart.destroy(); _fpChart = null; }

  _fpChart = new Chart(canvas, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
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
          callbacks: {
            label: ctx => {
              if (ctx.dataset.label === 'Min range' || ctx.dataset.label === 'Max range') return null;
              const v = ctx.parsed.y;
              return v != null ? ctx.dataset.label + ': $' + v.toFixed(3) : null;
            }
          }
        }
      },
      scales: {
        x: { grid: { color: gridCol }, ticks: { color: textCol, font: { size: 11 } } },
        y: {
          min: yMin, max: yMax,
          grid: { color: gridCol },
          ticks: { color: textCol, font: { size: 11, family: 'var(--mono, monospace)' }, callback: v => '$' + v.toFixed(2) }
        }
      }
    }
  });
}

// ── Storage forecast chart ────────────────────────────────────────────────────

let _stChart = null;

function renderStorageChart() {
  const canvas = document.getElementById('st-chart-canvas');
  if (!canvas || typeof Chart === 'undefined') return;
  const sd = state.stStorageData;
  if (!sd || sd.length < 2) return;
  const lat = sd[sd.length - 1];
  function getBand(date) { return st5y(sd, [date])[0]; }
  const pts = [
    { date: lat.date, val: lat.value },
    state.stLastF7  ? { date: state.stLastF7.endDate,  val: state.stLastF7.predictedLevel  } : null,
    state.stLastF14 ? { date: state.stLastF14.endDate, val: state.stLastF14.predictedLevel } : null,
    state.stLastF21 ? { date: state.stLastF21.endDate, val: state.stLastF21.predictedLevel } : null,
  ];
  const labels = ['Now', '+7D', '+14D', '+21D'];
  const vals = pts.map(p => p?.val ?? null);
  const avg5 = pts.map(p => p ? (getBand(p.date)?.avg ?? null) : null);
  const textCol = getComputedStyle(document.documentElement).getPropertyValue('--text3').trim() || '#6e7681';
  const gridCol = getComputedStyle(document.documentElement).getPropertyValue('--border').trim() || '#1f242c';
  if (_stChart) { _stChart.destroy(); _stChart = null; }
  _stChart = new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets: [{
      label: 'vs 5y avg',
      data: pts.map((p, i) => {
        const v = p?.val ?? null;
        const a = avg5[i];
        return (v != null && a != null) ? Math.round(v - a) : null;
      }),
      backgroundColor: pts.map((p, i) => {
        const v = p?.val ?? null;
        const a = avg5[i];
        if (v == null || a == null) return 'rgba(110,118,129,0.4)';
        return (v - a) >= 0 ? 'rgba(255,123,114,0.7)' : 'rgba(63,185,80,0.7)';
      }),
      borderColor: pts.map((p, i) => {
        const v = p?.val ?? null;
        const a = avg5[i];
        if (v == null || a == null) return '#6e7681';
        return (v - a) >= 0 ? '#ff7b72' : '#3fb950';
      }),
      borderWidth: 1.5,
      borderRadius: 4,
    }]},
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1c2128', borderColor: 'rgba(255,255,255,0.08)', borderWidth: 1,
          titleColor: '#e6edf3', bodyColor: '#9ba3ad', padding: 10,
          callbacks: {
            label: ctx => {
              const v = ctx.parsed.y;
              return v != null ? (v >= 0 ? '+' : '') + v.toLocaleString() + ' Bcf vs 5y avg' : null;
            }
          }
        }
      },
      scales: {
        x: { grid: { color: gridCol }, ticks: { color: textCol, font: { size: 11 } } },
        y: {
          grid: { color: gridCol },
          ticks: { color: textCol, font: { size: 11, family: 'var(--mono, monospace)' },
            callback: v => (v >= 0 ? '+' : '') + Math.round(v).toLocaleString()
          }
        }
      }
    }
  });
}

function renderFairBox(vid, rid, vfid, vnid, devBcf, isH) {
  const fp = fairPrice(devBcf), mn = fp - 0.5, mx = isH ? fp + 1.9 : fp + 0.5;

  const elV = document.getElementById(vid);
  if (elV) { elV.textContent = '$' + fp.toFixed(3); elV.style.color = '#e6edf3'; }

  const elR = document.getElementById(rid);
  if (elR) elR.innerHTML = 'Min $' + mn.toFixed(3) + '<br>Max $' + mx.toFixed(3);

  // vs Front Month
  const front = state.stNgfData.length ? state.stNgfData[state.stNgfData.length - 1].close : null;
  const elF = document.getElementById(vfid);
  if (elF) {
    if (front != null) {
      const d = fp - front;
      const col = d >= 0 ? '#3fb950' : '#ff7b72';
      elF.innerHTML = 'vs front <span style="color:' + col + '">' + (d >= 0 ? '+' : '') + d.toFixed(3) + '</span>';
    } else {
      elF.textContent = 'vs front —';
    }
  }

  // vs Next Contract
  const next = state.nextContractPrice;
  const elN = document.getElementById(vnid);
  if (elN) {
    if (next != null) {
      const d = fp - next;
      const col = d >= 0 ? '#3fb950' : '#ff7b72';
      elN.innerHTML = 'vs next <span style="color:' + col + '">' + (d >= 0 ? '+' : '') + d.toFixed(3) + '</span>';
    } else {
      elN.textContent = 'vs next —';
    }
  }
}

// ── Main render ───────────────────────────────────────────────────────────────

export function renderBiasCard() {
  const si=getSeasonInfo();
  const elS=document.getElementById('b-season'); elS.textContent=si.icon+' '+si.name; elS.style.color=si.col;
  document.getElementById('b-season-sub').innerHTML='Day '+si.daysIn+'/'+si.sTotal+' · '+si.daysLeft+'d left<br><span style="color:#6e7681">Next: '+si.nxtIcon+' '+esc(si.nxtName)+'</span>';

  if (!state.stStorageData.length) { renderBiasNGF(); return; }

  const lat=state.stStorageData[state.stStorageData.length-1];
  const prev=state.stStorageData.length>1?state.stStorageData[state.stStorageData.length-2]:null;
  const band=st5y(state.stStorageData,[lat.date])[0], avg5=band.avg;
  const devBcf=avg5!=null?lat.value-avg5:null;
  const devPct=(avg5&&avg5!==0&&devBcf!=null)?devBcf/avg5*100:null;

  const bVal=document.getElementById('b-stor-val'); bVal.textContent=Math.round(lat.value).toLocaleString()+' Bcf'; bVal.style.color='#e6edf3';
  if (prev) { const wk=lat.value-prev.value; document.getElementById('b-stor-wkchg').innerHTML='<span style="color:'+(wk>=0?'#ff7b72':'#3fb950')+'">'+sgn(wk)+Math.round(wk)+' Bcf vs last week</span>'; }
  document.getElementById('b-stor-dev').innerHTML=devBcf!=null
    ?'<span style="color:'+(devBcf>=0?'#ff7b72':'#3fb950')+'">'+sgn(devBcf)+Math.round(devBcf).toLocaleString()+' Bcf vs 5y</span>'
    :'5y avg N/A';
  document.getElementById('b-stor-date').innerHTML='Report: '+fmtDM(isoAdd(lat.date,6));
  if (devBcf!=null) renderFairBox('b-fp0','b-fp0-range','b-fp0-vs-front','b-fp0-vs-next',devBcf,si.isHeating);

  if (!state.wxS) { renderBiasNGF(); return; }

  // Forward storage forecasts
  const f7=calcForecast(lat.date,1,7), f14=calcForecast(lat.date,8,14), f21=calcForecast(lat.date,15,21);
  const lv7=f7?lat.value+f7.dBcf:null;
  const lv14=f14?(lv7!=null?lv7:lat.value)+f14.dBcf:null;
  const lv21=f21?(lv14!=null?lv14:lv7!=null?lv7:lat.value)+f21.dBcf:null;

  state.stLastF7  =f7  ?{D:f7.D,  dBcf:f7.dBcf,  startDate:f7.startDate,  endDate:f7.endDate,  predictedLevel:lv7}  :null;
  state.stLastF14 =f14 ?{D:f14.D, dBcf:f14.dBcf, startDate:f14.startDate, endDate:f14.endDate, predictedLevel:lv14} :null;
  state.stLastF21 =f21 ?{D:f21.D, dBcf:f21.dBcf, startDate:f21.startDate, endDate:f21.endDate, predictedLevel:lv21} :null;

  if (state.stStorageData.length) { stRenderStorChart(); stRenderDevChart(); stRenderInjChart(); }

  function fillF(vid,cid,vsid,dateid,fcst,base,vsLbl){
    if (!fcst||fcst.predictedLevel==null) { [vid,cid,vsid,dateid].forEach(id=>document.getElementById(id).textContent='N/A'); return; }
    const lv=fcst.predictedLevel, chg=lv-base, cc=chg>=0?'#ff7b72':'#3fb950';
    const elV=document.getElementById(vid); elV.textContent=Math.round(lv).toLocaleString()+' Bcf'; elV.style.color='#e6edf3';
    document.getElementById(cid).innerHTML='<span style="color:'+cc+'">'+sgn(chg)+Math.round(chg)+' Bcf '+esc(vsLbl)+' ('+fcst.D.toFixed(1)+'D)</span>';
    const b5r=st5y(state.stStorageData,[fcst.endDate])[0].avg;
    if (b5r!=null) { const dv=lv-b5r; document.getElementById(vsid).innerHTML='<span style="color:'+(dv>=0?'#ff7b72':'#3fb950')+'">'+sgn(dv)+Math.round(dv)+' Bcf vs 5y</span>'; }
    else document.getElementById(vsid).textContent='5y N/A';
    document.getElementById(dateid).innerHTML=fmtDM(fcst.startDate)+' – '+fmtDM(fcst.endDate)+'<br>Report: '+fmtDM(isoAdd(fcst.endDate,6));
  }
  fillF('b-f7-val','b-f7-chg','b-f7-vs5y','b-f7-date',state.stLastF7,lat.value,'vs now');
  fillF('b-f14-val','b-f14-chg','b-f14-vs5y','b-f14-date',state.stLastF14,lv7!=null?lv7:lat.value,lv7!=null?'vs 7d fcst':'vs now');
  fillF('b-f21-val','b-f21-chg','b-f21-vs5y','b-f21-date',state.stLastF21,lv14!=null?lv14:lv7!=null?lv7:lat.value,lv14!=null?'vs 14d fcst':lv7!=null?'vs 7d fcst':'vs now');

  const isH=si.isHeating;
  if (state.stLastF7?.predictedLevel!=null)  { const b=st5y(state.stStorageData,[state.stLastF7.endDate])[0].avg;  if(b!=null) renderFairBox('b-fp7', 'b-fp7-range', 'b-fp7-vs-front', 'b-fp7-vs-next', state.stLastF7.predictedLevel-b,isH); }
  if (state.stLastF14?.predictedLevel!=null) { const b=st5y(state.stStorageData,[state.stLastF14.endDate])[0].avg; if(b!=null) renderFairBox('b-fp14','b-fp14-range','b-fp14-vs-front','b-fp14-vs-next',state.stLastF14.predictedLevel-b,isH); }
  if (state.stLastF21?.predictedLevel!=null) { const b=st5y(state.stStorageData,[state.stLastF21.endDate])[0].avg; if(b!=null) renderFairBox('b-fp21','b-fp21-range','b-fp21-vs-front','b-fp21-vs-next',state.stLastF21.predictedLevel-b,isH); }

  renderBiasNGF();
  renderFairPriceChart();
  renderStorageChart();
  try { updateTopbar(); } catch(e) { dbLog('topbar update failed: '+e.message, 'warn'); }
}

// ── NGF part of bias card ─────────────────────────────────────────────────────

function renderBiasNGF() {
  if (!state.stNgfData.length) return;
  const lngf=state.stNgfData[state.stNgfData.length-1];
  const lngfPrev=state.stNgfData.length>1?state.stNgfData[state.stNgfData.length-2]:null;
  const curC=ngfCurrent(), nxtC=curC?ngfNext(curC):null;

  const elCur=document.getElementById('b-ngf-cur'); elCur.textContent='$'+lngf.close.toFixed(3); elCur.style.color='#e6edf3';
  document.getElementById('b-ngf-cur-lbl').textContent=curC?curC.label:'—';
  if (lngfPrev) { const cChg=lngf.close-lngfPrev.close,cPct=lngfPrev.close!==0?cChg/lngfPrev.close*100:0; const cf=fmtChg(cChg,cPct); document.getElementById('b-ngf-cur-chg').innerHTML='<span style="color:'+cf.color+'">'+esc(cf.text)+'</span>'; }
  else document.getElementById('b-ngf-cur-chg').textContent='—';

  document.getElementById('b-ngf-nxt').textContent='…'; document.getElementById('b-ngf-nxt').style.color='#6e7681';
  document.getElementById('b-ngf-nxt-lbl').textContent=nxtC?nxtC.label:'—';
  document.getElementById('b-ngf-nxt-chg').textContent='—'; document.getElementById('b-ngf-nxt-spread').textContent='—';

  if (nxtC) {
    ngfFetchTwoDays(nxtC.ticker,false).then(pd=>{
      state.nextContractPrice=pd.last;
      const elNxt=document.getElementById('b-ngf-nxt'); elNxt.textContent='$'+pd.last.toFixed(3); elNxt.style.color='#e6edf3';
      if (pd.prev!=null) { const nChg=pd.last-pd.prev,nPct=pd.prev!==0?nChg/pd.prev*100:0; const nf=fmtChg(nChg,nPct); document.getElementById('b-ngf-nxt-chg').innerHTML='<span style="color:'+nf.color+'">'+esc(nf.text)+'</span>'; }
      const spread=pd.last-lngf.close, sCol=spread>=0?'#ff7b72':'#3fb950';
      document.getElementById('b-ngf-nxt-spread').innerHTML='<span style="color:'+sCol+'">'+(spread>=0?'+':'')+spread.toFixed(3)+' vs front · '+(spread>=0?'Contango':'Backwardation')+'</span>';
      // Re-render fair price boxes now that nextContractPrice is known
      const si2=getSeasonInfo(), isH2=si2.isHeating;
      const sd=state.stStorageData;
      if (sd.length) {
        const lat2=sd[sd.length-1], band2=st5y(sd,[lat2.date])[0];
        if (band2?.avg!=null) renderFairBox('b-fp0','b-fp0-range','b-fp0-vs-front','b-fp0-vs-next',lat2.value-band2.avg,isH2);
      }
      if (state.stLastF7?.predictedLevel!=null)  { const b=st5y(sd,[state.stLastF7.endDate])[0].avg;  if(b!=null) renderFairBox('b-fp7', 'b-fp7-range', 'b-fp7-vs-front', 'b-fp7-vs-next', state.stLastF7.predictedLevel-b,isH2); }
      if (state.stLastF14?.predictedLevel!=null) { const b=st5y(sd,[state.stLastF14.endDate])[0].avg; if(b!=null) renderFairBox('b-fp14','b-fp14-range','b-fp14-vs-front','b-fp14-vs-next',state.stLastF14.predictedLevel-b,isH2); }
      if (state.stLastF21?.predictedLevel!=null) { const b=st5y(sd,[state.stLastF21.endDate])[0].avg; if(b!=null) renderFairBox('b-fp21','b-fp21-range','b-fp21-vs-front','b-fp21-vs-next',state.stLastF21.predictedLevel-b,isH2); }
      try { updateTopbar(); } catch(e) { dbLog('topbar update failed: '+e.message, 'warn'); }
      renderFairPriceChart();
      renderStorageChart();
      document.dispatchEvent(new CustomEvent('nextcontract:loaded'));
    }).catch(e=>{ state.nextContractPrice=null; document.getElementById('b-ngf-nxt').textContent='N/A'; dbLog('Next contract: '+e.message,'warn'); });
  }
}

// ── Forecast calculator ───────────────────────────────────────────────────────

function calcForecast(lastDate, startOff, endOff) {
  if (!state.wxS) return null;
  const s=isoAdd(lastDate,startOff), e=isoAdd(lastDate,endOff);
  let D=0, cnt=0;
  for (let i=0;i<state.wxS.allDates.length;i++) {
    const dt=state.wxS.allDates[i];
    if (dt>=s&&dt<=e&&state.wxS.demAll[i]!=null&&!isNaN(state.wxS.demAll[i])) { D+=state.wxS.demAll[i]; cnt++; }
  }
  if (!cnt) return null;
  const FA=0.0001607983,FB=-0.0460227485,FC=0.909433429,FD=95.0676254411;
  return {D, dBcf:FA*D*D*D+FB*D*D+FC*D+FD, startDate:s, endDate:e};
}
