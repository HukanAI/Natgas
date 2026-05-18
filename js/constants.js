// js/constants.js

export const MONTHS    = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
export const DAYS      = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
export const NGF_CODES = ['F','G','H','J','K','M','N','Q','U','V','X','Z'];

export const SEASON_DEF = [
  { name:'Heating',  icon:'❄️', col:'#7eb8f7', segs:[{sm:11,sd:1,em:2,ed:28}] },
  { name:'Shoulder', icon:'🌤', col:'#e3b341', segs:[{sm:3,sd:1,em:5,ed:31},{sm:10,sd:1,em:10,ed:31}] },
  { name:'Cooling',  icon:'☀️', col:'#f0a060', segs:[{sm:6,sd:1,em:9,ed:30}] }
];
export const SEASON_ORDER = [
  {n:'Heating',sm:11},{n:'Shoulder',sm:3},{n:'Cooling',sm:6},{n:'Shoulder',sm:10}
];
export const SEASON_TRANS = [
  {month:3, day:1, label:'Shoulder', icon:'🌤', col:'rgba(227,179,65,.7)'},
  {month:6, day:1, label:'Cooling',  icon:'☀️', col:'rgba(240,136,62,.7)'},
  {month:10,day:1, label:'Shoulder', icon:'🌤', col:'rgba(227,179,65,.7)'},
  {month:11,day:1, label:'Heating',  icon:'❄️', col:'rgba(68,147,248,.7)'}
];

export const WX_BASE      = 18;
export const WX_FCST_DAYS = 16;
export const WX_HIST_YRS  = [1,2,3,4,5];
export const WX_REGIONS   = [
  {name:'Northeast', lat:39.95,  lon:-75.17,  w:0.35},
  {name:'Midwest',   lat:41.85,  lon:-87.65,  w:0.32},
  {name:'S.Central', lat:32.78,  lon:-96.80,  w:0.18},
  {name:'Southeast', lat:33.75,  lon:-84.39,  w:0.10},
  {name:'West',      lat:39.74,  lon:-104.98, w:0.05}
];
export const WX_TW       = {ytd:null,'1m':30,'3m':90,'1y':365,'2y':730};
export const WX_LS_CACHE = 'ng_wx_v2';
export const WX_LS_API   = 'ng_wx_api_v2';

export const ST_API_KEY  = '0a6cBnSfbVdXpRPcDeuQAeTjGXajaK16pPM8sMF6';
export const ST_WINDOWS  = {max:99999,'5y':1825,'2y':730,'1y':365,ytd:null,'3m':90,'1m':30};
export const PE_WINDOWS  = {max:99999,'5y':1825,'2y':730,'1y':365,ytd:null};
export const PE_SERIES   = {prod:'NG.N9070US2.M',can:'NG.N9102CN2.M',mex:'NG.N9132MX2.M',lng:'NG.N9133US2.M'};
export const PE_COLORS   = {prod:'#3fb950',can:'#f0883e',mex:'#e3b341',lng:'#a371f7'};
export const PE_LABELS   = {prod:'Production',can:'Imports from Canada',mex:'Exports to Mexico',lng:'LNG Exports'};
export const PE_NAMES    = {prod:'natgas_production',can:'natgas_canada_imports',mex:'natgas_mexico_exports',lng:'natgas_lng_exports'};

export const NGF_PROXIES = [
  function(u){ return 'https://corsproxy.io/?url=' + encodeURIComponent(u); },
  function(u){ return 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u); },
  function(u){ return 'https://proxy.cors.sh/' + u; }
];

export const GROQ_URL    = 'https://natgas-proxy.ondra-peter.workers.dev/';
export const GROQ_MODEL  = 'deepseek-r1-distill-llama-70b';
export const TA_TFS      = ['5m','15m','1h','4h','1d','1w'];
export const REG_COLORS  = ['#4493f8','#3fb950','#e3b341','#f0883e','#a371f7'];
export const COT_WINDOWS = {max:99999,'5y':1825,'2y':730,'1y':365,ytd:null,'6m':180,'3m':90};
export const EXP_MON     = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sept','Oct','Nov','Dec'];
