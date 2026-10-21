# Validation evidence

Project: `/Users/mk/Documents/Codex/2026-10-20/task/dhan-market-data-mcp`.
Executed 19 October 2026 UTC. The workspace folder's date is 20 October; the intended strategy start is Wednesday 21 October 2026. The official NSE calendar identifies 20 October as a holiday; 21 October is a scheduled weekday session by calendar inference, not a live-data verification.

## Checks

- `npm run typecheck`: passed with strict TypeScript and unchecked-index checks.
- `npm test`: 35 passing tests, zero failures/skips, using synthetic fixtures and the official MCP client/server SDK.
- `npm run build`: passed; runnable stdio entry point is `dist/stdio.js`.
- Dependency installation after replacing vulnerable `csv-parse` with 7.0.3: npm reported zero vulnerabilities. The package lock is retained. An offline audit is not treated as authoritative evidence.
- Real stdio subprocess: client discovered exactly four read-only tools and called the mock quote. In-memory SDK tests called all four tools and checked sanitized unknown-instrument errors.
- `npm run test:http`: passed against a temporary Postman loopback-only simulation. Adapter requests reached the mock over actual HTTP, including CSV retrieval, quote retrieval, five-minute candle retrieval and rejected 401/429 responses. The probe used hard-coded fictional credentials and never read user credentials.
- Simulation log showed seven requests: five successful responses and two expected failures. Quote requests were logged at `16:33:45.794Z`, `16:33:46.797Z` and `16:33:47.796Z`, consistent with the global one/second quote limiter. Intraday JSON included the fixed `NSE_EQ`/`EQUITY`/`5` fields. Public CSV requests carried no Dhan credential headers.
- Temporary simulation stopped cleanly on SIGINT, with a final summary reporting 5 served and 2 failed requests. No remote server, tunnel or persistent service remains from this task.

Tests cover opening-range and confirmation boundaries, next-completed-candle fills, exact-slot 20-session median volume (including inclusive 1.5 threshold), bar-weighted VWAP, strict close conditions, zero/missing volume, missing recent sessions/slots, bad arrays/OHLC/duplicates, stale bars and quotes, timestamp/calendar verification gates, last 11:00 confirmation, conservative intrabar stop/target resolution, gap rejection and 15:15 exit observation. Future/incomplete bars cannot alter an earlier signal or fill. Tests also cover upstream-error sanitization, fixed allowlisted URLs, credential placement, redaction, placeholder rejection and the 90-day range bound.

## Limits and remaining setup

This evidence proves local TypeScript behavior against synthetic vendor-shaped data, not Dhan entitlement, live response compatibility or price freshness. No live Dhan data API call was made. Public official documentation and npm metadata/dependencies were retrieved; no broker credentials were installed/read, key or token created, subscription purchased, token renewed, order submitted, connector authorized, host registered, deployment published or account modified.

Before live use, obtain separate user approval for secure credential setup; confirm subscription status and current terms; provide a verified regular-session NSE calendar with 20 preceding trading sessions; validate live security IDs, epoch candle-start semantics, quote timestamp format/timezone, intraday adjustment treatment and observed lag. The disclosed HLC3 bar VWAP is approximate. Top-level exact qualification is always unverified, with `validSignal: false`, null strategy signal/trade and a separate approximate-analysis result. Exact qualification requires timestamp-aligned broker VWAP or suitable historical traded-value/tick data; no such integration is implemented. Simulation models one long trade and has no persistence, sizing, brokerage/fee model, execution integration or scheduling.

Only stdio is implemented. The README documents a secure future Streamable HTTP architecture, with separate MCP authorization and server-held broker credentials. Remote authentication and actual parent-chat compatibility remain unconfigured and unverified.

The optional local Postman mock was generated from the project's narrow, officially researched OpenAPI subset and extended with synthetic CSV. An owner-workspace search was intentionally omitted to avoid using existing app credentials. Its verbose fixture logs may expose the fictional test headers, so do not repurpose it with real secrets. A nonblocking keychain lookup error appeared during local mock generation; generation completed, no sign-in or credential setup was performed, and the loopback simulation/probe subsequently succeeded.

Focused follow-up findings, exact-qualification safeguards, official calendar evidence and updated tests are recorded in [SELF_REVIEW.md](SELF_REVIEW.md).

## Cloud automatic-paper integration — 21 October 2026

The user-verified recorder handoff (`93ec29b`, archive SHA256 `65e97008dfe35c21cf443eb9cc4449ed1d53e2551c109a82f8055c22541b7ab8`) is merged into the cloud paper branch. No AWS access, deployment, credential change, broker order or Notion publisher was performed.

Actual validation on Node v24.19.0:

- `npm run check`: **79/79 tests passed**, strict TypeScript checking and production build passed. This includes all **42 inherited tests**, 20 original paper tests, and 17 integration/regression/export/lock tests. Full combined run completed in approximately 67 seconds.
- Full-session synthetic integration: shared recorder and prior-20 backfill, signal→pending→entry→15:15 exit, durable restart and repeat polls, exactly one fill per symbol. Missing final three slots: 72 retained candles and unknown exit/gross/net, including restart.
- Legacy-store upgrade fixture: pre-paper 19/21 October rows with no `candle_batches`; bounded fresh historical baseline provenance restores next-session research readiness, original execution observations stay byte-for-byte unchanged, refreshed data cannot be used before receive time, and verification flags stay false.
- New-entry gates/mode/calendar change while positions exist: price-based stop/target management continues using stored quantity/terms. Volume-only blocks do not disable exits. Completed-price delivery grace prevents premature unknown outcomes; missing forced exit remains unknown after grace. Recorder revisions during paper downtime do not improve original fills.
- Durable failed-history retry bounds, calendar coverage/evidence checks, explicit research configuration, private report API, duplicate collector rejection/restart and read-only audit export passed.
- `npm run test:http:local`: both inherited HTTP adapter and recorder probes passed using only loopback fixture HTTP and synthetic credentials. Recorder scenarios included incomplete/complete, repeats, 401/429/500, duplicate/invalid candles, revisions and missing tail; 21 recorder fixture requests. No vendor network requests were sent.
- `git diff --check` and `bash -n deploy/lightsail/*.sh` passed.
- Docker is **not installed** in this executor, so no image build or container startup was claimed. `systemd-analyze verify` was attempted and could not fully validate runtime dependencies: `docker.service` and `/usr/bin/docker` are absent. Validate image build and service launch on a Docker-capable review host before deployment. Docker source/context checks verify both calendars are included; host storage, single-service guards and loopback-only report publishing are tested.

Earlier development runs exposed a delivery-grace expectation mismatch in two paper tests. The engine now explicitly waits the configured grace before declaring missing price paths unknown; regression tests cover both timely delivery within grace and missing forced-exit data after grace. The final combined check above passed.

Remaining LIVE limitations: no live-market replay of this worker; exact confirmation-time VWAP is unavailable; candle-label semantics and actual-session calendar evidence remain unverified; prior-slot REST history may be missing/unavailable; closing-tail omissions and delivery/observation latency need live review. Configured net is an estimate, never verified actual charges. Strict remains default and blocked; research must be explicitly opted in. Token refresh and production review/deployment are outside this cloud task.


## Research extensions — AWS validation, 21 October 2026

The AWS development container passed typechecking, all 95 tests, production build and both loopback HTTP suites. Tests cover persistent bounded recovery, complete one-minute aggregation, reviewer action/evidence validation, nonblocking calls, restart deduplication and the 40-call session cap, watchlist snapshots, independent ledgers, variants, compact evidence reports and completed-candle fetch caching.

An isolated network-disabled replay of the final 21 October REST snapshot reproduced all 50 baseline rows without changes to signal/entry/stop/target/exit/PnL/classification: six entries, four stopped out (known gross subtotal -58.22), two unknown outcomes, 44 no-signal. This is historical simulation, not observed live execution or a complete PnL total.

Both public screener sources fetched successfully. Preparation accepted 12 unique mapped stocks from 22 candidate rows after liquidity proxies and complete prior-20 morning history checks. A modeled 22 October pre-session rehearsal evaluated the baseline 50 plus those 12 in isolated storage, with all baseline history complete, no cohort errors and zero entries; cold pass 43.508 seconds and warm pass 4.52 seconds. The prepared list may change during the next automatic refresh.

One real OpenAI API smoke request authenticated and returned a schema-valid review using the pinned model. No production paper trades were created by these tests. Active-market latency, data completeness and paper behavior remain to be checked in the next session.


## Early planned exit — AWS validation, 21 October 2026

The suite passed 98 tests, typechecking, build and both HTTP suites; one additional targeted configuration test passed for the explicit planned-exit environment variable and rejected unsupported values. New regression cases cover 15:10 exit across every variant, completion gating, planned-open precedence over later intrabar extremes, duplicate ticks, missing selected candles and earlier missing price paths. Legacy omitted configuration retains the original 15:15 behavior.

A network-disabled isolated replay of all 50 stocks on 21 October with `PAPER_EXIT_TIME_IST=15:10` retained all six original entries, stops and targets, and retained all four earlier stop exits. SBILIFE closed at the observed 15:10 open of 1656.20 (gross -4.50); TECHM closed at 1822.20 (gross +8.30). All six outcomes were resolved under modeled timely delivery; gross total -54.42, net unknown. These are validation results for the newly selected exit policy, not live fills or an independent test of a winning strategy. Earlier historical reports keep their legacy exit policy and results.
