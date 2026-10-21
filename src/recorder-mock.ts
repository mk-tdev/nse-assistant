import {at,FIVE,type Instrument} from './model.js';
import type {Provider} from './dhan.js';
export function recorderMock(date:string):Provider{
 const items:Instrument[]=[{securityId:'1333',symbol:'HDFCBANK',name:'Synthetic HDFCBANK fixture',exchangeSegment:'NSE_EQ',instrument:'EQUITY'},{securityId:'11536',symbol:'TCS',name:'Synthetic TCS fixture',exchangeSegment:'NSE_EQ',instrument:'EQUITY'}];
 return {source:'Synthetic recorder fixture (not market data)',async instruments(){return {items,fetchedAt:Date.now()};},async quote(){throw new Error('RECORDER_QUOTES_NOT_USED');},async candles(id){if(!items.some(i=>i.securityId===id))throw new Error('UNKNOWN_NSE_EQUITY_SECURITY_ID');return {source:'Synthetic recorder fixture (not market data)',fetchedAt:Date.now(),candleStartVerified:false,missing:[],candles:Array.from({length:75},(_,i)=>({start:at(date,'09:15')+i*FIVE,open:100+i/10,high:102+i/10,low:99+i/10,close:101+i/10,volume:1000+i}))};}};
}
