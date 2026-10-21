# Cloud paper engine foundation — incomplete integration

Review status: **partial implementation; not ready for deployment**.

Repository base and remote main were both a60274dd221f05e51516759332b675f29498379c when work started. New work is on `codex/automatic-paper-trading`. No AWS instance, credentials, recorder process, broker account or Notion page was accessed or changed.

## Preservation blocker

The inline source-only recorder overlay from the task has **not been materialized, SHA256-verified, or extracted** in this implementation. The expected archive checksum is `65e97008dfe35c21cf443eb9cc4449ed1d53e2551c109a82f8055c22541b7ab8`. This checkout therefore does not contain the inherited 25-file recorder/deployment snapshot, and its test count must not be confused with the snapshot's 42 tests.

To finish safely, provide the same `.tar.gz` as a downloadable cloud attachment. Before applying it: verify that checksum, inspect every member, reject absolute/traversing names and links, compare remote changes against the base, then reconcile the overlay and these additions. Do not recreate or replace the unpushed recorder files from their description. Do not fetch them from the laptop or running AWS recorder.

## Implemented in this partial branch

`src/paper.ts` is a new isolated Node 24 SQLite ledger and transition engine. It is not wired to a REST collector or unattended worker yet. Existing `analyze()` and its exact qualification gates remain unchanged.

- Default mode is `strict`, quantity is one simulated share, fees and slippage are unspecified. Strict mode always records the missing timestamp-aligned exact VWAP gate; no verification flags can enable exact fills in this implementation.
- `approximate-research` requires explicit acceptance of unverified start labels and a scheduled calendar when those inputs are not independently verified. Calendar coverage and 20 enumerated prior sessions remain required. These explicit research assumptions never mark fields verified.
- Opening range, same-slot prior-20 volume, inclusive 1.5 volume threshold, confirmation through the 11:00 close, next-bar hypothetical entry, OR-low stop and 2R target are modeled.
- Each symbol/session/strategy-version/mode has one deterministic identity. Configuration changes within an existing identity are rejected. SQLite `BEGIN IMMEDIATE` serializes competing state transitions; uniqueness protects observation/event retries.
- Source candles, source/observation times and source issues are retained. The first admitted version is immutable for decisions; later revisions remain in the observation ledger. Future/incomplete bars are not admitted. Invalid, missing and late input blocks or cancels entry. Open-path uncertainty is irreversible; later history cannot improve a fill.
- An entry uses the next candle open only after that bar completes: this is a hypothetical research price at an earlier source time, not a live executable fill. Entry and close events carry observation times. Ambiguous stop/target bars take stop first; adverse gaps take the open and favorable target gaps are capped at target.
- Forced exit requires the actual 15:15 start bar after completion. A missing or invalid exit path closes with unknown outcome once the exit observation deadline is reached. Unknown entry/exit prices and PnL remain null.
- Gross PnL is separate from modeled net. Net remains null unless both fixed per-side fees and slippage basis points are configured. Fees/slippage are estimates, not verified charges.
- `src/paper-export.ts` opens the paper database read-only and exports state, events and complete observation/revision provenance for assistant-led review. It has no network listener, publisher or credentials.

## Developer workflow

Use Node 24. No Dhan token is needed.

```sh
npm ci --ignore-scripts
npm run check
# Export a paper database produced through PaperLedger:
node dist/paper-export.js /absolute/path/to/paper.sqlite > paper-review.json
```

The fixture tests construct `PaperLedger` with a synthetic calendar and explicitly enabled research assumptions. They seed historical observations, admit completed current-session bars and call `tick` at synthetic host times. They are not live market replays. The engine does not automatically collect, backfill or run on a schedule in this partial branch.

## Required completion before deployment review

1. Verify and preserve the inherited recorder archive as a separate snapshot commit. Reconcile this engine against its SQLite schema, quality checks, calendar representation, reports, rate limits and market-session lifecycle.
2. Add a bounded prior-session REST backfill through the inherited collector, sharing its serialization/limiter. Do not create a second independent live collector. Verify calendar coverage for all 20 prior sessions; observed weekdays alone are not evidence.
3. Connect validated persisted candles to the unattended worker and expose paper state in the existing private report viewer. Add integration fixtures for recorder revisions, restarts, backfill and concurrent worker attempts.
4. Prepare Docker/systemd changes using the inherited host storage and same market hours, with explicit singleton execution. No deployment changes are supplied by this partial branch.
5. Update the inherited strategy guide and deployment runbook after integration, including opt-in research configuration, exports and restart commands. Do not change today's recorder.
6. Re-run the full merged check suite, required relevant validation and a synthetic end-to-end market-session replay. Create/update the review PR with a reproducible complete snapshot.
7. User reviews before any AWS access or deployment. Exact qualification remains blocked by exact timestamp-aligned VWAP, independently verified timestamp/calendar evidence and absent baseline. A later deployment of research mode must retain those disclosures. Live collection timing, restarts, incomplete closing bars and actual market behavior remain unverified until a live observation/replay is reviewed.

No live market calls, broker orders, Notion publisher, new credentials, public listener, AWS deployment or notification schedule were created.

## Validation actually completed for this partial branch

- `npm ci --ignore-scripts`: succeeded on Node v24.19.0.
- `npm run check`: strict typecheck, **55 tests passed**, production TypeScript build passed. This is the remote base's 35 tests plus 20 new paper tests; it does not include overlay-only tests.
- Read-only compiled export CLI smoke test: passed using a temporary synthetic SQLite database, including blocked strict state and event output.
- `git diff --check`: passed. Existing `src/analysis.ts` and `src/dhan.ts` have no diff.
- A development run initially failed the new calendar-coverage fixture after constructor validation was tightened. The fixture was corrected to represent a valid but insufficient one-session calendar, then the full check passed.
- `npm run test:http` was not run: it requires the separate Postman loopback fixture service. No live-market or deployment validation was run.
