#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "==> Building @nimbalyst/extension-sdk"
pnpm --dir packages/extension-sdk run build

echo "==> Verifying package contents"
(
  cd packages/extension-sdk
  pnpm pack --dry-run >/dev/null
)

echo "==> Typechecking extension-dev-kit"
pnpm exec tsc --noEmit -p packages/extensions/extension-dev-kit/tsconfig.json

check_example() {
  local dir="$1"

  echo "==> Building example: ${dir}"
  (
    cd "$dir"
    pnpm exec vite build
  )

  echo "==> Typechecking example: ${dir}"
  pnpm exec tsc --noEmit -p "${dir}/tsconfig.json"
}

check_example "packages/extension-sdk-docs/examples/minimal"
check_example "packages/extension-sdk-docs/examples/custom-editor"
check_example "packages/extension-sdk-docs/examples/ai-tool"

echo "==> Public extension SDK checks passed"
