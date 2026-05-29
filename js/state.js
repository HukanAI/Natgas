// js/state.js — centrální mutable state sdílený napříč moduly

export const state = {
  // Weather
  wxS: null,
  wxWindow: '1y',

  // Storage
  stStorageData: [],
  stWindow: '1y',
  stApiCount: 0,
  stCharts: {stor:null, dev:null, inj:null},
  stLastF7: null,
  stLastF14: null,
  stLastF21: null,

  // NGF / Futures
  stNgfData: [],
  ngfWindow: 'max',
  ngfApiCount: 0,
  ngfChartType: 'candle',
  ngfChart: null,
  fpSpreadChart: null,
  seasonChart: null,
  seasonChartOv: null,        // overview-card seasonality chart instance
  fwCardMode: 'season',       // overview futures card: 'curve' | 'season'
  seasonOvYear: null,         // overview seasonality: selected year, null = current year
  seasonMode: 'abs', // 'pct' = % from start of year, 'abs' = absolute price
  nextContractPrice: null,
  frontLivePrice: null,       // latest live front-month price (1-min refresh)
  fcLoading: false,
  fcBodyOpen: true,
  fcContractsData: [],

  // Daily history for prev-day close calculations (separate from TA so it's always present)
  // dailyHistory.front[], dailyHistory.next[] = array of {ts, open, high, low, close}
  dailyHistory: { front: [], next: [] },

  // Production / Export
  peWindow: 'max',
  peApiCount: 0,
  peData: {prod:null, can:null, mex:null, lng:null},
  peCharts: {prod:null, can:null, mex:null, lng:null, supply:null},

  // Technical Analysis
  taType: 'candle',
  taTicker: 'front', // 'front' = NG=F, 'next' = next month contract
  taApiCount: 0,
  taData: {},
  taCharts: {},
  smcFlags: { highLow: true, zones: false, sts: false },

  // COT
  cotWindow: '2y',
  cotData: [],
  cotApiCount: 0,
  cotCharts: {net:null, ls:null, prod:null, swap:null, chg:null},

  // Weather charts (kept separate for easy killChart access)
  wxCh1: null,
  wxCh3: null,
  wxChReg: null,

  // Debug
  dbgEntries: [],
};
