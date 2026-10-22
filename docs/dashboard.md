# NSE Mission Control

Read-only dashboard on the existing Singapore AWS Lightsail host. No real-order API, credential editor, arbitrary MCP tool dispatcher or strategy-control endpoints are exposed.

## Contract

- `GET /` and `/dashboard.css`, `/report.js`: bundled UI, no third-party scripts/fonts/analytics.
- `GET /api/dashboard?session=YYYY-MM-DD`: available sessions, selected session, atomic combined quality/paper/research report and policy. Latest recorded session by default. 404 if absent; 400 for malformed session.
- `GET /api/candles?session=YYYY-MM-DD&symbol=TCS`: stored completed five-minute bars in the regular 09:15–15:30 IST window; parameter-bound SQL and read-only SQLite. No inferred gap bars. Latest recorded revisions are chart evidence; immutable execution observations drive paper decisions.
- `GET /api/quotes`: sanitized persisted Dhan full-quote snapshots. Observation time is distinct from the broker's unverified source trade timestamp. No source-freshness claim. No public upstream proxy.
- Existing `/api/latest` and `/api/paper` retained. All application routes reject methods other than GET.

The browser refreshes every 10 seconds. The separate `nse-quotes.service` batches up to 80 configured equities in one allowlisted Dhan REST full-quote request every five seconds (plus request time), only during 09:15–15:30 IST on the published regular-session calendar. It has only the protected Dhan environment and an eight-second timeout. On failures it writes an explicit error and empty quote rows; the browser falls back to clearly labelled stored bar closes. Browser count does not multiply broker calls. Out-of-hours snapshots are cleared. Five-minute bars continue through the unchanged recorder/paper worker. Existing MCP interfaces remain available for assistant-led read-only data checks; the website does not expose a general Dhan MCP trading surface.

## Access and deployment

Caddy terminates HTTPS at nse-assistant.pixeltrendanalytics.com and requires HTTP Basic sign-in for every path. Password is randomly generated, stored in the user's private local deployment file, and bcrypt-hashed in Caddy configuration. The backend remains on 127.0.0.1:8787; it receives no Dhan/OpenAI secrets. Internet firewall ports 80/443 serve redirect/TLS only. SSH stays IP restricted. Never publish port 8787.

Dashboard and quote image `nse-dashboard:local` is built separately; the recorder's deployed image, paper policy, persistent ledgers and budget guard stay intact. Rollback restores the prior report service and disables quotes/Caddy; preserve all databases and budget reservations. No new instance, load balancer or managed database required. AWS resource and data charges remain separate from the USD1/day LLM allowance.

Before the first scheduled paper run, old quality-only sessions may have no paper or agent outputs. Those remain explicitly absent. The first current-session report appears after 09:05 IST. Watchlist preparation is at 08:50 IST; the quote service starts fetching at 09:15 IST. Planned hypothetical exit is 15:10 candle open, admitted after completion at 15:15 plus latency; collection ends 15:35 IST.

P&L cards and CSV cover only the selected cohort. Known resolved gross subtotals, open positions and unknown outcomes are separate. Never sum strategy cohorts as one portfolio. Net P&L remains unknown when costs/slippage are unset. Chart shading identifies absent slots, not fabricated candle prices. Agent panels show concise recorded rationales and evidence IDs, not hidden reasoning. The daily budget meter shows reservations, not billed cost.

The deployment helper `deploy/lightsail/install-dashboard.py` runs as root on the existing host after building `nse-dashboard:local`. It accepts only the private login JSON through stdin; it hashes the supplied password without printing it. Keep that JSON out of Git and Notion. The helper backs up the prior report service, preserves the recorder image, writes only nonsecret deployment metadata, and enables Caddy plus quote collection. Hostinger A record `nse-assistant` points to the existing Lightsail IP. Verify public TLS, unauthenticated 401 for every API, authenticated dashboard/chart reads, method rejection and unchanged recorder timers after installation.
