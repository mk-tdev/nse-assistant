import { at, FIVE, type Batch, type Calendar, type Candle, type Instrument } from './model.js';
import type { Provider } from './dhan.js';
export const MOCK_DATE='2026-10-21';
export const MOCK_AS_OF=at(MOCK_DATE,'10:00');
// Synthetic prices on scheduled regular dates; documented NSE holidays are excluded.
const holidays=new Set(['2026-09-14','2026-10-02','2026-10-20']);
const sessions:string[]=[];
for(let t=Date.parse('2026-09-01');t<=Date.parse(MOCK_DATE);t+=86400000){if(![0,6].includes(new Date(t).getUTCDay())&&!holidays.has(new Date(t).toISOString().slice(0,10)))sessions.push(new Date(t).toISOString().slice(0,10));}
export const mockCalendar:Calendar={source:'SYNTHETIC market-data fixture with NSE 2026 published holiday exclusions; not an operational calendar',verified:true,sessions};
export function fixtureCandles():Candle[]{
  return sessions.flatMap(d=>Array.from({length:75},(_,i)=>({start:at(d,'09:15')+i*FIVE,open:i<3?100:103,high:i<3?102:104,low:i<3?99:102,close:i<3?101:103,volume:d===MOCK_DATE&&i===3?200:100})));
}
export class MockProvider implements Provider {
  source='SYNTHETIC fixture, not live Dhan';
  async instruments(){return {items:[{securityId:'999001',symbol:'MOCK_EQ',name:'Synthetic Equity',exchangeSegment:'NSE_EQ',instrument:'EQUITY'}] as Instrument[],fetchedAt:MOCK_AS_OF};}
  private check(id:string){if(id!=='999001')throw new Error('UNKNOWN_MOCK_SECURITY_ID');}
  async quote(id:string){this.check(id);return {securityId:id,lastPrice:103,source:this.source,timeZone:'Asia/Kolkata',fetchedAt:new Date(MOCK_AS_OF).toISOString(),sourceTimestamp:new Date(MOCK_AS_OF-1000).toISOString(),freshness:'mock_only',missingData:[],simulatedOnly:true};}
  async candles(id:string,from:string,to:string):Promise<Batch>{this.check(id);return {candles:fixtureCandles().filter(c=>c.start>=Date.parse(from)&&c.start<Date.parse(to)&&c.start+FIVE<=MOCK_AS_OF),fetchedAt:MOCK_AS_OF,source:this.source,candleStartVerified:true,missing:[]};}
}
