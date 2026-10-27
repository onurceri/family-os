#!/usr/bin/env bash
# Runs check.mjs in Chromium 106 (the Playwright 1.26 image). Needs Docker.
#   FAMOS_URL=http://host.docker.internal:3000 [FAMOS_EMAIL=... FAMOS_PASSWORD=...] scripts/old-browser/run.sh
# Screenshots land in scripts/old-browser/screenshots (not committed).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$here/screenshots"
exec docker run --rm \
  --add-host=host.docker.internal:host-gateway \
  -e FAMOS_URL -e FAMOS_EMAIL -e FAMOS_PASSWORD -e FAMOS_PAGES \
  -e FAMOS_OUT=/w/screenshots \
  -v "$here:/w" -w /w \
  mcr.microsoft.com/playwright:v1.26.0-focal \
  bash -c "npm i --silent --no-save --no-package-lock playwright@1.26.0 >/dev/null 2>&1; node check.mjs"
