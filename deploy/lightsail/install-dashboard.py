import json,sys,subprocess,pathlib,os,shutil
cfg=json.load(sys.stdin)
app=pathlib.Path('/home/ubuntu/nse-dashboard/app')
subprocess.run(['docker','image','inspect','nse-dashboard:local'],check=True,stdout=subprocess.DEVNULL)
backup=pathlib.Path('/var/backups/nse-recorder/pre-dashboard-20261022');backup.mkdir(parents=True,exist_ok=True);backup.chmod(0o700)
for name in ['nse-reports.service','nse-recorder.service','nse-recorder.timer']:
 target=backup/name
 if not target.exists():shutil.copy2('/etc/systemd/system/'+name,target)
subprocess.run(['docker','tag','nse-recorder:local','nse-recorder:pre-dashboard-20261022'],check=True)
hashed=subprocess.run(['caddy','hash-password'],input=(cfg['password']+'\n').encode(),check=True,stdout=subprocess.PIPE).stdout.decode().strip()
caddy='''nse-assistant.pixeltrendanalytics.com {
 encode zstd gzip
 header {
  X-Robots-Tag "noindex, nofollow, noarchive"
  Strict-Transport-Security "max-age=31536000"
 }
 basic_auth {
  mk HASHED_PASSWORD
 }
 reverse_proxy 127.0.0.1:8787 {
  header_up -Authorization
 }
}
'''.replace('HASHED_PASSWORD',hashed)
p=pathlib.Path('/etc/caddy/Caddyfile');p.write_text(caddy);os.chown(p,0,__import__('grp').getgrnam('caddy').gr_gid);p.chmod(0o640)
subprocess.run(['caddy','validate','--config',str(p)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
unit=(app/'deploy/lightsail/nse-reports.service').read_text().replace('nse-recorder:local','nse-dashboard:local')
pathlib.Path('/etc/systemd/system/nse-reports.service').write_text(unit)
shutil.copy2(app/'deploy/lightsail/nse-quotes.service','/etc/systemd/system/nse-quotes.service')
p=pathlib.Path('/var/lib/nse-recorder/dashboard-config.json')
p.write_text(json.dumps({'model':'gpt-5.6-luna','reasoningEffort':'low','dailyBudgetUsd':1,'universe':'Nifty 50 + frozen screener additions','schedule':'Collection 11:35–18:05 Singapore; quotes 11:45–18:00; paper exit confirmed after 17:45','region':'ap-southeast-1','paperOnly':True})+'\n');os.chown(p,1000,1000);p.chmod(0o600)
subprocess.run(['systemctl','daemon-reload'],check=True)
subprocess.run(['systemctl','restart','nse-reports.service'],check=True)
subprocess.run(['systemctl','enable','--now','nse-quotes.service','caddy'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
print('Dashboard, quote snapshots and authenticated HTTPS enabled. Recorder image and ledgers preserved. No credential values displayed.')
