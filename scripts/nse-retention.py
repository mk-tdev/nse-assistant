#!/usr/bin/env python3
"""Conservative AWS retention. Default is dry-run; no trading/quote/evidence ledgers are pruned."""
import argparse,datetime as dt,fcntl,gzip,hashlib,json,os,pathlib,re,shutil,sqlite3,subprocess,tarfile,time
P=pathlib.Path
DATA=P('/var/lib/nse-recorder');STATE=P('/var/lib/nse-retention');BACKUPS=P('/var/backups/nse-recorder')
OFFLINE_NAMES=['nse-budget-review-smoke-20261021','nse-paper-mockcheck-93b4d90','nse-paper-livecheck-93b4d90','nse-midday-rehearsal','nse-strategy-lab-validation-20261023','nse-strategy-lab-validation-final-20261023','nse-early-exit-validation-20261021','nse-early-exit-preflight-20261022','nse-extensions-preflight-20261022','nse-final-preflight-20261022','nse-reasoning-budget-preflight-20261022','nse-capacity-20261021']
STAGING=P('/var/tmp/nse-data-export-20261028T124515Z')

def emit(event,**values):print(json.dumps({'event':event,**values}),flush=True)
def sha(path):
 h=hashlib.sha256()
 with open(path,'rb') as f:
  for b in iter(lambda:f.read(512*1024),b''):h.update(b)
 return h.hexdigest()
def connect(path,write=False):
 c=sqlite3.connect(('file:'+str(path)+'?mode=rw') if write else ('file:'+str(path)+'?mode=ro'),uri=True,timeout=5)
 c.execute('PRAGMA cache_size=-4096');c.execute('PRAGMA temp_store=FILE')
 # A privileged read must not leave newly created WAL sidecars unreadable to the app.
 if os.geteuid()==0:
  owner=path.stat()
  for suffix in ['-wal','-shm']:
   sidecar=P(str(path)+suffix)
   if sidecar.exists() and sidecar.stat().st_uid==0 and owner.st_uid!=0:os.chown(sidecar,owner.st_uid,owner.st_gid);os.chmod(sidecar,owner.st_mode & 0o777)
 return c
def durable_json(path,value):
 path.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
 with open(str(path)+'.tmp','w') as f:os.chmod(f.name,0o600);json.dump(value,f,indent=2);f.flush();os.fsync(f.fileno())
 os.replace(str(path)+'.tmp',path)
def tree_size(path):return sum(p.stat().st_size for p in path.rglob('*') if p.is_file() and not p.is_symlink())
def busy(path):
 prefix=str(path.resolve());hits=[]
 for proc in P('/proc').glob('[0-9]*'):
  for f in [proc/'cwd',*list((proc/'fd').glob('*'))]:
   try:target=os.readlink(f).removesuffix(' (deleted)')
   except (OSError,PermissionError):continue
   if target==prefix or target.startswith(prefix+'/'):hits.append(proc.name);break
  try:
   if any(line.rstrip().endswith(prefix) or (' '+prefix+'/') in line for line in (proc/'maps').read_text().splitlines()):hits.append(proc.name)
  except (OSError,PermissionError):pass
 return sorted(set(hits))
def service_refs(path):
 needle=str(path);refs=[]
 for unit in P('/etc/systemd/system').glob('nse-*'):
  if unit.is_file() and needle in unit.read_text():refs.append(unit.name)
 ids=subprocess.check_output(['docker','ps','-aq'],text=True).split()
 if ids:
  for container in json.loads(subprocess.check_output(['docker','inspect',*ids],text=True)):
   for mount in container.get('Mounts',[]):
    source=mount.get('Source','')
    if source and (source==needle or source.startswith(needle+'/') or needle.startswith(source+'/')):refs.append(container['Name'])
 return refs

def offline_archive(path,run,apply):
 if not path.exists():return
 if path.is_symlink() or any(p.is_symlink() or (not p.is_file() and not p.is_dir()) for p in path.rglob('*')):raise RuntimeError('Unsafe offline tree: '+str(path))
 refs=service_refs(path);users=busy(path)
 if refs or users:emit('offline_skipped_in_use',path=str(path),references=refs,pids=users);return
 size=tree_size(path);emit('offline_archive_plan',path=str(path),bytes=size)
 if not apply:return
 # These are inactive snapshots; preserve every byte before removing the expanded copy.
 inventory={str(p.relative_to(path)):{'sha256':sha(p),'bytes':p.stat().st_size,'mtimeNs':p.stat().st_mtime_ns} for p in path.rglob('*') if p.is_file()}
 archive=STATE/'offline-archives'/(path.name+'-'+run+'.tar.gz');archive.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
 with tarfile.open(archive,'w:gz',compresslevel=1) as tar:tar.add(path,arcname=path.name)
 archive.chmod(0o600);seen=set()
 with tarfile.open(archive,'r:gz') as tar:
  for member in tar:
   if not member.isfile():continue
   relative=str(P(member.name).relative_to(path.name));h=hashlib.sha256();f=tar.extractfile(member)
   for block in iter(lambda:f.read(512*1024),b''):h.update(block)
   if relative not in inventory or h.hexdigest()!=inventory[relative]['sha256']:raise RuntimeError('Offline archive mismatch')
   seen.add(relative)
 if seen!=set(inventory):raise RuntimeError('Incomplete offline archive')
 if busy(path) or service_refs(path):raise RuntimeError('Offline tree became active; source kept')
 if {str(p.relative_to(path)) for p in path.rglob('*') if p.is_file()}!=set(inventory):raise RuntimeError('Offline source file list changed; source kept')
 for rel,v in inventory.items():
  f=path/rel
  if f.stat().st_size!=v['bytes'] or f.stat().st_mtime_ns!=v['mtimeNs']:raise RuntimeError('Offline source changed; source kept')
 if path.parent==P('/var/lib'):
  summaries=STATE/'validation-summaries'/path.name;summaries.mkdir(mode=0o700,parents=True,exist_ok=True)
  for rel,v in inventory.items():
   if rel.endswith('.json') and v['bytes']<=8*1024*1024:
    target=summaries/rel;target.parent.mkdir(mode=0o700,parents=True,exist_ok=True);shutil.copy2(path/rel,target);target.chmod(0o600)
 manifest={'source':str(path),'archive':str(archive),'archiveSha256':sha(archive),'expandedBytes':size,'archiveBytes':archive.stat().st_size,'verifiedFiles':inventory,'restore':'Extract into a staging directory, verify manifest file hashes, then restore deliberately. Never overwrite live budget/control databases with an old snapshot.'}
 durable_json(P(str(archive)+'.manifest.json'),manifest)
 shutil.rmtree(path);emit('offline_archived',source=str(path),archive=str(archive),freedBytes=size-archive.stat().st_size,files=len(inventory))

def protected_sessions():
 pins=set();pins_file=STATE/'pins.json'
 if pins_file.exists():pins.update(json.loads(pins_file.read_text())['sessions'])
 sources=[(p,'paper_states') for p in DATA.glob('paper*.sqlite')]
 sources += [(P('/var/lib')/f/'strategy-lab.sqlite','lab_positions') for f in ['nse-strategy-lab','nse-agent-trading','nse-agent-trading/shadow']]
 sources.append((P('/var/lib/nse-paper-controls/console.sqlite'),'manual_positions'))
 for path,table in sources:
  if not path.exists():continue
  c=connect(path)
  try:
   for row, in c.execute('SELECT body FROM '+table):
    state=json.loads(row)
    if state.get('unknownOutcome') or state.get('status') in ['open','pending','pending-entry']:
     session=state.get('session')
     if session:pins.add(session)
  finally:c.close()
 return pins

def canonical_digest(c):
 result={}
 for table, in c.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'polls' ORDER BY name"):
  count=0;h=hashlib.sha256();quoted='"'+table.replace('"','""')+'"'
  for row in c.execute('SELECT * FROM '+quoted+' ORDER BY rowid'):
   h.update(json.dumps(row,separators=(',',':')).encode());h.update(b'\n');count+=1
  result[table]={'rows':count,'sha256':h.hexdigest()}
 return result

def compact_recovery(run):
 output=STATE/'recovery'/('candles-canonical-'+run+'.sqlite');output.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
 source=connect(DATA/'candles.sqlite');source.execute('BEGIN');dest=sqlite3.connect(output);output.chmod(0o600)
 try:
  schemas=list(source.execute("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END"))
  for kind,name,sql in schemas:
   if kind!='table':continue
   dest.execute(sql);columns=len(source.execute('PRAGMA table_info("'+name.replace('"','""')+'")').fetchall());quoted='"'+name.replace('"','""')+'"'
   query='SELECT * FROM '+quoted
   if name=='polls':query+=' WHERE id IN (SELECT max(id) FROM polls GROUP BY session)'
   cursor=source.execute(query)
   while True:
    rows=cursor.fetchmany(32)
    if not rows:break
    dest.executemany('INSERT INTO '+quoted+' VALUES('+','.join(['?']*columns)+')',rows)
  for kind,name,sql in schemas:
   if kind!='table':dest.execute(sql)
  dest.commit()
  if dest.execute('PRAGMA quick_check').fetchone()[0]!='ok':raise RuntimeError('Recovery integrity failed')
  protected=canonical_digest(source)
  if canonical_digest(dest)!=protected:raise RuntimeError('Canonical recovery mismatch')
  retained=list(source.execute('SELECT session,max(id) FROM polls GROUP BY session'))
 finally:dest.close();source.close()
 checksum=sha(output);compressed=P(str(output)+'.gz')
 with open(output,'rb') as src,gzip.open(compressed,'wb',compresslevel=1) as target:shutil.copyfileobj(src,target,512*1024)
 compressed.chmod(0o600);h=hashlib.sha256()
 with gzip.open(compressed,'rb') as f:
  for b in iter(lambda:f.read(512*1024),b''):h.update(b)
 if h.hexdigest()!=checksum:raise RuntimeError('Recovery compression mismatch')
 durable_json(P(str(compressed)+'.manifest.json'),{'source':str(DATA/'candles.sqlite'),'archive':str(compressed),'archiveSha256':sha(compressed),'sqliteSha256':checksum,'canonicalTables':protected,'retainedFinalOrLatestPollIds':retained,'scope':'Every canonical candle, revision, batch provenance, fetch and metadata row; one latest polling report per session. Intermediate diagnostics are not part of this compact copy; production retains seven days and protects unresolved/pinned dates. Other production ledgers remain untouched.'})
 output.unlink();emit('canonical_recovery_verified',path=str(compressed),bytes=compressed.stat().st_size);return protected

def research_export(run):
 """Portable current research snapshot; credentials and intermediate poll copies excluded."""
 folder=STATE/'exports'/('research-'+run);folder.mkdir(mode=0o700,parents=True,exist_ok=True)
 canonical=STATE/'recovery'/('candles-canonical-'+run+'.sqlite.gz')
 for path in [canonical,P(str(canonical)+'.manifest.json')]:shutil.copy2(path,folder/path.name)
 sources=[('recorder-'+p.name,p) for p in DATA.glob('*.sqlite') if p.name not in ['candles.sqlite','collector-lock.sqlite']]
 sources += [('lab-'+p.name,p) for p in P('/var/lib/nse-strategy-lab').glob('*.sqlite')]
 sources += [('agent-'+p.name,p) for p in P('/var/lib/nse-agent-trading').glob('*.sqlite')]
 sources += [('shadow-'+p.name,p) for p in P('/var/lib/nse-agent-trading/shadow').glob('*.sqlite')]
 sources += [('budget-'+p.name,p) for p in P('/var/lib/nse-agent-budget').glob('*.sqlite')]
 sources += [('controls-'+p.name,p) for p in P('/var/lib/nse-paper-controls').glob('*.sqlite')]
 inventories={}
 for name,path in sources:
  target=folder/name;source=connect(path);destination=sqlite3.connect(target);target.chmod(0o600)
  try:
   source.execute('BEGIN');source.execute('SELECT count(*) FROM sqlite_master').fetchone();source.backup(destination,pages=128,sleep=.01)
   destination.execute('PRAGMA journal_mode=DELETE');destination.execute('PRAGMA cache_size=-4096');destination.execute('PRAGMA temp_store=FILE')
   if destination.execute('PRAGMA quick_check').fetchone()[0]!='ok':raise RuntimeError('Research snapshot integrity failed: '+name)
   tables=[row[0] for row in source.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
   counts={}
   for table in tables:
    quoted='"'+table.replace('"','""')+'"';a=source.execute('SELECT count(*) FROM '+quoted).fetchone()[0];b=destination.execute('SELECT count(*) FROM '+quoted).fetchone()[0]
    if a!=b:raise RuntimeError('Research snapshot table mismatch: '+name+'/'+table)
    counts[table]=a
   inventories[name]={'source':str(path),'tables':counts}
  finally:destination.close();source.close()
  expected=sha(target);compressed=P(str(target)+'.gz')
  with open(target,'rb') as src,gzip.open(compressed,'wb',compresslevel=1) as out:shutil.copyfileobj(src,out,512*1024)
  compressed.chmod(0o600);h=hashlib.sha256()
  with gzip.open(compressed,'rb') as f:
   for b in iter(lambda:f.read(512*1024),b''):h.update(b)
  if h.hexdigest()!=expected:raise RuntimeError('Research snapshot compression mismatch: '+name)
  inventories[name].update({'sqliteSha256':expected,'archiveSha256':sha(compressed)});target.unlink();emit('research_ledger_exported',name=name,bytes=compressed.stat().st_size)
 for path in DATA.glob('????-??-??*.json'):shutil.copy2(path,folder/('recorder-'+path.name))
 # Capture complete health-log lines up to each file's initial byte length.
 for path in DATA.glob('quote-health-*.jsonl'):
  limit=path.stat().st_size;remaining=limit;target=folder/(path.name+'.gz')
  with open(path,'rb') as source,gzip.open(target,'wb',compresslevel=1) as out:
   while remaining>0:
    line=source.readline(remaining);remaining-=len(line)
    if not line:break
    if line.endswith(b'\n'):out.write(line)
  target.chmod(0o600)
 for path in DATA.glob('quote-health-*.jsonl.gz'):shutil.copy2(path,folder/path.name)
 allowed={'PAPER_ENABLED','PAPER_MODE','PAPER_QUANTITY','PAPER_SCREENER_QUANTITY','PAPER_CALENDAR_PATH','PAPER_ACCEPT_SCHEDULED_CALENDAR','PAPER_ACCEPT_START_LABELS','PAPER_MAX_OBSERVATION_DELAY_SECONDS','PAPER_FEES_PER_SIDE','PAPER_SLIPPAGE_BPS','PAPER_RESEARCH_ENABLED','PAPER_EXIT_TIME_IST','RECORDER_UNIVERSE','RECORDER_UNIVERSE_PATH','RECORDER_WATCHLIST_PATH','RECORDER_FETCH_COMPLETED_ONLY','RECORDER_POLL_INTERVAL_SECONDS','OPENAI_REVIEW_MODEL','OPENAI_REVIEW_REASONING_EFFORT','OPENAI_REVIEW_DAILY_BUDGET_USD'}
 safe_config={}
 for path in [P('/etc/nse-assistant/paper.env'),P('/etc/nse-assistant/reviewer.env')]:
  if path.is_file():
   for line in path.read_text().splitlines():
    key,sep,value=line.partition('=')
    if sep and key.strip() in allowed:safe_config[key.strip()]=value.strip()
 durable_json(folder/'non-secret-settings.json',safe_config)
 for path in P('/opt/nse-assistant/deploy/lightsail').glob('*.json'):shutil.copy2(path,folder/('config-'+path.name))
 for prefix,path in [('lab-registry',P('/var/lib/nse-strategy-lab/registry.json')),('agent-status',P('/var/lib/nse-agent-trading/status.json')),('agent-news',P('/var/lib/nse-agent-trading/news.json'))]:
  if path.is_file():shutil.copy2(path,folder/(prefix+'.json'))
 images={}
 for name in ['nse-recorder','nse-quotes','nse-strategy-lab','nse-paper-console','nse-agent-trading','nse-reports']:
  r=subprocess.run(['docker','inspect',name],capture_output=True,text=True)
  if r.returncode==0:
   row=json.loads(r.stdout)[0];images[name]={'image':row['Config']['Image'],'imageId':row['Image']}
 manifest={'createdAt':dt.datetime.now(dt.timezone.utc).isoformat(),'ledgers':inventories,'images':images,'files':{p.name:sha(p) for p in folder.iterdir() if p.is_file()},'scope':'Canonical candle/provenance copy with final/latest report per session; all paper states/events/observations/baselines, lab/agent/shadow quotes and decisions, research/backfill evidence, model reservations, control audit, quote-health logs and explicitly allowlisted non-secret settings. Each SQLite snapshot is individually transaction-consistent; independent workers have separate capture times. No provider keys, .env files or credential backups are included. Intermediate polling reports remain in hot storage or verified poll archives, not this compact export. Old offline recovery archives are separate and may contain protected configuration. Never restore budget/control snapshots over a running system.'}
 durable_json(folder/'manifest.json',manifest)
 archive=P(str(folder)+'.tar')
 with tarfile.open(archive,'w') as tar:tar.add(folder,arcname=folder.name)
 archive.chmod(0o600);expected={p.name:sha(p) for p in folder.iterdir() if p.is_file()};seen=set()
 with tarfile.open(archive,'r') as tar:
  for member in tar:
   if not member.isfile():continue
   name=P(member.name).name;h=hashlib.sha256();f=tar.extractfile(member)
   for b in iter(lambda:f.read(512*1024),b''):h.update(b)
   if name not in expected or h.hexdigest()!=expected[name]:raise RuntimeError('Research bundle verification failed')
   seen.add(name)
 if seen!=set(expected):raise RuntimeError('Research bundle is incomplete')
 durable_json(P(str(archive)+'.manifest.json'),{**manifest,'archive':str(archive),'archiveSha256':sha(archive),'bytes':archive.stat().st_size})
 shutil.rmtree(folder);emit('research_export_verified',path=str(archive),bytes=archive.stat().st_size)

def polling_plan(c,cutoff,pins):
 groups={}
 # Never GROUP BY report_json: sorting multi-GB payloads can exhaust a small host.
 for id,session,observed,bytes_ in c.execute('SELECT id,session,observed_at,length(CAST(report_json AS BLOB)) FROM polls'):
  g=groups.setdefault(session,{'count':0,'bytes':0,'latestId':id});g['count']+=1;g['bytes']+=bytes_;g['latestId']=max(g['latestId'],id)
 eligible=[]
 for session,g in sorted(groups.items()):
  if not re.fullmatch(r'\d{4}-\d{2}-\d{2}',session) or session>=cutoff or session in pins:continue
  try:
   raw=c.execute('SELECT report_json FROM polls WHERE id=?',(g['latestId'],)).fetchone()[0];r=json.loads(raw);file=DATA/(session+'.json');disk=json.loads(file.read_text());observed=dt.datetime.fromisoformat(r['observedAt'].replace('Z','+00:00'));close=dt.datetime.fromisoformat(session+'T15:35:00+05:30')
   if r.get('sessionDate')!=session or r.get('mode')!='live' or r.get('phase')!='after_close' or observed<close or dt.datetime.now(dt.timezone.utc)<close+dt.timedelta(hours=1) or r!=disk:continue
   if g['count']>1:eligible.append({'session':session,**g,'finalReportSha256':sha(file)})
  except (OSError,ValueError,KeyError,TypeError):continue
 return groups,eligible

def archive_polls(c,plan,run):
 session=plan['session'];output=STATE/'poll-archives'/(session+'-'+run+'.jsonl.gz');output.parent.mkdir(mode=0o700,parents=True,exist_ok=True);count=0;h=hashlib.sha256()
 with gzip.open(output,'wb',compresslevel=1) as f:
  for row in c.execute('SELECT id,session,observed_at,report_json FROM polls WHERE session=? AND id<>?',(session,plan['latestId'])):
   line=(json.dumps(row,separators=(',',':'))+'\n').encode();f.write(line);h.update(line);count+=1
 output.chmod(0o600);check=hashlib.sha256();rows=0
 with gzip.open(output,'rb') as f:
  for line in f:check.update(line);rows+=1
 if rows!=count or check.digest()!=h.digest() or count!=plan['count']-1:raise RuntimeError('Polling archive verification failed')
 durable_json(P(str(output)+'.manifest.json'),{**plan,'removedRows':count,'archiveSha256':sha(output),'uncompressedSha256':h.hexdigest(),'format':'JSONL arrays [id, session, observed_at, report_json]. Restore through SQLite parameters; do not execute content as code.'})
 c.execute('BEGIN IMMEDIATE')
 try:
  deleted=c.execute('DELETE FROM polls WHERE session=? AND id<>?',(session,plan['latestId'])).rowcount
  if deleted!=count:raise RuntimeError('Concurrent polling change')
  c.commit()
 except Exception:c.rollback();raise
 emit('polls_archived',session=session,rows=count,archive=str(output))

def compress_logs(cutoff,pins,apply):
 for path in DATA.glob('quote-health-????-??-??.jsonl'):
  session=path.name[len('quote-health-'):-len('.jsonl')]
  if session>=cutoff or session in pins or busy(path):continue
  emit('health_log_plan',path=str(path),bytes=path.stat().st_size)
  if not apply:continue
  target=P(str(path)+'.gz')
  if target.exists():continue
  with open(path,'rb') as src,gzip.open(target,'wb',compresslevel=1) as dest:shutil.copyfileobj(src,dest,512*1024)
  target.chmod(0o600);h=hashlib.sha256()
  with gzip.open(target,'rb') as f:
   for b in iter(lambda:f.read(512*1024),b''):h.update(b)
  if h.hexdigest()!=sha(path) or busy(path):raise RuntimeError('Health log compression mismatch or active file')
  durable_json(P(str(target)+'.manifest.json'),{'source':str(path),'sha256':h.hexdigest(),'archiveSha256':sha(target)})
  path.unlink();emit('health_log_compressed',path=str(target))

def main():
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--apply',action='store_true');parser.add_argument('--offline',action='store_true',help='One-time archive of the explicit obsolete validation/backup inventory');parser.add_argument('--recovery-copy',action='store_true');parser.add_argument('--research-export',action='store_true',help='On-demand compact research bundle; no provider keys');parser.add_argument('--compact',action='store_true',help='One-time physical candle DB compaction; recorder must be inactive')
 args=parser.parse_args();os.umask(0o077);STATE.mkdir(mode=0o700,parents=True,exist_ok=True)
 with open(STATE/'cleanup.lock','a') as lock:
  try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except BlockingIOError:emit('skipped',reason='another cleanup run is active');return
  run=dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ');before=shutil.disk_usage(DATA);cutoff=(dt.datetime.now(dt.timezone(dt.timedelta(hours=5,minutes=30))).date()-dt.timedelta(days=7)).isoformat();audit={'run':run,'apply':args.apply,'beforeFreeBytes':before.free,'cutoffExclusive':cutoff}
  try:
   if args.offline:
    if STAGING.exists():
     users=busy(STAGING);refs=service_refs(STAGING);emit('interrupted_export_plan',path=str(STAGING),bytes=tree_size(STAGING),pids=users,references=refs)
     if args.apply and not users and not refs and not STAGING.is_symlink():shutil.rmtree(STAGING);emit('interrupted_export_removed',path=str(STAGING))
    for path in [P('/var/lib')/n for n in OFFLINE_NAMES]+sorted(p for p in BACKUPS.iterdir() if p.is_dir() and not p.is_symlink()):offline_archive(path,run,args.apply)
   pins=protected_sessions();audit['protectedSessions']=sorted(pins)
   with open('/run/lock/nse-recorder-cloud.lock','a') as collector:
    try:fcntl.flock(collector,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError:emit('poll_cleanup_skipped',reason='collector is active');return
    if subprocess.run(['systemctl','is-active','--quiet','nse-recorder']).returncode==0:raise RuntimeError('Recorder service is active')
    c=connect(DATA/'candles.sqlite',args.apply)
    try:
     groups,eligible=polling_plan(c,cutoff,pins);audit['pollingInventory']=groups;audit['eligibleSessions']=eligible;emit('polling_plan',cutoffExclusive=cutoff,protectedSessions=sorted(pins),eligible=eligible)
     protected=compact_recovery(run) if args.apply and (eligible or args.recovery_copy or args.research_export or args.compact) else None
     if args.apply:
      for plan in eligible:
       if plan['session'] in protected_sessions():emit('polls_skipped_new_pin',session=plan['session']);continue
       archive_polls(c,plan,run)
      if protected is not None and canonical_digest(c)!=protected:raise RuntimeError('Canonical data verification failed')
      if c.execute('PRAGMA quick_check').fetchone()[0]!='ok':raise RuntimeError('Candle database integrity failed')
      if args.compact:
       if [pid for pid in busy(DATA/'candles.sqlite') if pid!=str(os.getpid())]:raise RuntimeError('Candle database has active readers; compaction deferred')
       checkpoint=c.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone()
       if checkpoint[0]!=0:raise RuntimeError('Checkpoint is busy; no compaction')
       if shutil.disk_usage(DATA).free<(DATA/'candles.sqlite').stat().st_size*2:raise RuntimeError('Insufficient compaction headroom')
       c.execute('VACUUM')
       if c.execute('PRAGMA quick_check').fetchone()[0]!='ok':raise RuntimeError('Post-compaction integrity failed')
       if protected is not None and canonical_digest(c)!=protected:raise RuntimeError('Post-compaction canonical mismatch')
       emit('candle_database_compacted',bytes=(DATA/'candles.sqlite').stat().st_size)
    finally:c.close()
    if args.apply and args.research_export:research_export(run)
   compress_logs(cutoff,pins,args.apply);audit['success']=True
  except Exception as e:audit['success']=False;audit['error']=str(e);raise
  finally:
   audit['afterFreeBytes']=shutil.disk_usage(DATA).free;audit['netFilesystemFreeChangeBytes']=audit['afterFreeBytes']-before.free;durable_json(STATE/'audits'/(run+'.json'),audit);emit('cleanup_audit',**audit)
if __name__=='__main__':main()
