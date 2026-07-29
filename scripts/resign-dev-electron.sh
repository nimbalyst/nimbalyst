#!/usr/bin/env bash
#
# Re-seal the dev Electron.app bundle so macOS will accept its notifications.
#
# The Electron.app that ships in node_modules is only "linker-signed": the Mach-O
# has an ad-hoc signature, but the bundle itself is unsealed (`Info.plist=not bound`,
# `Sealed Resources=none`). On recent macOS, usernotificationd can't verify the
# bundle identity behind `com.github.Electron` and rejects every notification with
# `UNErrorDomain error 1` (UNErrorCodeNotificationsNotAllowed) -- even though
# System Settings > Notifications shows the app as allowed.
#
# Re-signing ad-hoc with a proper bundle seal fixes it. Only affects local dev;
# packaged builds get a real Developer ID signature and are unaffected.
#
# Run this after any `npm install` that reinstalls or upgrades `electron`.
# The dev app must be stopped -- rewriting the Mach-O under a running process
# can crash it.

set -euo pipefail

APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/node_modules/electron/dist/Electron.app"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "resign-dev-electron: macOS only, nothing to do."
  exit 0
fi

if [[ ! -d "$APP" ]]; then
  echo "resign-dev-electron: $APP not found -- run npm install first." >&2
  exit 1
fi

# pgrep -f does not match this process on macOS, so read argv straight from ps.
# Match only lines that *start* with the executable path: a `grep -F <path>`
# matches the grep process's own argv (ps and grep start concurrently in a
# pipeline), so the check reported "running" with nothing running at all.
# awk's own argv starts with "awk", so it can't match itself.
# -ww keeps ps from truncating argv to the terminal width.
RUNNING="$(ps -Awwo args= | awk -v exe="$APP/Contents/MacOS/Electron" 'index($0, exe) == 1' || true)"
if [[ -n "$RUNNING" ]]; then
  echo "resign-dev-electron: the dev app is running. Quit it (Ctrl+C on npm run dev) and re-run." >&2
  exit 1
fi

if codesign -dv "$APP" 2>&1 | grep -q "Sealed Resources version"; then
  echo "resign-dev-electron: bundle is already sealed, nothing to do."
  exit 0
fi

echo "resign-dev-electron: re-signing $APP"
codesign --force --deep --sign - "$APP"

if codesign -dv "$APP" 2>&1 | grep -q "Sealed Resources version"; then
  echo "resign-dev-electron: done. Restart the dev app; notifications should post now."
else
  echo "resign-dev-electron: bundle still unsealed after signing." >&2
  exit 1
fi
