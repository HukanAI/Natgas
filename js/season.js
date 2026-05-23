// js/season.js
import { SEASON_DEF, SEASON_ORDER, SEASON_TRANS } from './constants.js';
import { state } from './state.js';

export function getSeasonInfo() {
  const n = new Date(), m = n.getMonth()+1, d = n.getDate(), yr = n.getFullYear();

  function inSeg(s) {
    if (s.sm <= s.em)
      return (m>s.sm||(m===s.sm&&d>=s.sd)) && (m<s.em||(m===s.em&&d<=s.ed));
    return (m>s.sm||(m===s.sm&&d>=s.sd)) || (m<s.em||(m===s.em&&d<=s.ed));
  }

  let cur = SEASON_DEF[1];
  for (const sd of SEASON_DEF) { if (sd.segs.some(inSeg)) { cur=sd; break; } }
  const cs = cur.segs.find(inSeg) || cur.segs[0];

  function segStart(s) {
    let sy = yr; if (s.sm>s.em && m<=s.em) sy=yr-1;
    return new Date(sy, s.sm-1, s.sd);
  }
  function segEnd(s) {
    const st2=segStart(s), ey=st2.getFullYear()+(s.em<s.sm?1:0);
    return new Date(ey, s.em-1, s.ed);
  }

  const sS=segStart(cs), sE=segEnd(cs);
  const dL = Math.max(0, Math.ceil((sE-n)/864e5));
  const dI = Math.max(1, Math.ceil((n-sS)/864e5));
  const sT = Math.max(1, Math.ceil((sE-sS)/864e5));
  const oi  = SEASON_ORDER.findIndex(s => s.n===cur.name && s.sm===cs.sm);
  const nd  = SEASON_DEF.find(x => x.name===SEASON_ORDER[(oi+1)%SEASON_ORDER.length].n) || SEASON_DEF[1];

  return {
    name:cur.name, icon:cur.icon, col:cur.col,
    daysLeft:dL, daysIn:dI, sTotal:sT,
    nxtIcon:nd.icon, nxtName:nd.name,
    isHeating:cur.name==='Heating', month:m
  };
}

export function getSeasonTransitions(dates) {
  const out = [];
  for (let i=1; i<dates.length; i++) {
    const prev=new Date(dates[i-1]+'T12:00:00Z'), curr=new Date(dates[i]+'T12:00:00Z');
    const pm=prev.getMonth()+1, pd=prev.getDate(), cm=curr.getMonth()+1, cd=curr.getDate();
    SEASON_TRANS.forEach(t => {
      if ((pm<t.month||(pm===t.month&&pd<t.day)) && (cm>t.month||(cm===t.month&&cd>=t.day)))
        out.push({index:i, label:t.label, icon:t.icon, col:t.col});
    });
  }
  return out;
}

export function stSeasonTrans(dates) {
  return state.stWindow === 'max' ? [] : getSeasonTransitions(dates);
}
