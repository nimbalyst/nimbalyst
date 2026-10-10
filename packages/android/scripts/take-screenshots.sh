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
#   bash packages/android/scripts/take-screenshots.sh --avd=Nimbalyst_Tablet_10in --out=/tmp/tablet-10
#   bash packages/android/scripts/take-screenshots.sh --avd=Nimbalyst_Tablet_7in --port=5556   # fixed console port for parallel runs
#
# Several AVDs can run at once: a booted AVD gets its own console port, so
# --avd never captures from a different emulator that happens to be up.
# Each capture is flattened to a 24-bit PNG (Play rejects alpha) and checked
# against Play's size rules; see docs/ANDROID_MARKETING_SCREENSHOTS.md.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ANDROID_DIR="$(dirname "$SCRIPT_DIR")"
OUTPUT_DIR="$ANDROID_DIR/screenshots"
APK="$ANDROID_DIR/app/build/outputs/apk/debug/app-debug.apk"
APP_ID="com.nimbalyst.app"
ACTIVITY="$APP_ID/.MainActivity"

ALL_SCREENS="pairing projects sessions detail composer newsession computers files document settings"
SCREENS="$ALL_SCREENS"
AVD=""
DEVICE=""
PORT=""
SKIP_BUILD=0

for arg in "$@"; do
    case $arg in
        --screens=*) SCREENS="${arg#*=}"; SCREENS="${SCREENS//,/ }" ;;
        --avd=*) AVD="${arg#*=}" ;;
        --device=*) DEVICE="${arg#*=}" ;;
        --out=*) OUTPUT_DIR="${arg#*=}" ;;
        --port=*) PORT="${arg#*=}" ;;
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
    echo "[1/4] Building transcript and editor bundles..."
    (cd "$ANDROID_DIR" && pnpm run build:transcript >/dev/null && pnpm run build:editor >/dev/null)

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
    # Pick a free console port so this run owns exactly one emulator serial.
    # An emulator still booting is not in `adb devices` yet, so also skip ports
    # an emulator process has claimed. Runs launched in the same instant can
    # still race; give each its own --port.
    if [ -z "$PORT" ]; then
        PORT=5554
        while "$ADB" devices | grep -q "^emulator-$PORT" || pgrep -f -- "-port $PORT( |$)" >/dev/null; do
            PORT=$((PORT + 2))
        done
    fi
    DEVICE="emulator-$PORT"
    "$EMULATOR" -avd "$AVD" -port "$PORT" -no-snapshot -no-boot-anim -no-audio >/dev/null 2>&1 &
    EMULATOR_PID=$!

    echo "   Waiting for $DEVICE..."
    "$ADB" -s "$DEVICE" wait-for-device
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
# The animator scale stays at 1: Compose drives its progress spinners from it,
# and at 0 a running session's spinner renders as a stray dot.
for scale in window_animation_scale transition_animation_scale; do
    "$ADB" -s "$DEVICE" shell settings put global "$scale" 0 >/dev/null 2>&1 || true
done
"$ADB" -s "$DEVICE" shell settings put global animator_duration_scale 1 >/dev/null 2>&1 || true
# The app is dark only but asks for system-default bar icons, which are dark on
# a light-mode image and vanish against the app background.
"$ADB" -s "$DEVICE" shell cmd uimode night yes >/dev/null 2>&1 || true
# Screenshot mode hides the navigation bars (a tablet's taskbar shows other
# apps' icons); skip the one-time "Viewing full screen" cling that triggers.
"$ADB" -s "$DEVICE" shell settings put secure immersive_mode_confirmations confirmed >/dev/null 2>&1 || true

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

# --- UI driving --------------------------------------------------------------
# Some screens need a tap the launch intent cannot express (a tab, a menu, a
# collapsed group). Taps find their target by visible text or content
# description in a uiautomator dump, so they work at any screen size.
UI_DUMP="$(mktemp -t nimbalyst-ui)"
ui_center() { # $1 = text|desc, $2 = value; prints "x y" of the first match
    "$ADB" -s "$DEVICE" shell uiautomator dump /sdcard/nimbalyst-ui.xml >/dev/null 2>&1 || return 1
    "$ADB" -s "$DEVICE" exec-out cat /sdcard/nimbalyst-ui.xml > "$UI_DUMP"
    python3 -I - "$UI_DUMP" "$1" "$2" <<'PY'
import re, sys, xml.etree.ElementTree as ET
path, kind, value = sys.argv[1:]
attr = "text" if kind == "text" else "content-desc"
for node in ET.parse(path).iter("node"):
    if node.get(attr) == value:
        x1, y1, x2, y2 = map(int, re.findall(r"\d+", node.get("bounds")))
        print((x1 + x2) // 2, (y1 + y2) // 2)
        break
PY
}
ui_tap() { # $1 = text|desc, $2 = value
    local xy
    xy="$(ui_center "$1" "$2")"
    if [ -z "$xy" ]; then
        echo "   !! no element with $1 \"$2\"" >&2
        return 1
    fi
    # shellcheck disable=SC2086
    "$ADB" -s "$DEVICE" shell input tap $xy
    sleep 2
}
# Workstreams and worktrees start collapsed; open every group on screen.
expand_groups() {
    local i
    for i in 1 2 3 4 5 6; do
        [ -n "$(ui_center desc Expand)" ] || return 0
        ui_tap desc Expand || return 0
    done
}
drive_screen() {
    case "$1" in
        sessions) expand_groups ;;
        newsession) expand_groups; ui_tap desc Create && ui_tap text "New Session" ;;
        computers) expand_groups; ui_tap desc "Switch computer" ;;
        files) ui_tap text Files ;;
        document) ui_tap text Files && ui_tap text "dark-mode.md" && sleep 8 ;;
    esac
}

# Play: 24-bit PNG with no alpha. Phones 320-3840px with the long side at most
# twice the short one; tablets (large screens) 1080-7680px at 16:9 or 9:16.
check_play_size() {
    local w h
    read -r w h <<< "$(magick identify -format "%w %h" "$1")"
    local long=$(( w > h ? w : h )) short=$(( w > h ? h : w ))
    if [ "$long" -gt $((short * 2)) ] || [ "$short" -lt 320 ] || [ "$long" -gt 3840 ]; then
        echo "   !! ${w}x${h} breaks Play's phone limits" >&2
    elif [ $((long * 9)) -ne $((short * 16)) ] || [ "$short" -lt 1080 ]; then
        echo "   (${w}x${h}: phone-only; tablet uploads need 16:9 and >= 1080px)"
    fi
    return 0
}

# --- Capture -----------------------------------------------------------------
echo "[4/4] Capturing..."
mkdir -p "$OUTPUT_DIR"
SAFE_AVD="$(echo "${AVD:-$DEVICE}" | tr ' .' '_' | tr -cd '[:alnum:]_-')"

for SCREEN in $SCREENS; do
    echo "   $SCREEN"
    "$ADB" -s "$DEVICE" shell am force-stop "$APP_ID" >/dev/null
    "$ADB" -s "$DEVICE" shell am start -n "$ACTIVITY" \
        --ez screenshot_mode true \
        --es screenshot_screen "$SCREEN" >/dev/null

    # The transcript screens render in a WebView and need longer to settle.
    # On a tablet every workspace screen shows a transcript in the detail pane.
    case "$SCREEN" in
        pairing|settings|projects|files) sleep 12 ;;
        *) sleep 18 ;;
    esac
    drive_screen "$SCREEN" || echo "   !! could not drive $SCREEN; capturing as is" >&2

    OUT="$OUTPUT_DIR/${SAFE_AVD}_${SCREEN}.png"
    "$ADB" -s "$DEVICE" exec-out screencap -p > "$OUT"
    if command -v magick >/dev/null; then
        magick "$OUT" -alpha off "PNG24:$OUT"
        check_play_size "$OUT"
    else
        echo "   (ImageMagick not found: $OUT keeps its alpha channel; Play rejects that)" >&2
    fi
    echo "   -> $OUT"
done

"$ADB" -s "$DEVICE" shell am force-stop "$APP_ID" >/dev/null
rm -f "$UI_DUMP"

echo ""
echo "=== Done ==="
ls -la "$OUTPUT_DIR"/*.png 2>/dev/null || echo "No screenshots captured."
