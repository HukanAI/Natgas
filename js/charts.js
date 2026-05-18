// js/charts.js
// Chart.js helper factories, plugins, shared options

export function zoomOpts(onSync) {
  if (!onSync) return {
    zoom: {wheel:{enabled:true}, pinch:{enabled:true}, mode:'xy'},
    pan:  {enabled:true, mode:'xy', modifierKey:null, scaleMode:'xy'}
  };
  return {
    zoom: {
      wheel:{enabled:true}, pinch:{enabled:true}, mode:'xy',
      onZoom: ctx => onSync(ctx.chart),
      onZoomComplete: ctx => onSync(ctx.chart)
    },
    pan: {
      enabled:true, mode:'xy', modifierKey:null, scaleMode:'xy',
      onPan: ctx => onSync(ctx.chart),
      onPanComplete: ctx => onSync(ctx.chart)
    }
  };
}

export function resetZoom(cid) {
  const inst = Object.values(Chart.instances).find(c => c.canvas && c.canvas.id === cid);
  if (inst) inst.resetZoom();
}

export function killChart(ref) {
  try { if (ref) ref.destroy(); } catch(e) {}
}

export function baseTT() {
  return {
    backgroundColor:'#1c2128', titleColor:'#e6edf3', bodyColor:'#8b949e',
    borderColor:'#30363d', borderWidth:1, padding:10,
    titleFont:{family:'Inter',size:11}, bodyFont:{family:'Inter',size:11}
  };
}
export function baseX() {
  return {
    grid:{color:'rgba(255,255,255,0.04)'},
    ticks:{color:'#6e7681', font:{family:'Inter',size:9}, maxRotation:45, autoSkip:true, maxTicksLimit:16}
  };
}
export function baseY(cb) {
  return {
    grid:{color:'rgba(255,255,255,0.04)'},
    ticks:{color:'#6e7681', font:{family:'Inter',size:9}, callback: cb || undefined}
  };
}
export function baseOpts() {
  return {
    responsive:true, maintainAspectRatio:false,
    animation:{duration:300},
    interaction:{mode:'index', intersect:false},
    plugins:{legend:{display:false}, tooltip:baseTT(), zoom:zoomOpts()},
    scales:{x:baseX(), y:baseY()}
  };
}

// ── Plugins ──────────────────────────────────────────────────────────────────

export function makeSeasonPlugin(uid, getT) {
  return { id:'sp_'+uid, afterDraw(chart) {
    const t = getT(); if (!t || !t.length) return;
    const ctx = chart.ctx, ca = chart.chartArea, x = chart.scales.x;
    ctx.save();
    t.forEach(tr => {
      if (tr.index < 0 || tr.index >= chart.data.labels.length) return;
      const px = x.getPixelForValue(tr.index);
      ctx.strokeStyle = tr.col; ctx.lineWidth = 1.5; ctx.setLineDash([3,3]);
      ctx.beginPath(); ctx.moveTo(px, ca.top); ctx.lineTo(px, ca.bottom); ctx.stroke();
      ctx.setLineDash([]); ctx.font = 'bold 9px Inter,sans-serif';
      ctx.textAlign = 'left'; ctx.fillStyle = tr.col;
      ctx.fillText(tr.icon+' '+tr.label, px+3, ca.top+12);
    });
    ctx.restore();
  }};
}

export function makeBandPlugin(pid, minK, maxK, color) {
  return { id:pid, beforeDatasetsDraw(chart) {
    const ctx = chart.ctx, x = chart.scales.x, y = chart.scales.y;
    let mn = null, mx = null;
    chart.data.datasets.forEach(d => { if(d._k===minK) mn=d.data; if(d._k===maxK) mx=d.data; });
    if (!mn || !mx) return;
    ctx.save(); ctx.beginPath(); let go = false;
    mx.forEach((v,i) => {
      if (v == null || isNaN(v)) return;
      const px = x.getPixelForValue(i), py = y.getPixelForValue(v);
      if (!go) { ctx.moveTo(px,py); go=true; } else ctx.lineTo(px,py);
    });
    mn.slice().reverse().forEach((v,i) => {
      const ri = mn.length-1-i;
      if (v == null || isNaN(v)) return;
      ctx.lineTo(x.getPixelForValue(ri), y.getPixelForValue(v));
    });
    ctx.closePath(); ctx.fillStyle = color; ctx.fill(); ctx.restore();
  }};
}

export function makeTodayPlugin(uid, getIdx) {
  return { id:'td_'+uid, afterDraw(chart) {
    const ti = getIdx(); if (ti == null) return;
    const ctx = chart.ctx, ca = chart.chartArea, x = chart.scales.x;
    const px = x.getPixelForValue(ti);
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 1; ctx.setLineDash([4,4]);
    ctx.beginPath(); ctx.moveTo(px, ca.top); ctx.lineTo(px, ca.bottom); ctx.stroke();
    ctx.setLineDash([]); ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.font = '10px Inter,sans-serif'; ctx.fillText('today', px+4, ca.top+13);
    ctx.restore();
  }};
}

export function makeAnomalyPlugin(getIdx) {
  return { id:'ashd', beforeDatasetsDraw(chart) {
    const ti = getIdx(); if (ti == null) return;
    const ctx = chart.ctx, x = chart.scales.x, y = chart.scales.y;
    let fDs = null, aDs = null;
    chart.data.datasets.forEach(d => { if(d._k==='fcst') fDs=d; if(d._k==='avg') aDs=d; });
    if (!fDs || !aDs) return;
    ctx.save();
    fDs.data.forEach((v,i) => {
      if (v==null || aDs.data[i]==null || i>=fDs.data.length-1 || i<ti) return;
      const nv = fDs.data[i+1]!=null ? fDs.data[i+1] : v;
      const na = aDs.data[i+1]!=null ? aDs.data[i+1] : aDs.data[i];
      const x0=x.getPixelForValue(i), x1=x.getPixelForValue(i+1);
      const ty0=y.getPixelForValue(v), ty1=y.getPixelForValue(nv);
      const ay0=y.getPixelForValue(aDs.data[i]), ay1=y.getPixelForValue(na);
      ctx.beginPath();
      ctx.moveTo(x0,ty0); ctx.lineTo(x1,ty1); ctx.lineTo(x1,ay1); ctx.lineTo(x0,ay0);
      ctx.closePath();
      ctx.fillStyle = v > aDs.data[i] ? 'rgba(255,123,114,0.12)' : 'rgba(68,147,248,0.15)';
      ctx.fill();
    });
    ctx.restore();
  }};
}

export const stBandPlugin = { id:'stBand', beforeDatasetsDraw(chart) {
  const ctx = chart.ctx, x = chart.scales.x, y = chart.scales.y, ca = chart.chartArea;
  let mn = null, mx = null;
  chart.data.datasets.forEach(d => { if(d._k==='min') mn=d.data; if(d._k==='max') mx=d.data; });
  if (!mn || !mx) return;
  ctx.save(); ctx.beginPath(); let go = false;
  for (let i=0; i<mx.length; i++) {
    if (mx[i]==null || !isFinite(mx[i])) continue;
    const px = x.getPixelForValue(i);
    const py = Math.max(ca.top, Math.min(ca.bottom, y.getPixelForValue(mx[i])));
    if (!go) { ctx.moveTo(px,py); go=true; } else ctx.lineTo(px,py);
  }
  for (let j=mn.length-1; j>=0; j--) {
    if (mn[j]==null || !isFinite(mn[j])) continue;
    ctx.lineTo(x.getPixelForValue(j), Math.max(ca.top, Math.min(ca.bottom, y.getPixelForValue(mn[j]))));
  }
  ctx.closePath(); ctx.fillStyle = 'rgba(68,147,248,0.10)'; ctx.fill(); ctx.restore();
}};
