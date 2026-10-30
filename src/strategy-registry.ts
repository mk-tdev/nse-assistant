import type {EmaHistoryPolicy} from './ema-history.js';
import {createHash} from 'node:crypto';
export type SignalWindow={start:string;end:string};
export type LabStrategy={emaHistory?:EmaHistoryPolicy;setup?:'midday-consolidation'|'breakout-retest'|'ema-pullback';signalWindow?:SignalWindow;id:string;name:string;version:1|2;enabled:boolean;universe:'all'|'nifty50'|'screeners'|'stocks-in-play';maxExtension:number|null;sizing:'fixed-10'|'equal-risk';quantity:10;capital:number;riskPerTrade:number;maxPositionValue:number;maxOpenPositions:number;slippageBps:number;fillTimeoutMs:number;selection:{minimumOpeningRelativeVolume:number;minimumOpeningTurnover:number;topN:number}};
const common={version:1 as const,enabled:true,quantity:10 as const,capital:100000,riskPerTrade:250,maxPositionValue:25000,maxOpenPositions:80,slippageBps:1,fillTimeoutMs:60000,selection:{minimumOpeningRelativeVolume:2,minimumOpeningTurnover:10000000,topN:10}};
export const labStrategies:LabStrategy[]=[
 {...common,id:'nifty-quote-10-v1',name:'Nifty 50 control / observed quotes / 10 shares',universe:'nifty50',maxExtension:null,sizing:'fixed-10'},
 {...common,id:'orb-quote-10-v1',name:'ORB / observed quotes / 10 shares',universe:'all',maxExtension:null,sizing:'fixed-10'},
 {...common,id:'orb-extension-10-v1',name:'ORB / extension cap / 10 shares',universe:'all',maxExtension:1,sizing:'fixed-10'},
 {...common,id:'screener-quote-10-v1',name:'Screener ORB / observed quotes / 10 shares',universe:'screeners',maxExtension:null,sizing:'fixed-10'},
 {...common,id:'screener-extension-10-v1',name:'Screener ORB / extension cap / 10 shares',universe:'screeners',maxExtension:1,sizing:'fixed-10'},
 {...common,id:'in-play-10-v1',name:'Opening stocks in play / 10 shares',universe:'stocks-in-play',maxExtension:1,sizing:'fixed-10'},
 {...common,id:'midday-orb-quote-10-v1',name:'Midday ORB / 11:00–14:00 IST / 10 shares',enabled:false,universe:'all',maxExtension:null,sizing:'fixed-10',signalWindow:{start:'11:00',end:'14:00'}},
 {...common,id:'midday-consolidation-10-v1',name:'Midday consolidation / fresh 30-minute box / 10 shares',enabled:false,universe:'all',maxExtension:null,sizing:'fixed-10',signalWindow:{start:'11:00',end:'14:00'},setup:'midday-consolidation'},
 {...common,id:'orb-retest-10-v1',name:'ORB breakout retest and hold / 10 shares',enabled:false,universe:'all',maxExtension:null,sizing:'fixed-10',signalWindow:{start:'09:35',end:'14:00'},setup:'breakout-retest'},
 {...common,id:'orb-extension-risk-v1',name:'Optional equal-risk ORB / extension cap',enabled:false,universe:'all',maxExtension:1,sizing:'equal-risk',maxOpenPositions:4},
 {...common,id:'ema-pullback-10-v1',name:'8/21 EMA pullback / core rule / 10 shares',enabled:false,universe:'all',maxExtension:null,sizing:'fixed-10',signalWindow:{start:'09:45',end:'14:30'},setup:'ema-pullback'},
 {...common,id:'ema-core-nifty-10-v2',name:'8/21 EMA / core-session history v2 / Nifty 50 / 10 shares',version:2,enabled:false,universe:'nifty50',maxExtension:null,sizing:'fixed-10',signalWindow:{start:'09:45',end:'14:30'},setup:'ema-pullback',emaHistory:{sessionEnd:'15:15',lookbackSessions:3,minimumBars:200}},
];
export const strategyHash=(s:LabStrategy)=>{const {enabled,...parameters}=s;return createHash('sha256').update(JSON.stringify(parameters)).digest('hex');};
export function strategyById(id:string){const s=labStrategies.find(s=>s.id===id);if(!s)throw Error('LAB_UNKNOWN_STRATEGY');return s;}
