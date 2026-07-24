#!/bin/bash
# Build a single extension into a .nimext package
# Usage: ./scripts/build-extension.sh <extension-path> [--output-dir <dir>]
#
# Example:
#   ./scripts/build-extension.sh ../../extensions/excalidraw
#   ./scripts/build-extension.sh ../../extensions/csv-spreadsheet --output-dir ./dist
#
# The .nimext file is a zip containing:
#   manifest.json
#   dist/          (built extension bundle)
#   claude-plugin/ (if present, when manifest declares contributions.claudePlugin)
#   agent workflow assets (when manifest declares contributions.agentWorkflows.path)
#   screenshots/   (if present)
#   README.md      (if present)
#
# Set NIMBALYST_SKIP_BUILD=1 to package the existing dist/ output without
# running the extension's local build script.

set -e

EXTENSION_PATH="$1"
OUTPUT_DIR="./dist"

if [ -z "$EXTENSION_PATH" ]; then
  echo "Usage: $0 <extension-path> [--output-dir <dir>]"
  exit 1
fi

# Parse optional args
shift
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output-dir) OUTPUT_DIR="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# Resolve to absolute path
EXTENSION_PATH="$(cd "$EXTENSION_PATH" && pwd)"
MANIFEST="$EXTENSION_PATH/manifest.json"

if [ ! -f "$MANIFEST" ]; then
  echo "Error: No manifest.json found at $EXTENSION_PATH"
  exit 1
fi

# Read extension metadata from manifest
EXT_ID=$(node -p "require('$MANIFEST').id")
EXT_VERSION=$(node -p "require('$MANIFEST').version")
EXT_NAME=$(node -p "require('$MANIFEST').name")

echo "Building $EXT_NAME ($EXT_ID) v$EXT_VERSION..."

# Build the extension if it has a build script
if [ "${NIMBALYST_SKIP_BUILD:-0}" = "1" ]; then
  echo "  Skipping build and packaging existing dist/"
elif [ -f "$EXTENSION_PATH/package.json" ]; then
  HAS_BUILD=$(node -p "!!require('$EXTENSION_PATH/package.json').scripts?.build" 2>/dev/null || echo "false")
  if [ "$HAS_BUILD" = "true" ]; then
    echo "  Running build..."
    (cd "$EXTENSION_PATH" && npm run build)
  fi
fi

# Create temp directory for package assembly
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

# Copy manifest
cp "$MANIFEST" "$TEMP_DIR/manifest.json"

# Copy dist directory
if [ -d "$EXTENSION_PATH/dist" ]; then
  cp -r "$EXTENSION_PATH/dist" "$TEMP_DIR/dist"
else
  echo "Warning: No dist/ directory found. Extension may not have been built."
fi

# Copy claude-plugin if present. The manifest's contributions.claudePlugin.path
# is resolved relative to the installed extension root, so the SKILL.md and
# plugin.json files have to ship inside the .nimext or ExtensionHandlers logs
# "Claude plugin path not found" and the skill never reaches Claude Code.
if [ -d "$EXTENSION_PATH/claude-plugin" ]; then
  cp -r "$EXTENSION_PATH/claude-plugin" "$TEMP_DIR/claude-plugin"
fi

# Copy bundled agent workflows at the exact manifest-relative path. These files
# are loaded after installation, so omitting them produces an extension whose
# declared workflow contribution cannot activate. Reject unsafe or missing
# declared paths instead of silently packaging a broken contribution.
AGENT_WORKFLOWS_PATH=$(node -e "
  const path = require('path');
  const manifest = require('$MANIFEST');
  const configured = manifest.contributions?.agentWorkflows?.path;
  if (configured === undefined) process.exit(0);
  if (typeof configured !== 'string' || configured.trim() === '') {
    console.error('Error: contributions.agentWorkflows.path must be a non-empty relative path');
    process.exit(1);
  }
  const normalized = path.normalize(configured);
  if (path.isAbsolute(configured) || normalized === '..' || normalized.startsWith('../')) {
    console.error('Error: contributions.agentWorkflows.path must stay inside the extension');
    process.exit(1);
  }
  process.stdout.write(normalized);
")

if [ -n "$AGENT_WORKFLOWS_PATH" ]; then
  AGENT_WORKFLOWS_SOURCE="$EXTENSION_PATH/$AGENT_WORKFLOWS_PATH"
  if [ ! -d "$AGENT_WORKFLOWS_SOURCE" ]; then
    echo "Error: Declared agent workflows directory not found: $AGENT_WORKFLOWS_SOURCE"
    exit 1
  fi
  mkdir -p "$(dirname "$TEMP_DIR/$AGENT_WORKFLOWS_PATH")"
  cp -r "$AGENT_WORKFLOWS_SOURCE" "$TEMP_DIR/$AGENT_WORKFLOWS_PATH"
fi

# Copy screenshots if present
if [ -d "$EXTENSION_PATH/screenshots" ]; then
  cp -r "$EXTENSION_PATH/screenshots" "$TEMP_DIR/screenshots"
fi

# Copy README if present
if [ -f "$EXTENSION_PATH/README.md" ]; then
  cp "$EXTENSION_PATH/README.md" "$TEMP_DIR/README.md"
fi

# Create output directory. Resolve to an absolute path BEFORE the `cd
# "$TEMP_DIR"` below, or a relative --output-dir (the default `./dist`) would
# be interpreted relative to the temp dir and the .nimext would be written into
# the soon-deleted temp tree instead of dist/.
mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd)"

# Create the .nimext zip
NIMEXT_FILE="$OUTPUT_DIR/${EXT_ID}-${EXT_VERSION}.nimext"
(cd "$TEMP_DIR" && zip -r -q "$NIMEXT_FILE" .)

# Compute SHA-256 checksum
CHECKSUM=$(shasum -a 256 "$NIMEXT_FILE" | awk '{print $1}')

echo "  Package: $NIMEXT_FILE"
echo "  Checksum: $CHECKSUM"

# Write checksum file alongside the package
echo "$CHECKSUM" > "${NIMEXT_FILE}.sha256"

echo "  Done."
