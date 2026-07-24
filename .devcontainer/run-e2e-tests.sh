#!/bin/bash
# Helper script to run E2E tests in the dev container
# Usage: ./run-e2e-tests.sh [test-pattern]
# Example: ./run-e2e-tests.sh e2e/core/app-startup.spec.ts

set -e

# Ensure DISPLAY is set for Xvfb
export DISPLAY=:99

# Start Xvfb if not running
if ! pgrep -x Xvfb > /dev/null 2>&1; then
    echo "Starting Xvfb on display $DISPLAY..."
    Xvfb :99 -screen 0 1920x1080x24 &
    sleep 2
fi

# Clean up any zombie processes from previous runs
echo "Cleaning up zombie processes..."
pkill -9 -f "electron" 2>/dev/null || true
sleep 1

# Navigate to project root
cd "$(dirname "$0")/.."

# Build the worker before starting dev server (required for Electron to work)
echo "Building worker..."
cd packages/electron
npm run build:worker
cd ../..

# Start vite dev server for renderer only
# We use a minimal vite config instead of electron-vite because:
# 1. electron-vite always starts Electron which crashes or conflicts in containers
# 2. The main and preload are already built by post-create.sh
# Playwright launches Electron separately with --no-sandbox flag
echo "Starting Vite dev server for renderer..."
npx vite --config .devcontainer/e2e-vite.config.ts > /tmp/vite-e2e.log 2>&1 &
DEV_PID=$!

# Wait for dev server to be accessible (try both IPv4 and IPv6)
echo "Waiting for dev server on port 5273..."
for i in $(seq 1 60); do
    # Try IPv4 first, then IPv6
    if curl -s --max-time 2 http://127.0.0.1:5273 > /dev/null 2>&1; then
        echo "Dev server ready after ${i}s (IPv4)"
        break
    elif curl -s --max-time 2 "http://[::1]:5273" > /dev/null 2>&1; then
        echo "Dev server ready after ${i}s (IPv6)"
        break
    fi
    if [ $i -eq 60 ]; then
        echo "Dev server failed to start. Log:"
        cat /tmp/vite-e2e.log
        kill $DEV_PID 2>/dev/null || true
        exit 1
    fi
    sleep 1
done

# Run tests
echo ""
echo "Running E2E tests..."
if [ -n "$1" ]; then
    npx playwright test --workers=1 "$@"
else
    npx playwright test --workers=1
fi
TEST_EXIT=$?

# Cleanup
echo ""
echo "Cleaning up..."
kill $DEV_PID 2>/dev/null || true

exit $TEST_EXIT
