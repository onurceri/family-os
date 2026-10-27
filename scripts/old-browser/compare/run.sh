#!/usr/bin/env bash
# Compares FamilyOS page by page in the repo's Chromium and in Chromium 106 (Docker). Needs a
# build (`pnpm build`), Docker, and Chromium for Playwright (`pnpm --filter @famos/e2e exec
# playwright install --only-shell chromium`). It starts the sample family, takes the pictures in
# both browsers, and writes the report; see docs/releasing.md.
#
#   scripts/old-browser/compare/run.sh
#   FAMOS_STYLES=wall FAMOS_ONLY=today,display FAMOS_WIDTHS=1024 scripts/old-browser/compare/run.sh
#
# FAMOS_COMPARE_OUT sets where everything goes (default test-results/old-browser).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
out="${FAMOS_COMPARE_OUT:-$root/test-results/old-browser}"
mkdir -p "$out"
out="$(cd "$out" && pwd)"
rm -rf "$out/serve" "$out/modern" "$out/old" "$out/report"
mkdir -p "$out/serve"

for built in apps/server/dist/famos.mjs apps/web/build/index.html; do
  [ -e "$root/$built" ] || { echo "Build first: pnpm build ($built is missing)" >&2; exit 1; }
done

started=$(date +%s)
server_pid=""
stop_server() {
  touch "$out/serve/done"
  if [ -n "$server_pid" ]; then
    for _ in $(seq 1 30); do kill -0 "$server_pid" 2>/dev/null || return 0; sleep 1; done
    kill "$server_pid" 2>/dev/null || true
  fi
}
trap stop_server EXIT

# The family: prepared and kept running by a Playwright spec (apps/e2e/old-browser/serve.spec.ts).
(cd "$root/apps/e2e" && FAMOS_COMPARE_DIR="$out/serve" ./node_modules/.bin/playwright test \
  -c old-browser.config.ts >"$out/serve.log" 2>&1) &
server_pid=$!
for _ in $(seq 1 300); do
  [ -e "$out/serve/serve.json" ] && break
  kill -0 "$server_pid" 2>/dev/null || { cat "$out/serve.log" >&2; exit 1; }
  sleep 1
done
[ -e "$out/serve/serve.json" ] || { echo "The sample family did not start (see $out/serve.log)" >&2; exit 1; }
port="$(node -p "require('$out/serve/serve.json').port")"
url="http://host.docker.internal:$port"
echo "Sample family on $url"

echo "Taking pictures in the repo's Chromium..."
FAMOS_URL="$url" FAMOS_SERVE="$out/serve/serve.json" FAMOS_OUT="$out/modern" FAMOS_RESOLVE=1 \
  node "$here/capture.mjs"

echo "Taking pictures in Chromium 106..."
docker run --rm --shm-size=1gb \
  --add-host=host.docker.internal:host-gateway \
  -e FAMOS_STYLES -e FAMOS_ONLY -e FAMOS_WIDTHS \
  -e FAMOS_URL="$url" -e FAMOS_SERVE=/serve/serve.json -e FAMOS_OUT=/out \
  -v "$here:/src:ro" -v "$out/serve:/serve:ro" -v "$out/old:/out" \
  mcr.microsoft.com/playwright:v1.26.0-focal \
  bash -c "mkdir -p /w && cp /src/capture.mjs /w/ && cd /w && npm i --silent --no-save --no-package-lock playwright-core@1.26.0 >/dev/null 2>&1; node capture.mjs"

stop_server
trap - EXIT
node "$here/diff.mjs" "$out/modern" "$out/old" "$out/report"
echo "Took $(( $(date +%s) - started )) s."
