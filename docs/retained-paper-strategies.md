# Retained paper strategies — 30 October 2026

Paper trading only. Pause decisions use five recorded sessions (26–30 October), not proof of future performance.

Keep Agent Trading and shadows unchanged, plus Opening Stocks in Play, Breakout Retest, Nifty control, both general ORB variants and both screener ORB variants. Keep paired baselines for prospective comparison even where their latest trades coincide.

Pause and hide new standalone entries for:

- Midday ORB: −₹1,311.37 on 30 October; earlier aggregate includes unresolved sessions.
- Midday consolidation: −₹1,490.42 on 30 October; volatile across sessions.
- Core Nifty EMA: only +₹15.77 across 199 entries over five fully resolved sessions.
- EMA pullback: −₹374.15 known five-session subtotal, including partial early sessions.

Hide already-paused legacy cohorts and the unused optional equal-risk experiment. Preserve legacy technical signals used by the agent and retained quote strategies. Pausing standalone executions does not remove the agent's candidate evidence sources.

Execution pauses use the existing durable `lab_controls` overrides through the lab-toggle command queue. Existing workers consume these without restarting. Already-open positions would retain stop/target/time management. The archive display also keeps open positions visible until closed.

`src/strategy-visibility.ts` is the reversible presentation archive. Default dashboard, overview, comparison and position views omit archived closed records. Their displayed totals and capital estimates use the retained subset, including for historical dates. The pages label that scope. No original execution, P&L, candle, decision or shadow row is deleted or rewritten.

Full read-only historical API access remains available with `includeArchived=1` on `/api/overview`, `/api/comparison`, `/api/positions`, `/api/dashboard` and `/api/lab/status`. Saved backtest runs remain intact. To restore a strategy later, remove its ID from the presentation archive, redeploy the report service, and resume paper entries through the normal control. Backtest definitions retain all strategies.

No schedules change. Recorder and watchlist timers remain weekdays only. Deploy only the reporting image; do not restart trading workers or start a stopped recorder.
