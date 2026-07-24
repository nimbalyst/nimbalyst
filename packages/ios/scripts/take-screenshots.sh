#!/bin/bash
# App Store screenshot automation for Nimbalyst iOS
#
# Builds the app in screenshot mode, launches on multiple simulators,
# and captures screenshots of each screen.
#
# Usage:
#   bash packages/ios/scripts/take-screenshots.sh
#   bash packages/ios/scripts/take-screenshots.sh --screens=projects,sessions
#   bash packages/ios/scripts/take-screenshots.sh --simulators="iPhone 15 Pro Max"

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
IOS_DIR="$(dirname "$SCRIPT_DIR")"
APP_DIR="$IOS_DIR/NimbalystApp"
REPO_ROOT="$(dirname "$(dirname "$IOS_DIR")")"
OUTPUT_DIR="$IOS_DIR/screenshots"
SCHEME="NimbalystApp"
BUNDLE_ID="com.nimbalyst.app"

# Default screens to capture
ALL_SCREENS="projects sessions detail settings pairing"

# Default simulators
ALL_SIMULATORS=(
    "iPhone 15 Pro Max"
    "iPad Pro 13-inch (M4)"
)

# Parse arguments
SCREENS="$ALL_SCREENS"
CUSTOM_SIMS=()
for arg in "$@"; do
    case $arg in
        --screens=*)
            SCREENS="${arg#*=}"
            SCREENS="${SCREENS//,/ }"
            ;;
        --simulators=*)
            IFS=',' read -ra CUSTOM_SIMS <<< "${arg#*=}"
            ;;
    esac
done

if [ ${#CUSTOM_SIMS[@]} -gt 0 ]; then
    ALL_SIMULATORS=("${CUSTOM_SIMS[@]}")
fi

echo "=== Nimbalyst App Store Screenshots ==="
echo "Screens: $SCREENS"
echo "Simulators: ${ALL_SIMULATORS[*]}"
echo ""

mkdir -p "$OUTPUT_DIR"

# Step 1: Build transcript web bundle (needed for session detail screenshots)
echo "[1/4] Building transcript web bundle..."
cd "$IOS_DIR"
if [ -f "node_modules/.bin/vite" ] || [ -f "$REPO_ROOT/node_modules/.bin/vite" ]; then
    cd "$REPO_ROOT"
    npx vite build --config packages/ios/vite.config.transcript.ts 2>&1 | tail -3
    # Copy to Resources
    rm -rf "$APP_DIR/Resources/transcript-dist"
    mkdir -p "$APP_DIR/Resources/transcript-dist"
    if [ -d "packages/ios/dist-transcript" ]; then
        cp packages/ios/dist-transcript/transcript.html "$APP_DIR/Resources/transcript-dist/"
        cp -R packages/ios/dist-transcript/assets "$APP_DIR/Resources/transcript-dist/"
    fi
    echo "   Transcript bundle built."
else
    echo "   Vite not found, using existing transcript bundle."
fi

# Step 2: Generate Xcode project
echo "[2/4] Generating Xcode project..."
cd "$APP_DIR"
if command -v xcodegen &> /dev/null; then
    xcodegen generate 2>&1 | tail -1
else
    echo "   xcodegen not found, using existing project."
fi

# Step 3: Build for simulator
echo "[3/4] Building for simulator..."
DERIVED_DATA="$APP_DIR/build"
xcodebuild build \
    -project NimbalystApp.xcodeproj \
    -scheme "$SCHEME" \
    -destination "generic/platform=iOS Simulator" \
    -derivedDataPath "$DERIVED_DATA" \
    -quiet 2>&1 || {
    echo "Build failed. Check Xcode project configuration."
    exit 1
}
APP_PATH=$(find "$DERIVED_DATA" -name "NimbalystApp.app" -path "*/Debug-iphonesimulator/*" | head -1)
if [ -z "$APP_PATH" ]; then
    echo "Could not find built app. Build may have failed."
    exit 1
fi
echo "   Built: $APP_PATH"

# Step 4: Capture screenshots on each simulator
echo "[4/4] Capturing screenshots..."
echo ""

get_udid() {
    local sim_name="$1"
    xcrun simctl list devices available -j | \
        python3 -c "
import json, sys
data = json.load(sys.stdin)
for runtime, devices in data['devices'].items():
    for d in devices:
        if d['name'] == '$sim_name' and d['isAvailable']:
            print(d['udid'])
            sys.exit(0)
sys.exit(1)
" 2>/dev/null
}

for SIM_NAME in "${ALL_SIMULATORS[@]}"; do
    echo "--- $SIM_NAME ---"

    UDID=$(get_udid "$SIM_NAME") || {
        echo "   Simulator '$SIM_NAME' not found. Skipping."
        continue
    }

    # Derive a safe filename prefix from the simulator name
    SAFE_NAME=$(echo "$SIM_NAME" | tr ' ()' '_' | tr -d '"' | sed 's/__*/_/g' | sed 's/_$//')

    # Boot simulator
    echo "   Booting..."
    xcrun simctl boot "$UDID" 2>/dev/null || true

    # Wait for boot to complete
    sleep 5

    # Install the app
    echo "   Installing app..."
    xcrun simctl install "$UDID" "$APP_PATH"

    # Set dark appearance
    xcrun simctl ui "$UDID" appearance dark 2>/dev/null || true

    # Set status bar for clean screenshots (iOS 17+)
    xcrun simctl status_bar "$UDID" override \
        --time "9:41" \
        --batteryState charged \
        --batteryLevel 100 \
        --wifiBars 3 \
        --cellularBars 4 2>/dev/null || true

    for SCREEN in $SCREENS; do
        echo "   Capturing: $SCREEN"

        # Launch with screenshot mode and target screen
        xcrun simctl launch "$UDID" "$BUNDLE_ID" \
            --screenshot-mode \
            "--screenshot-screen=$SCREEN" 2>/dev/null

        # Wait for rendering (longer for detail screen with WKWebView)
        if [ "$SCREEN" = "detail" ]; then
            sleep 12
        else
            sleep 5
        fi

        # Capture screenshot
        OUTPUT_FILE="$OUTPUT_DIR/${SAFE_NAME}_${SCREEN}.png"
        xcrun simctl io "$UDID" screenshot "$OUTPUT_FILE" 2>/dev/null
        echo "   -> $OUTPUT_FILE"

        # Terminate app
        xcrun simctl terminate "$UDID" "$BUNDLE_ID" 2>/dev/null || true
        sleep 1
    done

    # Clear status bar override
    xcrun simctl status_bar "$UDID" clear 2>/dev/null || true

    # Shutdown simulator
    echo "   Shutting down..."
    xcrun simctl shutdown "$UDID" 2>/dev/null || true
    echo ""
done

echo "=== Done ==="
echo "Screenshots saved to: $OUTPUT_DIR"
echo ""
ls -la "$OUTPUT_DIR"/*.png 2>/dev/null || echo "No screenshots were captured."
