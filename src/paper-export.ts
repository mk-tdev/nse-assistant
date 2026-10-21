import { DatabaseSync } from 'node:sqlite';
// Read-only export for assistant-led review. No network listener or Notion publisher.
const file=process.argv[2];
if(!file) throw new Error('Usage: node dist/paper-export.js PATH_TO_PAPER_SQLITE');
const db=new DatabaseSync(file,{readOnly:true});
try {
  const states=db.prepare('SELECT body FROM paper_states ORDER BY id').all() as {body:string}[];
  const events=db.prepare('SELECT * FROM paper_events ORDER BY id').all();
  const observations=db.prepare('SELECT symbol,start,fingerprint,observed_at,body FROM paper_observations ORDER BY rowid').all();
  process.stdout.write(JSON.stringify({exportedAt:new Date().toISOString(),simulatedOnly:true,exactQualification:false,states:states.map(s=>JSON.parse(s.body)),events,observations},null,2)+'\n');
} finally { db.close(); }
