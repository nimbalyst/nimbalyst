#!/bin/bash
# Run Playwright E2E specs without the developer's dev server.
#
# Usage (from packages/electron):
#   ./scripts/e2e-host.sh [--skip-build] <playwright args...>
#   ./scripts/e2e-host.sh e2e/worktree/worktree.spec.ts
#
# Builds what the specs launch (workspace packages, extensions, worker, main and
# preload), serves the renderer from the real electron.vite.config.ts on its own
# port (NIMBALYST_E2E_RENDERER_PORT, default 5373) so a running `pnpm run dev`
# on 5273 is never touched, and runs Playwright under xvfb-run when available so
# no windows appear on the desktop. Temp workspaces and userData go under
# e2e_test_output/tmp. Set NIMBALYST_E2E_HEADED=1 to watch the windows.
#
# The per-test budget defaults to 60s (NIMBALYST_E2E_TIMEOUT): a first launch
# under xvfb's software rendering can take longer than the config's 15s before
# the sidebar appears. A --timeout passed on the command line still wins.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ELECTRON_DIR="$(dirname "$SCRIPT_DIR")"
REPO_ROOT="$(cd "$ELECTRON_DIR/../.." && pwd)"
PORT="${NIMBALYST_E2E_RENDERER_PORT:-5373}"
RENDERER_URL="http://127.0.0.1:$PORT"
OUTPUT_DIR="$REPO_ROOT/e2e_test_output"

SKIP_BUILD=0
if [ "${1:-}" = "--skip-build" ]; then
  SKIP_BUILD=1
  shift
fi

if [ "$PORT" = "5273" ]; then
  echo "[e2e-host] Port 5273 belongs to the developer's dev server; pick another NIMBALYST_E2E_RENDERER_PORT." >&2
  exit 1
fi
if curl -s -m 2 -o /dev/null "$RENDERER_URL/"; then
  echo "[e2e-host] Something is already serving $RENDERER_URL; stop it or set NIMBALYST_E2E_RENDERER_PORT." >&2
  exit 1
fi

cd "$ELECTRON_DIR"

if [ "$SKIP_BUILD" = "0" ]; then
  echo "[e2e-host] Building workspace packages, runtime and extensions..."
  (cd "$REPO_ROOT" && pnpm run build:workspace-deps && pnpm --filter @nimbalyst/runtime run build)
  pnpm run build:extensions
  echo "[e2e-host] Building worker, main and preload..."
  pnpm run build:worker
  NIMBALYST_EXTERNAL_RENDERER=1 pnpm exec electron-vite build
fi

mkdir -p "$OUTPUT_DIR/tmp"
RENDERER_LOG="$OUTPUT_DIR/e2e-host-renderer.log"
echo "[e2e-host] Starting the renderer server on $RENDERER_URL (log: $RENDERER_LOG)..."
NIMBALYST_RENDERER_HOST=127.0.0.1 VITE_PORT="$PORT" node ./scripts/renderer-dev-server.mjs > "$RENDERER_LOG" 2>&1 &
RENDERER_PID=$!
trap 'kill $RENDERER_PID 2>/dev/null || true' EXIT

for _ in $(seq 1 240); do
  if curl -s -m 2 -o /dev/null "$RENDERER_URL/"; then
    break
  fi
  if ! kill -0 "$RENDERER_PID" 2>/dev/null; then
    echo "[e2e-host] The renderer server exited:" >&2
    cat "$RENDERER_LOG" >&2
    exit 1
  fi
  sleep 0.5
done
if ! curl -s -m 2 -o /dev/null "$RENDERER_URL/"; then
  echo "[e2e-host] The renderer server did not answer within 120s." >&2
  exit 1
fi

echo "[e2e-host] Warming the renderer transform cache..."
node ./scripts/warm-renderer.mjs "$RENDERER_URL"

export NIMBALYST_E2E_DEV_SERVER_URL="$RENDERER_URL"
export TMPDIR="$OUTPUT_DIR/tmp"

TIMEOUT="${NIMBALYST_E2E_TIMEOUT:-60000}"
if [ -z "${NIMBALYST_E2E_HEADED:-}" ] && command -v xvfb-run >/dev/null 2>&1; then
  xvfb-run -a pnpm exec playwright test --workers=1 --timeout="$TIMEOUT" "$@"
else
  pnpm exec playwright test --workers=1 --timeout="$TIMEOUT" "$@"
fi
