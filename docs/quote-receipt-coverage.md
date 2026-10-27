# Quote receipt coverage and legacy screener sizing

The 27 October 2026 investigation found successful REST receipts every roughly five seconds for HILINFRA and GANDHAR even while `last_trade_time`, LTP and cumulative volume stayed unchanged. The lab updated its coverage clock only when the last trade was at most 15 seconds old. It therefore mislabeled inactive trading as a missing feed, including when a new eligible quote had just arrived.

`receipt-continuity-v2` tracks successful received observations separately from eligible execution quotes. A valid same-session receipt with an older last trade advances coverage, but never authorizes a stale-price fill. The existing post-decision entry, source freshness, stop/target and exit gates remain. Genuine gaps over 30 seconds, invalid/missing rows, future timestamps and missing exits remain conservative. Receipt continuity is sampled REST continuity, not a complete exchange tick history or independently verified source timing.

Position audit records include the receipt coverage policy, last receipt time and a separate stale-trade event. Coverage events record gap length and receipt timestamps. `quote-health-YYYY-MM-DD.jsonl` persists request duration, receipt gaps, missing rows and stale-trade symbols. Commodity master/history maintenance runs as one background task so those downloads cannot hold up quote polling. Quote snapshots remain atomic and the existing lab quote journal retains raw observations.

Closed historical positions are not rewritten. An isolated replay against archived observed quotes can show the prospective rule's effect, but it must be labelled a replay, not a corrected live execution result. Missing prices are never interpolated.

`PAPER_SCREENER_QUANTITY=10` in protected `paper.env` changes only newly created legacy `screener-orb` states to ten shares. Other legacy cohorts keep `PAPER_QUANTITY`; old state quantities remain stored. The new screener cohort is still candle-based and must not be treated as identical to quote-fill strategies. P&L comparisons across the size-change date should account for the change rather than scaling old trades.
