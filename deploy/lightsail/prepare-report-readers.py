"""Initialize SQLite WAL reader metadata after the writer exits; price tables stay read-only."""
import sqlite3,pathlib,os
root=pathlib.Path('/var/lib/nse-recorder')
for path in [root/'candles.sqlite',*root.glob('paper*.sqlite')]:
    if not path.is_file(): continue
    with sqlite3.connect('file:'+str(path)+'?mode=ro',uri=True) as db:
        db.execute('PRAGMA schema_version').fetchone()
    st=path.stat()
    for suffix in ['-shm','-wal']:
        metadata=pathlib.Path(str(path)+suffix)
        if metadata.exists():
            os.chown(metadata,st.st_uid,st.st_gid)
            metadata.chmod(0o600)
