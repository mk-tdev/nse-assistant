# Dhan read-only market-data MCP

Isolated TypeScript project for NSE cash-equity paper analysis, starting **Wednesday 21 October 2026**. Default mode is entirely synthetic. It does not connect to Dhan, an account, a subscription, or the parent chat. The separate recorder command now includes an automatic simulated paper loop with a persistent SQLite ledger; the existing Lightsail timer can schedule that combined process after review. Strict mode remains blocked by missing exact inputs.

## Run locally

Requires Node.js 24+ and npm. Clone this repository, then install and verify:

```sh
git clone https://github.com/mk-tdev/nse-assistant.git
cd nse-assistant
npm ci --ignore-scripts
npm run check
npm start
```

`npm start` speaks MCP on stdin/stdout; use an MCP client to interact with it. Ordinary diagnostics go to stderr. Tests need no Dhan credentials. `node --import tsx src/stdio.ts` also runs the source. The lockfile pins the dependency tree; the official split MCP server/client SDK packages are version 2.3.1.

A **review-only** host configuration example follows. This was not installed in any host:

```json
{
  "mcpServers": {
    "dhan-market-data-local": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/dhan-market-data-mcp/dist/stdio.js"],
      "env": { "DHAN_MODE": "mock" }
    }
  }
}
```

Creating this server does **not** make its tools available in another chat. Host registration, supported transports, permissions and tool discovery must be checked separately. No connector, OAuth grant or host configuration was changed.

## Read-only session recorder (HDFCBANK and TCS)

A separate foreground worker records completed five-minute candles to SQLite and writes per-symbol data-quality reports. It never places orders or claims exact strategy qualification. It also runs the strict-default paper worker; explicitly opted-in research can record hypothetical signals and positions. Run `npm run check` first, then:

```sh
npm run record -- --live --date 2026-10-21
npm run record -- --report --date 2026-10-21
```

The command explicitly loads `.env.local`; select the intended session date and keep the computer awake. Defaults: 30-second polling, 10-second settlement allowance, and private gitignored storage under `.local/recorder/live/`. It stops after the session-close grace period. Mock demonstrations use separate storage. See [the recorder runbook](docs/session-recorder.md) for timing, error handling, restart behavior, synthetic HTTP tests and next-session checks. The existing MCP `npm start` entry point still does not load environment files automatically.

## Tool contract

All four tools advertise `readOnlyHint: true`; none accepts credentials, an arbitrary URL, an endpoint path, or an HTTP method. Scope is deliberately restricted to NSE EQ-series cash equities. Resolve an instrument before using its ID.

| Tool | Input | Result |
| --- | --- | --- |
| `instrument_lookup` | `query`, optional `limit` (1–50) | Matching security IDs, symbols and display names; source, retrieval time and freshness |
| `timestamped_quote` | `securityId` | Price, broker session VWAP when supplied, source trade timestamp, retrieval time, age/freshness and missing status |
| `historical_five_minute_candles` | `securityId`, `date` | Completed regular-session five-minute OHLCV, explicit UTC start/end, missing slot list and freshness relative to the requested session |
| `opening_range_breakout_analysis` | `securityId`, `date`, optional offset-qualified `asOf` | Exact qualification unverified/blocked, separate approximate candidate and hypothetical trade, evidence, source, calendar, time zone and missing-data status |

Mock example: ID `999001`, symbol `MOCK_EQ`, date `2026-10-21`, fixed as-of `10:00 IST`. The security ID and prices are fictional; session fixtures exclude published holidays. Mock output says `mode: mock`, `liveConnected: false`, `currentSignal: false` and identifies its synthetic source. The mock fixture excludes published NSE holidays on 14 September, 2 October and 20 October. It is not installed as an operational calendar.

## Paper-analysis rules

- Time zone is `Asia/Kolkata` (IST, UTC+05:30). Candle timestamps are interpreted as interval starts only when verified. The regular session is 09:15–15:30; special sessions are unsupported.
- Opening range is exactly the three bars starting 09:15, 09:20 and 09:25, i.e. **[09:15, 09:30)**. The 09:30 bar is excluded from the range.
- First eligible confirmation is the completed 09:30–09:35 bar. Its close must be strictly above the range high and session VWAP model; volume must be at least **1.5 × the median volume of that exact five-minute start slot across the previous 20 trading sessions**. A zero median is undefined. Session dates come from an explicitly verified calendar; a missing recent session is never replaced with an older observed session.
- **VWAP limitation:** candle analysis explicitly uses cumulative `sum(HLC3 × bar volume) / sum(bar volume)` through the confirmation bar. This is a bar approximation, not exact exchange traded-value VWAP. It is named in the tool description and every analysis result. Dhan's `average_price` quote field is returned separately as `brokerSessionVwap`; its current value is never applied retrospectively to earlier bars. **Approximation can never qualify the exact strategy:** top-level `qualification` stays `unverified`, `validSignal` and `currentSignal` stay `false`, and strategy `signal`/`trade` stay null. Only the separate `approximateAnalysis` reports `qualifiesUnderApproximateModel`, a `candidate` and `hypotheticalTrade`. Without exact VWAP at each signal candle completion, top-level status is `exact_vwap_unverified` (or `blocked` for deficient data). A current broker quote is not timestamp-aligned historical evidence. A suitable historical traded-value/tick source or precisely aligned broker VWAP observations are still required; no exact-VWAP input path has been implemented.
- The approximate model considers only its first qualifying long candidate; at most one hypothetical trade per session. The final confirmation close is **11:00 IST inclusive** (10:55 start). No 11:05 confirmation.
- Entry uses the next candle's open, never the confirmation close. Conservatively, that next candle must itself be completed before a fill is reported. Otherwise the nested approximate-analysis status is `signal_pending_next_completed_candle`, with no fill/target calculated from unseen data. An entry at/below the range low is rejected.
- Stop is opening-range low. Target is entry + 2 × (entry − stop). Simulated stop gaps fill at the worse of open or stop. If stop and target are both touched in a bar, stop wins; intrabar order is unknown. Target fills at the target. Exit at the 15:15 candle open is reported only after that candle completes at 15:20. Until then no unseen exit price is fabricated.
- Only bars ending at/before as-of are used. Missing range/session bars, absent volume, missing same-slot history, zero VWAP volume, duplicates/invalid prices, unverified calendar/timestamps, or missing latest completed bars block validity. History is fetched before evaluation and never filled forward. Historical replay is labeled and cannot be a current signal. Exact strategy `validSignal` and `currentSignal` remain false; approximate model evidence is kept separate and never becomes an exact entry instruction.
- Freshness is conservative: if an expected completed five-minute slot is absent, data is stale. Source retrieval time alone is not proof of fresh prices. An unverified or missing quote timestamp produces `unknown` freshness, not `fresh`. Quotes older than 60 seconds are marked stale.

This is a simulated research engine, not Dhan Sandbox or a broker execution engine. There are no order, portfolio, funds, positions, token renewal, authentication-changing, or account-modification tools or endpoints. The separate automatic paper worker has an explicit one-share default and optional configured fee/slippage estimates; net PnL is null when costs are unspecified. Corporate actions and actual execution costs remain unverified.

### Scheduled launch date

The [official NSE capital-market circular NSE/CMTR/71775](https://nsearchives.nseindia.com/content/circulars/CMTR71775.pdf) and [current NSE holiday page](https://www.nseindia.com/resources/exchange-communication-holidays) identify **20 October 2026 as the Dussehra trading holiday**. **21 October is Wednesday and is not listed as a trading holiday**, so it is a scheduled regular session by that published calendar; this is a calendar inference, not a live-opening or data-delivery verification. Review subsequent exchange notices before operation. Tests exclude the holiday and require 19 October's same-slot volume rather than fabricating 20 October's.

## Live setup is a separate approved step

**No credential installation, subscription purchase, remote authentication or persistent access has been performed.** `.env.example` contains placeholders only and is not automatically loaded. Actual `.env*`, secrets, logs, local configuration, build output and dependencies are gitignored. Do not paste tokens into chats, tool arguments, source, tests or host configuration committed to Git.

After the user approves secure setup, a local operator can arrange short-lived environment injection from a protected secret store, then set:

| Variable | Meaning |
| --- | --- |
| `DHAN_MODE` | `mock` by default; `live` opts into Dhan calls |
| `DHAN_CLIENT_ID`, `DHAN_ACCESS_TOKEN` | User-supplied short-lived credentials, held server-side only |
| `DHAN_CANDLE_START_VERIFIED` | `true` only after verifying epoch seconds refer to candle starts |
| `DHAN_QUOTE_TIMEZONE_VERIFIED` | `true` only after verifying the quote's DD/MM/YYYY timestamp is IST |
| `DHAN_CALENDAR_PATH` | Local JSON `{ "source": "verified exchange reference", "verified": true, "sessions": ["YYYY-MM-DD"] }` with every regular trading date covering the previous 20 sessions plus requested date |

The MCP path still needs an operator calendar. The combined worker includes an explicitly unverified scheduled research calendar covering September–December; strict mode does not treat it as verified. A non-installed test snapshot of scheduled September–October dates is in `fixtures/nse-scheduled-sessions-2026-09-to-10.json`. An absent calendar blocks analysis. Do not mark a weekday list as verified. Live access, timestamps, holiday completeness, instrument mapping, adjustment semantics, entitlement and actual data lag must be validated in that approved setup before relying on outputs.

### Official Dhan integration facts

Checked against public official documentation during implementation (19 October 2026 UTC; workspace folder is dated 20 October):

- Data access is separately chargeable. Dhan Support lists **₹499 plus applicable taxes per month**, with auto-debit from the trading ledger every 30 days. Confirm entitlement/pricing with the user; this project does not subscribe or charge anything. [Dhan Support](https://dhan.co/support/platforms/dhanhq-api/how-to-access-dhan-api/)
- Direct web access tokens last **24 hours**. API key/secret validity is separate (documented as 12 months); neither is created or renewed here. A token's capability is not assumed to be data-only: isolation is enforced in this adapter. [Authentication](https://dhanhq.co/docs/v2/authentication/)
- Quote snapshots use `POST /v2/marketfeed/quote` with `access-token` and `client-id`; up to 1,000 IDs per vendor request, one request/second. This tool queries one resolved instrument. Daily OHLC in a quote is not a five-minute candle; `average_price` is the broker's daily VWAP. The quote timestamp example is DD/MM/YYYY but its timezone/field description is insufficiently explicit, so timezone verification is gated. [Market Quote](https://dhanhq.co/docs/v2/market-quote/)
- Intraday uses `POST /v2/charts/intraday`, interval `5`, `NSE_EQ`, `EQUITY`; five years for active instruments, at most 90 days per request. The adapter checks parallel array lengths, numeric values, OHLC relationships, alignment, chronological order and duplicates. Missing volume stays missing. Documentation identifies epoch timestamps but does not explicitly guarantee start/end labeling or intraday adjustment treatment. No automatic chunking, expired-instrument support or adjustment correction is implemented. [Historical Data](https://dhanhq.co/docs/v2/historical-data/)
- Official detailed CSV maps security IDs to instruments. The adapter retrieves only `https://images.dhan.co/api-data/api-scrip-master-detailed.csv`, filters NSE/E/EQUITY/EQ, and caches it for an hour; a recent retrieval does not prove a new source revision. [Instrument List](https://dhanhq.co/docs/v2/instruments/)
- General documented data limits are five requests/second and 100,000/day, while quotes have their own one/second limit. Independent process-wide queues enforce 200ms historical and 1,000ms quote spacing. Local UTC daily counters cap each at 100,000; they reset on restart and cannot account for other applications or processes. **Run a single process**; a future shared limiter is required before multiple instances. `401`, `403`, `429`, timeout, bad schema and other failures return sanitized errors; no silent retries or credential renewal. [Rate limits](https://dhanhq.co/docs/v2/)

Only three upstream method/URL pairs are allowlisted in `src/dhan.ts`: the public CSV GET and the quote/intraday POSTs. All redirects are rejected; credential headers are never attached to the public CSV. No generic proxy exists. Exceptions exposed through MCP use fixed codes, and startup diagnostics omit exception details; the redactor also removes secret fields and known literal tokens. Debug request/body/header logging must remain disabled.

## Lightsail recorder deployment

The [Singapore deployment runbook](deploy/lightsail/README.md) includes a Docker image, market-session scheduler, persistent host storage and a quality-report viewer accessed through SSH. Instance `nse-recorder` was deployed using AWS profile `default` following approval of the US$12/month plan. Local access instructions are in `.local/deploy/ACCESS.md`. The worker requires a current Dhan access token; token renewal is not automated.

## Secure remote MCP transport option (documented, not enabled)

Use MCP **Streamable HTTP** with the same `createServer` tool definitions behind a reviewed HTTPS endpoint and separate MCP authorization. No remote MCP listener or authentication has been implemented. The separate read-only report viewer in the Lightsail package uses SSH access.

Before implementation/deployment, a separate user-approved security setup must choose a supported host/client and auth provider. Use the official SDK's `@modelcontextprotocol/node` adapter or Web-standard handler for the negotiated protocol version. Require TLS, validate Host and Origin with an explicit allowlist (invalid Origin → 403), and bind any local upstream listener to 127.0.0.1. Validate short-lived MCP access tokens, issuer, audience/resource and appropriate data-read scope on every call; use protected-resource metadata and the MCP authorization flow supported by the client. Deny unauthenticated requests. Keep broker credentials entirely server-side and separate from MCP tokens. Do not pass through a client's bearer token to Dhan. Restrict access to the user's private market data, enforce rate limits, disable public caching and redact authorization in proxy/application logs. Treat any sharing/redistribution rights as an unresolved operational check before sharing data.

The current 2026-07-28 transport uses a single POST MCP endpoint; older clients may negotiate legacy behavior. Use the SDK's compatibility support, not a hand-written JSON-RPC bridge. Sources: [official SDK](https://github.com/modelcontextprotocol/typescript-sdk), [stdio guide](https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio.html), [Streamable HTTP requirements](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http). No remote authentication has been configured or tested.

## Verification and fixtures

`npm run check` runs type checking, unit/adapter/MCP tests and compilation. Tests cover IST boundaries, session VWAP model, exact-slot median relative volume, missing/invalid/stale data, no look-ahead, final signal, stop/target ambiguity and forced exit. MCP tests exercise all four tools in memory and a real stdio subprocess with the official client SDK. `docs/dhan-data.openapi.json` is a narrow local vendor contract, not a vendor-provided full schema. JSON/CSV fixtures and `src/mock.ts` contain synthetic data only.

A local Postman simulation exercises the actual adapter over HTTP with fixed loopback URL mapping in a developer-only probe. It is not reachable through the MCP server and does not relax the production URL allowlist:

```sh
postman simulation run postman/simulations/dhan-data.sim.yaml --port 4900 --no-history --output ndjson
# In another terminal, then stop the simulation with Ctrl-C:
npm run test:http
```

The HTTP probe accepts only hard-coded synthetic credentials. Postman's verbose simulation log may include those fixture headers; never use that developer-only probe or logging mode with real credentials. The fixture mock was generated from the cited local contract and extended for the public CSV; unmodeled paths return 501. No owner workspace was searched because this task excludes use of existing credentials; no Postman login, push, deployment or history configuration was requested. No live Dhan success is inferred from passing fixture tests. See `docs/VALIDATION.md` for recorded results and remaining limitations.

## Automatic paper operation

See [paper configuration, backfill, restart/export and review steps](docs/paper-trading.md) and [implementation status](docs/PAPER_IMPLEMENTATION_STATUS.md). One shared collector manages persisted completed bars, bounded prior-20 history and risk for existing simulated positions. New-entry gates never imply an exact trade; missing closing data retains unknown outcomes. No Notion publisher or broker order routes exist.
