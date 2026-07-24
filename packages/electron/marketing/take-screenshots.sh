#!/bin/bash
#
# Marketing Screenshot & Video Capture Runner
#
# Usage:
#   bash marketing/take-screenshots.sh                    # Run all screenshot specs
#   bash marketing/take-screenshots.sh --grep=hero        # Run only hero shots
#   bash marketing/take-screenshots.sh --grep=editor      # Run only editor type shots
#   bash marketing/take-screenshots.sh --grep=video       # Run only video specs
#   bash marketing/take-screenshots.sh --grep=loop        # Run only short loop videos
#   bash marketing/take-screenshots.sh --list             # List all specs without running
#

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ELECTRON_DIR="$(dirname "$SCRIPT_DIR")"
REPO_ROOT="$(dirname "$(dirname "$ELECTRON_DIR")")"

# Ensure output directories exist
mkdir -p "$SCRIPT_DIR/screenshots/dark"
mkdir -p "$SCRIPT_DIR/screenshots/light"
mkdir -p "$SCRIPT_DIR/videos/dark"
mkdir -p "$SCRIPT_DIR/videos/light"

# Parse arguments
GREP_PATTERN=""
LIST_ONLY=false

for arg in "$@"; do
  case "$arg" in
    --grep=*)
      GREP_PATTERN="${arg#--grep=}"
      ;;
    --list)
      LIST_ONLY=true
      ;;
    --help)
      echo "Usage: $0 [--grep=PATTERN] [--list] [--help]"
      echo ""
      echo "Options:"
      echo "  --grep=PATTERN  Only run specs matching PATTERN"
      echo "  --list          List all specs without running"
      echo "  --help          Show this help"
      echo ""
      echo "Patterns:"
      echo "  hero            Hero/overview screenshots"
      echo "  editor          Editor type screenshots"
      echo "  ai              AI feature screenshots"
      echo "  settings        Settings screenshots"
      echo "  feature         Special feature screenshots"
      echo "  video           All video specs"
      echo "  loop            Short loop videos"
      echo "  hero-ambient    Hero ambient video"
      exit 0
      ;;
  esac
done

if [ "$LIST_ONLY" = true ]; then
  echo "Available specs:"
  ls -1 "$SCRIPT_DIR/specs/"*.spec.ts 2>/dev/null | while read f; do
    echo "  $(basename "$f")"
  done
  exit 0
fi

# Check dev server
echo "Checking dev server..."
if ! curl -s http://127.0.0.1:5273 > /dev/null 2>&1; then
  if ! curl -s http://[::1]:5273 > /dev/null 2>&1; then
    echo ""
    echo "Dev server is not running on port 5273."
    echo "Start it with: cd packages/electron && npm run dev"
    echo ""
    exit 1
  fi
fi
echo "Dev server is running."

# Build the playwright command
CMD="npx playwright test --config=$SCRIPT_DIR/playwright.marketing.config.ts"

if [ -n "$GREP_PATTERN" ]; then
  CMD="$CMD --grep=\"$GREP_PATTERN\""
fi

echo ""
echo "Running marketing capture..."
echo "  Command: $CMD"
echo ""

# Run from the electron package directory
cd "$ELECTRON_DIR"
eval "$CMD"

echo ""
echo "Done! Screenshots saved to:"
echo "  $SCRIPT_DIR/screenshots/dark/"
echo "  $SCRIPT_DIR/screenshots/light/"

# Count output files
DARK_COUNT=$(ls -1 "$SCRIPT_DIR/screenshots/dark/"*.png 2>/dev/null | wc -l | tr -d ' ')
LIGHT_COUNT=$(ls -1 "$SCRIPT_DIR/screenshots/light/"*.png 2>/dev/null | wc -l | tr -d ' ')
echo ""
echo "  Dark theme: $DARK_COUNT screenshots"
echo "  Light theme: $LIGHT_COUNT screenshots"

# Check for videos
VIDEO_COUNT=$(find "$SCRIPT_DIR/videos" -name "*.webm" 2>/dev/null | wc -l | tr -d ' ')
if [ "$VIDEO_COUNT" -gt 0 ]; then
  echo "  Videos: $VIDEO_COUNT files"
  echo ""
  echo "Run process-videos.sh to convert videos to MP4/GIF."
fi
