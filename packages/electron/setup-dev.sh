#!/bin/bash

echo "Setting up electron for development..."

# Electron 42+ dropped the download from its own package postinstall, so this
# package's postinstall runs `install-electron` explicitly -- a normal
# `npm install` already leaves the binary in place. This script is the manual
# repair path for a tree installed with --ignore-scripts or an interrupted
# download; it's a fast no-op when the right version is already present.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"
npx --no-install install-electron

echo "Electron binary ready. You can now run:"
echo "  npm run dev  (from packages/electron directory)"
