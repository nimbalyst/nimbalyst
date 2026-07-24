---
description: Prepare and execute an iOS release (patch/minor/major)
---
**Arguments**: `{{arg1}}`
- First word: release type (patch, minor, major)

Prepare an iOS release following this workflow:

## iOS RELEASE WORKFLOW

1. **Get commits since last iOS release**:
  - Find the last iOS git tag: `git tag --list 'ios/*' --sort=-v:refname | head -1`
  - If no iOS tags exist, note this is the first tracked iOS release and use a reasonable cutoff (e.g., last 30 commits touching iOS paths)
  - Get commits since that tag touching iOS-relevant paths:
    ```
    git log [last-ios-tag]..HEAD --oneline -- packages/ios/ packages/runtime/
    ```
  - Also check for root-level changes that affect iOS (package.json dependency changes, etc.)

2. **Generate release notes**:
  - Create TWO versions of release notes:

   **A. Developer Changelog (for IOS_CHANGELOG.md)**:
  - Include all meaningful iOS changes (features, fixes, improvements, refactors)
  - Can include internal changes (Swift refactoring, build config, dependency updates)
  - Technical language is fine
  - Categorize using: Added, Changed, Fixed, Removed

   **B. App Store "What's New" text**:
  - ONLY user-facing changes that affect the iOS app experience
  - Write in marketing/user-friendly language
  - Each bullet should answer "what can I now do?" or "what problem is fixed?"
  - Filter out ALL internal details:
    - NO code quality changes (Swift refactoring, type improvements)
    - NO internal architecture changes
    - NO performance optimizations unless user-perceptible
    - NO developer tooling changes
  - Keep it concise -- App Store allows ~4000 chars but shorter is better
  - Use present tense
  - No category headers -- just a clean bulleted list

3. **Update IOS_CHANGELOG.md**:
  - Add DEVELOPER CHANGELOG notes to the `[Unreleased]` section in `IOS_CHANGELOG.md` (repository root)
  - Use the standard format with ### headings for each category
  - Only include categories that have changes

4. **Show BOTH versions to user**:
  - Display the developer changelog (what will go in IOS_CHANGELOG.md)
  - Display the App Store "What's New" text separately
  - Show the current iOS version and what it will be bumped to
  - Ask for approval before proceeding

5. **Execute iOS release** (after user approval):
  - Run `./scripts/ios-release.sh [type]`
  - The script will:
    - Bump version in Info.plist (CFBundleShortVersionString)
    - Increment build number in Info.plist (CFBundleVersion)
    - Move [Unreleased] notes to a new versioned section in IOS_CHANGELOG.md
    - Create commit with release notes
    - Create annotated git tag `ios/v[VERSION]` with release notes

6. **Show next steps**:
  - Push main and tag: `git push origin main && git push origin ios/v[VERSION]`
  - Open Xcode, select the NimbalystApp scheme
  - Product > Archive
  - Upload to App Store Connect
  - Copy the App Store "What's New" text into the version description

7. **Done**: Show the App Store "What's New" text for easy copy-paste into App Store Connect.

Valid release types: patch, minor, major

Example IOS_CHANGELOG.md format:
```markdown
## [Unreleased]

### Added
- Hierarchical session navigation with worktree sync

### Fixed
- Fixed transcript blank screen on session load

## [1.0.1] - 2026-03-01
...
```
