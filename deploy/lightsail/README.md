# Reviewed Docker/systemd deployment

This is a source runbook, not a record of production infrastructure or approval to deploy. The cloud implementation task did not access a production host, change credentials, enable services or submit broker orders. Keep concrete host/account/access/billing details in the operator's private records.

## One scheduled collector

The existing systemd timer starts `nse-recorder.service` at 09:05 IST on scheduled weekdays. The application additionally checks the bundled regular-session calendar; it skips holidays, dates outside coverage and launches outside 09:05–15:35. Special sessions are unsupported. Update the reviewed calendar after notices and before its coverage expires.

One container runs the recorder, bounded history backfill and simulated paper worker together. It shares one provider/rate limiter and a persistent data-directory singleton. There is no additional paper collector or timer. The host service retains an outer flock guard. Strict mode is default and records exact-data blocks; explicit research configuration never establishes exact strategy qualification. See [paper runbook](../../docs/paper-trading.md).

## Prepare after user review

```sh
npm ci --ignore-scripts
npm run check
npm run test:http:local
docker build -f deploy/lightsail/Dockerfile -t nse-recorder:local .
```

Review the service source, persistent storage mount, calendar evidence and configuration before deployment. Docker is unavailable in the cloud coding executor; build and launch the image on a Docker-capable review host. No successful image/systemd launch of this integration is claimed by the cloud tests.

The optional source package script uses an explicit allowlist excluding secrets, recorded data and Git history. The installer is intended for the operator-reviewed host checkout. It prepares Docker and unit files but does not enable timers. It preserves existing credential files and creates missing configuration templates.

```sh
# Only on the reviewed host after approval:
cd /opt/nse-assistant
sudo bash deploy/lightsail/install.sh
sudoedit /etc/nse-assistant/dhan.env
sudoedit /etc/nse-assistant/paper.env
```

Populate short-lived vendor credentials securely on the host; never commit or paste them into commands or chat. Do not enable timestamp verification merely to bypass a gate. Refresh credentials before expiry and restart the reviewed process as needed. No token-renewal service is included. Paper-enabled operation continues to record fetch errors and manage known/unknown position state through the collection window when authentication fails.

## Review service behavior

The recorder service mounts persistent host storage for `candles.sqlite`, `paper.sqlite` and dated report JSON. Container recreation retains it. The kernel-held `collector-lock.sqlite` lock releases automatically on crash; do not delete it while active. The old temporary lock-dir argument is compatibility-only. SQLite retains candle revisions, batch provenance, bounded backfill attempts and paper events.

After deployment review, the operator can inspect the service/timer definitions, start or restart the existing recorder service, and inspect its journal and reports. Restart within the collection window recovers durable state; starting outside the window records a skip. A skip does not verify vendor credentials or market completeness. Preserve a consistent backup and previous image before changes. Never copy an actively written SQLite main file alone; use a consistent backup or stop before copying.

## Private reports

The existing report container mounts data read-only, receives no vendor credentials and publishes only on host loopback. Keep it private; no public listener/authentication expansion is part of this implementation. Use the operator's existing private tunnel/access procedure. The viewer and `/api/latest` expose quality; `/api/paper` exposes simulated decisions, positions, assumptions, provenance, blocks and timestamps. An old report is not current health.

The [paper runbook](../../docs/paper-trading.md) describes strict/research opt-in, history bounds, legacy baseline upgrades, delivery grace, unknown forced exits, exports, restart and rollback. [Validation](../../docs/VALIDATION.md) distinguishes synthetic cloud checks from remaining live-session and deployment validation.
