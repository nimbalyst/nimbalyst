#!/bin/sh
# Chromium needs a TMPDIR shared with the host; the sandbox's /tmp is private.
export TMPDIR="$XDG_RUNTIME_DIR/app/$FLATPAK_ID"
# Tells Electron which desktop file the window belongs to, so the taskbar shows the right entry and icon.
export CHROME_DESKTOP="$FLATPAK_ID.desktop"
# Host tools are opt-in: the user lists extra directories, see README.
[ -n "${NIMBALYST_EXTRA_PATH:-}" ] && export PATH="$PATH:$NIMBALYST_EXTRA_PATH"
# On KDE Electron would talk to KWallet directly, which the sandbox blocks. libsecret uses the Secret portal instead.
exec zypak-wrapper /app/nimbalyst/nimbalyst --password-store=gnome-libsecret "$@"
