import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {PaperLedger,paperDefaults,type PaperConfig} from '../src/paper.js';
import {at,day,FIVE,type Candle,type Instrument} from '../src/model.js';
import {fixtureCandles,mockCalendar,MOCK_DATE as date} from '../src/mock.js';
import {parseCandles,type Provider} from '../src/dhan.js';
import {CandleStore,SessionRecorder} from '../src/recorder.js';
import {aggregateMinutes,RecoveryAgent,type RecoveryCase} from '../src/recovery.js';
import {validateReviews,requestReview,Reviewer} from '../src/reviewer.js';
import {parseScreener,chartinkDefinition,loadWatchlists,hash} from '../src/watchlists.js';
import {ResearchCoordinator} from '../src/research.js';
const config=(variant?:PaperConfig['variant']):PaperConfig=>({...paperDefaults({source:'synthetic sessions',coverageFrom:mockCalendar.sessions[0]!,coverageTo:date,sessions:mockCalendar.sessions,independentlyVerified:false}),mode:'approximate-research',acceptStartLabelsForResearch:true,acceptScheduledCalendarForResearch:true,...(variant?{variant}:{})});
const item:Instrument={symbol:'TCS',securityId:'11536',name:'synthetic TCS',exchangeSegment:'NSE_EQ',instrument:'EQUITY'};
const bar=(time:string,patch:Partial<Candle>={})=>({...fixtureCandles().find(c=>c.start===at(date,time))!,...patch});
function seed(l:PaperLedger){for(const c of fixtureCandles().filter(c=>day(c.start)<date))l.observe('TCS',{candle:c,observedAt:at(date,'09:00'),sourceTime:c.start+FIVE,source:'synthetic baseline',issues:[]});}
function observe(l:PaperLedger,time:string,patch:Partial<Candle>={}){const c=bar(time,patch),now=c.start+FIVE+10_000;l.observe('TCS',{candle:c,observedAt:now,sourceTime:c.start+FIVE,source:'synthetic',issues:[]});return l.tick('TCS',date,now);}
function opening(l:PaperLedger){seed(l);for(const t of ['09:15','09:20','09:25'])observe(l,t);return observe(l,'09:30');}
test('baseline stays identical while range-hold waits for a second completed close then uses the next open',()=>{
 const base=new PaperLedger(':memory:',config()),hold=new PaperLedger(':memory:',config('range-hold'));
 try{assert.equal(opening(base).status,'pending-entry');assert.equal(opening(hold).status,'no-signal');assert.equal(observe(base,'09:35').entry,103);assert.equal(observe(hold,'09:35').status,'pending-entry');const s=observe(hold,'09:40');assert.equal(s.entryAt,at(date,'09:40'));assert.equal(s.entry,103);assert.match(s.strategy,/range-hold/);assert.equal(base.list()[0]!.strategy,'orb-long-v1');}finally{base.close();hold.close();}
});
test('range-failure exit uses next completed-bar open without changing the baseline, and never duplicates on restart',()=>{
 const dir=mkdtempSync(join(tmpdir(),'variant-'));const base=new PaperLedger(':memory:',config());let l=new PaperLedger(join(dir,'paper.sqlite'),config('range-failure-exit'));
 try{opening(base);opening(l);const patch={close:101,low:100};observe(base,'09:35',patch);observe(l,'09:35',patch);l.close();l=new PaperLedger(join(dir,'paper.sqlite'),config('range-failure-exit'));const s=observe(l,'09:40',{open:101.2,low:100,high:104,close:103});assert.equal(s.exitReason,'range_failure_next_open');assert.equal(s.exit,101.2);assert.equal(s.exitAt,at(date,'09:40'));assert.equal(observe(base,'09:40',{open:101.2,low:100,high:104,close:103}).status,'open');const events=l.events(s.id).length;observe(l,'09:40',{open:101.2,low:100,high:104,close:103});assert.equal(l.events(s.id).length,events);}finally{base.close();l.close();rmSync(dir,{recursive:true,force:true});}
});
test('minute recovery requires all five unique valid completed minutes with volume',()=>{
 const start=at(date,'09:30'),candles=Array.from({length:5},(_,i)=>({start:start+i*60000,open:100+i,high:102+i,low:99+i,close:101+i,volume:10}));const batch={candles,fetchedAt:start+FIVE+10000,source:'synthetic minute',candleStartVerified:false,missing:[]};const c=aggregateMinutes(batch,start,batch.fetchedAt)!;assert.deepEqual(c,{start,open:100,high:106,low:99,close:105,volume:50});
 assert.equal(aggregateMinutes({...batch,candles:candles.slice(1)},start,batch.fetchedAt),null);assert.equal(aggregateMinutes({...batch,candles:[...candles.slice(0,4),candles[3]!]},start,batch.fetchedAt),null);assert.equal(aggregateMinutes({...batch,candles:candles.map((c,i)=>i===0?{...c,volume:null}:c)},start,batch.fetchedAt),null);assert.equal(aggregateMinutes(batch,start,start+FIVE-1),null);
 const raw={timestamp:candles.map(c=>c.start/1000),open:candles.map(c=>c.open),high:candles.map(c=>c.high),low:candles.map(c=>c.low),close:candles.map(c=>c.close),volume:candles.map(c=>c.volume)};assert.equal(parseCandles(raw,batch.fetchedAt,'synthetic',false,60000).candles.length,5);assert.throws(()=>parseCandles(raw,batch.fetchedAt,'synthetic',false));
});
test('recovery retries are durable and bounded; reconstructed observations never alter the raw baseline store',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'recover-')),store=new CandleStore(join(dir,'candles.sqlite')),ledger=new PaperLedger(join(dir,'agent.sqlite'),config('agent-recovery'));let now=at(date,'09:36');let calls=0;
 const provider:Provider={source:'synthetic',async instruments(){return {items:[item],fetchedAt:now};},async quote(){throw Error('no orders');},async candles(){calls++;return {candles:[],fetchedAt:now,source:'synthetic',candleStartVerified:false,missing:[]};},async minuteCandles(){calls++;return {candles:Array.from({length:5},(_,i)=>({start:at(date,'09:30')+i*60000,open:100,high:102,low:99,close:101,volume:10})),fetchedAt:now,source:'synthetic',candleStartVerified:false,missing:[]};}};
 let agent=new RecoveryAgent(join(dir,'research.sqlite'),store,provider,[item],date,ledger,()=>now);
 try{const report=await new SessionRecorder(store,provider,[item],date,'mock').poll(now);const selected={...report,instruments:report.instruments.map(i=>({...i,missingSlots:[new Date(at(date,'09:30')).toISOString()]}))};calls=0;
 await agent.recover(selected,1);assert.equal(calls,1);agent.close();agent=new RecoveryAgent(join(dir,'research.sqlite'),store,provider,[item],date,ledger,()=>now);now+=16000;await agent.recover(selected,1);agent.ingest();assert.equal(calls,2);assert.equal(agent.records()[0]!.status,'recovered');assert.equal(store.candles(date,item.securityId).length,0);assert.equal(ledger.db.prepare('SELECT count(*) AS n FROM paper_observations').get()!.n,1);await agent.recover(selected,1);assert.equal(calls,2);
 }finally{agent.close();ledger.close();store.close();rmSync(dir,{recursive:true,force:true});}
});
test('protective observed-price paper exit requires fresh evidence and leaves unknown-path PnL null',()=>{
 const l=new PaperLedger(':memory:',config('agent-recovery')),base=new PaperLedger(':memory:',config());try{opening(l);const s=observe(l,'09:35');const now=at(date,'09:46')+10000;l.tick('TCS',date,now);assert.equal(l.list()[0]!.unknownOutcome,true);const evidence={price:102,sourceTime:now-10000,observedAt:now,reason:'test'};assert.throws(()=>base.protectiveExit('x',evidence,now));assert.throws(()=>l.protectiveExit(s.id,{...evidence,sourceTime:now-61000},now));assert.equal(l.protectiveExit(s.id,evidence,now),true);const p=l.list()[0]!;assert.equal(p.status,'closed');assert.equal(p.exit,102);assert.equal(p.grossPnl,null);assert.equal(p.netPnl,null);assert.equal(p.unknownOutcome,true);assert.equal(l.protectiveExit(s.id,evidence,now),false);}finally{l.close();base.close();}
});
const example:RecoveryCase={id:'case1',symbol:'TCS',gapStart:at(date,'09:30'),positionId:null,mark:null,actionOptions:['block_new_entries','wait_recovery'],evidence:[{id:'gap',kind:'missing_candle',body:{start:at(date,'09:30')}}]};
const decision={caseId:'case1',action:'block_new_entries',reason:'Required signal candle is absent.',evidenceIds:['gap']};
test('LLM output cannot add cases, invent evidence or choose an unauthorized action',()=>{
 assert.equal(validateReviews({reviews:[decision]},[example]).length,1);for(const d of [{...decision,caseId:'other'},{...decision,action:'protective_paper_exit'},{...decision,evidenceIds:['invented']}])assert.throws(()=>validateReviews({reviews:[d]},[example]));assert.throws(()=>validateReviews({reviews:[decision,decision]},[example]));
});
test('Responses reviewer uses fixed endpoint, redacted inputs, strict schema and disabled server storage; errors omit secrets',async()=>{
 const env={OPENAI_API_KEY:'synthetic-secret-api-key',OPENAI_REVIEW_MODEL:'gpt-4.1-mini-2025-04-14'};
 const fetcher:typeof fetch=async(url,init)=>{assert.equal(url,'https://api.openai.com/v1/responses');assert.equal(init!.redirect,'error');const b=JSON.parse(String(init!.body));assert.equal(b.store,false);assert.equal(b.text.format.strict,true);assert.equal(JSON.stringify(b).includes(env.OPENAI_API_KEY),false);assert.equal(b.tools,undefined);return new Response(JSON.stringify({status:'completed',id:'resp_test',usage:{total_tokens:50},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({reviews:[decision]})}]}]}));};
 assert.equal((await requestReview([example],env,fetcher)).decisions.length,1);
 await assert.rejects(()=>requestReview([example],env,async()=>new Response('secret body',{status:401})),/OPENAI_HTTP_401/);
 await assert.rejects(()=>requestReview([example],env,async()=>new Response(JSON.stringify({status:'incomplete'}))),/OPENAI_INCOMPLETE_OR_REFUSED/);
});
test('review submission is nonblocking, durable and deduplicated across restarts',async()=>{
 const db=new DatabaseSync(':memory:');let release!:()=>void,calls=0,applied=0;const wait=new Promise<void>(r=>{release=r;});const env={OPENAI_REVIEW_ENABLED:'true',OPENAI_API_KEY:'synthetic'};
 const fetcher:typeof fetch=async()=>{calls++;await wait;return new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({reviews:[decision]})}]}]}));};let reviewer=new Reviewer(db,date,()=>{applied++;},()=>at(date,'10:00'),env,fetcher);
 reviewer.submit([example]);assert.equal(db.prepare('SELECT status FROM llm_calls').get()!.status,'pending');reviewer.submit([example]);assert.equal(calls,1);release();await reviewer.drain();assert.equal(applied,1);reviewer=new Reviewer(db,date,()=>{},()=>at(date,'10:00'),env,fetcher);reviewer.submit([example]);assert.equal(calls,1);assert.equal(reviewer.snapshot().calls[0]!.status,'completed');db.close();
});
test('watchlist parsers retain only source candidates and validate freeze time, hash and instrument mapping',async()=>{
 assert.deepEqual(parseScreener('<table class="data-table"><tr><td><a href="/company/TCS/consolidated/">TCS</a></td><td><a href="/company/123456/">BSE code</a></td></tr></table>'),['TCS']);assert.throws(()=>parseScreener('<html>changed page</html>'));const scan={slug:'short-term-breakouts',is_private:false,atlas_query:'public query'};assert.equal(chartinkDefinition('<scanner :scan-json="'+JSON.stringify(scan).replace(/"/g,'&quot;')+'"></scanner>'),'public query');
 const dir=mkdtempSync(join(tmpdir(),'watch-')),path=join(dir,'watch.json');try{const w={sessionDate:date,frozenAt:'2026-10-20T15:00:00+00:00',candidates:[{symbol:'TCS',source:'chartink',sourceUrl:'https://chartink.com/screener/short-term-breakouts'}],accepted:[{symbol:'TCS',securityId:'11536',sources:['chartink'],medianObservedTurnover:1e8,medianObservedVolume:1e6}],rejected:[],sources:[],policy:'test',snapshotHash:''};w.snapshotHash=hash({...w,snapshotHash:undefined});writeFileSync(path,JSON.stringify(w));assert.equal((await loadWatchlists(date,[item],path)).instruments.length,1);assert.ok((await loadWatchlists(date,[],path)).error);writeFileSync(path,JSON.stringify({...w,sessionDate:'2026-10-22'}));assert.ok((await loadWatchlists(date,[item],path)).error);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('research cohort wiring survives restart independently and never inserts raw baseline paper states',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'research-cohorts-'));const store=new CandleStore(join(dir,'candles.sqlite'));let now=at(date,'09:35')+10000;
 const provider:Provider={source:'synthetic cohort',async instruments(){return {items:[item],fetchedAt:now};},async quote(){throw Error('no orders');},async candles(id,from,to){return {candles:fixtureCandles().filter(c=>c.start>Date.parse(from)&&c.start<Date.parse(to)),fetchedAt:now,source:this.source,candleStartVerified:false,missing:[]};}};
 for(const d of mockCalendar.sessions.filter(d=>d<date).slice(-20))store.save(d,item,fixtureCandles().filter(c=>day(c.start)===d&&c.start>=at(d,'09:30')&&c.start<at(d,'11:00')),at(date,'09:00'),{source:provider.source,candleStartVerified:false,missing:[]});
 const recorder=new SessionRecorder(store,provider,[item],date,'mock');let research=new ResearchCoordinator(store,provider,[item],[item],date,'mock',config(),dir,null,null,()=>now);
 try{let raw=await recorder.poll(now),r=await research.poll(raw);assert.equal(r.cohorts.length,4);assert.ok(r.cohorts.every(c=>c.states.length===1));assert.equal(r.cohorts.find(c=>c.name==='range-hold')!.states[0]!.status,'no-signal');await research.close();research=new ResearchCoordinator(store,provider,[item],[item],date,'mock',config(),dir,null,null,()=>now);now=at(date,'09:40')+10000;raw=await recorder.poll(now);r=await research.poll(raw);assert.equal(r.cohorts.find(c=>c.name==='screener-orb')!.states[0]!.entry,103);assert.equal(r.cohorts.find(c=>c.name==='range-hold')!.states[0]!.status,'pending-entry');assert.deepEqual(r.errors,[]);
 }finally{await research.close();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('compact reports retain complete baseline evidence in SQLite rather than duplicating it in every poll',()=>{
 const l=new PaperLedger(':memory:',config());try{const state=opening(l);const complete=l.events(state.id).find(e=>e.kind==='research_signal')!;assert.equal(JSON.parse(String(complete.body)).baselineObservations.length,20);const compact=l.snapshot(date,true);const event=compact.events.find(e=>e.kind==='research_signal')!;assert.equal(JSON.parse(String(event.body)).baselineObservationCount,20);assert.equal(JSON.parse(String(event.body)).baselineObservations,undefined);assert.equal(JSON.parse(String(l.events(state.id).find(e=>e.kind==='research_signal')!.body)).baselineObservations.length,20);}finally{l.close();}
});
test('review budget remains exhausted after process restart and never sends request forty-one',()=>{
 const db=new DatabaseSync(':memory:');const env={OPENAI_REVIEW_ENABLED:'true',OPENAI_API_KEY:'synthetic'};let called=0;
 let reviewer=new Reviewer(db,date,()=>{},()=>at(date,'10:00'),env,async()=>{called++;throw Error('must not send');});
 for(let i=0;i<40;i++)db.prepare("INSERT INTO llm_calls VALUES(?,?,?,'failed','[]',NULL,'synthetic failure')").run('prior'+i,date,i);
 reviewer=new Reviewer(db,date,()=>{},()=>at(date,'10:00'),env,async()=>{called++;throw Error('must not send');});reviewer.submit([example]);assert.equal(called,0);assert.equal(reviewer.snapshot().calls.length,40);db.close();
});
test('completed-only polling caches a complete interval but fetches the next one and preserves raw revisions',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'cadence-')),store=new CandleStore(join(dir,'candles.sqlite'));let now=at(date,'09:35')+10000,calls=0;
 const provider:Provider={source:'synthetic cadence',async instruments(){return {items:[item],fetchedAt:now};},async quote(){throw Error('unused');},async candles(id,from,to){calls++;return {candles:fixtureCandles().filter(c=>c.start>Date.parse(from)&&c.start<Date.parse(to)),fetchedAt:now,source:this.source,candleStartVerified:false,missing:[]};}};
 try{const recorder=new SessionRecorder(store,provider,[item],date,'mock',10,undefined,true);await recorder.poll(now);assert.equal(calls,1);now+=15000;await recorder.poll(now);assert.equal(calls,1);now=at(date,'09:40')+10000;await recorder.poll(now);assert.equal(calls,2);assert.equal(store.candles(date,item.securityId).length,5);}finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
