# Focused self-review

Performed 19 October 2026 UTC. All follow-up work remained local and mock-only; no credentials, connectors, subscriptions, deployments, listeners or network-permission changes were configured during this review.

## Defects fixed

1. **Exact qualification flag could be true using approximate VWAP.** Disclosing the approximation was insufficient. `src/analysis.ts` now separates `analyzeApproximate` from the MCP-facing `analyze`. Exact results always have `qualification: unverified`, `validSignal: false`, `signal: null`, and `trade: null`, and explicitly identify missing `timestamp_aligned_exact_session_vwap`. The approximate model's `candidate`, `hypotheticalTrade` and `qualifiesUnderApproximateModel` are nested under `approximateAnalysis`. `src/server.ts` always returns `currentSignal: false`. Even a rejected approximate candidate cannot prove the exact strategy did not qualify: exact status remains unverified.
2. **Synthetic weekday calendar included published holidays.** `src/mock.ts` now excludes 14 September, 2 October and 20 October. The default fixture source remains explicitly synthetic; a scheduled-date evidence snapshot is retained under `fixtures/` and tested against the mock dates, without configuring it for live operation. Missing 19 October volume cannot be substituted with fabricated 20 October or older sessions.
3. **Whitespace in opaque bearer-token logs could leave token text behind.** `src/dhan.ts` redacts complete quoted values and complete unquoted authorization values, and tests cover opaque bearer tokens and whitespace. The production server still omits exception details and has no request/header logging. Allowlist entries are individually frozen as well as the containing map.

## Code paths and qualifications

- `src/server.ts:createServer` registers exactly `instrument_lookup`, `timestamped_quote`, `historical_five_minute_candles`, and `opening_range_breakout_analysis`. SDK tests discover this exact set and exercise all four, including nested approximate output, a pending next-candle observation, a rejected future as-of, and sanitized errors. A real stdio subprocess is also tested.
- `src/analysis.ts:analyzeApproximate` requires verified start timestamps/calendar, exactly 20 distinct prior calendar sessions with valid same-time volume, all completed current-session bars from 09:15, fresh latest expected bar, nonzero VWAP volume, and valid OHLC. Range is [09:15,09:30). Candidate close must exceed range high and approximate session VWAP; slot volume must be >=1.5× prior-20 median. The filter checks `c.start + FIVE <= at(date,'11:00')`, so 10:55–11:00 qualifies for timing and 11:00–11:05 does not.
- The nested approximate simulator uses the next candle's open only after it completes, OR-low stop, 2R target, conservative stop-first ambiguity, and a 15:15 open exit reported after that bar completes. It never creates a strategy-approved fill.
- `src/dhan.ts:quote` exposes stale/unknown timestamps and broker daily VWAP separately. Quotes are not read by the analysis path, so a later broker snapshot cannot be substituted for a prior confirmation-time VWAP.
- `src/dhan.ts:DhanProvider` uses only a private key into three fixed method/URL pairs (official CSV GET, quote POST, intraday POST), rejects redirects, keeps credential headers off the public CSV, and exposes no generic request MCP tool. No token generation/renewal, account, orders, portfolio or funds endpoint exists.

## Calendar evidence

The official [NSE capital-market circular NSE/CMTR/71775, 12 December 2025](https://nsearchives.nseindia.com/content/circulars/CMTR71775.pdf), page 1, lists 20 October 2026 as the Dussehra trading holiday. The [current official NSE holiday page](https://www.nseindia.com/resources/exchange-communication-holidays) confirms that holiday. The annual capital-market list contains no 21 October holiday. Because 21 October is Wednesday, it is a **scheduled regular session by calendar inference**, subject to subsequent notices. This research verifies the published schedule, not actual market opening, a live quote, Dhan entitlement or data delivery.

## Verification

`npm run check` passes strict type checking, **35 tests** and the production build. Added focused assertions cover exact-versus-approximate qualification, incomplete range, stale quotes, 19 prior sessions, duplicate-session attempts, holiday gaps, start/end-label ambiguity, incomplete-next-candle behavior, future bar/volume leakage, future as-of rejection, 11:00 completion cutoff and authorization redaction. No HTTP listener was started or new network permission requested during this follow-up; the earlier loopback-only adapter evidence remains recorded in `VALIDATION.md`.

## Minimum remaining requirements

Exact strategy qualification still needs a data-source integration that supplies instrument/session-specific exact cumulative traded value and volume, or broker session VWAP with trustworthy timestamps aligned to every evaluated five-minute completion and no next-bar trades included. A current quote alone is insufficient. That integration must validate source, alignment, completeness/freshness and session reset, and gain tests before exact qualification can be enabled.

Live operation additionally needs separately approved secure short-lived credential injection, subscription confirmation, a currently verified operational NSE regular-session calendar covering the prior 20 sessions, live instrument/time/adjustment/lag validation and a supported host registration. Remote authorization is documented only; it is not configured. The four tools are not automatically connected to the parent chat. No live-data or exact-signal readiness is claimed.
