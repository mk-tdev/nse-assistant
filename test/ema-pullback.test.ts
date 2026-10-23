import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {at,FIVE,type Candle,type Instrument} from '../src/model.js';
import {ema} from '../src/ema.js';
import {firstStrategyCandidate} from '../src/setup-signals.js';
import {strategyById} from '../src/strategy-registry.js';
import {CandleStore} from '../src/recorder.js';
import {PaperLedger,paperDefaults} from '../src/paper.js';
import {StrategyLabStore} from '../src/strategy-lab-store.js';
import {middayDecisions} from '../src/midday-signals.js';

const session='2026-10-23';
const previousSessions=(count=20)=>Array.from({length:count},(_,i)=>{
 const d=new Date(Date.parse(session+'T00:00:00Z'));d.setUTCDate(d.getUTCDate()-(count-i));return d.toISOString().slice(0,10);
}).sort();
const flat=(start:number,close:number,low=close,open=close,high=close):Candle=>({start,open,high,low,close,volume:10000});

/**
 * A long smooth uptrend gives a real, causally-computed EMA8>EMA21 trend, then two
 * deliberately engineered bars pull back into the EMA8-EMA21 zone without closing
 * below EMA21, then a bullish bar reclaims EMA8 and the preceding bar's high.
 * Every value is derived from the same `ema()` used by production code, never guessed.
 */
function buildFixture(opts: {previousCount?:number; pullback1Offset?:number; pullback2Offset?:number; confirmationExtra?:number; confirmationBullish?:boolean; touchZone?:boolean} = {}) {
 const previousCount=opts.previousCount??20,pullback1Offset=opts.pullback1Offset??0.5,pullback2Offset=opts.pullback2Offset??0.3;
 const confirmationExtra=opts.confirmationExtra??2,confirmationBullish=opts.confirmationBullish??true,touchZone=opts.touchZone??true;
 const previous=previousSessions(previousCount);
 const historyLen=previous.length*75,prefixToTrend=6; // 09:15..09:40 continues the trend; 09:45/09:50 pull back; 09:55 confirms.
 let closes=Array.from({length:historyLen+prefixToTrend},(_,i)=>100+i*0.3),e8=ema(closes,8),e21=ema(closes,21);
 const trendIdx=closes.length-1;
 const pullback1=e21[trendIdx]!+pullback1Offset;closes=[...closes,pullback1];e8=ema(closes,8);e21=ema(closes,21);
 const idx1=closes.length-1,low1=e21[idx1]!+0.1;
 const pullback2=e21[idx1]!+pullback2Offset;closes=[...closes,pullback2];e8=ema(closes,8);e21=ema(closes,21);
 const idx2=closes.length-1,high2=pullback2+0.01;
 const confirmClose=high2+confirmationExtra;closes=[...closes,confirmClose];
 const history:Candle[]=[];let gi=0;
 for(const d of previous){for(let s=0;s<75;s++){history.push(flat(at(d,'09:15')+s*FIVE,closes[gi]!));gi++;}}
 const times=['09:15','09:20','09:25','09:30','09:35','09:40','09:45','09:50','09:55'];
 const bars:Candle[]=times.map((t,s)=>{
  const idx=historyLen+s;
  if(s===times.length-1)return confirmationBullish?flat(at(session,t),closes[idx]!,high2,high2,closes[idx]!):flat(at(session,t),closes[idx]!);
  return flat(at(session,t),closes[idx]!,idx===idx1&&touchZone?low1:closes[idx]!);
 });
 return {previous,history,bars,stop:touchZone?low1:Math.min(pullback1,pullback2),rangeHigh:pullback2};
}
const cfg={...strategyById('ema-pullback-10-v1'),enabled:true};

test('8/21 EMA pullback: 200+ bar warm-up, trend, zone pullback and bullish reclaim produce a candidate',()=>{
 const {previous,history,bars,stop,rangeHigh}=buildFixture();
 const result=firstStrategyCandidate(cfg,'TEST',session,bars,history,previous,0,cfg.signalWindow)!;
 assert.ok(result);
 assert.equal(result.session,session);
 assert.equal(result.stop,stop);
 assert.ok(Math.abs(result.rangeHigh-rangeHigh)<1e-9);
 assert.ok(result.rangeHigh>result.stop);
 assert.equal((result.setupEvidence as {setup:string}).setup,'ema-pullback');
});

test('rejects when fewer than 20 prior sessions are available, same as every other setup',()=>{
 const {previous,history,bars}=buildFixture({previousCount:19});
 assert.equal(firstStrategyCandidate(cfg,'TEST',session,bars,history,previous,0,cfg.signalWindow),null);
});

test('rejects a pullback that closes back below EMA21 instead of holding the zone',()=>{
 const {previous,history,bars}=buildFixture({pullback1Offset:-5,pullback2Offset:-5});
 assert.equal(firstStrategyCandidate(cfg,'TEST',session,bars,history,previous,0,cfg.signalWindow),null);
});

test('rejects a pullback that never trades into the EMA8-EMA21 zone',()=>{
 const {previous,history,bars}=buildFixture({pullback1Offset:4,pullback2Offset:4,touchZone:false});
 assert.equal(firstStrategyCandidate(cfg,'TEST',session,bars,history,previous,0,cfg.signalWindow),null);
});

test('rejects a non-bullish confirmation candle even after a qualifying trend and pullback',()=>{
 const {previous,history,bars}=buildFixture({confirmationBullish:false});
 assert.equal(firstStrategyCandidate(cfg,'TEST',session,bars,history,previous,0,cfg.signalWindow),null);
});

test('live decision wiring: continuous multi-session history is fetched by session, not same-slot sampling, and journals an immutable decision',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'nse-ema-live-')),labDir=mkdtempSync(join(tmpdir(),'nse-ema-lab-'));
 const {previous,history,bars}=buildFixture();
 const instrument:Instrument={securityId:'1',symbol:'TEST',name:'synthetic',exchangeSegment:'NSE_EQ',instrument:'EQUITY'};
 const candles=new CandleStore(join(dir,'candles.sqlite'));
 const ledger=new PaperLedger(join(dir,'paper.sqlite'),{...paperDefaults({source:'synthetic',coverageFrom:previous[0]!,coverageTo:session,sessions:[...previous,session],independentlyVerified:false}),mode:'approximate-research'});
 const labStore=new StrategyLabStore(labDir);
 try{
  for(const d of previous){
   const dayBars=history.filter(c=>c.start>=at(d,'09:15')&&c.start<at(d,'15:30'));
   candles.save(d,instrument,dayBars,at(d,'15:35'),{source:'synthetic',candleStartVerified:true,missing:[]});
  }
  for(const bar of bars)ledger.observe('TEST',{candle:bar,observedAt:bar.start+FIVE+5000,source:'synthetic',sourceTime:bar.start+FIVE,issues:[]});
  const now=at(session,'09:55')+FIVE+15000; // past the 09:55 bar's completion, within the 60s decision deadline
  const candidates=middayDecisions(dir,labStore,cfg,session,['TEST'],[...previous,session],now);
  assert.equal(candidates.length,1);
  assert.equal(candidates[0]!.symbol,'TEST');
  const saved=labStore.db.prepare('SELECT body FROM lab_signal_decisions WHERE strategy_id=? AND session=? AND symbol=?').get(cfg.id,session,'TEST');
  assert.ok(saved);
  const evidence=JSON.parse(String(saved!.body));
  assert.equal(evidence.reason,'research_signal');
  assert.equal(evidence.baselineObservations.length,previous.length*75);
 }finally{candles.close();ledger.close();labStore.close();rmSync(dir,{recursive:true,force:true});rmSync(labDir,{recursive:true,force:true});}
});
