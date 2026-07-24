#!/bin/bash
# Upload built extensions, screenshots, and registry to R2
# Usage: ./scripts/publish-extensions.sh [--input-dir <dir>] [--env <staging|production>]
#
# Uploads:
#   - .nimext files to extensions/{id}/{version}.nimext
#   - Screenshots to screenshots/{id}/{filename}
#   - registry.json to registry.json

set -e

# Pin wrangler's config dir to the Nimbalyst OAuth profile so this script
# can't accidentally upload R2 objects into the wrong Cloudflare account.
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config/nimbalyst}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INPUT_DIR="$SCRIPT_DIR/../dist"
WRANGLER_ENV=""
BUCKET_NAME="nimbalyst-extensions"

# Parse optional args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --input-dir) INPUT_DIR="$2"; shift 2 ;;
    --env)
      WRANGLER_ENV="--env $2"
      if [ "$2" = "staging" ]; then
        BUCKET_NAME="nimbalyst-extensions-staging"
      fi
      shift 2
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

if [ ! -d "$INPUT_DIR" ]; then
  echo "Error: Input directory $INPUT_DIR does not exist"
  exit 1
fi

TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

echo "Publishing extensions to R2 ($BUCKET_NAME)..."
echo ""

# Upload each .nimext file
for NIMEXT in "$INPUT_DIR"/*.nimext; do
  [ -f "$NIMEXT" ] || continue

  # Extract manifest to get id and version
  unzip -o -q "$NIMEXT" manifest.json -d "$TEMP_DIR" 2>/dev/null
  EXT_ID=$(node -p "require('$TEMP_DIR/manifest.json').id")
  EXT_VERSION=$(node -p "require('$TEMP_DIR/manifest.json').version")

  R2_KEY="extensions/${EXT_ID}/${EXT_VERSION}.nimext"
  echo "  Uploading $EXT_ID v$EXT_VERSION -> $R2_KEY"
  npx wrangler r2 object put "$BUCKET_NAME/$R2_KEY" --file "$NIMEXT" --content-type "application/zip" --remote $WRANGLER_ENV

  # Upload screenshots if they exist in the .nimext
  SCREENSHOTS=$(unzip -l "$NIMEXT" 2>/dev/null | grep "screenshots/" | awk '{print $4}' | grep -v "/$" || true)
  if [ -n "$SCREENSHOTS" ]; then
    # Extract screenshots to temp dir
    unzip -o -q "$NIMEXT" "screenshots/*" -d "$TEMP_DIR" 2>/dev/null || true

    for SS in $SCREENSHOTS; do
      SS_FILENAME=$(echo "$SS" | sed 's|screenshots/||')
      R2_SS_KEY="screenshots/${EXT_ID}/${SS_FILENAME}"

      # Determine content type
      case "$SS_FILENAME" in
        *.png) CT="image/png" ;;
        *.jpg|*.jpeg) CT="image/jpeg" ;;
        *.webp) CT="image/webp" ;;
        *) CT="application/octet-stream" ;;
      esac

      echo "    Screenshot: $R2_SS_KEY"
      npx wrangler r2 object put "$BUCKET_NAME/$R2_SS_KEY" --file "$TEMP_DIR/$SS" --content-type "$CT" --remote $WRANGLER_ENV
    done

    rm -rf "$TEMP_DIR/screenshots"
  fi

  rm -f "$TEMP_DIR/manifest.json"
done

# Upload registry.json
REGISTRY="$INPUT_DIR/registry.json"
if [ -f "$REGISTRY" ]; then
  echo ""
  echo "  Uploading registry.json"
  npx wrangler r2 object put "$BUCKET_NAME/registry.json" --file "$REGISTRY" --content-type "application/json" --remote $WRANGLER_ENV
else
  echo ""
  echo "Warning: No registry.json found. Run generate-registry.sh first."
fi

echo ""
echo "Done."
