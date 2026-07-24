#!/bin/bash
# Creates a Docker container for E2E testing with proper node_modules isolation.
#
# CRITICAL: Two layers of protection prevent npm ci from corrupting host binaries:
# 1. Anonymous Docker volumes for each node_modules dir (belt)
# 2. --cap-add=SYS_ADMIN so post-create.sh can tmpfs-mount any node_modules
#    that weren't covered by a volume flag (suspenders)
# Without both, linux-arm64 binaries (esbuild, electron, node-pty) overwrite
# the macOS host's darwin-arm64 binaries via the bind mount.
#
# Usage: .devcontainer/create-container.sh [container-name]
# If no name given, generates one from worktree name + timestamp.

set -e

cd "$(dirname "$0")/.."

CONTAINER_NAME="${1:-nimbalyst-e2e-$(basename "$(pwd)")-$(date +%s)}"

# Build volume flags for ALL node_modules directories (root + every workspace package)
NODE_MODULES_VOLUMES="-v /workspaces/nimbalyst/node_modules"
for pkg_json in $(find packages -name package.json -maxdepth 3 -not -path "*/node_modules/*"); do
  pkg_dir=$(dirname "$pkg_json")
  NODE_MODULES_VOLUMES="$NODE_MODULES_VOLUMES -v /workspaces/nimbalyst/$pkg_dir/node_modules"
done

echo "Starting container: ${CONTAINER_NAME}"
echo "Isolating $(echo "$NODE_MODULES_VOLUMES" | wc -w | tr -d ' ') node_modules directories"

docker run -d \
  --name "${CONTAINER_NAME}" \
  --shm-size=2g \
  --cap-add=SYS_ADMIN \
  -v "$(pwd):/workspaces/nimbalyst" \
  $NODE_MODULES_VOLUMES \
  -v nimbalyst-npm-cache:/root/.npm \
  -v nimbalyst-playwright-cache:/root/.cache/ms-playwright \
  -e DISPLAY=:99 \
  -e PLAYWRIGHT=1 \
  -e ELECTRON_DISABLE_SECURITY_WARNINGS=1 \
  nimbalyst-devcontainer:latest \
  sleep infinity

echo "${CONTAINER_NAME}"
