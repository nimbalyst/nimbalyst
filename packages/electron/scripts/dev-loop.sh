#!/bin/bash
# Dev loop script that watches for restart requests and relaunches pnpm run dev
# Usage: ./scripts/dev-loop.sh
#
# This script runs pnpm run dev in a loop. When the app exits, it checks for
# a .restart-requested file. If present, it restarts pnpm run dev.
# If not present, it exits (user manually closed the app).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ELECTRON_DIR="$(dirname "$SCRIPT_DIR")"

# Use a unique restart signal file per instance to avoid cross-talk
if [ -n "$NIMBALYST_USER_DATA_DIR" ]; then
  INSTANCE_SUFFIX="-$(basename "$NIMBALYST_USER_DATA_DIR")"
else
  INSTANCE_SUFFIX=""
fi
RESTART_SIGNAL="$ELECTRON_DIR/.restart-requested${INSTANCE_SUFFIX}"

cd "$ELECTRON_DIR"

# Clean up any stale restart signal
rm -f "$RESTART_SIGNAL"

echo "Starting Nimbalyst dev loop..."
echo "Use /restart in the AI chat to restart the app."
echo ""

# The renderer dev server outlives each app run. `electron-vite dev` exits with
# Electron and takes the renderer's transform cache with it, so every restart
# recompiled ~2,600 modules (~30s) before a window could paint. With the server
# kept here, a restart only rebuilds main/preload and relaunches Electron.
RENDERER_PORT="${VITE_PORT:-5273}"
RENDERER_PID=""
RENDERER_READY=$(mktemp "${TMPDIR:-/tmp}/nimbalyst-renderer-ready.XXXXXX") || exit 1
cleanup_renderer() {
  if [ -n "$RENDERER_PID" ]; then
    kill "$RENDERER_PID" 2>/dev/null
    wait "$RENDERER_PID" 2>/dev/null
  fi
  rm -f "$RENDERER_READY"
}
trap cleanup_renderer EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

wait_for_renderer() {
  local deadline=$((SECONDS + 180))
  until [ -s "$RENDERER_READY" ]; do
    if ! kill -0 "$RENDERER_PID" 2>/dev/null || [ "$SECONDS" -ge "$deadline" ]; then
      echo "Renderer supervisor stopped or Vite did not become ready within 180 seconds"
      exit 1
    fi
    sleep 0.5
  done
}

# Supervision continues while dev.sh blocks on Electron, so crashes and hangs
# recover without an app restart. Only this supervisor owns the Vite child.
node ./scripts/renderer-supervisor.mjs "$RENDERER_READY" &
RENDERER_PID=$!
export NIMBALYST_EXTERNAL_RENDERER=1
export ELECTRON_RENDERER_URL="http://localhost:$RENDERER_PORT"

while true; do
  wait_for_renderer

  # Run the dev server (use dev.sh directly so env vars like NIMBALYST_USER_DATA_DIR propagate)
  ./scripts/dev.sh
  EXIT_CODE=$?

  # Check if restart was requested
  if [ -f "$RESTART_SIGNAL" ]; then
    echo ""
    echo "Restart requested, relaunching in 2 seconds..."
    rm -f "$RESTART_SIGNAL"
    sleep 2
    echo ""
  else
    # Normal exit (user closed the app or error)
    echo ""
    echo "Dev server exited with code $EXIT_CODE"
    exit $EXIT_CODE
  fi
done
