# 8/21 EMA pullback — research only

Reviewed 23 October 2026. Registered as `ema-pullback-10-v1`, **disabled**, implementing
the core rule below (no volume filter yet). There is no verified win rate or
profitability estimate for this proposal.

## Implementation status (added after this review)

The core trend/pullback/reclaim rule is implemented in `src/ema.ts` (plain EMA with
fixed SMA seeding) and `src/setup-signals.ts` (`cfg.setup==='ema-pullback'` branch),
unit-tested in `test/ema.test.ts` and `test/ema-pullback.test.ts` against synthetic
fixtures only. `src/midday-signals.ts` was extended so this setup's live decision path
fetches a continuous per-session candle range for warm-up (at least 200 prior bars),
instead of the same-time-of-day sampling the other midday setups use, since an EMA
needs a gap-free chronological series, not slot samples.

It has **not** been backtested against real recorded sessions: this repository's local
candle history (two symbols, a few sessions) is far short of the 20-session, 75-bar/day
continuous history the rule requires, so no realistic OHLC-proxy or quote-replay result
can be produced here. Before enabling it in the live strategy lab, run the dashboard's
existing backtest tool (OHLC proxy, then quote replay) on AWS, exactly as was done for
`midday-consolidation-10-v1` and `orb-retest-10-v1` in `docs/research-cohorts.md`, and
record the result there. It stays disabled until that review happens.

The shared session-approximate-VWAP gate that every other setup in `setup-signals.ts`
goes through (confirmation close must exceed cumulative session VWAP) also applies here,
as an extra conservative filter beyond what the sources below describe. Relative volume
at the confirmation candle is computed and recorded as evidence (reusing the same
prior-20-session median as every other setup) but is **not** a gate for this variant,
matching the "core rule first, volume-confirmed variant separately" plan below.

## What the sources actually say

[Fidelity's EMA guide](https://www.fidelity.com/learning-center/trading-investing/technical-analysis/technical-indicator-guide/ema)
describes using a rising EMA as trend context and looking for price dips near it.
It also explains that EMA sensitivity creates more short-term changes and that
entries/exits still lag. This supports studying pullbacks; it does not establish
an edge for the specific 8/21 combination or our NSE universe.

[TradingView's calculation guide](https://www.tradingview.com/support/solutions/43000502589-moving-averages/)
explains recursive EMA calculation and SMA initialization. An 8-period EMA on a
five-minute chart uses five-minute closes, not eight days. The EMA retains
historical influence, so initialization and warm-up must be fixed before a replay.

[Chartink's 8-21 bullish scan](https://chartink.com/screener/copy-copy-multiple-ema-5m-intraday-buy-scanner-2),
inspected in the browser, requires five-minute close above EMA8/21/50/100, with
EMA8 > EMA21 > EMA50 > EMA100, in the futures-eligible stock universe. These are
trend-alignment filters. They do not require a prior pullback, a touch of either
EMA, a reclaim, a stop, an execution price or a trade exit. The displayed current
bar must not be treated as a completed-bar signal.

[Screener's screen titled 20EMA pull back](https://www.screener.in/screens/1972969/20ema-pull-back/?include_old=yes)
actually queries market cap >1000 crore, price above DMA50/200, DMA50 > DMA200,
volume >100000, monthly average volume above yearly average, weekly average below
monthly average, and monthly average >500000. The visible query does not calculate
an EMA or prove that price touched it. This is a possible watchlist context only.

[Chartink's official backtest FAQ](https://chartink.com/articles/backtest/backtest-results-faq/)
warns that incomplete and mixed-timeframe candles can change historical scan
results. Freeze watchlists and completed higher-timeframe inputs at their actual
availability times; never reconstruct morning eligibility from end-of-day scans.

## Proposed experiment, subject to later approval

The following rules are our research hypothesis, not rules validated by the sources.

1. Use five-minute completed closes and at least 200 valid preceding trading bars
   for warm-up; continue across sessions. Fix SMA seeding and reject missing warm-up
   data. Do not silently interpolate a missing candle or reset EMAs each morning.
2. Trend: EMA8 > EMA21 and both higher than three completed bars earlier. The close
   before the pullback must be above EMA8. Start evaluation after 09:45 IST.
3. Pullback: within one to three completed bars price trades into the EMA8–EMA21
   zone, while every pullback close remains above EMA21. This distinguishes a
   controlled pullback from buying every upward crossover.
4. Confirmation: a bullish completed candle closes back above EMA8 and above the
   preceding candle's high. Freeze the pullback low as the stop. Reject nonpositive
   risk or stale/unavailable quotes. First future eligible quote is the paper entry;
   target is 2R from actual entry, and the common 15:10 time exit applies.
5. Keep 10 shares and independent accounts. Compare the core rule with one separate
   volume-confirmed variant; do not add many filters until a preferred result appears.
   If adding a 15-minute trend filter, use only completed 15-minute bars.

## How to judge it

Use the same frozen stock universes, quotes, charges and slippage as the other
strategies. Report Nifty and screener subsets separately, entry/stop distance,
fees as a fraction of risk, expectancy, drawdown, unknown outcomes and missed
signals. A tight stop can lose its apparent advantage after charges, spread and
slippage. Flat, tangled EMAs are a likely whipsaw regime to investigate, not a
reason to claim the trend rule already works.

Freeze rules before collecting a fresh holdout period. Our two available complete
October sessions are useful for debugging and exploration, not enough to declare
a winning strategy. This signal rule also does not replace point-in-time stock
selection or liquidity checks.
