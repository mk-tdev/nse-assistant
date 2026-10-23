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

## Dashboard workspaces and archived chart access

The authenticated app exposes `/` for charts and selected-strategy trades, `/strategies` for management and backtests, `/commodities` for manual MCX paper activity, and `/operations` for agent and data quality. All visible select controls are custom button/listbox widgets, backed by hidden form values. SVG sidebar icons use fixed aligned slots. `?session=YYYY-MM-DD&strategy=ID&symbol=SYMBOL` opens a specific chart. The dated review `/reviews/2026-10-23` separates actual ONGC paper observations from exploratory later-breakout OHLC scenarios.

SQLite WAL mode needs reader metadata even after the collector closes. AWS runs `deploy/lightsail/prepare-report-readers.py` through an `nse-recorder.service` ExecStopPost drop-in, installed at `/opt/nse-assistant/prepare-report-readers.py`. It opens candle/paper databases in read-only mode to initialize SQLite metadata and gives generated metadata the database owner's permissions. It does not update price or trade tables. The report container keeps its source bind mount read-only.

## Independent midday breakout

`midday-orb-quote-10-v1` compares the same frozen Nifty plus screener universe with `orb-quote-10-v1`. Morning accepts signal candles starting 09:30 with completion by 11:00 IST. Midday accepts starts at/after 11:00 with completion by 14:00 IST. Both use the original 09:15–09:30 opening range, close above range high and approximate VWAP, and same-slot 20-session RVOL >=1.5. Midday uses fixed 10 shares, OR-low stop, 2R target from quote entry and the existing 15:10 quote time exit. First qualifying attempt per stock/strategy/session; no re-entry, independent ledgers and duplicated exposure are intentional comparison accounts. Existing baseline parameters and hash are unchanged.

Midday is initially disabled, then enabled only after the requested historical comparison is inspected. Live decisions freeze the first observed completed-bar versions and baseline versions available at the actual decision time in `lab_signal_decisions`. Invalid/missing prefix or prior-20 data block signals. Decisions start 10 seconds after completion and require the completed observation within 60 seconds; quote entry then requires the existing fresh post-decision quote within 60 seconds. Late recovery does not create a backdated signal. The signal journal and quote journal permit future exact replay; a historical midday quote replay without original decisions is explicitly BLOCKED rather than shown as zero trades or modeled decisions.

The 21–23 October OHLC comparison is exploratory: midday was chosen after observing KROSS on 23 October, so these dates are not out-of-sample evidence. Uses future-bar proxy fills and indicative costs. Missing history/paths and unavailable pre-session membership remain flagged. Historical runs never rewrite the live strategy snapshot or positions.

Historical qualification coverage is reported independently of realized trade paths. Missing current prefixes or prior-20 same-slot baseline data mark a comparison partial/blocked, including a zero-trade session that could not be evaluated. RVOL calculations group history by time slot before applying the unchanged median calculation; this avoids repeatedly scanning unrelated historical times.

## Fresh consolidation and retest paper experiments (23 October 2026)

These two independent accounts keep all existing baselines. Each takes 10 shares,
long-only, at most one first eligible attempt per stock/session. The universe is
that session's recorded Nifty plus frozen screener watchlist, not a new hindsight
stock list. Both use completed five-minute bars, a contiguous session prefix,
20 prior sessions' same-slot volume, and approximate HLC3 bar VWAP. No LLM can
invent missing prices or override these requirements. Missing qualification data
blocks signals; missing execution coverage keeps outcomes unknown.

* `midday-consolidation-10-v1`: signal candles start at/after 11:00 and finish
  by 14:00 IST. Freeze the **six preceding five-minute candles** as a fresh
  30-minute box (all start at/after 10:30). Box width / high must be ≤1%.
  Signal close must exceed box high and session approximate VWAP. Signal volume
  must be ≥1.5× prior-20 same-slot median and ≥1.2× mean box volume. Stop is box
  low. This differs from the preserved midday ORB, which uses the morning range.
* `orb-retest-10-v1`: confirmation candles start at/after 09:35 and finish by
  14:00 IST. The 09:15–09:30 opening high is resistance. A fresh breakout must
  close above it and approximate VWAP, have RVOL ≥1.5×, and follow a close at/below
  the level. Within the next 1–3 completed bars, a bullish candle must touch
  within 0.1% of the level and close above the level and current VWAP. Every
  intervening close must hold above the level. Stop is the lowest low since
  breakout, strictly below resistance. RVOL displayed is the breakout's RVOL.
  This conservative version requires a traded retest below resistance; a pullback
  that remains entirely above it does not qualify.

Entry uses the first eligible **future observed quote**, within 60s of an actual
recorded decision; no candle-open backdating. Target is 2× actual entry-to-stop
risk. Existing estimated charges and 1bp per-side slippage apply. Time exit begins
15:10 IST. Each setup's bars, levels and baseline observations are journaled.
The engine cannot make original quote-replay decisions for dates before its
installation; those replays are blocked rather than fabricated.

Historical comparison uses final-bar OHLC proxy execution: modeled decision at
bar end+10s, strictly later bar-open entry within 330s, stop-first ambiguous bars,
and unknown outcomes for missing price intervals. It is in-sample exploration,
not evidence of a profitable live strategy. New experiments remain disabled until
that comparison is reviewed, then may be enabled for prospective paper recording.
At that point 8/21 EMA pullback was research only; subsequent implementation and the versioned history fix are documented below.

AWS comparison completed before activation: run
`708ea2e0-f735-4355-aa3b-23fc84121cfe`, OHLC proxy, 21–23 October 2026.
21 October blocked: unavailable prior-20 volume history. On 22 October,
consolidation: 31 entries, net −₹2,490.56; retest: 7 entries, net −₹84.63.
On 23 October, consolidation: 26 entries, net −₹1,471.96; retest: 1 entry,
net −₹17.97. Net includes estimated charges and slippage. No unknown entered
outcomes on the two complete sessions. Neither experiment was profitable in this
sample. Both were enabled for prospective paper observation after this review;
existing strategy controls/configurations were checked unchanged. Research notes
for the EMA idea are in `research/ema-8-21-pullback.md`.

## 8/21 EMA pullback (23 October 2026)

`ema-pullback-10-v1` implements the core trend/pullback/reclaim rule from
`research/ema-8-21-pullback.md`: a 200+ bar continuous EMA8/EMA21 warm-up (every one
of the prior 20 sessions must be a complete 75-bar day, not same-slot samples), an
established rising trend, a 1-3 bar pullback that trades into the EMA8-EMA21 zone
without closing below EMA21, and a bullish candle that recloses above EMA8 and the
preceding bar's high. Stop is the pullback low. It shares the same fixed-10-share
sizing, estimated costs, 1bp slippage and 15:10 time exit as every other strategy, and
the same shared approximate-VWAP confirmation gate used by every setup in
`setup-signals.ts`. Relative volume is recorded as evidence only, not a gate, for this
variant; a volume-confirmed variant is a possible separate follow-up, not implemented.

Registered **disabled** when first implemented; it has not been backtested against real
recorded sessions, so there is still no result to cite, only the logic and its unit
tests against synthetic fixtures. The user explicitly chose to enable it anyway on
23 October 2026, reasoning that this entire deployment is paper-only (no broker orders
exist here regardless of strategy), so an unvalidated signal carries no real-money risk,
unlike the consolidation/retest setups above which were reviewed against two sessions'
OHLC-proxy history before being enabled. It is still recommended to run the dashboard's
OHLC-proxy and quote-replay backtests once enough real sessions exist and record the
result here, the same process used for consolidation and retest, since "paper-only"
protects capital, not research validity.

Deployment review follow-up: EMA qualification now explicitly reports blocked
when its required twenty complete 75-bar prior sessions are unavailable. Existing
72-bar REST histories do not satisfy this condition; zero trades in that case are
not a valid zero-return backtest. The live decision journal records the per-day
counts and avoids reconstructing large baseline batches when the history is
already known incomplete. No missing candle is interpolated. Existing strategy
parameters and controls remain unchanged. The operator watchlist now chooses the
newest pending submission across the whole queue, including more than 20 queued
requests, with older pending submissions explicitly superseded.

## EMA history v2: explicit core-session series

`ema-core-nifty-10-v2` is a separate Nifty 50 fixed-10-share paper experiment.
It preserves the strict full-session v1 account and every other baseline. The
versioned configuration declares a 09:15–15:15 IST calculation window on every
session. Only starts 09:15 through 15:10 are eligible for this EMA. The absent
15:15/15:20/15:25 starts stay missing in the raw recorder and full-session quality
reports. They are deliberately outside this model, not invented or treated as
exchange holidays. This EMA can differ from a normal full-session chart EMA.

Seed each session from the last **200 scheduled core-window slots** of the
previous three exchange-calendar sessions, followed by the current completed
prefix. SMA initialization of periods 8/21 is fixed at that seed start. Every one
of those 200 slots must contain exactly one real valid OHLCV bar; duplicate,
invalid, missing or unavailable-as-of-decision observations block the setup.
Unused earlier bars cannot affect this fixed seed. Current-session gaps also
block. Prior-20 same-slot volume evidence is still required; no minimum RVOL
ratio is introduced. Signals remain 09:45–14:30 IST, with approximate VWAP,
pullback/reclaim, stop, 2R target, future-quote entry, costs and 15:10 exit unchanged.

Historical runs use the identical seed/window policy with final-bar OHLC proxy
execution, explicitly labelled in-sample. Live decisions reconstruct only versions
observed by the actual decision time and journal the seed policy and source bars.
Quote replay without original v2 decisions is blocked; historical modeled signals
are never installed as live trades. Activation follows the requested backtest.
