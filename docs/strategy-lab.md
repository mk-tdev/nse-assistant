# Independent strategy lab

All execution is research paper simulation. No broker orders. The original collector, one-share ORB baseline, existing comparison ledgers and manual MCX records stay separate. The user's latest instruction selects **10 shares per trade regardless of cost/capital** for trials. Fees and assumed adverse slippage are nevertheless reported. Fixed-share trials are unconstrained research portfolios; their P&L is not a return on an assumed funded account.

## Versioned strategies

| ID | Selection | Extension | Sizing | Default |
|---|---|---|---|---|
| nifty-quote-10-v1 | Frozen Nifty 50 control | None | 10 shares | Enabled |
| orb-quote-10-v1 | All collected Nifty + frozen screener candidates | None | 10 shares | Enabled |
| orb-extension-10-v1 | Same | At most 1 opening-range width | 10 shares | Enabled |
| screener-quote-10-v1 | Frozen screener additions only | None | 10 shares | Enabled |
| screener-extension-10-v1 | Same | At most 1 width | 10 shares | Enabled |
| in-play-10-v1 | Opening stocks-in-play ranking | At most 1 width | 10 shares | Enabled |
| orb-extension-risk-v1 | All collected candidates | At most 1 width | Optional equal risk | Paused |

The trigger adapter consumes the **first immutable ORB research signal per stock/session** from the existing baseline and screener engines. An extension-rejected first candidate is skipped for the day; this version does not search for later re-entry signals. The cap is `(signal close - opening-range high) / opening-range width <= 1`, rechecked at the actual entry quote too. The first-candidate trigger adapter and execution logic are separate from the registry, so future strategies may add different triggers without mixing old records.

Definitions and parameter hashes are frozen per live session/run. Enable/pause is an operational control outside the parameter hash. New definitions take effect on the next live session; existing positions retain their stored parameters. One position/candidate per stock/session/strategy. Each strategy has isolated positions, event history, costs, net P&L and its own optional risk account, even though all share the collector.

## Stocks in play v1

The universe is the current collected Nifty 50 plus pre-session screener additions, **not the entire NSE market**. Freeze at 09:31 IST using only opening bars observed by that cutoff. Require all three 09:15–09:30 bars and all corresponding bars in the previous 20 scheduled sessions. Rank by opening 15-minute relative volume (current volume / prior-20 median), then relative strength, then symbol. Require RVOL >=2, approximate opening traded value >= INR1crore, positive opening return, and positive return relative to the pool's median opening return. Keep top 10. Missing baselines block selection. Cross-sectional relative strength is not an index/sector adjustment. These are research hypotheses, not calibrated winning thresholds.

Keep frozen source membership, all accepted/rejected ranking rows, freeze time, signal evidence, configuration and source quote with every run. Current revised bars are never promoted to verified historical quote evidence. A quote backtest requires the actual immutable live decisions.

## Prospective fills and costs

A pending entry waits at most 60 seconds for a Dhan LTP snapshot with both observation and interpreted source-trade time after the actual logged signal decision. Observation age and source age must each be <=15 seconds. Missing, invalid, future, placeholder or stale timestamps cannot fill. The source timezone remains a disclosed research IST interpretation. Entries use the observed LTP at processing time; no candle-open backdating. Reject quotes through the stop, above the original candidate's 2R ceiling, or beyond the variant's extension cap. Target is recalculated at 2R from the actual paper entry.

Every subsequent eligible sampled quote manages stop/target. Time exit uses the first eligible post-15:10 IST quote, not a retrospective bar open. No eligible exit before the close leaves an unknown exit. A quote coverage gap over 30 seconds irreversibly marks the prior path unknown, even if a protective/manual mark later closes it. Sub-snapshot stop crossings cannot be reconstructed; this is a sampled-quote simulator, not tick-perfect or broker-executable proof.

Gross is observed mark movement times quantity. Indicative retail NSE intraday fees use `estimateCosts` and its dated Dhan pricing source; brokerage, exchange, SEBI/IPFT, STT, stamp and GST components are retained. An assumed **1 bp per side** slippage is deducted separately from gross, never silently applied twice. Fee rounding is an approximation of contract-note accounting. Costs do not prevent fixed-10-share entries. No account-specific billed charge claim is made.

Equal-risk mode is available only when explicitly enabled/selected: reference capital INR100,000, stop-risk allowance INR250/trade including estimated stop costs, INR25,000 position value, four concurrent positions, no leverage and no new entries when prior outcomes are unknown. Quantity is rounded down to an integer and may be zero. Its constraints are independent of fixed-10 trials. Price gaps can exceed intended stop risk.

## Backtests

Queue from the authenticated dashboard. Select dates (maximum seven calendar days / five scheduled sessions), strategy IDs, and execution mode. Runs use a separate UUID namespace in the lab database, with separate per-session/per-strategy records. No production trade/observation is rewritten. Backtests queue during NSE collection and run outside it.

- **Quote replay:** uses persisted quote observations AND actual immutable signal-decision timestamps. Missing either produces a blocked result, not a fabricated fill. Partial quote coverage is disclosed; missing entry quotes expire, and missing open paths remain unknown. Quote journaling begins with this deployment; 22 October cannot be reconstructed from its overwritten latest-quote file.
- **OHLC proxy:** explicitly exploratory. Signals use final historical bars with modeled availability at end+10s. Entry uses a strictly later future bar open, so maximum wait is relaxed to 330s versus the live 60s; this difference is frozen in run configuration. Stops/targets use conservative stop-first OHLC ambiguity. Missing intervening bars produce unknown paths. This cannot validate live quote execution or forecast its returns. Daily selection uses historical bar proxies and a possibly retrospective Nifty membership snapshot; provenance warnings remain visible. No present-day screener list is applied when the historical morning snapshot is missing.

Strategies and thresholds developed after seeing 22 October make its replay an in-sample diagnostic. Reserve future unseen sessions for validation. Compare selection methods under the same trigger, quantity, execution model, cost model and date range. Never add overlapping cohorts as a portfolio.

## Storage, operations and controls

`/var/lib/nse-strategy-lab/strategy-lab.sqlite` holds runs, partitioned positions/events, source quote journal, frozen selections and operational controls. It is outside containers and survives restarts. Source data is mounted read-only. The worker and console have no Dhan/OpenAI credentials. The web server reads the lab snapshot mount read-only and can write only the existing authenticated command queue. Original recorder and quote services remain independent. The existing OpenAI reviewer/model/budget are not changed, and backtests do not invoke an LLM.

`nse-strategy-lab.service` runs continuously but activates new live runs only during the scheduled 09:05–15:35 IST window. Quotes are journaled during that window. Pausing cancels pending entries; already open risk is still monitored. Existing global/individual paper exits include live lab positions. Manual exits require fresh post-click quotes and remain audited. A process restart cannot duplicate entries or resolve missing paths. Interrupted historical runs preserve partial records; retry with a new request UUID.

API additions reuse HTTPS authentication, exact Origin, JSON content type, per-process CSRF and body bounds:

- `POST /api/lab/toggle`: requestId, strategyId, pause/resume.
- `POST /api/lab/backtest`: requestId, from, to, strategyIds, quote-replay/bar-proxy. Completed sessions only.
- `GET /api/lab/status`: worker health, definitions, queued/completed run descriptors.
- `GET /api/lab/run?id=UUID`: saved historical result only.
- `GET /backtests?run=UUID`: separate historical day/strategy/trade/chart viewer and export.

Quote archive growth and the existing large recorder poll history need retention planning as the sample grows. Do not delete trade audits, frozen selections or budget databases to make room. No cleanup/retention policy is introduced by this change.
