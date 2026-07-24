#!/usr/bin/env bash
#
# Run extension live integration tests against a running Nimbalyst instance.
#
# Usage:
#   npm run test:extensions              # Run all extension tests
#   npm run test:extensions -- csv       # Run tests for a specific extension (substring match)
#   npm run test:extensions -- --list    # List available test suites
#
# Prerequisites:
#   - Nimbalyst running in dev mode (npm run dev in packages/electron)
#   - CDP enabled on port 9222 (automatic in dev mode)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PW_CONFIG="$REPO_ROOT/packages/electron/playwright-extension.config.ts"

# Find all extension test directories
find_test_dirs() {
  find "$REPO_ROOT/packages/extensions" -path "*/tests/*.spec.ts" -exec dirname {} \; | sort -u
}

# List available test suites
if [[ "${1:-}" == "--list" ]]; then
  echo "Available extension test suites:"
  for dir in $(find_test_dirs); do
    ext_name=$(echo "$dir" | sed "s|.*/extensions/||;s|/tests||")
    spec_count=$(find "$dir" -name "*.spec.ts" | wc -l | tr -d ' ')
    echo "  $ext_name ($spec_count spec files)"
  done
  exit 0
fi

# Filter by extension name if provided
FILTER="${1:-}"
DIRS=$(find_test_dirs)

if [[ -n "$FILTER" ]]; then
  DIRS=$(echo "$DIRS" | grep -i "$FILTER" || true)
  if [[ -z "$DIRS" ]]; then
    echo "No extension tests matching '$FILTER'"
    echo "Run with --list to see available suites"
    exit 1
  fi
fi

# Check CDP is reachable
if ! curl -s http://localhost:9222/json/version > /dev/null 2>&1; then
  echo "Error: Cannot connect to CDP on port 9222."
  echo "Make sure Nimbalyst is running in dev mode (npm run dev in packages/electron)."
  exit 1
fi

# Run tests
TOTAL_PASSED=0
TOTAL_FAILED=0

for dir in $DIRS; do
  ext_name=$(echo "$dir" | sed "s|.*/extensions/||;s|/tests||")
  echo ""
  echo "=== $ext_name ==="

  if NIMBALYST_EXT_TEST_DIR="$dir" npx playwright test --config "$PW_CONFIG" 2>&1; then
    TOTAL_PASSED=$((TOTAL_PASSED + 1))
  else
    TOTAL_FAILED=$((TOTAL_FAILED + 1))
  fi
done

echo ""
echo "=== Summary ==="
echo "Suites passed: $TOTAL_PASSED"
if [[ $TOTAL_FAILED -gt 0 ]]; then
  echo "Suites failed: $TOTAL_FAILED"
  exit 1
fi
