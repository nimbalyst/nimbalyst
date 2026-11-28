# Flatpak

App id `com.nimbalyst.Nimbalyst`. Built from source, offline, on `org.electronjs.Electron2.BaseApp`.

Run from the repo root:

```bash
flatpak/generate-sources.sh
flatpak-builder --user --install --install-deps-from=flathub --force-clean build-dir flatpak/com.nimbalyst.Nimbalyst.yml
flatpak run com.nimbalyst.Nimbalyst
```

`generate-sources.sh` needs `flatpak-node-generator` and skips when `generated-sources.json` is newer than `pnpm-lock.yaml`. The file is generated and not committed.

`flathub.json` limits the build to `x86_64` and `aarch64`.

The manifest builds the checkout it sits in, not a remote commit. Build from a clean checkout; a local `node_modules` inside `packages/*` is copied into the build.

## Host tools

The sandbox only sees the freedesktop runtime. Binaries on the host are not on `PATH`. To expose a directory (the home folder is already readable), set `NIMBALYST_EXTRA_PATH`:

```bash
flatpak override --user --env=NIMBALYST_EXTRA_PATH="$HOME/.local/bin" com.nimbalyst.Nimbalyst
```

Only statically linked or self-contained binaries run, since the sandbox libraries replace the host's.

Updates come from the Flatpak remote. The in-app updater is off.
