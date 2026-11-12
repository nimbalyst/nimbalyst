#!/bin/bash
# Build the on-device dictation helper (macOS only) as a universal binary.
#
# Output: resources/dictation-helper-bin/nimbalyst-dictation
# Packaged by electron-builder (mac.extraResources) to
# Contents/Resources/dictation-helper/nimbalyst-dictation and signed with the app.
#
# Usage:
#   ./build-dictation-helper.sh          # universal (arm64 + x86_64)
#   ./build-dictation-helper.sh --host   # current arch only (faster for dev)
#
# On non-macOS hosts this is a no-op so cross-platform build scripts can call it.

set -e

if [ "$(uname -s)" != "Darwin" ]; then
    echo "Skipping dictation helper build (not macOS)."
    exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ELECTRON_DIR="$SCRIPT_DIR/.."
SRC_DIR="$ELECTRON_DIR/native/dictation-helper"
OUTPUT_DIR="$ELECTRON_DIR/resources/dictation-helper-bin"
OUTPUT="$OUTPUT_DIR/nimbalyst-dictation"
MIN_MACOS="13.0"

mkdir -p "$OUTPUT_DIR"

build_arch() {
    local arch=$1
    local outfile=$2
    echo "Building dictation helper for $arch..."
    xcrun swiftc \
        -O \
        -swift-version 5 \
        -target "$arch-apple-macos$MIN_MACOS" \
        -sdk "$(xcrun --sdk macosx --show-sdk-path)" \
        -framework Speech -framework AVFoundation \
        -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$SRC_DIR/Info.plist" \
        "$SRC_DIR/main.swift" \
        -o "$outfile"
}

if [ "$1" = "--host" ]; then
    build_arch "$(uname -m)" "$OUTPUT"
else
    build_arch arm64 "$OUTPUT-arm64"
    build_arch x86_64 "$OUTPUT-x86_64"
    lipo -create "$OUTPUT-arm64" "$OUTPUT-x86_64" -output "$OUTPUT"
    rm "$OUTPUT-arm64" "$OUTPUT-x86_64"
fi

chmod +x "$OUTPUT"
# Ad-hoc sign so the binary runs in dev; electron-builder re-signs it with the
# Developer ID and hardened runtime when packaging.
codesign --force --sign - "$OUTPUT"

file "$OUTPUT"
"$OUTPUT" --probe || echo "Warning: dictation helper probe failed"
