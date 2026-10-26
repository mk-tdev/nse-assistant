# All-strategy P&L overview

`/overview` and `GET /api/overview?from=YYYY-MM-DD&to=YYYY-MM-DD` provide an
independent, read-only report. The dashboard's selected strategy/stock has no
effect. The default is the latest recorded session. Date ranges use IST entry
session dates and the latest recorded final closed outcomes, not an intraday
point-in-time replay. Future or invalid ranges return HTTP 400.

The report explicitly sums independent live-paper strategy experiments, including
repeated trades in the same stock and mixed legacy quantities. It is not a single
account equity curve, common-capital return, or deduplicated trade portfolio.
Backtest runs are excluded. Strategies with no entered trades remain listed in
a separate expandable section and do not imply a validated zero return.

Saved charge breakdowns are reused when complete and internally consistent.
Legacy trades lacking a breakdown receive a comparable estimate from their
recorded entry/exit fills using the existing paper cost model. Stored results,
positions, controls and strategy parameters are never rewritten. All charges are
paper estimates, not broker-billed expenses. The breakdown includes brokerage,
exchange charges, STT/CTT, GST, stamp duty, SEBI/IPFT, and separate slippage.

Buy/sell turnover is executed notional, not an expense; short entries are sell
turnover and short exits are buy turnover. Unknown exit legs are omitted rather
than invented. Open estimates include hypothetical exit fees only for fresh
current-session marks; they do not add hypothetical exits to executed turnover.
Old open positions, missing costs, stale marks and unknown paths prevent complete
net reporting. Partial cards show valued-position P&L subtotals, and cost totals
may include known charges on unresolved outcomes. This is labelled on the page.
Net win/loss counts use valued closed positions after costs.

The existing dashboard, positions view and trading workers are unchanged apart
from additive navigation links. The overview refreshes every ten seconds and
reports disconnected/stale results instead of presenting them as fresh. Cloud,
LLM and data subscription spending is outside this trading-cost report.
