# All paper positions

`/positions` is an independent read-only view, linked from the sidebar. It shows
entered open and closed positions across all recorded sessions, with one table per
strategy. The same symbol stays separate in each strategy/account. Stock, session
and strategy selections in the existing dashboard do not filter this page.

`GET /api/positions` reads the existing legacy paper ledgers, strategy-lab rows
whose run ID starts with `live/`, and manual paper positions. It excludes unfilled
candidates, cancellations with no entry and historical simulation runs. It writes
no positions, controls, configurations or fills. A ledger read failure is shown
as partial data rather than an empty complete result.

The page refreshes every five seconds from the existing Dhan quote snapshots.
Live freshness uses the existing source/observation timestamp checks. Otherwise
it labels the most recent recorded quote (including the per-session quote
journal) as not live, or shows unavailable. Stocks outside the current quote
feed may have only an archived price. The existing quote collector is unchanged.

Open P&L is estimated only from a fresh mark. Closed P&L uses the original stored
result and never moves with live prices. Unknown outcomes stay unknown. Net
subtotals are per strategy; overlapping paper accounts are never summed into a
portfolio return. All displayed timestamps are IST; this is REST polling, not a
tick stream. A disconnected/stale page demotes live labels and open P&L marks.

The existing pages, selections and trading logic are unchanged apart from the
additive Paper positions navigation link. There are no order-entry/exit controls
on this page and no vendor credentials in the browser.
