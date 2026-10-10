#!/bin/bash
# Post-create script for Nimbalyst dev container
# This runs after the container is created

set -e

echo "=== Nimbalyst Dev Container Setup ==="

# CRITICAL: Isolate ALL node_modules from the host bind mount BEFORE pnpm install.
# Without this, pnpm install puts linux-arm64 native binaries (esbuild, electron,
# node-pty, etc.) directly into the macOS host's node_modules, breaking the host.
#
# Two layers of defense:
# 1. create-container.sh passes anonymous Docker volumes for each node_modules (belt)
# 2. This script tmpfs-mounts any that were missed (suspenders, needs SYS_ADMIN)
# If neither works, we ABORT rather than corrupt the host.
echo "Isolating node_modules from host bind mount..."
ISOLATED=0
FAILED=0
for pkg_json in $(find packages -name package.json -maxdepth 4 -not -path "*/node_modules/*"); do
  pkg_dir=$(dirname "$pkg_json")
  # Check if already isolated by a Docker anonymous volume
  if mount | grep -q "on $(pwd)/$pkg_dir/node_modules "; then
    ISOLATED=$((ISOLATED + 1))
    continue
  fi
  # Try tmpfs overlay (requires --cap-add=SYS_ADMIN)
  mkdir -p "$pkg_dir/node_modules"
  if mount -t tmpfs tmpfs "$pkg_dir/node_modules" 2>/dev/null; then
    ISOLATED=$((ISOLATED + 1))
  else
    FAILED=$((FAILED + 1))
    echo "  WARNING: Could not isolate $pkg_dir/node_modules"
  fi
done
# Also handle root node_modules
if mount | grep -q "on $(pwd)/node_modules "; then
  ISOLATED=$((ISOLATED + 1))
else
  mkdir -p node_modules
  if mount -t tmpfs tmpfs node_modules 2>/dev/null; then
    ISOLATED=$((ISOLATED + 1))
  else
    FAILED=$((FAILED + 1))
    echo "  WARNING: Could not isolate root node_modules"
  fi
fi
echo "  Isolated $ISOLATED node_modules directories"
if [ "$FAILED" -gt 0 ]; then
  echo ""
  echo "ERROR: $FAILED node_modules directories could not be isolated!"
  echo "pnpm install would corrupt the host's darwin-arm64 binaries."
  echo ""
  echo "Fix: use .devcontainer/create-container.sh to create the container"
  echo "(it passes --cap-add=SYS_ADMIN and anonymous volume mounts)."
  exit 1
fi

# pnpm comes from corepack (version pinned by packageManager in package.json).
# Keep its store out of the bind-mounted checkout: when the store sits on a
# different filesystem than the project, pnpm would fall back to <project>/.pnpm-store
# on the host.
corepack enable
export pnpm_config_store_dir="${pnpm_config_store_dir:-/root/.local/share/pnpm/store}"

# Install dependencies
echo "Installing dependencies..."
pnpm install --frozen-lockfile

# Build required packages for E2E tests
echo "Building extension-sdk..."
cd packages/extension-sdk && pnpm run build && cd ../..

echo "Building runtime package..."
cd packages/runtime && pnpm run build && cd ../..

echo "Building extensions..."
cd packages/extensions/datamodellm && pnpm run build && cd ../../..
cd packages/extensions/pdf-viewer && pnpm run build && cd ../../..
cd packages/extensions/csv-spreadsheet && pnpm run build && cd ../../..

# Build the Electron app (required for E2E tests)
echo "Building Electron app..."
cd packages/electron && pnpm run build && cd ../..

# Install Playwright browsers (for non-Electron tests if needed)
echo "Installing Playwright dependencies..."
pnpm exec playwright install --with-deps chromium

echo ""
echo "=== Setup Complete ==="
echo ""
echo "To run E2E tests:"
echo "  1. Start Xvfb: Xvfb :99 -screen 0 1920x1080x24 &"
echo "  2. Start dev server with --noSandbox:"
echo "     cd packages/electron && pnpm exec electron-vite dev --noSandbox"
echo "  3. In another terminal: pnpm exec playwright test"
echo ""
echo "Or run a single test:"
echo "  pnpm exec playwright test e2e/core/app-startup.spec.ts"
echo ""
echo "Note: The --noSandbox flag is required when running as root in containers."
echo ""
