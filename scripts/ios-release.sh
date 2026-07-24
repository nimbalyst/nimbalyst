#!/bin/bash

set -e

RELEASE_TYPE=$1
PLIST_PATH="packages/ios/NimbalystApp/Sources/Info.plist"
CHANGELOG_PATH="IOS_CHANGELOG.md"

if [ -z "$RELEASE_TYPE" ]; then
  echo "Usage: ./scripts/ios-release.sh [patch|minor|major]"
  exit 1
fi

if [ "$RELEASE_TYPE" != "patch" ] && [ "$RELEASE_TYPE" != "minor" ] && [ "$RELEASE_TYPE" != "major" ]; then
  echo "Error: Release type must be patch, minor, or major"
  exit 1
fi

echo "Preparing iOS $RELEASE_TYPE release..."

# Verify Info.plist exists
if [ ! -f "$PLIST_PATH" ]; then
  echo "Error: $PLIST_PATH not found"
  exit 1
fi

# Verify changelog exists
if [ ! -f "$CHANGELOG_PATH" ]; then
  echo "Error: $CHANGELOG_PATH not found"
  exit 1
fi

# Read current version and build number using PlistBuddy
CURRENT_VERSION=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$PLIST_PATH")
CURRENT_BUILD=$(/usr/libexec/PlistBuddy -c "Print :CFBundleVersion" "$PLIST_PATH")

echo "Current version: $CURRENT_VERSION (build $CURRENT_BUILD)"

# Parse semver components
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"

# Bump version based on release type
case $RELEASE_TYPE in
  major)
    MAJOR=$((MAJOR + 1))
    MINOR=0
    PATCH=0
    ;;
  minor)
    MINOR=$((MINOR + 1))
    PATCH=0
    ;;
  patch)
    PATCH=$((PATCH + 1))
    ;;
esac

NEW_VERSION="$MAJOR.$MINOR.$PATCH"
NEW_BUILD=$((CURRENT_BUILD + 1))

echo "New version: $NEW_VERSION (build $NEW_BUILD)"

# Update Info.plist
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $NEW_VERSION" "$PLIST_PATH"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $NEW_BUILD" "$PLIST_PATH"

# Extract release notes from [Unreleased] section
RELEASE_NOTES=$(awk '/^## \[Unreleased\]/,0 {
  if (/^## \[Unreleased\]/) next
  if (/^## \[/) exit
  print
}' "$CHANGELOG_PATH" | sed '/^$/d' | sed '/^###/d' | sed '/^<!--/d')

if [ -z "$RELEASE_NOTES" ]; then
  echo "Error: No release notes found in [Unreleased] section of $CHANGELOG_PATH"
  echo "Please add release notes before creating a release."
  exit 1
fi

# Get current date
RELEASE_DATE=$(date +%Y-%m-%d)

# Create new release entry and save to temp file
echo "## [$NEW_VERSION] - $RELEASE_DATE" > /tmp/ios_release_entry.txt
echo "" >> /tmp/ios_release_entry.txt
awk '/^## \[Unreleased\]/,0 {if (/^## \[Unreleased\]/) next; if (/^## \[/) exit; print}' "$CHANGELOG_PATH" >> /tmp/ios_release_entry.txt

# Update IOS_CHANGELOG.md: replace [Unreleased] section with new release and empty [Unreleased]
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
  while ((getline line < "/tmp/ios_release_entry.txt") > 0) {
    print line
  }
  close("/tmp/ios_release_entry.txt")
  skip=1
  next
}
/^## \[/ && skip {
  skip=0
}
!skip {print}
' "$CHANGELOG_PATH" > "$CHANGELOG_PATH.tmp" && mv "$CHANGELOG_PATH.tmp" "$CHANGELOG_PATH"

# Format release notes for commit message (remove HTML comments)
COMMIT_NOTES=$(echo "$RELEASE_NOTES" | sed '/^<!--/d')

# Stage files
git add "$PLIST_PATH" "$CHANGELOG_PATH"

# Create commit
git commit -m "iOS Release v$NEW_VERSION (build $NEW_BUILD)

$COMMIT_NOTES"

# Create annotated git tag
git tag -a "ios/v$NEW_VERSION" -m "iOS Release v$NEW_VERSION (build $NEW_BUILD)

$COMMIT_NOTES"

echo ""
echo "iOS Release v$NEW_VERSION (build $NEW_BUILD) created successfully!"
echo ""
echo "Next steps:"
echo "1. Review the commit: git show HEAD"
echo "2. Review the tag: git show ios/v$NEW_VERSION"
echo "3. Push the commit: git push origin main"
echo "4. Push the tag: git push origin ios/v$NEW_VERSION"
echo "5. Open Xcode, archive the app, and upload to App Store Connect"
