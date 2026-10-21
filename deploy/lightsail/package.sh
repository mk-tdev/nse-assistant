#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
npm run check
mkdir -p .local/deploy
# Explicit allowlist: never archive .env*, .aws, .git, SQLite data or node_modules.
COPYFILE_DISABLE=1 tar -czf .local/deploy/nse-assistant-lightsail.tar.gz package.json package-lock.json tsconfig.json tsconfig.build.json src deploy/lightsail .dockerignore
printf '%s\n' 'Prepared .local/deploy/nse-assistant-lightsail.tar.gz (source only; no live credentials).'
