# Recorder and automatic paper loop

All times below are IST. Nothing in this runbook has been deployed by the cloud implementation task. Node 24 is required. Broker orders are not implemented.

## Development and fixture validation

```sh
npm ci --ignore-scripts
npm run check
npm run test:http:local
# Safe one-shot recorder smoke; synthetic prices and strict blocked paper state:
npm run record -- --mock --date 2026-10-21 --once --data-dir .local/recorder/mock
```

`test:http:local` starts only development loopback fixtures and runs the inherited adapter/recorder HTTP probes with synthetic credentials. It needs no Dhan token or Postman CLI.

## Default: strict mode

The recorder command and existing market-session service automatically evaluate paper state after every poll. The default is `PAPER_ENABLED=true`, `PAPER_MODE=strict`, one simulated share. Strict mode always records the unavailable timestamp-aligned exact VWAP gate; it cannot create a qualified exact trade. The existing scheduled calendar does not establish actual sessions or verified timestamp semantics. Missing calendar coverage and baseline slots are reported separately, rather than reported as no signal.

`PAPER_ENABLED=false` explicitly runs the recorder alone; do not disable paper processing while expecting automatic management of a paper position. No setting enables real orders.

## Explicit approximate research opt-in

Use the included `deploy/lightsail/paper.env.example` as the server-side paper configuration. To opt in to hypothetical HLC3-bar VWAP research using the included scheduled calendar, set all three:

```dotenv
PAPER_MODE=approximate-research
PAPER_ACCEPT_SCHEDULED_CALENDAR=true
PAPER_ACCEPT_START_LABELS=true
```

Do **not** turn `DHAN_CANDLE_START_VERIFIED` on merely to bypass a gate. That flag requires external evidence. The research assumptions remain false for verification and are exposed in every report. The included calendar covers 2026-09-01–2026-12-31 using inherited published-schedule evidence; subsequent notices/actual sessions remain unverified. Replace/review it when coverage expires. `PAPER_CALENDAR_PATH` can point to a reviewed JSON file, mounted read-only inside the container. Schema: `source`, `kind`, `validFrom`, `validThrough`, unique `sessions`; `kind:verified_regular_sessions` additionally requires a nonempty `verificationEvidence`. Only a genuinely reviewed actual-session calendar should use that kind. Never generate a verified calendar from weekdays.

Other settings:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PAPER_QUANTITY` | `1` | Positive integer simulated shares; frozen for the position |
| `PAPER_MAX_OBSERVATION_DELAY_SECONDS` | `60` | Maximum signal/entry observation lateness and missing-price grace |
| `PAPER_FEES_PER_SIDE` | unset | Fixed estimated rupee cost per entry/exit |
| `PAPER_SLIPPAGE_BPS` | unset | Estimated turnover slippage in basis points |
| `PAPER_CALENDAR_PATH` | bundled paper calendar | Complete enumerated session calendar with coverage/evidence |

Gross PnL uses raw hypothetical prices × quantity. Net is null unless both cost settings are supplied; then it subtracts twice the per-side fee plus slippage on entry+exit turnover. This is a configured estimate, not actual taxes/charges or verified execution. Changing entry settings/configuration during a session blocks further entry for that saved identity. Existing positions still use their stored quantity, stop, target and cost terms.

## Automatic lifecycle and conservative execution

One collector lock covers the recorder, history requests and paper loop using persistent host storage. Do not start a second collector with another data directory or another service. The existing Dhan read-only adapter and shared process rate gates handle all REST requests. The loop polls every 30 seconds by default, 09:05–15:35 via the inherited schedule.

Before 09:15, bounded backfill gradually requests missing morning-slot volumes for exactly the prior 20 enumerated sessions. At most two REST requests per poll and two durable attempts per symbol/history day/current session are permitted. Partial/failed responses retain missing slot names, safe errors and attempt counts; restart cannot reset that budget. Strict does not fetch inferred history when calendar evidence is unverified. Research with explicit calendar acceptance may fetch that scheduled history. Calls stop after 11:00; exhausted/missing history blocks relevant signals. Morning slots can be valid even if a prior day's final three slots are absent.

After recorder persistence, paper processing imports only completed observations. The first admitted candle version is fixed; all revisions remain auditable. On restart after recorder-only downtime, the worker reconstructs original versions from recorder revision history. Old current-session rows with no batch provenance remain blocked for new entries; they are not silently relabeled verified. For historical baseline days, complete OHLCV without provenance is also considered incomplete readiness: the same bounded REST path refreshes it. Fresh historical observations enter a separate `paper_baselines` ledger with their real receive time and an explicit historical-refresh label. Original execution observations, prior decisions and fills are unchanged; refresh can support only later timely decisions, never retroactive signals. Reports name `unprovenancedSlots`, baseline refresh counts/times and policy. A fresh historical fetch does not establish exact VWAP, actual-session evidence or verified candle labels. Source time (bar start/end), first observed time, evaluation time and execution uncertainty are retained.

Range is [09:15,09:30). A completed 09:30–10:55 start-slot bar must close strictly above range high and HLC3 session VWAP, with volume ≥1.5× prior-20 same-slot median. The final eligible close is 11:00. Signal and entry must be observed within the configured delay. Entry uses the next candle open only after that candle completes: a hypothetical earlier price, not an executable live fill. A gap at/below OR low rejects entry. Stop is OR low, target 2R. Stop wins an intrabar stop/target ambiguity. Adverse stop gaps use the worse open; favorable target gaps are capped at target.

Existing positions continue exit management even when exact VWAP, calendar, baseline, new configuration or opening-range inputs block new entries. Volume-only missing data does not prevent price-based risk management. A missing price waits for the grace deadline, then makes the path irreversibly unknown. Later backfill/revisions cannot improve it. Forced exit requires the actual 15:15 bar and is reported only after completion. The observed 72-bar pattern has no such bar: unresolved exit price, gross and net remain null. If the process misses the session end, next-session recovery finalizes unknown outcomes from old positions without inventing a close. No automatic carry-forward trade is created.

With paper enabled the session loop continues on fetch/auth errors, preserving blocked/unknown state through the end of the window; the recorder's read-only REST calls may continue failing until the token is refreshed and the process restarted. No credentials are printed. The user handles token refresh separately. Paper configuration/setup faults are exposed in the report and do not stop candle persistence.

## Private inspection and export

The existing report service still publishes only `127.0.0.1:8787` on the host. Use the existing SSH tunnel procedure; do not open a public firewall/listener. `/api/latest` includes quality and paper state; `/api/paper` returns the latest dated simulated state, decisions/events, assumptions, revisions, backfill gaps and errors. The viewer labels simulation and observation time. An old report is not current health.

Files in the persistent recorder directory:

- `candles.sqlite`: original recorder candles, revisions/polls/fetches, added batch provenance and bounded backfill attempts.
- `paper.sqlite`: immutable admitted execution observations, separate historical-baseline refresh versions, deterministic symbol/session/version/mode states and unique transition events.
- `collector-lock.sqlite`: OS-held singleton lock; persists but releases automatically on crash. Do not delete it while running.
- `YYYY-MM-DD.json` and `YYYY-MM-DD.paper.json`: atomically replaced quality/paper reports. Report event view is capped at 2,000; full history remains in SQLite.

```sh
# Local checkout, read-only reports/export:
npm run record -- --report --date YYYY-MM-DD --data-dir /path/to/copied-data
npm run paper:export -- /path/to/copied-data/paper.sqlite > paper-audit.json
```

For assistant-led Notion updates, export/copy the dated JSON reports and `paper-audit.json`; the assistant can review evidence and write the existing journal after your request. No AWS-to-Notion service or new API key is needed. Never copy an active SQLite main file alone: use a consistent SQLite backup, or stop the reviewed service and copy the DB plus its WAL/SHM consistently. Dated JSON is safe to copy atomically while running.

## Review, prepare and deploy later (user-controlled)

1. Review draft PR #1, the inherited snapshot commit and the new engine/integration commits. Run the fixture commands above. Review calendar evidence, research assumptions, quantity and cost settings; exact strategy remains blocked.
2. On a Docker-capable review host: `docker build -f deploy/lightsail/Dockerfile -t nse-recorder:local .`. This cloud executor has no Docker binary/daemon; image build and actual systemd/docker launch must be validated before deployment. Shell/unit source checks do not substitute for that launch.
3. After approval, preserve today's reports/consistent DB backup and previous image for rollback. Install the reviewed source using the existing Lightsail procedure. Run `deploy/lightsail/install.sh` only on the reviewed host; it preserves existing credential/config files and does not enable timers.
4. Ensure `/etc/nse-assistant/paper.env` exists with strict defaults or explicitly reviewed research choices; the service reads it in addition to the existing server-side `dhan.env`. Existing credentials are not copied into images. Mount `/var/lib/nse-recorder` unchanged; both SQLite stores and report JSON survive container recreation. Only the existing recorder timer/service runs—there is no paper timer.
5. Refresh the short-lived token securely outside this cloud task. Check `systemctl cat nse-recorder.service`, `systemctl cat nse-recorder.timer` and the report unit before enabling/restarting. The service retains host `flock` plus the persistent data-directory singleton.
6. After review/deployment, inspect `journalctl -u nse-recorder.service`, private report timestamps, backfill gaps and strict block reasons. `systemctl restart nse-recorder.service` resumes durable state within the collection window; no duplicate signals/fills should be created. Restart outside market hours exits without starting a collector. Do not erase state to retry a signal.
7. Run an observed session before trusting delivery latency, timestamp semantics, actual-session evidence or closing fills. Review missing tails and all unknown outcomes. Roll back by stopping the service and restoring the reviewed previous image/config, preserving data for audit. An older recorder binary can keep writing its original tables, but does not process new paper positions.
