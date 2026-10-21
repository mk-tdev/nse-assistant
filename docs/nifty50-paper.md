# Nifty 50 research paper scanner

AWS production selects RECORDER_UNIVERSE=nifty50. The frozen official NSE snapshot has exactly 50 distinct NSE EQ constituents (including BSE, excluding WIPRO); every symbol must map uniquely to a distinct Dhan security ID. Invalid, incomplete or expired membership fails startup; no silent two-stock fallback. Snapshot expires after 2026-10-31 and must be refreshed before November.

Every stock runs orb-long-v1 independently: 09:15–09:30 IST opening range; completed five-minute close above range high and approximate HLC3 VWAP; volume at least 1.5 times the same-slot median across 20 prior scheduled sessions; morning confirmation through 11:00; next-bar hypothetical open entry observed only when its bar completes; stop at range low, target 2R, one candidate per stock/session; 15:15 hypothetical time exit when observable. One simulated share per candidate, at most 50 candidates/day. No portfolio capital allocation or ranking is implied. Unknown fees/slippage keep net P&L null. Missing terminal prices keep outcomes unknown. No real orders or trading endpoints.

Scanner rows and counts are published in paper.scanner in the dated session report and dated paper report, and displayed by the private SSH report viewer. Rows show opening range, latest close, approximate VWAP, same-time volume ratio during the entry window, ledger status, reasons and data quality. Descriptive latest revised bars cannot modify immutable simulated trade decisions. All 50 are evaluated; no top-N filter.

Historical data calls share the collector process limiter with 350ms minimum start spacing (under Dhan's published 5/sec maximum), no parallel collector, and fixed target poll cadence. Fetch errors and stale observations block affected entries. Data freshness limits are unchanged. Preload all 20-session morning baselines before market; runtime backfill is only a bounded repair path. Research calendar and candle-start assumptions remain provisional. AWS keeps SQLite on the existing persistent data mount; SSH-only access and the session timer remain in place.

Sources: https://archives.nseindia.com/content/indices/ind_nifty50list.csv and https://www.niftyindices.com/Press_Release/ind_prs10082026.pdf ; rate limits https://dhanhq.co/docs/v2/ .

SQLite temporary sorting stays in memory so full-universe history ingestion also works under the production container read-only root filesystem; persistent ledger files remain on the writable data mount.
