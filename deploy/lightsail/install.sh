#!/usr/bin/env bash
# Run on the reviewed Ubuntu Lightsail instance from /opt/nse-assistant.
set -euo pipefail
if [[ ${EUID} -ne 0 ]]; then echo 'Run this installer with sudo on the Lightsail host.' >&2; exit 1; fi
cd /opt/nse-assistant
apt-get update
apt-get install -y docker.io util-linux
systemctl enable --now docker
install -d -m 0700 -o 1000 -g 1000 /var/lib/nse-recorder
install -d -m 0700 /etc/nse-assistant
if [[ ! -e /etc/nse-assistant/dhan.env ]]; then
  install -m 0600 deploy/lightsail/dhan.env.example /etc/nse-assistant/dhan.env
fi
if [[ ! -e /etc/nse-assistant/paper.env ]]; then
  install -m 0600 deploy/lightsail/paper.env.example /etc/nse-assistant/paper.env
fi
if [[ ! -e /etc/nse-assistant/reviewer.env ]]; then
  install -m 0600 deploy/lightsail/reviewer.env.example /etc/nse-assistant/reviewer.env
fi
docker build -f deploy/lightsail/Dockerfile -t nse-recorder:local .
install -m 0644 deploy/lightsail/nse-recorder.service deploy/lightsail/nse-recorder.timer deploy/lightsail/nse-reports.service deploy/lightsail/nse-watchlists.service deploy/lightsail/nse-watchlists.timer /etc/systemd/system/
systemctl daemon-reload
printf '%s\n' 'Prepared. Populate /etc/nse-assistant/dhan.env securely, then enable the reviewed services. Nothing was scheduled by this installer.'
