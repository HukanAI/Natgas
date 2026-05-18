// js/storage5y.js — 5-year average / band calculation (shared by storage + bias)

export function st5y(all, dates) {
  return dates.map(date => {
    const ref = new Date(date+'T12:00:00Z');
    const refDOY = ref.getMonth()*30 + ref.getDate();
    const peers = [];
    all.forEach(r => {
      const pp = new Date(r.date+'T12:00:00Z');
      const diff = ref.getFullYear() - pp.getFullYear();
      if (diff < 1 || diff > 5) return;
      if (Math.abs(pp.getMonth()*30 + pp.getDate() - refDOY) <= 7) peers.push(r.value);
    });
    const valid = peers.filter(v => isFinite(v));
    if (valid.length < 2) return {avg:null, min:null, max:null};
    const avg = valid.reduce((a,b)=>a+b) / valid.length;
    return {avg, min:Math.min(...valid), max:Math.max(...valid)};
  });
}
