# Validation evidence

Project: `/Users/mk/Documents/Codex/2026-10-20/task/dhan-market-data-mcp`.
Executed 19 October 2026 UTC. The workspace folder's date is 20 October; the intended strategy start is Wednesday 21 October 2026. The official NSE calendar identifies 20 October as a holiday; 21 October is a scheduled weekday session by calendar inference, not a live-data verification.

## Checks

- `npm run typecheck`: passed with strict TypeScript and unchecked-index checks.
- `npm test`: 35 passing tests, zero failures/skips, using synthetic fixtures and the official MCP client/server SDK.
- `npm run build`: passed; runnable stdio entry point is `dist/stdio.js`.
- Dependency installation after replacing vulnerable `csv-parse` with 7.0.3: npm reported zero vulnerabilities. The package lock is retained. An offline audit is not treated as authoritative evidence.
- Real stdio subprocess: client discovered exactly four read-only tools and called the mock quote. In-memory SDK tests called all four tools and checked sanitized unknown-instrument errors.
- `npm run test:http`: passed against a temporary Postman loopback-only simulation. Adapter requests reached the mock over actual HTTP, including CSV retrieval, quote retrieval, five-minute candle retrieval and rejected 401/429 responses. The probe used hard-coded fictional credentials and never read user credentials.
- Simulation log showed seven requests: five successful responses and two expected failures. Quote requests were logged at `16:33:45.794Z`, `16:33:46.797Z` and `16:33:47.796Z`, consistent with the global one/second quote limiter. Intraday JSON included the fixed `NSE_EQ`/`EQUITY`/`5` fields. Public CSV requests carried no Dhan credential headers.
- Temporary simulation stopped cleanly on SIGINT, with a final summary reporting 5 served and 2 failed requests. No remote server, tunnel or persistent service remains from this task.

Tests cover opening-range and confirmation boundaries, next-completed-candle fills, exact-slot 20-session median volume (including inclusive 1.5 threshold), bar-weighted VWAP, strict close conditions, zero/missing volume, missing recent sessions/slots, bad arrays/OHLC/duplicates, stale bars and quotes, timestamp/calendar verification gates, last 11:00 confirmation, conservative intrabar stop/target resolution, gap rejection and 15:15 exit observation. Future/incomplete bars cannot alter an earlier signal or fill. Tests also cover upstream-error sanitization, fixed allowlisted URLs, credential placement, redaction, placeholder rejection and the 90-day range bound.

## Limits and remaining setup

This evidence proves local TypeScript behavior against synthetic vendor-shaped data, not Dhan entitlement, live response compatibility or price freshness. No live Dhan data API call was made. Public official documentation and npm metadata/dependencies were retrieved; no broker credentials were installed/read, key or token created, subscription purchased, token renewed, order submitted, connector authorized, host registered, deployment published or account modified.

Before live use, obtain separate user approval for secure credential setup; confirm subscription status and current terms; provide a verified regular-session NSE calendar with 20 preceding trading sessions; validate live security IDs, epoch candle-start semantics, quote timestamp format/timezone, intraday adjustment treatment and observed lag. The disclosed HLC3 bar VWAP is approximate. Top-level exact qualification is always unverified, with `validSignal: false`, null strategy signal/trade and a separate approximate-analysis result. Exact qualification requires timestamp-aligned broker VWAP or suitable historical traded-value/tick data; no such integration is implemented. Simulation models one long trade and has no persistence, sizing, brokerage/fee model, execution integration or scheduling.

Only stdio is implemented. The README documents a secure future Streamable HTTP architecture, with separate MCP authorization and server-held broker credentials. Remote authentication and actual parent-chat compatibility remain unconfigured and unverified.

The optional local Postman mock was generated from the project's narrow, officially researched OpenAPI subset and extended with synthetic CSV. An owner-workspace search was intentionally omitted to avoid using existing app credentials. Its verbose fixture logs may expose the fictional test headers, so do not repurpose it with real secrets. A nonblocking keychain lookup error appeared during local mock generation; generation completed, no sign-in or credential setup was performed, and the loopback simulation/probe subsequently succeeded.

Focused follow-up findings, exact-qualification safeguards, official calendar evidence and updated tests are recorded in [SELF_REVIEW.md](SELF_REVIEW.md).
