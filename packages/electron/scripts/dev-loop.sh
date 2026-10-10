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
trap 'kill $RENDERER_PID 2>/dev/null' EXIT

start_renderer() {
  node ./scripts/renderer-dev-server.mjs &
  RENDERER_PID=$!
  until curl -s -o /dev/null "http://localhost:$RENDERER_PORT/"; do
    if ! kill -0 $RENDERER_PID 2>/dev/null; then
      echo "Renderer dev server failed to start"
      exit 1
    fi
    sleep 0.5
  done
}

# A long-lived server can stop answering (it once wedged on a file-watcher
# listener leak after a few days). Relaunching Electron against it would leave
# every window blank, so replace it first.
ensure_renderer_responsive() {
  if curl -s -m 10 -o /dev/null "http://localhost:$RENDERER_PORT/"; then
    return
  fi
  echo "Renderer dev server is not responding; restarting it..."
  kill $RENDERER_PID 2>/dev/null
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 $RENDERER_PID 2>/dev/null || break
    sleep 0.5
  done
  kill -9 $RENDERER_PID 2>/dev/null
  start_renderer
}

start_renderer
export NIMBALYST_EXTERNAL_RENDERER=1
export ELECTRON_RENDERER_URL="http://localhost:$RENDERER_PORT"

while true; do
  ensure_renderer_responsive

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
