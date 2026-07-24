#!/bin/bash
# Build the Claude CLI helper binary using Bun
# This creates a standalone binary that can be used instead of the Electron binary
# On macOS, this prevents the dock icon from appearing
#
# Usage:
#   ./build-claude-helper.sh                  # Build for current platform
#   ./build-claude-helper.sh --mac            # Build universal macOS binary (arm64 + x64)
#   ./build-claude-helper.sh --windows        # Build Windows binary (x64)
#   ./build-claude-helper.sh --windows-arm64  # Build Windows binary (arm64)
#   ./build-claude-helper.sh --linux          # Build Linux binary (x64)
#   ./build-claude-helper.sh --all            # Build for all platforms

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ELECTRON_DIR="$SCRIPT_DIR/.."
PROJECT_ROOT="$ELECTRON_DIR/../.."
# Resolve SDK location - may be hoisted to root or in packages/electron/node_modules
if [ -d "$ELECTRON_DIR/node_modules/@anthropic-ai/claude-agent-sdk" ]; then
    SDK_DIR="$ELECTRON_DIR/node_modules/@anthropic-ai/claude-agent-sdk"
else
    SDK_DIR="$PROJECT_ROOT/node_modules/@anthropic-ai/claude-agent-sdk"
fi
OUTPUT_DIR="$ELECTRON_DIR/resources/claude-helper-bin"

# Check for bun
if ! command -v bun &> /dev/null; then
    echo "Error: bun is required but not installed."
    echo "Install it with: curl -fsSL https://bun.sh/install | bash"
    exit 1
fi

echo "Building Claude helper binary..."
echo "  SDK: $SDK_DIR"
echo "  Output: $OUTPUT_DIR"

# Create output directory
mkdir -p "$OUTPUT_DIR"

# The CLI entry point
CLI_ENTRY="$SDK_DIR/cli.js"

if [ ! -f "$CLI_ENTRY" ]; then
    echo "Error: CLI entry point not found at $CLI_ENTRY"
    exit 1
fi

cd "$SDK_DIR"

build_for_target() {
    local target=$1
    local outfile=$2

    echo ""
    echo "Building for $target..."
    bun build "$CLI_ENTRY" \
        --compile \
        --outfile "$outfile" \
        --target="$target"

    chmod +x "$outfile" 2>/dev/null || true
    echo "Built: $outfile ($(ls -lh "$outfile" | awk '{print $5}'))"
}

strip_bun_signature() {
    local binary=$1
    echo "Stripping Bun adhoc signature from $binary..."

    # Bun binaries include an adhoc signature that causes codesign issues.
    # We must remove it BEFORE creating the universal binary with lipo,
    # otherwise the combined signature structure can become corrupted.
    if codesign --remove-signature "$binary" 2>/dev/null; then
        echo "  Stripped signature using codesign"
    else
        # If codesign fails, the binary may not have a signature or it's corrupted
        echo "  No signature to strip or codesign failed (this is OK)"
    fi
}

build_mac_universal() {
    echo ""
    echo "=== Building macOS Universal Binary ==="

    build_for_target "bun-darwin-arm64" "$OUTPUT_DIR/claude-helper-arm64"
    build_for_target "bun-darwin-x64" "$OUTPUT_DIR/claude-helper-x64"

    # Strip Bun adhoc signatures BEFORE creating universal binary
    # This prevents signature corruption issues during lipo merge
    strip_bun_signature "$OUTPUT_DIR/claude-helper-arm64"
    strip_bun_signature "$OUTPUT_DIR/claude-helper-x64"

    # Create universal binary using lipo
    echo ""
    echo "Creating universal binary..."
    lipo -create \
        "$OUTPUT_DIR/claude-helper-arm64" \
        "$OUTPUT_DIR/claude-helper-x64" \
        -output "$OUTPUT_DIR/claude-helper"

    chmod +x "$OUTPUT_DIR/claude-helper"

    # Clean up architecture-specific binaries
    rm "$OUTPUT_DIR/claude-helper-arm64" "$OUTPUT_DIR/claude-helper-x64"

    echo "Created universal binary: $OUTPUT_DIR/claude-helper"
    file "$OUTPUT_DIR/claude-helper"
}

build_windows() {
    echo ""
    echo "=== Building Windows Binary (x64) ==="

    build_for_target "bun-windows-x64" "$OUTPUT_DIR/claude-helper.exe"

    echo "Created Windows binary: $OUTPUT_DIR/claude-helper.exe"
}

build_windows_arm64() {
    echo ""
    echo "=== Building Windows Binary (arm64) ==="

    # Bun does not yet publish a native Windows ARM64 target. The Windows ARM64
    # runner has Windows' built-in x64 emulation, so an x64 Bun binary will run;
    # however, bun's `bun-windows-arm64` target is preferred when available.
    # Fall back to x64 if the arm64 target is unsupported by the local bun.
    if bun build --help 2>/dev/null | grep -q "bun-windows-arm64"; then
        build_for_target "bun-windows-arm64" "$OUTPUT_DIR/claude-helper.exe"
    else
        echo "bun-windows-arm64 target not supported by this bun version; falling back to bun-windows-x64 (Windows 11 ARM runs x64 under emulation)."
        build_for_target "bun-windows-x64" "$OUTPUT_DIR/claude-helper.exe"
    fi

    echo "Created Windows binary: $OUTPUT_DIR/claude-helper.exe"
}

build_linux() {
    echo ""
    echo "=== Building Linux Binary ==="

    build_for_target "bun-linux-x64" "$OUTPUT_DIR/claude-helper-linux"

    # Rename to standard name
    mv "$OUTPUT_DIR/claude-helper-linux" "$OUTPUT_DIR/claude-helper"

    echo "Created Linux binary: $OUTPUT_DIR/claude-helper"
}

build_current_platform() {
    echo ""
    echo "=== Building for Current Platform ==="

    case "$(uname -s)" in
        Darwin)
            build_for_target "bun" "$OUTPUT_DIR/claude-helper"
            ;;
        Linux)
            build_for_target "bun" "$OUTPUT_DIR/claude-helper"
            ;;
        MINGW*|MSYS*|CYGWIN*)
            build_for_target "bun" "$OUTPUT_DIR/claude-helper.exe"
            ;;
        *)
            echo "Unknown platform: $(uname -s)"
            build_for_target "bun" "$OUTPUT_DIR/claude-helper"
            ;;
    esac
}

# Parse arguments
case "$1" in
    --mac)
        build_mac_universal
        ;;
    --windows)
        build_windows
        ;;
    --windows-arm64)
        build_windows_arm64
        ;;
    --linux)
        build_linux
        ;;
    --all)
        build_mac_universal
        build_windows
        build_linux
        ;;
    *)
        # Default: build for current platform only (faster for development)
        build_current_platform
        ;;
esac

echo ""
echo "=== Build Complete ==="
ls -lh "$OUTPUT_DIR/"

# Verify the binary runs (only for current platform)
if [ "$1" = "" ] || [ "$1" = "--mac" -a "$(uname -s)" = "Darwin" ]; then
    echo ""
    echo "Verifying binary..."
    "$OUTPUT_DIR/claude-helper" --version 2>/dev/null || echo "Warning: Version check failed (may need API key)"
fi
