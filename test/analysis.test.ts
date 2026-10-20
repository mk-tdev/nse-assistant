import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {analyze,analyzeApproximate,median,relativeVolume,vwap} from '../src/analysis.js';
import {at,day,FIVE,metadata,minute,validCandle,type Batch,type Candle} from '../src/model.js';
import {fixtureCandles,mockCalendar,MOCK_DATE as date} from '../src/mock.js';
const make=(time='10:00'):Batch=>({candles:fixtureCandles(),fetchedAt:at(date,time),source:'synthetic test',candleStartVerified:true,missing:[]});
const run=(b=make(),time='10:00')=>analyzeApproximate(b,mockCalendar,date,at(date,time));
const current=(b:Batch,time:string)=>b.candles.find(c=>c.start===at(date,time))!;
const prior20=mockCalendar.sessions.filter(d=>d<date).slice(-20);
test('IST date, opening and five-minute completion boundaries',()=>{
 assert.equal(day(at(date,'09:15')),date);assert.equal(minute(at(date,'09:15')),555);
 assert.equal(run(make('09:29'),'09:29').qualifiesUnderApproximateModel,false);
 assert.equal(run(make('09:30'),'09:30').status,'no_signal');
 assert.equal(run(make('09:34'),'09:34').status,'no_signal');
 assert.equal(run(make('09:35'),'09:35').status,'signal_pending_next_completed_candle');
 assert.equal(run(make('09:40'),'09:40').status,'simulated_open');
});
test('opening range excludes 09:30 bar; next candle entry and 2R',()=>{
 const result=run();assert.equal(result.qualifiesUnderApproximateModel,true);assert.deepEqual(result.openingRange,{high:102,low:99});
 assert.equal(result.trade?.entryAt,new Date(at(date,'09:35')).toISOString());assert.equal(result.trade?.entry,103);assert.equal(result.trade?.target,111);assert.equal(result.trade?.stop,99);
});
test('median and weighted HLC3 VWAP, null for missing/zero volume',()=>{
 assert.equal(median([9,1,3,7]),5);
 const a: Candle={start:at(date,'09:15'),open:10,high:12,low:8,close:10,volume:100};
 const b={...a,start:a.start+FIVE,open:20,high:22,low:18,close:20,volume:300};
 assert.equal(vwap([a,b]),17.5);assert.equal(vwap([{...a,volume:0}]),null);assert.equal(vwap([{...a,volume:null}]),null);
});
test('same-time volume uses previous 20 sessions, never same day or another slot',()=>{
 const batch=make(),c=current(batch,'09:30');assert.equal(relativeVolume(c,batch.candles,prior20).ratio,2);
 for(const x of batch.candles)if(minute(x.start)!==570)x.volume=999999;
 assert.equal(relativeVolume(c,batch.candles,prior20).ratio,2);
 const h=batch.candles.find(c=>day(c.start)===prior20[0]&&minute(c.start)===570)!;h.volume=null;
 assert.equal(relativeVolume(c,batch.candles,prior20).ratio,null);
});
test('volume threshold is inclusive at 1.5',()=>{
 const b=make();current(b,'09:30').volume=150;assert.equal(run(b).qualifiesUnderApproximateModel,true);
 current(b,'09:30').volume=149;assert.equal(run(b).status,'no_signal');
});
test('missing volume, missing candle, duplicate, invalid OHLC, zero baseline block',()=>{
 for(const mutate of [(b:Batch)=>{current(b,'09:15').volume=null;},(b:Batch)=>{b.candles=b.candles.filter(c=>c.start!==at(date,'09:20'));},(b:Batch)=>{b.candles.push(current(b,'09:20'));},(b:Batch)=>{current(b,'09:20').high=1;},(b:Batch)=>{b.candles.filter(c=>day(c.start)<date&&minute(c.start)===570).forEach(c=>c.volume=0);}]){
 const b=make();mutate(b);assert.equal(run(b).status,'blocked');assert.equal(run(b).qualifiesUnderApproximateModel,false);
 }
});
test('stale candles block; fresh retrieval does not repair missing latest data',()=>{
 const b=make();b.candles=b.candles.filter(c=>c.start!==at(date,'09:55'));assert.equal(run(b).status,'blocked');assert.equal(run(b).freshness,'stale');
});
test('unverified timestamps/calendar and fewer than 20 prior sessions block',()=>{
 const b=make();b.candleStartVerified=false;assert.equal(run(b).status,'blocked');
 assert.equal(analyze(make(),{...mockCalendar,verified:false},date,at(date,'10:00')).status,'blocked');
 assert.equal(analyze(make(),{...mockCalendar,sessions:[date]},date,at(date,'10:00')).status,'blocked');
});
test('future and incomplete candles cannot change the decision or entry',()=>{
 const b=make('09:35'),first=run(b,'09:35');
 for(const c of b.candles)if(c.start>=at(date,'09:35')){c.open=999;c.close=999;c.high=1000;c.low=900;c.volume=999999;}
 const second=run(b,'09:35');assert.deepEqual({...second,retrievalAgeMs:0},{...first,retrievalAgeMs:0});assert.equal(first.trade,null);
 const full=make(),result=run(full);const vw=result.signal?.vwap;
 for(const c of full.candles)if(c.start>at(date,'09:30')){c.high=10000;c.volume=999999;}
 assert.equal(run(full).signal?.vwap,vw);
});
test('11:00 close is the last signal; 11:05 close is excluded',()=>{
 const b=make('11:05');for(const c of b.candles)if(day(c.start)===date&&minute(c.start)>=570)c.volume=100;
 current(b,'10:55').volume=200;assert.equal(run(b,'11:05').signal?.confirmedAt,new Date(at(date,'11:00')).toISOString());
 current(b,'10:55').volume=100;current(b,'11:00').volume=200;assert.equal(run(b,'11:05').status,'no_signal');
});
test('stop first if stop and target touched in same completed bar; gap stop conservative',()=>{
 const b=make();current(b,'09:40').low=98;current(b,'09:40').high=112;
 assert.equal(run(b).trade?.exitReason,'stop_first_intrabar_ambiguity');assert.equal(run(b).trade?.exitPrice,99);
 current(b,'09:40').open=97;current(b,'09:40').low=96;assert.equal(run(b).trade?.exitPrice,97);
});
test('target and 15:15 forced exit are paper-only and observed without lookahead',()=>{
 const b=make();current(b,'09:40').high=112;assert.equal(run(b).trade?.exitReason,'2R_target');
 const full=make('15:20');const r=run(full,'15:20');assert.equal(r.trade?.exitReason,'15:15_time_exit');assert.equal(r.trade?.exitAt,new Date(at(date,'15:15')).toISOString());
 assert.equal(run(make('15:15'),'15:15').trade?.exitReason,null);
});
test('entry gap at or below OR low is rejected and only first signal used',()=>{
 const b=make();current(b,'09:35').open=99;current(b,'09:35').low=98;assert.equal(run(b).status,'entry_rejected_gap_at_or_below_stop');
});
test('calendar does not substitute older sessions for missing recent slot',()=>{
 const b=make();b.candles=b.candles.filter(c=>!(day(c.start)===prior20[19]&&minute(c.start)===570));assert.equal(run(b).status,'blocked');
});
test('snapshot before decision, prelaunch date and non-session day block',()=>{
 const b=make();b.fetchedAt--;assert.equal(run(b).status,'blocked');
 assert.equal(analyze(make(),mockCalendar,'2026-10-20',at('2026-10-20','10:00')).validSignal,false);
});
test('invalid candle alignment and empty freshness remain unknown',()=>{
 const b=make();assert.equal(validCandle({...b.candles[0]!,start:1}),false);
 b.candles=[];assert.equal(metadata(b,at(date,'10:00'),date).freshness,'unknown');
});
test('close must strictly exceed range high and the disclosed session VWAP',()=>{
 const b=make();current(b,'09:30').close=102;assert.equal(run(b).qualifiesUnderApproximateModel,false);
 current(b,'09:30').close=103;current(b,'09:30').high=600;assert.equal(run(b).qualifiesUnderApproximateModel,false);
});
test('unverified candle interpretation cannot advertise fresh historical data',()=>{
 const b=make();b.candleStartVerified=false;assert.equal(metadata(b,at(date,'10:00'),date).freshness,'unknown');
});
test('approximate VWAP can never qualify the exact strategy or produce a strategy fill',()=>{
 const result=analyze(make(),mockCalendar,date,at(date,'10:00'));
 assert.equal(result.approximateAnalysis.qualifiesUnderApproximateModel,true);
 assert.equal(result.status,'exact_vwap_unverified');assert.equal(result.qualification,'unverified');assert.equal(result.validSignal,false);
 assert.equal(result.signal,null);assert.equal(result.trade,null);
 assert.ok(result.missingData.includes('timestamp_aligned_exact_session_vwap'));
 assert.equal(result.approximateAnalysis.hypotheticalTrade?.entry,103);
});
test('missing exact VWAP is unverified even if the approximate model rejects a candidate',()=>{
 const b=make();current(b,'09:30').high=600;
 const result=analyze(b,mockCalendar,date,at(date,'10:00'));
 assert.equal(result.approximateAnalysis.qualifiesUnderApproximateModel,false);assert.equal(result.validSignal,false);assert.equal(result.qualification,'unverified');
});
test('incomplete or absent opening-range bar blocks both exact and approximate analysis',()=>{
 const b=make('09:29');let result=analyze(b,mockCalendar,date,at(date,'09:29'));
 assert.equal(result.validSignal,false);assert.equal(result.approximateAnalysis.qualifiesUnderApproximateModel,false);assert.ok(result.missingData.includes('opening_range_incomplete'));
 b.fetchedAt=at(date,'09:30');b.candles=b.candles.filter(c=>c.start!==at(date,'09:20'));
 result=analyze(b,mockCalendar,date,at(date,'09:30'));assert.equal(result.status,'blocked');assert.ok(result.missingData.includes('missing_session_candle'));
});
test('19 valid prior sessions cannot be replaced with an older observed or repeated date',()=>{
 const sessions=[...prior20.slice(1),date];
 let result=analyze(make(),{...mockCalendar,sessions},date,at(date,'10:00'));
 assert.equal(result.status,'blocked');assert.ok(result.missingData.includes('missing_previous_20_trading_sessions'));
 result=analyze(make(),{...mockCalendar,sessions:[...sessions,prior20[1]!]},date,at(date,'10:00'));
 assert.equal(result.status,'blocked');assert.equal(result.approximateAnalysis.qualifiesUnderApproximateModel,false);
 assert.equal(relativeVolume(current(make(),'09:30'),make().candles,Array(20).fill(prior20[0]!)).missing,true);
});
test('holiday-aware fixture skips October 20 and October 2 without demanding their volume',()=>{
 assert.equal(mockCalendar.sessions.includes('2026-10-20'),false);assert.equal(mockCalendar.sessions.includes('2026-10-02'),false);
 assert.equal(mockCalendar.sessions.includes('2026-10-21'),true);assert.equal(prior20.at(-1),'2026-10-19');
 assert.equal(make().candles.some(c=>day(c.start)==='2026-10-20'),false);
 const result=analyze(make(),mockCalendar,date,at(date,'10:00'));
 assert.equal(result.approximateAnalysis.qualifiesUnderApproximateModel,true);
 const noRecentSession=make();noRecentSession.candles=noRecentSession.candles.filter(c=>day(c.start)!=='2026-10-19');
 assert.equal(analyze(noRecentSession,mockCalendar,date,at(date,'10:00')).status,'blocked');
});
test('end-labeled bars cannot be silently accepted as verified start-labeled range',()=>{
 const b=make();b.candleStartVerified=false;
 for(const c of b.candles)c.start+=FIVE;
 let result=analyze(b,mockCalendar,date,at(date,'10:00'));
 assert.equal(result.validSignal,false);assert.ok(result.missingData.includes('unverified_candle_timestamp_semantics'));
 b.candleStartVerified=true;result=analyze(b,mockCalendar,date,at(date,'10:00'));
 assert.equal(result.status,'blocked');assert.ok(result.missingData.includes('missing_session_candle'));
});
test('future timestamps and missing future volume cannot influence an earlier model decision',()=>{
 const b=make('09:35'),before=analyze(b,mockCalendar,date,at(date,'09:35'));
 b.candles.push({start:at(date,'10:05'),open:999,high:1000,low:900,close:999,volume:null});
 const after=analyze(b,mockCalendar,date,at(date,'09:35'));
 assert.deepEqual(after.approximateAnalysis,before.approximateAnalysis);assert.equal(after.validSignal,false);
 assert.equal(after.approximateAnalysis.hypotheticalTrade,null);
});

test('calendar evidence fixture matches mock scheduled dates without claiming live verification',async()=>{
 const snapshot=JSON.parse(await readFile(new URL('../fixtures/nse-scheduled-sessions-2026-09-to-10.json',import.meta.url),'utf8'));
 assert.deepEqual(snapshot.sessions,mockCalendar.sessions);assert.equal(snapshot.liveDataVerified,false);assert.equal(snapshot.operationallyInstalled,false);
 assert.ok(snapshot.holidays.includes('2026-10-20'));assert.equal(new Date('2026-10-21').getUTCDay(),3);
});
