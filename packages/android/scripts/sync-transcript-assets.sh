#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DIST_DIR="$ROOT_DIR/dist-transcript"
ASSET_DIR="$ROOT_DIR/app/build/generated/transcript-assets/transcript-dist"

if [ ! -f "$DIST_DIR/transcript.html" ]; then
  echo "Transcript bundle not found in $DIST_DIR"
  echo "Run: npm run build:transcript"
  exit 1
fi

rm -rf "$ASSET_DIR"
mkdir -p "$ASSET_DIR"
cp "$DIST_DIR/transcript.html" "$ASSET_DIR/"
cp -R "$DIST_DIR/assets" "$ASSET_DIR/"

echo "Synced transcript assets to $ASSET_DIR"
