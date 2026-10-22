// Read-only exploratory diagnostics. No network calls, broker credentials or mutations.
import {readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {sessionUniverse,sessionBars,liveCandidates} from '../dist/strategy-lab-data.js';
import {openingSelection} from '../dist/strategy-selection.js';
import {labStrategies} from '../dist/strategy-registry.js';
const dir=process.argv[2],session=process.argv[3];if(!dir||!/^\d{4}-\d{2}-\d{2}$/.test(session??''))throw Error('Usage: DATA_DIR YYYY-MM-DD');
const calendar=JSON.parse(await readFile(new URL('../deploy/lightsail/calendar-paper-2026.json',import.meta.url),'utf8')).sessions;
const previous=calendar.filter(d=>d<session).sort().slice(-20),universe=await sessionUniverse(dir,session),bars=sessionBars(dir,session,universe.symbols,previous),freeze=Date.parse(session+'T09:31:00+05:30'),selection=openingSelection(session,universe.symbols,bars.current,bars.history,previous,labStrategies[0].selection,freeze),candidates=liveCandidates(dir,session),states=[];
for(const file of ['paper.sqlite','paper-screener-orb.sqlite']){const db=new DatabaseSync(join(dir,file),{readOnly:true});try{states.push(...db.prepare('SELECT body FROM paper_states').all().map(r=>JSON.parse(r.body)).filter(s=>s.session===session&&s.entry!==null));}finally{db.close();}}
const groups=[['Nifty50',s=>universe.nifty.includes(s.symbol)],['Screeners',s=>universe.screeners.includes(s.symbol)],['Opening selector',s=>selection.some(r=>r.symbol===s.symbol&&r.eligible)],['Extension cap',s=>candidates.some(c=>c.symbol===s.symbol&&c.extension<=1)]];
const summary=groups.map(([name,pick])=>{const chosen=states.filter(pick),known=chosen.filter(s=>s.grossPnl!==null&&!s.unknownOutcome);return {name,entries:chosen.length,known:known.length,grossOneShareSubtotal:known.reduce((n,s)=>n+s.grossPnl,0),meanGrossR:known.length?known.reduce((n,s)=>n+s.grossPnl/((s.entry-s.stop)*s.quantity),0)/known.length:null};});
console.log(JSON.stringify({session,warning:'Post-hoc exploratory selection diagnostic; thresholds designed after observing 22 October. Reuses original bar-fill outcomes for inspection only, not quote-based returns or out-of-sample evidence. Opening inputs are final stored bar versions; original pre-cutoff versions not independently reconstructed.',selectionEvidence:universe.selectionEvidence,summary,selected:selection.filter(r=>r.eligible),rejectionCounts:Object.fromEntries([...new Set(selection.map(r=>r.reason))].map(reason=>[reason,selection.filter(r=>r.reason===reason).length])),candidateExtensions:candidates.map(c=>({symbol:c.symbol,extension:c.extension,relativeVolume:c.relativeVolume})),selection},null,2));
