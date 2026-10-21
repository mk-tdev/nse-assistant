# Read-only session recorder

The recorder polls **HDFCBANK and TCS only**, resolves their NSE EQ-series mappings from Dhan's instrument master, and saves completed five-minute candles to local SQLite. It does not place orders, calculate strategy signals, or connect to Dhan MCP. Its only upstream operations are the existing public instrument CSV GET and historical-candle POST.

## Start for the next session

Requires Node.js 24+ and the existing `.env.local` credentials. Do not paste them into a terminal command, chat, or committed configuration.

```sh
npm ci --ignore-scripts
npm run check
npm run record -- --live --date 2026-10-21
```

21 October 2026 opens at 09:15 IST / 11:45 Singapore on the published calendar. `--date` is explicit selection, not automatic calendar verification: confirm the intended exchange session before running. If testing 22 October instead, change the date to `2026-10-22`. The process may start before the open and wait. Keep the laptop awake and connected; this is not installed as an automatically scheduled service.

The command loads `.env.local` explicitly and uses live credentials only with `--live`, independently of `DHAN_MODE`. No credentials are stored in the database or reports. Keep one live collector running; its process-wide Dhan limiter does not coordinate with other applications.

Default poll interval is 30 seconds. Optional controls:

```sh
npm run record -- --live --date 2026-10-21 --interval 60
npm run record -- --live --date 2026-10-19 --once
npm run record -- --report --date 2026-10-21
```

`--once` runs a bounded check and exits. The historical example can verify ingestion now; it cannot prove future live completeness. A check before the session may report `waiting`, which does not establish authenticated candle access yet: instrument resolution uses a public CSV, and candle requests begin after the first completed slot's settlement delay.

Stop with Ctrl-C. After 15:35 IST / 18:05 Singapore, the final poll completes and the process exits. Restarts on the same date resume the database and backfill from the session opening; they do not duplicate candle rows. It does not continue into the next day automatically. An expired/unauthorized credential response (401 or 403) records the errors and stops so an operator can replace credentials and restart. Other fetch failures remain visible and are retried at the next poll, without fabricating data or silently renewing credentials.

## Read the output

Live files are gitignored under `.local/recorder/live/`:

- `candles.sqlite`: durable candles, revision history, per-poll reports, last-success timestamps, and source/mode identity. Uses SQLite transactions and WAL journaling.
- `YYYY-MM-DD.json`: latest human-readable session report, replaced atomically after each poll.
- `recorder.lock`: active recorder PID and selected session. Removed on normal exit, Ctrl-C and SIGTERM. After a crash/SIGKILL, confirm the recorded process is no longer running before manually removing a stale lock. Never remove it while a recorder is active.

The report includes each instrument's stored/expected counts, exact missing source slots, missing volumes, last source timestamp, last successful fetch, lag in seconds relative to the latest expected completed candle, revisions and rejected-response errors.

| Status | Meaning |
| --- | --- |
| `waiting` | No completed candle is expected yet, including the first slot's settlement delay |
| `collecting` | All slots currently expected are stored; the session is still in progress |
| `complete` | All 75 expected source slots and volumes are stored for this session |
| `missing_data` | One or more expected source slots or volumes are absent |
| `fetch_error` | The latest request or batch validation failed; earlier valid rows are retained |

These statuses describe **coverage under the start-timestamp interpretation**, not verified exchange truth, a trading signal, or a passed calendar/VWAP requirement. Reports always identify whether start semantics were operator-verified and say `calendarVerified: false`, `strategyEnabled: false`. Quote freshness, exact VWAP, WebSocket continuity, same-slot 20-session baselines and strategy outcomes are outside this recorder.

Exit codes: `0` for waiting/collecting/complete; `2` for a bounded/final missing-data or upstream-error outcome; `1` for setup/storage failure. Do not configure a service manager to blindly restart an incomplete historical/final run forever.

## Timing and completeness rules

- Requests cover 09:14:59 IST through the earlier of the poll's time or 15:30, then filter locally to `[09:15, 15:30)`. This recovers the opening row that the tested API excluded at an exact 09:15 lower bound.
- Only source rows whose interpreted five-minute interval has completed by the poll's evaluation time enter persistent candle storage. Incomplete current-session rows are counted and excluded. Out-of-session rows are ignored.
- A 10-second settlement allowance delays the latest *expected* slot to avoid declaring a candle missing the instant it closes. It does not establish a provider delivery SLA. At a 30-second poll interval, observations may arrive later than that threshold; the report shows actual gaps.
- Invalid array lengths, nonfinite/invalid prices, duplicate timestamps and reversed order reject the whole batch. Existing valid observations survive.
- Repeated observations update the same primary key `(session, security ID, source epoch)`. Changed OHLCV values add an audit revision and replace the current stored value. A row absent from a later response does not erase an earlier valid observation.
- The sampled Dhan history ends at 15:10 five-minute starts. If that occurs during the live test, the missing 15:15, 15:20 and 15:25 slots remain explicit. No forward fills, timestamp shifts or invented exit prices occur.
- A process restart cannot guarantee recovery of data Dhan no longer serves. A WebSocket recorder is not included in this version.

## Offline demonstration

```sh
npm run record -- --mock --date 2026-10-21 --once
npm run record -- --mock --report --date 2026-10-21
```

This uses synthetic prices and a fixed 10:00:10 IST observation time. It writes to `.local/recorder/mock/`, separately from live data, and never contacts Dhan. The database identity prevents accidentally reusing a mock store in live mode, including with a custom `--data-dir`.

## Verification

`npm run check` includes recorder tests for restart persistence, deduplication, revisions, incomplete-bar exclusion, missing tails/volume, settlement timing, rejected batches, safe errors, and mode separation.

The HTTP probe exercises the actual recorder and existing adapter against the repository's Postman stand-in, using synthetic credentials only:

```sh
postman simulation run postman/simulations/dhan-data.sim.yaml --port 4900 --no-history --output ndjson
# Separate terminal:
npm run test:recorder:http
```

It verifies the padded request boundary over real HTTP, a full 75-slot session, incomplete bars, repeated polls, 401/429/500 errors, invalid/duplicate batches, revision auditing, and missing-tail reporting. Stop the simulation afterward. Simulation logs may show synthetic fixture headers; never point real credentials at it. Passing synthetic checks establishes local recorder behavior, not live feed completeness.

## Next-session acceptance checks

1. At/after 09:20:10 IST, confirm the 09:15 source row is captured for both equities.
2. Through the opening range, compare reported source times and OHLCV against the broker chart, allowing for observed delivery delay.
3. Stop and restart once; confirm counts and source primary keys remain unique.
4. Inspect `lagSeconds`, missing slots and safe error codes during any delivery or connectivity issue. Do not disable quality checks to make the report look healthy.
5. Keep collecting through 15:35 IST. Verify all 75 source slots, or preserve the exact missing list as the session's result.
6. Retain the SQLite database and report for diagnosis. Compare the tail with the historical query afterward; this can distinguish missing historical generation from missing live delivery.

This version is a local foreground worker. Cloud deployment, automatic schedules, a dashboard, alerts and order execution were not configured.

## Implementation validation (21 October 2026)

- `npm run check`: typecheck, 40 tests and production build passed.
- `npm run test:recorder:http` and `npm run test:http`: passed against the local Postman simulation. Its log recorded 28 HTTP requests across both probes, including 21 recorder-path requests. No real credentials were used in the simulation.
- A real REST `--once` smoke test for 19 October stored 72 unique source rows for each watchlist equity and explicitly reported the three missing tail slots. A second process run preserved exactly 72 unique rows per equity and added a second quality report. Both runs exited 2, as expected for an incomplete historical session. These checks establish ingestion, persistence and gap reporting, not next-session live completeness.
- The smoke test also caught and corrected the existing adapter's CSV symbol mapping: the detailed master uses `UNDERLYING_SYMBOL` for the exchange trading symbol, while `SYMBOL_NAME` contains a company-name string. The HTTP fixture and unit test now cover that real schema shape.

The live historical test is stored separately in `.local/recorder/live-smoke/`. No unattended recorder was left running by these validation steps.
