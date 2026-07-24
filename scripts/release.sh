#!/bin/bash

set -e

RELEASE_TYPE=$1

if [ -z "$RELEASE_TYPE" ]; then
  echo "Usage: ./scripts/release.sh [patch|minor|major]"
  exit 1
fi

if [ "$RELEASE_TYPE" != "patch" ] && [ "$RELEASE_TYPE" != "minor" ] && [ "$RELEASE_TYPE" != "major" ]; then
  echo "Error: Release type must be patch, minor, or major"
  exit 1
fi

echo "Preparing $RELEASE_TYPE release..."

# Change to electron package directory
cd packages/electron

# Get current version
CURRENT_VERSION=$(node -p "require('./package.json').version")
echo "Current version: $CURRENT_VERSION"

# Bump version using npm
npm version $RELEASE_TYPE --no-git-tag-version

# Get new version
NEW_VERSION=$(node -p "require('./package.json').version")
echo "New version: $NEW_VERSION"

# Go back to root
cd ../..

# Update root package-lock.json
npm install --package-lock-only

# Check if CHANGELOG.md exists
if [ ! -f "CHANGELOG.md" ]; then
  echo "Error: CHANGELOG.md not found in repository root"
  exit 1
fi

# Extract release notes from [Unreleased] section
RELEASE_NOTES=$(awk '/^## \[Unreleased\]/,0 {
  if (/^## \[Unreleased\]/) next
  if (/^## \[/) exit
  print
}' CHANGELOG.md | sed '/^$/d' | sed '/^###/d' | sed '/^<!--/d')

if [ -z "$RELEASE_NOTES" ]; then
  echo "Error: No release notes found in [Unreleased] section of CHANGELOG.md"
  echo "Please add release notes before creating a release."
  exit 1
fi

# Get current date
RELEASE_DATE=$(date +%Y-%m-%d)

# Create new release entry and save to temp file
echo "## [$NEW_VERSION] - $RELEASE_DATE" > /tmp/new_release_entry.txt
echo "" >> /tmp/new_release_entry.txt
awk '/^## \[Unreleased\]/,0 {if (/^## \[Unreleased\]/) next; if (/^## \[/) exit; print}' CHANGELOG.md >> /tmp/new_release_entry.txt

# Update CHANGELOG.md: replace [Unreleased] section with new release and empty [Unreleased]
awk '
/^## \[Unreleased\]/ {
  print "## [Unreleased]"
  print ""
  print "### Added"
  print "<!-- New features go here -->"
  print ""
  print "### Changed"
  print "<!-- Changes to existing functionality go here -->"
  print ""
  print "### Fixed"
  print "<!-- Bug fixes go here -->"
  print ""
  print "### Removed"
  print "<!-- Removed features go here -->"
  print ""
  while ((getline line < "/tmp/new_release_entry.txt") > 0) {
    print line
  }
  close("/tmp/new_release_entry.txt")
  skip=1
  next
}
/^## \[/ && skip {
  skip=0
}
!skip {print}
' CHANGELOG.md > CHANGELOG.md.tmp && mv CHANGELOG.md.tmp CHANGELOG.md

# Format release notes for commit message (remove HTML comments)
COMMIT_NOTES=$(echo "$RELEASE_NOTES" | sed '/^<!--/d')

# Create commit with release notes
git add packages/electron/package.json package-lock.json CHANGELOG.md
git commit -m "Release v$NEW_VERSION

$COMMIT_NOTES"

# Create annotated git tag with release notes
git tag -a "v$NEW_VERSION" -m "Release v$NEW_VERSION

$COMMIT_NOTES"

echo ""
echo "Release v$NEW_VERSION created successfully!"
echo ""
echo "Next steps:"
echo "1. Review the commit: git show HEAD"
echo "2. Review the tag: git show v$NEW_VERSION"
echo "3. Push the commit: git push origin main"
echo "4. Push the tag to trigger CI: git push origin v$NEW_VERSION"
echo ""
echo "The GitHub Actions workflow will automatically build and publish the release."
