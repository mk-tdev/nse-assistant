# Automatic simulated paper execution — cloud review

The source handoff is resolved. The exact 25-file recorder snapshot supplied and checksum-verified by the user is preserved in commit `93ec29b` and merged into `codex/automatic-paper-trading`. Archive SHA256: `65e97008dfe35c21cf443eb9cc4449ed1d53e2551c109a82f8055c22541b7ab8`. The earlier paper-ledger commit is preserved separately; subsequent integration changes are distinguishable in history.

## Implemented

The existing market-session process now runs one REST recorder, bounded prior-session backfill, durable paper evaluation, and atomic private reports. There is no separate collector, scheduler platform, order route or Notion publisher. Existing `analyze()` exact qualification remains unchanged (`validSignal:false`, `trade:null`). See [the paper runbook](paper-trading.md) for configuration and review/deployment commands.

`src/paper-worker.ts` connects the recorder SQLite store to `src/paper.ts`, sharing the same provider and rate gates. It reconstructs the first version from recorder revision records after downtime, imports all corrections for audit, and never substitutes a revised price for an existing decision/fill. Legacy pre-paper historical rows without batch metadata trigger bounded provenance refresh even when their OHLCV is complete. Refreshed baselines are stored separately with receive times and explicit historical labels; original observations/decisions/fills remain immutable and verification remains false. The upgrade fixture reproduces a database without `candle_batches`, including 19/21 October rows, then verifies next-session research readiness after bounded refresh. It uses persisted observation times, not restart time, to judge execution uncertainty. Per-candle volume defects do not contaminate earlier decisions through incomplete future bars.

Strict is default and cannot produce exact trades because aligned exact VWAP is unavailable. Research is explicitly opt-in; calendar and candle-label assumptions remain unverified and visible. A one-share simulation default is explicit. Configured costs are estimates; unspecified costs leave net PnL null. Observation delay, gaps, stop/target ambiguity and unresolved exits are recorded. Missing prices and PnL remain null.

New-entry gates never disable risk management for an existing position. A restarted worker manages saved positions even if mode/calendar/config changes; stored economic terms and quantity remain fixed. Duplicate workers sharing the data directory are rejected by a kernel-held SQLite singleton lock, released automatically on crash. SQLite transactions/uniqueness independently deduplicate state transitions. The host service retains its outer `flock` guard.

## Data evidence and bounds

`calendar-paper-2026.json` carries explicit scheduled dates from the inherited published-holiday evidence and deployment schedule, covering September–December 2026. It is **scheduled inference, not independent actual-session verification**. The scheduled calendar never sets verification flags true. Strict blocks it; research must explicitly accept it. An independently verified calendar must use `verified_regular_sessions` and supply evidence plus complete bounded session coverage. Weekdays alone are not accepted as evidence.

History uses only the most recent 20 listed sessions; no substitution of older days. At most two history requests per poll and two attempts per symbol/history session/evaluation session are durably reserved before requests. Requests use the existing read-only adapter, padded lower bound, validation and rate limits. Only morning same-slot volume is required; absent afternoon tails are still reported by recorder quality. Missing slots and exhausted attempts remain explicit. Backfill occurs only 09:05–11:00 IST. It cannot retroactively fill late signals.

## Validation

Current test evidence and environment limitations are recorded in [VALIDATION.md](VALIDATION.md). Synthetic sessions exercise collection, backfill, paper progression, repeated polls, restarts, revisions, evidence gates, risk management under blocked new-entry settings and unknown outcomes for the observed 72-bar pattern. These fixtures do not verify real delivery latency or strategy performance.

The cloud task did not access AWS, modify credentials, deploy, merge the PR, submit orders, publish to Notion, or configure a notification schedule. Review/deployment and a live-session trial remain separate user-controlled steps. The expiring AWS token is handled outside this task.
