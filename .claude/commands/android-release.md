---
description: Prepare and execute an Android release (patch/minor/major)
---
**Arguments**: `{{arg1}}`
- First word: release type (patch, minor, major)

Prepare an Android release following this workflow:

## ANDROID RELEASE WORKFLOW

1. **Get commits since last Android release**:
  - Find the last Android git tag: `git tag --list 'android/*' --sort=-v:refname | head -1`
  - If no Android tags exist, note this is the first tracked Android release and use a reasonable cutoff (e.g., last 30 commits touching Android paths)
  - Get commits since that tag touching Android-relevant paths:
    ```
    git log [last-android-tag]..HEAD --oneline -- packages/android/ packages/runtime/
    ```
  - Also check for root-level changes that affect Android (package.json dependency changes, CI workflow changes, etc.)

2. **Generate developer changelog notes**:
  - Include all meaningful Android changes (features, fixes, improvements, refactors)
  - Internal changes are fine (Kotlin refactoring, build config, dependency updates)
  - Technical language is fine
  - Categorize using: Added, Changed, Fixed, Removed
  - There is no app-store "What's New" deliverable: Google Play upload is intentionally deferred, so the release stops at the CI APK artifact.

3. **Update ANDROID_CHANGELOG.md**:
  - Add the developer changelog notes to the `[Unreleased]` section in `ANDROID_CHANGELOG.md` (repository root)
  - Use the standard format with ### headings for each category
  - Only include categories that have changes

4. **Show the changes to user**:
  - Display the developer changelog (what will go in ANDROID_CHANGELOG.md)
  - Show the current Android version (`versionName`) and `versionCode`, and what they will be bumped to
  - Ask for approval before proceeding

5. **Execute Android release** (after user approval):
  - Run `./scripts/android-release.sh [type]`
  - The script will:
    - Bump `versionName` in `packages/android/app/build.gradle.kts`
    - Increment `versionCode` by 1 in `packages/android/app/build.gradle.kts`
    - Move [Unreleased] notes to a new versioned section in ANDROID_CHANGELOG.md
    - Stage only `packages/android/app/build.gradle.kts` and `ANDROID_CHANGELOG.md`
    - Create a commit with release notes
    - Create an annotated git tag `android/v[VERSION]` with release notes

6. **Show next steps**:
  - Push main and tag: `git push origin main && git push origin android/v[VERSION]`
  - CI (`.github/workflows/android-build.yml`) builds the signed APK artifact for the pushed tag
  - Download the APK artifact from the workflow run
  - Google Play upload is intentionally out of scope for now and is deferred to a later phase

7. **Done**: Confirm the tag is pushed and point the user at the CI workflow run for the APK artifact.

Valid release types: patch, minor, major

Example ANDROID_CHANGELOG.md format:
```markdown
## [Unreleased]

### Added
- Live session and transcript sync between desktop and Android

### Fixed
- Fixed queued prompt ordering after reconnect

## [0.1.0]
...
```
