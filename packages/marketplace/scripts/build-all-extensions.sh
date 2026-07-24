#!/bin/bash
# Build the curated release set of marketplace extensions into .nimext packages
# Usage: ./scripts/build-all-extensions.sh [--output-dir <dir>] [--manifest <file>]
#
# Reads a release manifest containing one extension path per line.
# Optional flags can be added after a pipe, for example:
#   ../extensions/csv-spreadsheet
#   ../../../nimbalyst-mindmap|skip-build
# Paths are resolved relative to the manifest file location.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUTPUT_DIR="$SCRIPT_DIR/../dist"
MANIFEST_FILE="$SCRIPT_DIR/../release-extensions.txt"

# Parse optional args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output-dir) OUTPUT_DIR="$2"; shift 2 ;;
    --manifest) MANIFEST_FILE="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

mkdir -p "$OUTPUT_DIR"

if [ ! -f "$MANIFEST_FILE" ]; then
  echo "Error: release manifest not found: $MANIFEST_FILE"
  exit 1
fi

MANIFEST_DIR="$(cd "$(dirname "$MANIFEST_FILE")" && pwd)"

echo "Building marketplace release set..."
echo "Output directory: $OUTPUT_DIR"
echo "Release manifest: $MANIFEST_FILE"
echo ""

BUILT=0
SKIPPED=0
MISSING=0

rm -f "$OUTPUT_DIR"/*.nimext "$OUTPUT_DIR"/*.nimext.sha256 "$OUTPUT_DIR"/registry.json

while IFS= read -r ENTRY || [ -n "$ENTRY" ]; do
  ENTRY="${ENTRY%%#*}"
  ENTRY="$(echo "$ENTRY" | xargs)"

  if [ -z "$ENTRY" ]; then
    continue
  fi

  EXT_SPEC="$ENTRY"
  EXT_FLAGS=""
  if [[ "$ENTRY" == *"|"* ]]; then
    EXT_SPEC="${ENTRY%%|*}"
    EXT_FLAGS="${ENTRY#*|}"
  fi

  if [[ "$EXT_SPEC" = /* ]]; then
    EXT_DIR="$EXT_SPEC"
  else
    EXT_DIR="$(cd "$MANIFEST_DIR" && cd "$EXT_SPEC" && pwd 2>/dev/null || true)"
  fi

  if [ -z "$EXT_DIR" ] || [ ! -d "$EXT_DIR" ]; then
    echo "Skipping $EXT_SPEC (path not found)"
    MISSING=$((MISSING + 1))
    continue
  fi

  EXT_NAME=$(basename "$EXT_DIR")

  if [ ! -f "$EXT_DIR/manifest.json" ]; then
    echo "Skipping $EXT_NAME (no manifest.json)"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  if echo "$EXT_FLAGS" | grep -qw "skip-build"; then
    NIMBALYST_SKIP_BUILD=1 "$SCRIPT_DIR/build-extension.sh" "$EXT_DIR" --output-dir "$OUTPUT_DIR"
  else
    "$SCRIPT_DIR/build-extension.sh" "$EXT_DIR" --output-dir "$OUTPUT_DIR"
  fi
  BUILT=$((BUILT + 1))
  echo ""
done < "$MANIFEST_FILE"

echo "Built $BUILT extensions, skipped $SKIPPED, missing $MISSING"
echo "Packages in: $OUTPUT_DIR"
