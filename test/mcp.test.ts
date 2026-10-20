import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {InMemoryTransport} from '@modelcontextprotocol/server';
import {createServer} from '../src/server.js';
import {MockProvider,mockCalendar} from '../src/mock.js';
const names=['historical_five_minute_candles','instrument_lookup','opening_range_breakout_analysis','timestamped_quote'];
function data(result:Awaited<ReturnType<Client['callTool']>>){const item=result.content.find(c=>c.type==='text');assert.ok(item&&item.type==='text');return JSON.parse(item.text);}
test('MCP discovery and all four tools via real SDK in-memory transport',async()=>{
 const [clientSide,serverSide]=InMemoryTransport.createLinkedPair();
 const server=createServer(new MockProvider(),mockCalendar,true),client=new Client({name:'fixture-test',version:'1'},{versionNegotiation:{mode:'auto'}});
 await server.connect(serverSide);await client.connect(clientSide);
 try{
  const list=await client.listTools();assert.deepEqual(list.tools.map(t=>t.name).sort(),names);
  for(const t of list.tools)assert.equal(t.annotations?.readOnlyHint,true);
  assert.equal(data(await client.callTool({name:'instrument_lookup',arguments:{query:'MOCK'}})).items[0].securityId,'999001');
  assert.equal(data(await client.callTool({name:'timestamped_quote',arguments:{securityId:'999001'}})).freshness,'mock_only');
  const candles=data(await client.callTool({name:'historical_five_minute_candles',arguments:{securityId:'999001',date:'2026-10-21'}}));assert.equal(candles.candles.length,9);assert.deepEqual(candles.missingData,[]);
  const analysis=data(await client.callTool({name:'opening_range_breakout_analysis',arguments:{securityId:'999001',date:'2026-10-21'}}));assert.equal(analysis.mode,'mock');assert.equal(analysis.currentSignal,false);assert.equal(analysis.liveConnected,false);assert.equal(analysis.status,'exact_vwap_unverified');assert.equal(analysis.validSignal,false);assert.equal(analysis.qualification,'unverified');assert.equal(analysis.signal,null);assert.equal(analysis.trade,null);assert.equal(analysis.approximateAnalysis.status,'simulated_open');assert.equal(analysis.approximateAnalysis.qualifiesUnderApproximateModel,true);
  const pending=data(await client.callTool({name:'opening_range_breakout_analysis',arguments:{securityId:'999001',date:'2026-10-21',asOf:'2026-10-21T09:35:00+05:30'}}));
  assert.equal(pending.validSignal,false);assert.equal(pending.currentSignal,false);assert.equal(pending.signal,null);assert.equal(pending.approximateAnalysis.status,'signal_pending_next_completed_candle');assert.equal(pending.approximateAnalysis.hypotheticalTrade,null);
  const future=await client.callTool({name:'opening_range_breakout_analysis',arguments:{securityId:'999001',date:'2026-10-21',asOf:'2026-10-21T10:01:00+05:30'}});assert.equal(future.isError,true);assert.equal(data(future).validSignal,false);assert.equal(data(future).code,'INVALID_FUTURE_AS_OF');
  const invalid=await client.callTool({name:'timestamped_quote',arguments:{securityId:'1'}});assert.equal(invalid.isError,true);assert.equal(data(invalid).validSignal,false);
 }finally{await client.close();await server.close();}
});
test('stdio subprocess discovers tools and calls synthetic quote without credentials',async()=>{
 const transport=new StdioClientTransport({command:process.execPath,args:['--import','tsx','src/stdio.ts'],env:{DHAN_MODE:'mock'},stderr:'pipe'});
 const client=new Client({name:'stdio-test',version:'1'},{versionNegotiation:{mode:'auto'}});
 try{await client.connect(transport);assert.deepEqual((await client.listTools()).tools.map(t=>t.name).sort(),names);assert.equal(data(await client.callTool({name:'timestamped_quote',arguments:{securityId:'999001'}})).simulatedOnly,true);}
 finally{await client.close();await transport.close();}
});
