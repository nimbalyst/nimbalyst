#!/bin/bash
# Wrapper script for npm run dev that supports --user-data-dir argument
# Usage: ./scripts/dev.sh --user-data-dir=/path/to/dir

# Parse arguments for --user-data-dir
for arg in "$@"; do
  if [[ "$arg" == --user-data-dir=* ]]; then
    export NIMBALYST_USER_DATA_DIR="${arg#--user-data-dir=}"
    echo "[dev.sh] Using custom userData directory: $NIMBALYST_USER_DATA_DIR"
  fi
done

# When NIMBALYST_USER_DATA_DIR is set, use a separate build output directory
# to avoid triggering the primary dev instance's file watcher. Without this,
# both electron-vite watchers share out/main/index.js and the module-level
# singletons from one instance bleed into the other on HMR restart.
if [ -n "$NIMBALYST_USER_DATA_DIR" ]; then
  export ELECTRON_ENTRY=out2/main/index.js
  echo "[dev.sh] Using isolated build output: out2/"
  npm run build:worker && npx electron-vite dev --outDir=out2
else
  npm run build:worker && npx electron-vite dev
fi
