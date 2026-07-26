#!/bin/bash
# Screen recording for the Play Console reviewer screencast / promo video.
#
# Two modes:
#   demo   (default) -- boots the emulator in screenshot mode and drives a
#                       scripted tour over demo data. No desktop needed.
#   manual            -- records a device you drive by hand, for the real paired
#                       flow (QR pairing, live prompt, push notification).
#
# Usage:
#   bash packages/android/scripts/record-walkthrough.sh
#   bash packages/android/scripts/record-walkthrough.sh --manual --device=<serial> --duration=120
#   bash packages/android/scripts/record-walkthrough.sh --output=/tmp/nimbalyst.mp4
#
# Play Console note: the store listing's promo video field takes a YouTube URL,
# not a file. Upload the mp4 yourself and paste the link.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ANDROID_DIR="$(dirname "$SCRIPT_DIR")"
APK="$ANDROID_DIR/app/build/outputs/apk/debug/app-debug.apk"
APP_ID="com.nimbalyst.app"
ACTIVITY="$APP_ID/.MainActivity"
OUTPUT="$ANDROID_DIR/screenshots/walkthrough.mp4"

MODE="demo"
DEVICE=""
AVD=""
DURATION=90
SKIP_BUILD=0

for arg in "$@"; do
    case $arg in
        --manual) MODE="manual" ;;
        --device=*) DEVICE="${arg#*=}" ;;
        --avd=*) AVD="${arg#*=}" ;;
        --duration=*) DURATION="${arg#*=}" ;;
        --output=*) OUTPUT="${arg#*=}" ;;
        --skip-build) SKIP_BUILD=1 ;;
        *) echo "Unknown argument: $arg" >&2; exit 1 ;;
    esac
done

ANDROID_SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
ADB="$ANDROID_SDK/platform-tools/adb"
EMULATOR="$ANDROID_SDK/emulator/emulator"
[ -x "$ADB" ] || { echo "adb not found at $ADB. Set ANDROID_HOME." >&2; exit 1; }

if [ -z "${JAVA_HOME:-}" ] && [ -d "/Applications/Android Studio.app/Contents/jbr/Contents/Home" ]; then
    export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
fi

# adb screenrecord caps a single recording at 180s.
if [ "$DURATION" -gt 180 ]; then
    echo "screenrecord caps out at 180s; clamping." >&2
    DURATION=180
fi

mkdir -p "$(dirname "$OUTPUT")"
DEVICE_MP4="/sdcard/nimbalyst-walkthrough.mp4"

EMULATOR_PID=""
cleanup() {
    if [ -n "$EMULATOR_PID" ] && [ -n "$DEVICE" ]; then
        "$ADB" -s "$DEVICE" emu kill >/dev/null 2>&1 || kill "$EMULATOR_PID" 2>/dev/null || true
    fi
}
trap cleanup EXIT

if [ "$MODE" = "demo" ]; then
    if [ "$SKIP_BUILD" -eq 0 ]; then
        echo "[1/4] Building debug APK..."
        (cd "$ANDROID_DIR" && npm run build:transcript >/dev/null && ./gradlew :app:assembleDebug -q)
    fi
    [ -f "$APK" ] || { echo "Debug APK not found at $APK" >&2; exit 1; }

    if [ -z "$DEVICE" ]; then
        echo "[2/4] Booting emulator..."
        [ -n "$AVD" ] || AVD="$("$EMULATOR" -list-avds | head -1)"
        "$EMULATOR" -avd "$AVD" -no-snapshot -no-boot-anim -no-audio >/dev/null 2>&1 &
        EMULATOR_PID=$!
        "$ADB" wait-for-device
        DEVICE="$("$ADB" devices | awk '/emulator/ {print $1; exit}')"
        until [ "$("$ADB" -s "$DEVICE" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do
            sleep 2
        done
        sleep 25
    fi

    "$ADB" -s "$DEVICE" shell pm disable-user --user 0 com.google.android.apps.wellbeing >/dev/null 2>&1 || true
    "$ADB" -s "$DEVICE" shell settings put global anr_show_background 0 >/dev/null 2>&1 || true

    echo "[3/4] Installing and warming up..."
    "$ADB" -s "$DEVICE" install -r -t "$APK" >/dev/null
    "$ADB" -s "$DEVICE" shell am start -n "$ACTIVITY" --ez screenshot_mode true --es screenshot_screen walkthrough >/dev/null
    sleep 20
    "$ADB" -s "$DEVICE" shell am force-stop "$APP_ID" >/dev/null

    "$ADB" -s "$DEVICE" shell settings put global sysui_demo_allowed 1 >/dev/null
    demo() { "$ADB" -s "$DEVICE" shell am broadcast -a com.android.systemui.demo "$@" >/dev/null; }
    demo -e command enter
    demo -e command clock -e hhmm 0941
    demo -e command battery -e level 100 -e plugged false
    demo -e command network -e wifi show -e level 4
    demo -e command notifications -e visible false

    echo "[4/4] Recording tour (${DURATION}s max)..."
    "$ADB" -s "$DEVICE" shell screenrecord --bit-rate 8000000 --time-limit "$DURATION" "$DEVICE_MP4" &
    RECORD_PID=$!
    sleep 3

    tap() { "$ADB" -s "$DEVICE" shell input tap "$1" "$2" >/dev/null; sleep "${3:-3}"; }
    swipe() { "$ADB" -s "$DEVICE" shell input swipe "$@" >/dev/null; sleep 2; }

    # Scripted tour. Coordinates target a 1080x2220 phone (Pixel 3a).
    "$ADB" -s "$DEVICE" shell am start -n "$ACTIVITY" --ez screenshot_mode true --es screenshot_screen walkthrough >/dev/null
    sleep 10                       # project list
    tap 540 340 5                  # open the first project -> session list
    swipe 540 1500 540 900 300     # scan the session list
    sleep 2
    tap 540 700 12                 # open a session -> transcript
    swipe 540 800 540 1600 400     # scroll back through the transcript
    sleep 2
    swipe 540 1600 540 700 400
    sleep 2
    tap 540 1930 3                 # focus the prompt composer
    "$ADB" -s "$DEVICE" shell input text "Add%stests%sfor%sthe%stheme%scontroller" >/dev/null
    sleep 4

    wait "$RECORD_PID" 2>/dev/null || true
    sleep 3
    demo -e command exit
else
    [ -n "$DEVICE" ] || DEVICE="$("$ADB" devices | awk 'NR==2 {print $1}')"
    [ -n "$DEVICE" ] || { echo "No device attached. Plug in a phone or pass --device=<serial>." >&2; exit 1; }
    echo "Recording $DEVICE for ${DURATION}s -- drive the app now."
    echo "Suggested reviewer flow: pair via QR -> project list -> session -> transcript -> send a prompt -> push notification."
    "$ADB" -s "$DEVICE" shell screenrecord --bit-rate 8000000 --time-limit "$DURATION" "$DEVICE_MP4"
fi

echo "Pulling recording..."
"$ADB" -s "$DEVICE" pull "$DEVICE_MP4" "$OUTPUT" >/dev/null
"$ADB" -s "$DEVICE" shell rm -f "$DEVICE_MP4" >/dev/null 2>&1 || true

# Re-encode for wide compatibility (YouTube, Play Console review notes).
if command -v ffmpeg >/dev/null 2>&1; then
    TMP="${OUTPUT%.mp4}-h264.mp4"
    ffmpeg -y -loglevel error -i "$OUTPUT" -c:v libx264 -pix_fmt yuv420p -movflags +faststart "$TMP"
    mv "$TMP" "$OUTPUT"
fi

echo "=== Done ==="
ls -la "$OUTPUT"
