#!/bin/bash
#
# Video Post-Processing
#
# Converts Playwright WebM recordings to MP4 and GIF for marketing use.
# Requires: ffmpeg, gifski (optional, for high-quality GIFs)
#
# Usage:
#   bash marketing/process-videos.sh                      # Process all videos
#   bash marketing/process-videos.sh --input=videos/dark   # Process specific directory
#   bash marketing/process-videos.sh --gif                 # Also generate GIFs
#

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VIDEO_DIR="$SCRIPT_DIR/videos"
OUTPUT_DIR="$SCRIPT_DIR/videos/processed"
GENERATE_GIF=false
INPUT_DIR=""

for arg in "$@"; do
  case "$arg" in
    --gif)
      GENERATE_GIF=true
      ;;
    --input=*)
      INPUT_DIR="${arg#--input=}"
      ;;
    --help)
      echo "Usage: $0 [--gif] [--input=DIR] [--help]"
      echo ""
      echo "Options:"
      echo "  --gif          Also generate GIF versions (requires gifski or ffmpeg)"
      echo "  --input=DIR    Process only videos in DIR (default: all in videos/)"
      echo "  --help         Show this help"
      exit 0
      ;;
  esac
done

# Check ffmpeg
if ! command -v ffmpeg &> /dev/null; then
  echo "ffmpeg is required. Install with: brew install ffmpeg"
  exit 1
fi

mkdir -p "$OUTPUT_DIR"

# Find all WebM files
if [ -n "$INPUT_DIR" ]; then
  SEARCH_DIR="$INPUT_DIR"
else
  SEARCH_DIR="$VIDEO_DIR"
fi

WEBM_FILES=$(find "$SEARCH_DIR" -name "*.webm" -not -path "*/processed/*" 2>/dev/null)

if [ -z "$WEBM_FILES" ]; then
  echo "No WebM files found in $SEARCH_DIR"
  exit 0
fi

echo "Processing videos..."
echo ""

while IFS= read -r webm_file; do
  basename=$(basename "$webm_file" .webm)
  parent_dir=$(basename "$(dirname "$webm_file")")

  echo "  Processing: $parent_dir/$basename.webm"

  # Convert to MP4 (H.264, web-compatible)
  mp4_output="$OUTPUT_DIR/${parent_dir}-${basename}.mp4"
  ffmpeg -y -i "$webm_file" \
    -c:v libx264 \
    -crf 20 \
    -preset slow \
    -pix_fmt yuv420p \
    -movflags +faststart \
    "$mp4_output" 2>/dev/null

  echo "    -> $mp4_output"

  # Trim first 0.5s and last 0.5s (dead frames from startup/shutdown)
  duration=$(ffprobe -v quiet -show_entries format=duration -of csv=p=0 "$mp4_output" 2>/dev/null)
  if [ -n "$duration" ]; then
    trimmed_end=$(echo "$duration - 0.5" | bc 2>/dev/null || echo "$duration")
    trimmed_output="$OUTPUT_DIR/${parent_dir}-${basename}-trimmed.mp4"
    ffmpeg -y -i "$mp4_output" \
      -ss 0.5 \
      -to "$trimmed_end" \
      -c copy \
      "$trimmed_output" 2>/dev/null
    echo "    -> $trimmed_output (trimmed)"
  fi

  # Generate GIF if requested
  if [ "$GENERATE_GIF" = true ]; then
    gif_output="$OUTPUT_DIR/${parent_dir}-${basename}.gif"

    if command -v gifski &> /dev/null; then
      # Use gifski for higher quality
      temp_frames="$OUTPUT_DIR/.frames_$$"
      mkdir -p "$temp_frames"
      ffmpeg -y -i "$mp4_output" \
        -vf "fps=15,scale=720:-1" \
        "$temp_frames/%04d.png" 2>/dev/null
      gifski --fps 15 --quality 90 -o "$gif_output" "$temp_frames"/*.png 2>/dev/null
      rm -rf "$temp_frames"
    else
      # Fallback to ffmpeg GIF (lower quality)
      ffmpeg -y -i "$mp4_output" \
        -vf "fps=15,scale=720:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" \
        "$gif_output" 2>/dev/null
    fi

    echo "    -> $gif_output"
  fi

  echo ""
done <<< "$WEBM_FILES"

echo "Done! Processed videos saved to: $OUTPUT_DIR"

# Count outputs
MP4_COUNT=$(ls -1 "$OUTPUT_DIR"/*.mp4 2>/dev/null | wc -l | tr -d ' ')
GIF_COUNT=$(ls -1 "$OUTPUT_DIR"/*.gif 2>/dev/null | wc -l | tr -d ' ')
echo "  MP4: $MP4_COUNT files"
if [ "$GIF_COUNT" -gt 0 ]; then
  echo "  GIF: $GIF_COUNT files"
fi
