#!/bin/sh
# Regenerates flatpak/generated-sources.json from pnpm-lock.yaml.
# Needs flatpak-node-generator and python3 on PATH. Skips when the sources are newer than the lockfile.
set -eu
cd "$(dirname "$0")/.."
if [ -f flatpak/generated-sources.json ] && [ flatpak/generated-sources.json -nt pnpm-lock.yaml ]; then
  exit 0
fi
flatpak-node-generator pnpm pnpm-lock.yaml \
  --pnpm-store-version v11 \
  --electron-node-headers \
  --node-sdk-extension org.freedesktop.Sdk.Extension.node26//26.08 \
  -o flatpak/generated-sources.json
python3 -I flatpak/prune-sources.py flatpak/generated-sources.json
