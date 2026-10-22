# Paper portfolio controls and mini commodities

All controls are internal simulations. No broker order endpoint, real position, funding or margin API is called. HTTPS Basic authentication remains mandatory for every route. Mutations additionally require the exact configured Origin, JSON content type and the per-process CSRF token from authenticated `GET /api/control-session`. No CORS access is granted. The public report container still has read-only recorder data and no broker/API secrets; it can write only the dedicated paper command queue.

## P&L definitions

Open P&L uses an eligible Dhan snapshot; if unavailable, the last stored completed cash candle is clearly labelled an old mark. Unpriced positions and unknown prior paths have no final P&L. Gross, estimated fees, assumed slippage and estimated net stay separate. Historical ledger gross/net fields are not rewritten to manufacture net returns. Returns are net estimate divided by entry notional, per trade or cumulative entry notional for the selected cohort. This denominator is neither account equity, peak invested capital, nor futures margin. Independent strategy cohorts are never added as one portfolio.

Cost assumptions: Dhan retail NSE intraday indicative fees, per-trade rounding rather than contract-note aggregation; commodity fees use an explicitly illustrative non-agricultural MCX schedule. Slippage is 1 bp per side, an assumption rather than measured impact. Expand each cost cell for components. Indicative source: https://dhan.co/pricing/. Model version `paper-costs-2026-10-22-v1`. No delivery, funding, clearing-member-specific or physical settlement charges are modeled.

## Commands

- `POST /api/paper/exit`: UUID requestId, current IST session, scope `position`, `cohort` or `all`; position/cohort scopes require an allowlisted cohort, individual scope requires positionId. The target set is frozen at request acceptance. Global exit covers all currently open/pending positions across experimental cohorts and manual commodities, not future signals; it is not a strategy pause switch.
- `POST /api/paper/entry`: UUID requestId, selected Gold Mini/Silver Mini contractId, integer lots 1–10, side long/short. Creates only a manual research paper position.
- `GET /api/paper/command?id=UUID`: durable status and per-position outcomes. A 202 is queued, not filled. Partial bulk completion stays visible; stale/unavailable-price targets expire after 90 seconds. Retries with the same ID cannot create another fill.

The separate console worker holds no Dhan/OpenAI credentials. It uses only persisted quotes. Quote observation must follow the click, be at most 15 seconds old, and carry a parseable same-day trade timestamp no older than 60 seconds. Dhan's DD/MM/YYYY timestamp is provisionally interpreted as IST, logged as a research assumption. Placeholder 1980, invalid, future or missing timestamps cannot authorize fills. Manual exits first reconcile already observed engine stop/target evidence, preserve unknown historical paths and record an audit event. SQLite write transactions serialize manual actions against the normal strategy worker. Replay/price timestamps are never used to backdate a manual fill.

Queue and manual positions persist at `/var/lib/nse-paper-controls/console.sqlite`. The report service reads current paper states without modifying the original dated reports. The existing strategy ledgers are updated only by the worker in response to an explicit valid paper command. A worker heartbeat gates new commands. No synthetic test positions are placed in production.

## MCX manual lab

Public Dhan detailed security master resolves unique active MCX_COMM/FUTCOM contracts daily. Gold Mini (`GOLDM`) is 100g per lot quoted per 10g: multiplier 10. Silver Mini (`SILVERM`) is 5kg per lot quoted per kg: multiplier 5. API LOT_SIZE=1 describes contract quantity and does not replace the physical P&L multiplier. API TICK_SIZE is in paise. Expiry/security ID/lot/tick information is frozen on every manual position; it never silently rolls. Select the nearest uniquely mapped expiry beyond seven calendar days. Opening a position within that expiry buffer is rejected. Expired positions are not assigned invented settlement prices.

Quotes and completed five-minute commodity candles persist independently. The conservative weekday observation window is 09:00–23:30 IST; holiday sessions and the later winter extension are not assumed verified. Fresh source timestamps gate actions even if the collector is running on a holiday. The NSE opening-range strategy remains exclusive to equities. MCX is quotes/charts plus manual paper only. Notional is shown; margin is explicitly unavailable.

References: https://www.mcxindia.com/products/bullion/gold-mini; https://www.mcxindia.com/products/bullion/silver-mini; https://dhanhq.co/docs/v2/annexure/; https://images.dhan.co/api-data/api-scrip-master-detailed.csv.

## Reviewer budget update

GPT-6 Luna / low, standard service tier, max 4096 output+reasoning tokens and 24KB request body. Official standard short-context input/output pricing is USD 0.10 / 0.50 per million tokens; the conservative input bound includes the 12h cache-write upper rate USD 0.25/million. Each request still reserves USD 0.025. The explicitly authorized app-side ceiling is USD 3 per actual IST day, with at most 120 requests/session in production; default remains 40 and default allowance remains USD1 for compatibility. Failures keep their reservations. No provider/account-wide billing limit is implied. Existing reservations and audit records are retained. Sources: https://developers.openai.com/api/docs/models/gpt-6-luna; https://developers.openai.com/api/docs/pricing.
