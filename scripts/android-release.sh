#!/bin/bash

set -e

RELEASE_TYPE=$1
GRADLE_FILE="packages/android/app/build.gradle.kts"
CHANGELOG_PATH="ANDROID_CHANGELOG.md"

if [ -z "$RELEASE_TYPE" ]; then
  echo "Usage: ./scripts/android-release.sh [patch|minor|major]"
  exit 1
fi

if [ "$RELEASE_TYPE" != "patch" ] && [ "$RELEASE_TYPE" != "minor" ] && [ "$RELEASE_TYPE" != "major" ]; then
  echo "Error: Release type must be patch, minor, or major"
  exit 1
fi

echo "Preparing Android $RELEASE_TYPE release..."

# Verify build.gradle.kts exists
if [ ! -f "$GRADLE_FILE" ]; then
  echo "Error: $GRADLE_FILE not found"
  exit 1
fi

# Verify changelog exists
if [ ! -f "$CHANGELOG_PATH" ]; then
  echo "Error: $CHANGELOG_PATH not found"
  exit 1
fi

# Read current versionName (semver) and versionCode (integer) from build.gradle.kts
CURRENT_VERSION=$(sed -nE 's/.*versionName = "([0-9]+\.[0-9]+\.[0-9]+)".*/\1/p' "$GRADLE_FILE")
CURRENT_CODE=$(sed -nE 's/.*versionCode = ([0-9]+).*/\1/p' "$GRADLE_FILE")

if [ -z "$CURRENT_VERSION" ]; then
  echo "Error: could not read versionName from $GRADLE_FILE"
  exit 1
fi

if [ -z "$CURRENT_CODE" ]; then
  echo "Error: could not read versionCode from $GRADLE_FILE"
  exit 1
fi

echo "Current version: $CURRENT_VERSION (versionCode $CURRENT_CODE)"

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
NEW_CODE=$((CURRENT_CODE + 1))

echo "New version: $NEW_VERSION (versionCode $NEW_CODE)"

# Update build.gradle.kts. The captured prefix/suffix carry the original
# indentation and quoting through unchanged, so we never depend on matching the
# exact old value. Temp-file pattern keeps this portable across GNU/BSD sed.
sed -E "s/(versionName = \")[0-9]+\.[0-9]+\.[0-9]+(\")/\1${NEW_VERSION}\2/" "$GRADLE_FILE" > "$GRADLE_FILE.tmp" && mv "$GRADLE_FILE.tmp" "$GRADLE_FILE"
sed -E "s/(versionCode = )[0-9]+/\1${NEW_CODE}/" "$GRADLE_FILE" > "$GRADLE_FILE.tmp" && mv "$GRADLE_FILE.tmp" "$GRADLE_FILE"

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
echo "## [$NEW_VERSION] - $RELEASE_DATE" > /tmp/android_release_entry.txt
echo "" >> /tmp/android_release_entry.txt
awk '/^## \[Unreleased\]/,0 {if (/^## \[Unreleased\]/) next; if (/^## \[/) exit; print}' "$CHANGELOG_PATH" >> /tmp/android_release_entry.txt

# Update ANDROID_CHANGELOG.md: replace [Unreleased] section with new release and empty [Unreleased]
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
  while ((getline line < "/tmp/android_release_entry.txt") > 0) {
    print line
  }
  close("/tmp/android_release_entry.txt")
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

# Stage only the two files this release touches (never -A)
git add "$GRADLE_FILE" "$CHANGELOG_PATH"

# Create commit
git commit -m "Android Release v$NEW_VERSION (versionCode $NEW_CODE)

$COMMIT_NOTES"

# Create annotated git tag
git tag -a "android/v$NEW_VERSION" -m "Android Release v$NEW_VERSION (versionCode $NEW_CODE)

$COMMIT_NOTES"

echo ""
echo "Android Release v$NEW_VERSION (versionCode $NEW_CODE) created successfully!"
echo ""
echo "Next steps:"
echo "1. Review the commit: git show HEAD"
echo "2. Review the tag: git show android/v$NEW_VERSION"
echo "3. Push the commit: git push origin main"
echo "   -> This commit bumps build.gradle.kts (under packages/android/), which"
echo "      triggers .github/workflows/android-build.yml to build the signed APK"
echo "      artifact. Download it from that workflow run."
echo "4. Push the tag: git push origin android/v$NEW_VERSION"
echo "   -> The tag marks the release commit; it does not itself trigger CI."
echo ""
echo "Note: Google Play upload is intentionally out of scope for now and is"
echo "      deferred to a later phase. This release stops at the CI APK artifact."
