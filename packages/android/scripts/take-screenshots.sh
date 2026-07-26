#!/bin/bash
# Play Store screenshot automation for Nimbalyst Android.
#
# Builds the debug APK, boots an emulator, and captures each listing screen via
# the debug-only screenshot mode (see app/src/debug/.../screenshots/).
#
# Usage:
#   bash packages/android/scripts/take-screenshots.sh
#   bash packages/android/scripts/take-screenshots.sh --screens=sessions,detail
#   bash packages/android/scripts/take-screenshots.sh --avd=Pixel_3a_API_34_extension_level_7_arm64-v8a
#   bash packages/android/scripts/take-screenshots.sh --device=emulator-5554   # skip boot, use a running device
#   bash packages/android/scripts/take-screenshots.sh --skip-build

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ANDROID_DIR="$(dirname "$SCRIPT_DIR")"
OUTPUT_DIR="$ANDROID_DIR/screenshots"
APK="$ANDROID_DIR/app/build/outputs/apk/debug/app-debug.apk"
APP_ID="com.nimbalyst.app"
ACTIVITY="$APP_ID/.MainActivity"

ALL_SCREENS="pairing projects sessions detail composer settings"
SCREENS="$ALL_SCREENS"
AVD=""
DEVICE=""
SKIP_BUILD=0

for arg in "$@"; do
    case $arg in
        --screens=*) SCREENS="${arg#*=}"; SCREENS="${SCREENS//,/ }" ;;
        --avd=*) AVD="${arg#*=}" ;;
        --device=*) DEVICE="${arg#*=}" ;;
        --skip-build) SKIP_BUILD=1 ;;
        *) echo "Unknown argument: $arg" >&2; exit 1 ;;
    esac
done

ANDROID_SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
ADB="$ANDROID_SDK/platform-tools/adb"
EMULATOR="$ANDROID_SDK/emulator/emulator"
[ -x "$ADB" ] || { echo "adb not found at $ADB. Set ANDROID_HOME." >&2; exit 1; }

# JDK 17+ for AGP. Android Studio's bundled JBR is the safe default on macOS.
if [ -z "${JAVA_HOME:-}" ] && [ -d "/Applications/Android Studio.app/Contents/jbr/Contents/Home" ]; then
    export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
fi

echo "=== Nimbalyst Play Store screenshots ==="
echo "Screens: $SCREENS"
mkdir -p "$OUTPUT_DIR"

# --- Build -------------------------------------------------------------------
if [ "$SKIP_BUILD" -eq 0 ]; then
    echo "[1/4] Building transcript bundle..."
    (cd "$ANDROID_DIR" && npm run build:transcript >/dev/null)

    echo "[2/4] Building debug APK..."
    (cd "$ANDROID_DIR" && ./gradlew :app:assembleDebug -q)
else
    echo "[1-2/4] Skipping build (--skip-build)."
fi
[ -f "$APK" ] || { echo "Debug APK not found at $APK" >&2; exit 1; }

# --- Device ------------------------------------------------------------------
EMULATOR_PID=""
cleanup() {
    if [ -n "$DEVICE" ]; then
        "$ADB" -s "$DEVICE" shell am broadcast -a com.android.systemui.demo -e command exit >/dev/null 2>&1 || true
    fi
    if [ -n "$EMULATOR_PID" ]; then
        echo "   Shutting down emulator..."
        "$ADB" -s "$DEVICE" emu kill >/dev/null 2>&1 || kill "$EMULATOR_PID" 2>/dev/null || true
    fi
}
trap cleanup EXIT

if [ -z "$DEVICE" ]; then
    echo "[3/4] Booting emulator..."
    if [ -z "$AVD" ]; then
        AVD="$("$EMULATOR" -list-avds | head -1)"
        [ -n "$AVD" ] || { echo "No AVD found. Create one in Android Studio." >&2; exit 1; }
    fi
    echo "   AVD: $AVD"
    "$EMULATOR" -avd "$AVD" -no-snapshot -no-boot-anim -no-audio >/dev/null 2>&1 &
    EMULATOR_PID=$!

    echo "   Waiting for device..."
    "$ADB" wait-for-device
    DEVICE="$("$ADB" devices | awk '/emulator/ {print $1; exit}')"
    until [ "$("$ADB" -s "$DEVICE" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do
        sleep 2
    done
    "$ADB" -s "$DEVICE" shell input keyevent 82 >/dev/null 2>&1 || true
    # boot_completed fires well before the system apps stop thrashing.
    echo "   Letting the system settle..."
    sleep 25
else
    echo "[3/4] Using device: $DEVICE"
fi

# Emulator hygiene: system apps (Digital Wellbeing in particular) like to throw
# an ANR dialog over the app on a freshly booted image, and animations make
# captures non-deterministic.
"$ADB" -s "$DEVICE" shell pm disable-user --user 0 com.google.android.apps.wellbeing >/dev/null 2>&1 || true
"$ADB" -s "$DEVICE" shell settings put global anr_show_background 0 >/dev/null 2>&1 || true
for scale in window_animation_scale transition_animation_scale animator_duration_scale; do
    "$ADB" -s "$DEVICE" shell settings put global "$scale" 0 >/dev/null 2>&1 || true
done

echo "   Installing $APK"
"$ADB" -s "$DEVICE" install -r -t "$APK" >/dev/null

# First cold start after an install is slow enough to capture the splash screen
# instead of the UI. Warm the process once before capturing anything.
echo "   Warming up..."
"$ADB" -s "$DEVICE" shell am start -n "$ACTIVITY" --ez screenshot_mode true >/dev/null
sleep 15
"$ADB" -s "$DEVICE" shell am force-stop "$APP_ID" >/dev/null

# Clean status bar: 9:41, full signal, full battery, no notification icons.
"$ADB" -s "$DEVICE" shell settings put global sysui_demo_allowed 1 >/dev/null
demo() { "$ADB" -s "$DEVICE" shell am broadcast -a com.android.systemui.demo "$@" >/dev/null; }
demo -e command enter
demo -e command clock -e hhmm 0941
demo -e command battery -e level 100 -e plugged false
demo -e command network -e wifi show -e level 4
demo -e command network -e mobile show -e datatype none -e level 4
demo -e command notifications -e visible false

# --- Capture -----------------------------------------------------------------
echo "[4/4] Capturing..."
SAFE_AVD="$(echo "${AVD:-$DEVICE}" | tr ' .' '_' | tr -cd '[:alnum:]_-')"

for SCREEN in $SCREENS; do
    echo "   $SCREEN"
    "$ADB" -s "$DEVICE" shell am force-stop "$APP_ID" >/dev/null
    "$ADB" -s "$DEVICE" shell am start -n "$ACTIVITY" \
        --ez screenshot_mode true \
        --es screenshot_screen "$SCREEN" >/dev/null

    # The transcript screens render in a WebView and need longer to settle.
    case "$SCREEN" in
        detail|composer) sleep 18 ;;
        *) sleep 12 ;;
    esac

    OUT="$OUTPUT_DIR/${SAFE_AVD}_${SCREEN}.png"
    "$ADB" -s "$DEVICE" exec-out screencap -p > "$OUT"
    echo "   -> $OUT"
done

"$ADB" -s "$DEVICE" shell am force-stop "$APP_ID" >/dev/null

echo ""
echo "=== Done ==="
ls -la "$OUTPUT_DIR"/*.png 2>/dev/null || echo "No screenshots captured."
