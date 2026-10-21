# AWS paper research cohorts and recovery reviewer

The original Nifty 50 ORB strategy remains the control: `paper.sqlite`, default `orb-long-v1`, raw five-minute observations, original entries/stops/2R target/time exit and unknown-outcome handling. Its config hash and state IDs do not change. New behavior uses separate ledgers; cohort returns must not be summed as a portfolio.

## Watchlists

`prepare-watchlists.js` reads the user-selected public Chartink short-term-breakouts screen and Screener.in near-breakout-uptrend screen. Chartink's public page supplies its published `atlas_query`; the read-only screen calculation uses the site's existing process route with its own public session/CSRF context. It receives no Dhan or OpenAI credential. Screener.in company rows supply candidate symbols; numeric BSE-only codes are excluded. Schema or transport failures remain explicit. A valid previously frozen snapshot for the same target session can supply a failed source; it retains the original fetch timestamp. Different-session snapshots are never silently reused.

The preparer freezes `/data/YYYY-MM-DD.watchlists.json` before 09:05 IST. Every candidate is resolved uniquely against the Dhan NSE EQ instrument master. It requires all 18 eligible morning slots across each prior 20 scheduled sessions, median observed historical turnover of at least INR 1 crore, and median observed volume of at least 100,000 shares. Historical tails remain incomplete, so these are observed liquidity proxies, not full exchange turnover or spread/circuit eligibility. At most 20 accepted screener stocks are added to one shared collector. Rejections retain reasons. Selection is frozen for the session; it is not a claim those names were known at a past session's entry time.

`nse-watchlists.timer` prepares the current session at 08:50 IST (11:20 Singapore) on weekdays. Published-calendar checks reject non-session dates. The existing recorder starts at 09:05 IST. Current-session instrument/history failures can block the screener cohort without stopping Nifty 50 baseline collection. A source refresh failure must be inspected in the snapshot/report. Preparation has an eight-minute deadline and shares the same host/kernel collector locks.

## Comparison ledgers

- `paper-screener-orb.sqlite`: original ORB rules on the accepted screener cohort, including any overlapping Nifty 50 constituents.
- `paper-range-hold.sqlite`: all collected symbols; prior bar meets the original breakout/volume trigger, then a second completed close holds above the opening-range high and cumulative approximate VWAP. Entry is the following bar's hypothetical open, admitted only after that bar completes. Confirmation cutoff remains 11:00 IST.
- `paper-range-failure-exit.sqlite`: all collected symbols; original entry trigger, with a completed close below opening-range high causing a hypothetical next-bar-open exit. Original time exit, stop-gap, target-gap and intrabar stop-first rules apply. Stop/target evidence within the invalidating candle precedes its close-based decision. No hindsight exit at the invalidating close is invented.
- `paper-agent-recovery.sqlite`: original entry rules on raw and separately recovered observations. Freshness gates still prevent retroactive fills. The agent can record a protective paper action on fresh observed completed-close evidence, with its missing historical path and P&L still unknown.

One simulated share per entry, one candidate per symbol/session/variant, unknown fees/slippage and net P&L, provisional calendar/start timestamps and approximate HLC3 VWAP remain explicit. A better outcome in a variant is research evidence, not a verified improvement.

## Recovery and agent decisions

The recovery agent persists attempts and evidence in `research.sqlite`. It prioritizes open positions, then recent missing slots. Each slot has at most two durable attempts: a padded five-minute REST retry and a one-minute fallback. There are at most two extra historical requests per collector cycle, sharing Dhan's 350ms process limiter. When budget permits, fallback runs immediately after the unsuccessful retry. A reconstruction requires exactly five ordered unique valid completed minutes with non-null volume, then uses first open, maximum high, minimum low, final close and summed volume. It is recorded with actual retrieval time and provenance. Baseline candles are never changed or forward-filled. Recovery may also fail for the vendor's known missing session tail.

Unrecovered old gaps create evidence cases. Required absent entry data blocks new entries; existing position management continues. A subsequent fresh observed completed-close mark may support a separately labelled protective paper exit, but cannot establish whether an earlier stop was crossed. Such a protective exit has a recorded mark/time and `unknownOutcome=true`, with gross and net P&L null. It is not a verified executable quote fill or the missing scheduled exit price.

The OpenAI reviewer uses the Responses API with strict structured output, no tools, `store:false`, an eight-second timeout, at most five cases per request and forty persisted requests per session. It runs asynchronously; collection and baseline decisions do not await it. Input is limited to validated market evidence and simulated position terms, with no broker credentials, client ID, account balances or account positions. Model output is checked against case IDs, allowed actions and supplied evidence IDs. It cannot create candles, prices, entries, change stops or restore unknown P&L. A protective action is revalidated at application time; evidence that aged out while awaiting the model is rejected and logged. Failures/refusals/missing credentials leave the deterministic recovery policy active.

Configured model: `gpt-4.1-mini-2025-04-14`, overridable with `OPENAI_REVIEW_MODEL`. Root-only `/etc/nse-assistant/reviewer.env` contains `OPENAI_API_KEY`, `OPENAI_REVIEW_ENABLED` and the model. Never commit or display it. Only the recorder receives it; the private report server receives no provider keys. Usage and response IDs are retained in the LLM call audit. The request cap bounds calls/tokens, not a currency-denominated billing cap.

## Operations and reports

Enable `PAPER_RESEARCH_ENABLED=true`, `RECORDER_WATCHLIST_PATH=/data/{date}.watchlists.json`, `RECORDER_FETCH_COMPLETED_ONLY=true`, `RECORDER_POLL_INTERVAL_SECONDS=15` in the existing paper environment. Completed-only collection skips repeat requests once all slots in an interval are present; it re-fetches full-session data for each new completed interval, so revisions remain audited. Failed or missing intervals continue to be retried. Wakeups align with the ten-second bar-settlement boundary. Baseline gates and numeric strategy rules are unchanged.

The private `/api/paper` report includes `research` with watchlist provenance/rejections, four separate cohort snapshots, recovery attempts and decisions, and LLM assessments/errors. Raw `/api/latest` quality remains explicit even when the agent comparison reconstructs a bar. Reports retain 200 recent compact events per ledger; full observations, baseline evidence and events remain in SQLite for read-only export. This prevents duplicating full historical baseline evidence into every polling report.

Run `node dist/paper-export.js /data/paper-range-hold.sqlite` (or another ledger) for full paper audit. Read `research.sqlite` read-only for recovery/reviewer audits. New exports are separate from historical simulation archives and actual market-session results.

No broker-order endpoints, trade MCP tools, account changes or real orders are implemented. The only authenticated upstream calls are Dhan data and OpenAI Responses; public screen refreshes are read-only calculations. No new public application listener or paid AWS instance is needed.


## Planned early paper exit — 22 October deployment

The AWS paper environment now sets `PAPER_EXIT_TIME_IST=15:10` for every cohort, including the Nifty 50 baseline. Entry, stop and target rules remain the same. An open paper position exits at the hypothetical **15:10 IST candle open**, admitted only after that candle completes at **15:15 IST**, plus collection latency. The source price is not an executable live fill. This precedes the observed missing 15:15, 15:20 and 15:25 candle starts. If the selected candle or an earlier exit path is missing/late, the outcome remains unknown; no last close is substituted. A planned exit takes precedence over intrabar stop/target touches in that exit candle, because its price is the earlier open.

Recorder/data-quality collection continues until 15:35 IST so final feed gaps remain visible. The old default is 15:15 when the variable is omitted, preserving prior historical replay configuration and hashes. Historical reports generated before this change retain their original exit policy and results; they are not rewritten as evidence for the new rule. A changed configuration cannot rewrite an existing session ledger.


## Reasoning reviewer and one-dollar daily allowance

AWS explicitly configures `gpt-5.6-luna` with `reasoning.effort=low`, standard service tier, a 20-second nonblocking timeout and at most 4096 total output tokens (including reasoning). The earlier GPT-4.1 Mini profile remains a validated legacy option, but production now uses the reasoning model. API availability and strict structured review output were verified with the configured account before rollout.

`OPENAI_REVIEW_DAILY_BUDGET_USD=1` cannot be raised above one dollar by the application. `OPENAI_REVIEW_BUDGET_PATH=/data/reviewer-budget.sqlite` stores atomic reservations across restarts, all session labels and all reviewer processes sharing this mount. A request reserves USD0.025 before network dispatch. Reservations are never refunded, including timeouts, interrupted calls, refusals and invalid responses. At most 40 such requests fit a day, and the earlier 40-request/session cap also remains. Smaller configured daily allowances are supported. Exhaustion stops only LLM requests; deterministic recovery gates, collection and paper strategies continue.

Budget days use the actual wall-clock date in Asia/Kolkata, independently of the simulated session/evidence clock. This prevents a historical replay from obtaining a fresh daily allowance just by changing its session label. Each live request is at most 24,000 UTF-8 bytes; requests contain text-only evidence/schema, no external tools. A conservative 32,000 input-token allowance plus the model-specific total-output ceiling fits the USD0.025 reservation at the verified short-context rates, including the highest short-context cache-write rate. Unknown models and unsupported effort values are refused. Large batches are reduced; a single oversized case is visibly blocked without an API call.

OpenAI standard pricing checked on 21 October 2026: [GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna), [pricing](https://developers.openai.com/api/docs/pricing), [reasoning token/output limits](https://developers.openai.com/api/docs/guides/reasoning). Short-context input USD0.20/million, output USD1.20/million; conservative input/cache-write upper rate USD0.50/million. The allowance covers this AWS reviewer's token usage before tax. It is not an account-wide provider billing limit, an AWS cost limit, or permission to spend on unrelated API calls. Recheck the pricing profile before changing model or token bounds.

The private report exposes model/effort, actual budget day, reserved and remaining allowance, limits and blocked status; reserved allowance is deliberately more conservative than actual billed usage. Include `reviewer-budget.sqlite` in consistent backups. Keep it separate from paper P&L. Rollbacks must preserve this database and must not reset the daily allowance. Historical review records retain their originally used model.
