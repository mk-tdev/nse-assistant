# Trading-data cleanup: preservation policy and runbook

Reviewed and implemented 28 October 2026. This replaces the recommendation-only cleanup proposal for operational use.

## What must survive until strategy research is complete

Keep all recorded sessions indefinitely. This includes:

- Every strategy's entered/pending/closed state, actual entry/exit timing and prices, quantities, stops/targets, costs, P&L, configurations, events and unresolved outcome flags.
- Agent approvals, WAIT/SKIP decisions, original input/news evidence, reasoning, model usage, and separate shadow outcomes.
- All quote observations in the strategy, agent and shadow stores, including source and receipt timestamps. Candles and P&L cannot reconstruct quote fills.
- All candles, first/last observation metadata, revisions, batch provenance, historical baselines, EMA warm-up and volume-history inputs.
- One final/latest report per session, frozen watchlists, calendars, code/image identifiers, control audit and current spending-counter continuity.

The cleanup job does **not** delete strategy decisions, quote journals, paper events, observations, baselines, agent/news records, candles, revisions, backfill history or budget/control records. The existing comparison, historical charts, backtests and post-session verification keep reading their original production stores.

## What was safe to remove now

The abandoned `/var/tmp/nse-data-export-20261028T124515Z` was confirmed unused and removed. It was an incomplete export, not a valid recovery point.

Twelve explicitly named inactive validation/preflight/rehearsal directories and the old rollback backup directories were replaced with complete compressed archives. Every archived regular file was checked against its source SHA-256 before the expanded directory was removed. Their evidence remains recoverable; these are not lost research records. The original historical/backtest research directories and the baseline golden dataset remain in place.

The initial run recovered **10,214,113,280 filesystem bytes (about 9.51 GiB)** before creating the new portable research export. A new export consumes some of that space; final disk figures are recorded in the deployment receipt. No production polling rows were eligible for deletion on 28 October.

## The daily job

Source: `scripts/nse-retention.py`. Units: `deploy/lightsail/nse-retention.{service,timer}`.

Schedule: **19:30 UTC = 01:00 IST / 03:30 Singapore the following morning**, plus up to one minute jitter. Runs on AWS, independently of the laptop.

Default is a dry run. `--apply` enables these limited actions:

1. Preserve at least seven calendar days of intermediate polling diagnostics.
2. Protect every session with an open, pending or unresolved paper/shadow/manual position, plus explicitly pinned dates in `/var/lib/nse-retention/pins.json`.
3. For an older unprotected session, require an actual live after-close report observed at/after 15:35 IST, a grace period, and agreement between the final on-disk report and latest database report. A clock cutoff alone is insufficient.
4. Before removing redundant poll rows, create and verify a compact canonical candle-store recovery copy and a lossless compressed archive of every affected polling row. Keep the latest polling row hot so `--report` keeps working. The standalone dated JSON reports are untouched.
5. Compress inactive quote-health logs older than seven days, retaining hashes and all their content. No quote journal is removed.

The job uses a single-run lock and the recorder's existing host lock. It skips destructive work if the collector is active, evidence cannot be read, finalization does not match or archive verification fails. Protected sessions are individually skipped, with pins checked again immediately before pruning. The service has a 256 MiB memory limit and low CPU/I/O priority. Audits, manifests and archives are root-private under `/var/lib/nse-retention/`.

The routine job does **not** delete arbitrary temporary directories, rotate away recovery archives, remove Docker images, stop trading services, or run VACUUM. Offline cleanup is a separate explicit `--offline` invocation with a fixed inventory, process/mount/service-reference checks and full archive verification.

## Reduce future growth

The combined recorder previously stored an initial full-universe report and a second combined report every poll. It now stores only combined reports, preserving the first snapshot at each five-minute or health-state transition, a fresh rolling latest snapshot, and an explicit final checkpoint. Dated JSON reports still refresh every poll; trade/decision/quote/candle evidence is unchanged. The command-line latest report also stays fresh.

This reduces redundant report storage. It does not downsample candles, quotes, signals or executions. The standalone SessionRecorder default remains unchanged for other callers.

## Compact research exports and recovery

```sh
# Read-only plan (writes only a small audit/lock in retention storage)
sudo python3 /opt/nse-assistant/scripts/nse-retention.py

# On-demand complete research bundle, excluding API keys and credential backups
sudo python3 /opt/nse-assistant/scripts/nse-retention.py --apply --research-export

# Service / timer / audit inspection
sudo systemctl status nse-retention.timer
sudo journalctl -u nse-retention.service
sudo ls -lh /var/lib/nse-retention/exports/
```

A research export is a TAR containing compressed, individually transaction-consistent SQLite snapshots, final reports, point-in-time agent/news/quote evidence, health logs, image identifiers and explicitly allowlisted non-secret settings. Table counts, SQLite integrity, compression round trips and final bundle hashes are checked. Independent workers have separate snapshot times; this is not a cross-database atomic transaction. Intermediate polling diagnostics remain in hot storage or their separate verified poll archives.

The small `recovery/candles-canonical-*.sqlite.gz` copy contains every canonical price/provenance row and one latest report per session. **It is not a complete application backup by itself.** Use the research bundle for strategy/agent/quote evidence too.

Recovery artifacts:

- `exports/research-*.tar` plus its manifest: portable research snapshot, without provider credentials.
- `recovery/`: compact canonical candle-store copies and hashes.
- `poll-archives/`: original archived poll rows as JSONL arrays `[id, session, observed_at, report_json]` plus checksums.
- `offline-archives/`: complete inactive validation/rollback archives. Some rollback archives contain protected configuration; do not treat these as a public data export.
- `validation-summaries/`: small retained validation summaries when available.
- `audits/`: exact plans, retained/pinned dates, row counts, failures and before/after free space.

Restore archives into a separate staging directory first and verify their manifests. Use SQLite parameterized inserts to restore polling rows; archived JSON is data, not executable code. Never restore an old budget/control snapshot over a running system or reset counters to create spending allowance.

## Physical compaction and deferred changes

Row deletion creates reusable SQLite pages; it may not shrink files immediately. `--apply --compact` is an explicit maintenance operation that requires no active reader, an inactive collector, sufficient disk headroom and a verified canonical recovery copy. It checkpoints through SQLite and verifies canonical tables after VACUUM. Never manually unlink live WAL/SHM files.

Quote consolidation, hot quote pruning, strategy-input deduplication and removal of old research records remain disabled. They require compatible readers and replay verification before any source evidence can be removed. This is intentional: saved space must not make a strategy look better or prevent us explaining its trades.

## Verification

Before/after checks cover all seven recorded sessions, the multi-session leaderboard, agent and shadow summaries, original agent decisions, dated-report hashes, all canonical candle/provenance tables, strategy settings, budget reservations and trading-worker start times. The registry's heartbeat timestamp is excluded from configuration equality. No outcome was resolved by inventing a candle or exit.
