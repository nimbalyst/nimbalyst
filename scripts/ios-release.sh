#!/bin/bash

set -e

PLIST_PATH="packages/ios/NimbalystApp/Sources/Info.plist"
CHANGELOG_PATH="IOS_CHANGELOG.md"

# The marketing version is NOT bumped here. After a release is accepted in the
# App Store, the plist is moved to the next expected version by hand, and that
# is the version TestFlight builds carry until it ships. This script releases
# whatever version the plist already holds and only increments the build number.
echo "Preparing iOS release..."

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
NEW_VERSION=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$PLIST_PATH")
CURRENT_BUILD=$(/usr/libexec/PlistBuddy -c "Print :CFBundleVersion" "$PLIST_PATH")
NEW_BUILD=$((CURRENT_BUILD + 1))

if git rev-parse -q --verify "refs/tags/ios/v$NEW_VERSION" >/dev/null; then
  echo "Error: tag ios/v$NEW_VERSION already exists."
  echo "Info.plist still holds a version that was already released; set the next version in it first."
  exit 1
fi

echo "Releasing version: $NEW_VERSION (build $CURRENT_BUILD -> $NEW_BUILD)"

# Update Info.plist
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $NEW_BUILD" "$PLIST_PATH"

# The widget extension is a separate bundle and App Store Connect rejects an
# embedded extension whose version does not match the app's, so it is kept in step here.
WIDGET_PLIST_PATH="packages/ios/NimbalystApp/NimbalystWidgets/Info.plist"
if [ -f "$WIDGET_PLIST_PATH" ]; then
  /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $NEW_VERSION" "$WIDGET_PLIST_PATH"
  /usr/libexec/PlistBuddy -c "Set :CFBundleVersion $NEW_BUILD" "$WIDGET_PLIST_PATH"
fi

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
[ -f "$WIDGET_PLIST_PATH" ] && git add "$WIDGET_PLIST_PATH"

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
