# Intraday stock selection — research and test plan, 23 October 2026

## What our own evidence says

On 22 October the morning-frozen screener list supplied 11 stocks and five original ORB entries: three gross winners, two gross losers, known one-share gross -14.70 INR. Nifty 50 supplied 22 entries: 11 winners/11 losers and -73.97 INR. Normalizing each trade by its original stop risk gave mean gross +0.306R for the screeners versus +0.022R for Nifty. Costs were not included in those R figures. One-share allocations have unequal cash risk. Five screener trades and one session are insufficient to establish selection alpha.

Nifty 50 is a liquid benchmark universe, not an intraday catalyst or momentum selector. Screener selection supplies a different prior hypothesis, but daily breakout lists can contain thin names and already extended moves. Their as-of snapshots must be frozen before the trading session; applying today's list to old dates leaks future selection information. The 16/19/21 October exploratory screener results had that limitation. The actual 22 October list was frozen before the market opened.

EICHERMOT's 22 October signal was 2.05 opening-range widths beyond the breakout high. Its 2.86x same-slot volume did not prevent a loss. TCS failed with 1.58x; ETERNAL failed with 7.42x. A volume threshold alone cannot guarantee follow-through. Our faster exit reduced those losses but also cut BAJAJ-AUTO and CIPLA winners. Changing entry selection and changing exits must be tested separately.

## External evidence and its limits

Zarattini, Barbon and Aziz study ORB and volume-selected "stocks in play" in **US equities**, including the distinction between broad stock universes and unusually active names. This motivates a test of opening relative volume here; the markets, timeframe, execution/cost assumptions and opening auction differ, so it does not validate our NSE parameters or imply comparable returns. Primary university repository: https://www.alexandria.unisg.ch/server/api/core/bitstreams/3c2989c4-688d-4d78-8a71-f02690990d51/content ; author discussion: https://members.bearbulltraders.com/a-profitable-day-trading-strategy/ .

NSE explains that execution impact depends on order size and book liquidity, not simply share count or the bid-ask spread. Turnover is only a practical proxy until quote depth is archived: https://www.nseindia.com/static/products-services/indices-impact-cost . Our existing 100k-share prefilter can exclude expensive stocks even when their traded value is substantial; evaluate it separately from traded-value and spread filters rather than assuming it identifies intraday tradability.

NSE's pre-open information includes indicative equilibrium prices, quantities and imbalances, with the opening price determined through the auction. Pre-open indications are not interchangeable with executed regular-session trades: https://www.nseindia.com/static/products-services/equity-market-pre-open .

NSE surveillance frameworks can impose trade-for-trade, price-band or other restrictions. A high-ranking chart does not establish intraday eligibility. Point-in-time series, surveillance and corporate-action metadata are separate inputs: https://www.nseindia.com/static/regulations/additional-surveillance-measure and https://www.nseindia.com/static/regulations/graded-surveillance-measure . The current EQ instrument mapping is not a complete historical surveillance audit.

The indicative cost model is sourced from Dhan's published pricing, not the user's actual contract notes: https://dhan.co/pricing/ . Record measured spreads/impact when available; don't treat the assumed 1 bp per side as observed execution cost.

## Candidate-selection approaches

| Approach | Why test it | As-of evidence required | Current implementation |
|---|---|---|---|
| Frozen daily breakout watchlists | Prior trend/level preparation | Morning source snapshot + unique NSE mapping | Existing Chartink/Screener baseline retained |
| Opening stocks in play | Unusual participation in today's session | Same opening window vs prior 20 sessions, turnover, return | New ranked trial; frozen at 09:31 IST |
| Gap/catalyst selection | Fresh repricing may explain activity | Adjusted prior close, opening price, timestamped news/filings | Research proposal; not implemented as a verified news feed |
| Sector-relative leaders | Distinguish stock strength from a sector-wide move | Historical membership and synchronous sector/index prices | Research proposal; new v1 uses pool-median relative strength only |
| Volatility/room-to-target | Avoid very wide stops, nearby resistance or late chasing | Adjusted prior ranges/ATR, price levels known before entry | Extension cap trial implemented; full verified ATR/level filter not implemented |
| Liquidity/tradability | Avoid unstable spreads and restricted instruments | Bid/ask depth, size-specific impact, bands/series/surveillance | Turnover proxy and existing mapping only; no claim of full tradability validation |

## What is active now

Six independent trials use the same first ORB candidate trigger, 10 shares, observed post-decision quotes and identical estimated costs: Nifty-only control, all candidates, extension cap, screeners, screeners plus cap, and opening-ranked stocks in play plus cap. This isolates selection/extension changes from execution and sizing. The original bar-based ledgers remain a historical control, but cannot be compared as equal fills against the new quote engine. Equal-risk sizing is an optional paused experiment, consistent with the user's decision to use fixed 10 shares for trials.

Opening selector v1 requires complete 09:15–09:30 bars and prior-20 same-window baselines, opening relative volume >=2x, approximate turnover >=1 crore INR, a positive opening return above the candidate pool median, and a top-10 rank by relative volume then relative strength. These thresholds were selected as explicit starting hypotheses, not fitted/validated estimates. Its pool is the collected Nifty 50 plus screener additions; it is not a scan of every NSE stock. Missing evidence produces a rejection reason, not a substitute stock picked after seeing the day.

## How we learn without picking yesterday's winners

1. Freeze universe, source snapshots, filters and definition versions before the session. Log every acceptance/rejection, including data-unavailable cases.
2. Compare the **same trigger and fills** across selections. Track candidate count, fill rate, stale-quote rejection, unknown outcomes, turnover, fee/slippage drag, net expectancy and R distribution. Include no-trade days.
3. Predeclare a validation block of future sessions and avoid changing thresholds each day. Keep in-sample exploratory replays clearly separated. A few profitable runs cannot establish a reliable edge.
4. Evaluate gap, sector and catalyst ideas only after collecting their timestamped inputs. Don't retrofit current lists, current sector membership or later news into old decisions.
5. Expand the candidate pool with a separate liquid-market discovery snapshot only when ingestion capacity and point-in-time eligibility data are ready. Do not silently replace the old screener universe, broaden all collectors to thousands of names, or call missing-history names no-signal.
6. Evaluate any additional filters for both avoided losers and discarded winners. Confidence intervals, cost sensitivity and out-of-sample drawdowns matter more than selecting a perfect-looking historical chart.

No method can pick intraday stocks perfectly. The objective is a reproducible improvement in net expectancy under realistic observations, not a guarantee that every chosen stock wins.
