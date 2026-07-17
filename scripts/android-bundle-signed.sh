#!/bin/bash
#
# Build a signed Android release artifact, pulling all signing secrets from
# 1Password at build time via `op`. No secret ever lives on disk permanently:
# the keystore is fetched to a temp file that is deleted on exit, and the
# passwords/alias are injected into the Gradle process environment only.
#
# Prereqs:
#   - op (1Password CLI) installed and signed in:  op signin
#   - JDK 17 (brew install openjdk@17)
#   - Android SDK (defaults to ~/Library/Android/sdk)
#   - The "Nimbalyst Android Signing" item populated in the Nimbalyst vault
#     (keystore-password / key-alias / key-password fields + upload-keystore file)
#
# Usage:
#   ./scripts/android-bundle-signed.sh                # :app:bundleRelease (AAB, default)
#   ./scripts/android-bundle-signed.sh assembleRelease  # signed APK instead
#
set -euo pipefail

GRADLE_TASK="${1:-bundleRelease}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ANDROID_DIR="$REPO_ROOT/packages/android"

OP_ITEM="op://Nimbalyst/Nimbalyst Android Signing"

# --- 1Password availability -------------------------------------------------
command -v op >/dev/null 2>&1 || { echo "Error: 1Password CLI (op) not found. brew install 1password-cli"; exit 1; }
# `op whoami` gives a false negative under 1Password desktop-app integration
# (each command is authorized via the app, not a CLI session token). Probe with
# a real read-only call instead.
if ! op vault list >/dev/null 2>&1; then
  echo "Error: 1Password is locked or unavailable. Unlock the 1Password app (or run: op signin)"; exit 1
fi

# --- JDK 17 -----------------------------------------------------------------
if [ -n "${JAVA_HOME:-}" ] && "$JAVA_HOME/bin/java" -version 2>&1 | grep -q '"17'; then
  :
elif [ -x /opt/homebrew/opt/openjdk@17/bin/java ]; then
  export JAVA_HOME=/opt/homebrew/opt/openjdk@17
elif /usr/libexec/java_home -v 17 >/dev/null 2>&1; then
  export JAVA_HOME="$(/usr/libexec/java_home -v 17)"
else
  echo "Error: JDK 17 required (AGP jlink fails on other versions). brew install openjdk@17"; exit 1
fi

# --- Android SDK ------------------------------------------------------------
export ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
[ -d "$ANDROID_HOME" ] || { echo "Error: Android SDK not found at $ANDROID_HOME (set ANDROID_HOME)"; exit 1; }

# --- Fetch the keystore into a temp dir, wiped on exit ----------------------
# Use a temp DIR (not a temp file with an appended suffix) so nothing is
# orphaned: the whole dir is removed on exit.
KEYSTORE_DIR="$(mktemp -d -t nimbalyst-android-signing)"
KEYSTORE_TMP="$KEYSTORE_DIR/upload.jks"
cleanup() { rm -rf "$KEYSTORE_DIR"; }
trap cleanup EXIT INT TERM
op read --force --out-file "$KEYSTORE_TMP" "$OP_ITEM/upload-keystore" >/dev/null

# --- Inject signing secrets into the environment for Gradle only ------------
export NIMBALYST_ANDROID_KEYSTORE="$KEYSTORE_TMP"
NIMBALYST_ANDROID_KEYSTORE_PASSWORD="$(op read "$OP_ITEM/keystore-password")"
NIMBALYST_ANDROID_KEY_ALIAS="$(op read "$OP_ITEM/key-alias")"
NIMBALYST_ANDROID_KEY_PASSWORD="$(op read "$OP_ITEM/key-password")"
export NIMBALYST_ANDROID_KEYSTORE_PASSWORD NIMBALYST_ANDROID_KEY_ALIAS NIMBALYST_ANDROID_KEY_PASSWORD

if [ "$NIMBALYST_ANDROID_KEYSTORE_PASSWORD" = "REPLACE_ME" ] || [ "$NIMBALYST_ANDROID_KEY_PASSWORD" = "REPLACE_ME" ]; then
  echo "Error: signing secrets in 1Password still hold placeholder 'REPLACE_ME'."
  echo "Fill keystore-password / key-alias / key-password on the 'Nimbalyst Android Signing' item, then rerun."
  exit 1
fi

# --- Transcript bundle must exist before a release build --------------------
if [ ! -f "$ANDROID_DIR/dist-transcript/transcript.html" ]; then
  echo "Transcript bundle missing; building it..."
  ( cd "$REPO_ROOT" && npm run android:build:transcript )
fi

# --- Build ------------------------------------------------------------------
echo "Building :app:$GRADLE_TASK with signing from 1Password (JDK: $JAVA_HOME)..."
( cd "$ANDROID_DIR" && ./gradlew ":app:$GRADLE_TASK" )

# --- Report + verify signature ----------------------------------------------
if [ "$GRADLE_TASK" = "bundleRelease" ]; then
  OUT="$(find "$ANDROID_DIR/app/build/outputs/bundle/release" -name '*.aab' -type f | head -n 1)"
  echo "Built AAB: $OUT"
  jarsigner -verify "$OUT" >/dev/null 2>&1 && echo "AAB signature: VERIFIED" || echo "AAB signature: NOT verified (check keystore secrets)"
else
  OUT="$(find "$ANDROID_DIR/app/build/outputs/apk/release" -name '*.apk' -type f | head -n 1)"
  APKSIGNER="$(find "$ANDROID_HOME/build-tools" -name apksigner | sort | tail -n 1)"
  echo "Built APK: $OUT"
  [ -n "$APKSIGNER" ] && "$APKSIGNER" verify --verbose "$OUT" >/dev/null 2>&1 && echo "APK signature: VERIFIED" || echo "APK signature: check manually"
fi
