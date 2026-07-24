#!/bin/bash
# Generate registry.json from built .nimext packages
# Usage: ./scripts/generate-registry.sh [--input-dir <dir>] [--output <file>] [--base-url <url>]
#
# Reads each .nimext, extracts manifest.json, and generates the registry with
# download URLs, screenshot URLs, and checksums.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INPUT_DIR="$SCRIPT_DIR/../dist"
OUTPUT_FILE="$SCRIPT_DIR/../dist/registry.json"
BASE_URL="https://extensions.nimbalyst.com"

# Parse optional args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --input-dir) INPUT_DIR="$2"; shift 2 ;;
    --output) OUTPUT_FILE="$2"; shift 2 ;;
    --base-url) BASE_URL="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

if [ ! -d "$INPUT_DIR" ]; then
  echo "Error: Input directory $INPUT_DIR does not exist"
  exit 1
fi

TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

echo "Generating registry from packages in $INPUT_DIR..."

# Collect all extension metadata
EXTENSIONS_JSON="[]"

for NIMEXT in "$INPUT_DIR"/*.nimext; do
  [ -f "$NIMEXT" ] || continue

  FILENAME=$(basename "$NIMEXT")
  CHECKSUM_FILE="${NIMEXT}.sha256"

  # Extract manifest from .nimext
  unzip -o -q "$NIMEXT" manifest.json -d "$TEMP_DIR" 2>/dev/null

  if [ ! -f "$TEMP_DIR/manifest.json" ]; then
    echo "  Warning: No manifest.json in $FILENAME, skipping"
    continue
  fi

  # Read checksum
  CHECKSUM=""
  if [ -f "$CHECKSUM_FILE" ]; then
    CHECKSUM=$(cat "$CHECKSUM_FILE")
  fi

  # Extract screenshot list from the .nimext
  SCREENSHOTS=$(unzip -l "$NIMEXT" 2>/dev/null | grep "screenshots/" | awk '{print $4}' | grep -v "/$" || true)

  # Generate the extension entry using Node
  ENTRY=$(node -e "
    const manifest = require('$TEMP_DIR/manifest.json');
    const baseUrl = '$BASE_URL';
    const checksum = '$CHECKSUM';
    const screenshots = \`$SCREENSHOTS\`.split('\n').filter(Boolean);

    // Build screenshot entries: use manifest metadata when available,
    // fall back to files found in the package screenshots/ dir
    const manifestScreenshots = manifest.marketplace?.screenshots || [];
    const screenshotEntries = [];

    // First, include manifest-declared screenshots with their alt text and theme variants
    for (const ms of manifestScreenshots) {
      if (ms.src) {
        // Resolve src/srcLight paths to CDN URLs (paths are relative to extension root)
        const filename = ms.src.replace(/^screenshots\//, '');
        const entry = {
          src: baseUrl + '/screenshots/' + manifest.id + '/' + filename,
          alt: ms.alt || manifest.name + ' screenshot',
        };
        if (ms.srcLight) {
          const lightFilename = ms.srcLight.replace(/^screenshots\//, '');
          entry.srcLight = baseUrl + '/screenshots/' + manifest.id + '/' + lightFilename;
        }
        screenshotEntries.push(entry);
      }
    }

    // If no manifest src entries, fall back to package file listing
    // Group dark/light pairs by index (convention: {id}-{n}-dark.png / {id}-{n}-light.png)
    if (screenshotEntries.length === 0) {
      const darkFiles = screenshots.filter(s => s.includes('-dark.'));
      const lightFiles = screenshots.filter(s => s.includes('-light.'));
      if (darkFiles.length > 0) {
        for (const s of darkFiles) {
          const filename = s.replace('screenshots/', '');
          const lightFile = lightFiles.find(l => l.replace('-light.', '-dark.') === s);
          const entry = {
            src: baseUrl + '/screenshots/' + manifest.id + '/' + filename,
            alt: manifest.name + ' screenshot',
          };
          if (lightFile) {
            entry.srcLight = baseUrl + '/screenshots/' + manifest.id + '/' + lightFile.replace('screenshots/', '');
          }
          screenshotEntries.push(entry);
        }
      } else {
        // No dark/light convention -- include all files as-is
        for (const s of screenshots) {
          const filename = s.replace('screenshots/', '');
          screenshotEntries.push({
            src: baseUrl + '/screenshots/' + manifest.id + '/' + filename,
            alt: manifest.name + ' screenshot',
          });
        }
      }
    }

    const entry = {
      id: manifest.id,
      name: manifest.name,
      description: manifest.description || '',
      version: manifest.version,
      author: manifest.author || 'Unknown',
      categories: manifest.marketplace?.categories || ['other'],
      tags: manifest.marketplace?.tags || [],
      icon: manifest.marketplace?.icon || 'extension',
      screenshots: screenshotEntries,
      downloads: 0,
      featured: manifest.marketplace?.featured || false,
      permissions: Object.entries(manifest.permissions || {})
        .filter(([, v]) => v)
        .map(([k]) => k),
      minimumAppVersion: manifest.apiVersion || '1.0.0',
      downloadUrl: baseUrl + '/dl/' + manifest.id + '/' + manifest.version,
      checksum: checksum,
      repositoryUrl: manifest.marketplace?.repositoryUrl || '',
      changelog: manifest.marketplace?.changelog || '',
      tagline: manifest.marketplace?.tagline || '',
      longDescription: manifest.marketplace?.longDescription || '',
      highlights: manifest.marketplace?.highlights || [],
      fileTypes: manifest.marketplace?.fileTypes || [],
    };

    console.log(JSON.stringify(entry));
  ")

  # Add to extensions array
  EXTENSIONS_JSON=$(node -e "
    const arr = $EXTENSIONS_JSON;
    arr.push($ENTRY);
    console.log(JSON.stringify(arr));
  ")

  EXT_ID=$(node -p "($ENTRY).id")
  echo "  Added: $EXT_ID"

  # Clean up extracted manifest
  rm -f "$TEMP_DIR/manifest.json"
done

# Define categories
CATEGORIES='[
  {"id":"developer-tools","name":"Developer Tools","icon":"code"},
  {"id":"diagrams","name":"Diagrams","icon":"brush"},
  {"id":"data","name":"Data","icon":"table_chart"},
  {"id":"ai-tools","name":"AI Tools","icon":"auto_awesome"},
  {"id":"themes","name":"Themes","icon":"palette"},
  {"id":"writing","name":"Writing","icon":"edit_note"},
  {"id":"knowledge","name":"Knowledge","icon":"psychology"},
  {"id":"integrations","name":"Integrations","icon":"link"}
]'

# Generate final registry
node -e "
  const registry = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    extensions: $EXTENSIONS_JSON,
    categories: $CATEGORIES,
  };
  require('fs').writeFileSync('$OUTPUT_FILE', JSON.stringify(registry, null, 2));
"

EXT_COUNT=$(node -p "($EXTENSIONS_JSON).length")
echo ""
echo "Registry generated: $OUTPUT_FILE ($EXT_COUNT extensions)"
