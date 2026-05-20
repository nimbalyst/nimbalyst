#!/bin/bash
# Deploy the marketplace Worker with version bumping
# Usage: ./scripts/deploy.sh [patch|minor|major] --env [staging|production]

set -e

# Pin wrangler's config dir to the Nimbalyst OAuth profile so deploys can't
# accidentally land on whatever Cloudflare account is selected in the
# default config. Mirrors the npm scripts in package.json.
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config/nimbalyst}"

BUMP_TYPE="${1:-patch}"
shift || true

# Bump version in package.json
cd "$(dirname "$0")/.."
CURRENT_VERSION=$(node -p "require('./package.json').version")

IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"

case "$BUMP_TYPE" in
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  patch) PATCH=$((PATCH + 1)) ;;
  *) echo "Usage: $0 [patch|minor|major] --env [staging|production]"; exit 1 ;;
esac

NEW_VERSION="${MAJOR}.${MINOR}.${PATCH}"

# Update package.json version
node -e "
const pkg = require('./package.json');
pkg.version = '${NEW_VERSION}';
require('fs').writeFileSync('./package.json', JSON.stringify(pkg, null, 2) + '\n');
"

echo "Deploying marketplace Worker v${NEW_VERSION}..."

# Deploy with version injected
npx wrangler deploy --define "VERSION:\"${NEW_VERSION}\"" "$@"

echo ""
echo "Deployed marketplace Worker v${NEW_VERSION}"
echo ""
echo "To tag this release:"
echo "  git tag marketplace-v${NEW_VERSION}"
echo "  git push origin marketplace-v${NEW_VERSION}"
