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
  nextContractPrice: null,
  fcLoading: false,
  fcBodyOpen: true,
  fcContractsData: [],

  // Production / Export
  peWindow: 'max',
  peApiCount: 0,
  peData: {prod:null, can:null, mex:null, lng:null},
  peCharts: {prod:null, can:null, mex:null, lng:null, supply:null},

  // Technical Analysis
  taType: 'candle',
  taApiCount: 0,
  taData: {},
  taCharts: {},

  // COT
  cotWindow: '2y',
  cotData: [],
  cotApiCount: 0,
  cotCharts: {net:null, ls:null, prod:null, swap:null, chg:null},

  // Weather charts (kept separate for easy killChart access)
  wxCh1: null,
  wxCh3: null,
  wxChReg: null,

  // AI
  aiHistory: [],

  // Debug
  dbgEntries: [],
};
