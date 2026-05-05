# Release Process

This document describes the release process for Nimbalyst.

## Overview

Nimbalyst now uses a single GitHub Releases-based flow for both alpha and stable distribution:
- **Tag push**: builds all platforms and publishes a visible GitHub **pre-release** for the alpha channel
- **Stable promotion**: run `/promote-public-release` to rebuild cumulative public notes, let the user edit them, update the existing GitHub release notes, and flip that release from pre-release to stable
- **CHANGELOG.md**: remains the source of truth for release notes
- **Annotated Git Tags**: still carry the release notes snapshot

During the migration away from Cloudflare R2, `.github/workflows/electron-build.yml` keeps a temporary `LEGACY_ALPHA_TRANSITION_R2_UPLOAD` switch enabled. Leave it on for exactly one transition release so older alpha installs that still point at R2 can update onto the GitHub-backed alpha feed, then turn it off.

## Standard Release Workflow

The release process is divided into two phases so alpha users can test a published prerelease before it becomes the stable release.

### Phase 1: Alpha Pre-release

#### 1. Prepare Release Notes

As you work, add changes to the `[Unreleased]` section of `CHANGELOG.md`:

```markdown
## [Unreleased]

### Added
- New feature X that does Y

### Fixed
- Fixed bug where Z happened

### Changed
- Updated behavior of A to B
```

#### 2. Create Internal Release (Using /release-alpha)

Run the `/release-alpha` slash command in Claude Code:

```
/release-alpha patch    # For bug fixes (0.42.60 → 0.42.61)
/release-alpha minor    # For new features (0.42.60 → 0.43.0)
/release-alpha major    # For breaking changes (0.42.60 → 1.0.0)
```

This command will:
1. Review commits since last release
2. Generate TWO versions of release notes:
   - Developer CHANGELOG (technical, all changes)
   - Public release notes (user-facing only)
3. Update CHANGELOG.md [Unreleased] section
4. Wait for your approval

#### 3. Execute Internal Release

After approving the release notes, the command will run `./scripts/release.sh` which:
1. Bumps version in `package.json`
2. Updates `package-lock.json`
3. Moves [Unreleased] notes to new version section in CHANGELOG.md
4. Creates a commit with release notes
5. Creates an annotated git tag with release notes

#### 4. Push the Release Commit and Tag

```bash
# Review the changes
git show HEAD
git show v0.42.61

# Push commit and tag
git push origin main
git push origin v0.42.61
```

#### 5. GitHub Actions Publishes the Alpha Release

Pushing the tag triggers the GitHub Actions workflow which:
1. Builds for macOS (arm64 + x64), Windows (x64 + arm64), and Linux (x64)
2. Signs and notarizes macOS builds; signs Windows builds via DigiCert KeyLocker
3. Publishes a visible GitHub **pre-release** for tag `vX.Y.Z`
4. Uploads build artifacts and update manifests to that release
5. Optionally uploads the same assets to the legacy R2 bucket when `LEGACY_ALPHA_TRANSITION_R2_UPLOAD` is still enabled

**Windows artifacts:** Two installers ship per release. `Nimbalyst-Windows-x64.exe`
and `Nimbalyst-Windows-arm64.exe` are the arch-specific installers referenced by
`latest.yml` / `alpha.yml` for auto-update. A third file, `Nimbalyst-Windows.exe`, is a copy of
the signed x64 installer kept for backwards-compatible download links — it is not
referenced by the updater metadata.

#### 6. Test the Alpha Build

Before proceeding to Phase 2:
1. Download the build from the GitHub pre-release for that tag
2. Test thoroughly on target platforms
3. Verify all features work as expected
4. Check for any critical issues

Alpha users in the app receive this release through the GitHub pre-release feed:
- `releaseChannel=alpha` sets `autoUpdater.allowPrerelease = true`
- `autoUpdater.channel = 'alpha'` makes electron-updater read `alpha*.yml` assets from the GitHub release

### Phase 2: Stable Promotion

Only proceed after successfully testing the alpha pre-release.

#### 1. Verify the Pre-release

Ensure:
- The alpha pre-release has been tested
- No critical issues found
- Ready to release publicly

#### 2. Promote the Same Tag to Stable

Run `/promote-public-release`.

That command:
- finds the current GitHub prerelease for the tag
- finds the previous stable public release
- rebuilds `PUBLIC_RELEASE_NOTES.md` cumulatively across releases since that stable release
- pauses for user edits
- commits the final `PUBLIC_RELEASE_NOTES.md`
- updates the existing GitHub release notes from that file
- clears the prerelease flag on the existing release

No second tag is created, and no separate release draft is involved.

#### 3. Verify Stable Release

Check that:
- Release appears on public repo: https://github.com/nimbalyst/nimbalyst/releases
- Only user-facing changes are mentioned
- No internal/technical details exposed
- Build artifacts are available (if applicable)
- The release is **not** marked as a pre-release

## Release Branch Workflow (Optional)

For more control or when you need to test a release before publishing:

### 1. Create Release Branch

```bash
# Create release branch from main
git checkout -b release/v0.42.61 main

# Or create from a specific commit
git checkout -b release/v0.42.61 abc123
```

### 2. Prepare Release on Branch

Follow the standard workflow steps 1-3 above, but commit to the release branch:

```bash
# After running release.sh, you'll be on the release branch
git push origin release/v0.42.61
```

### 3. Test the Release

The GitHub Actions workflow will build the release branch automatically. You can:
- Download and test the artifacts
- Make additional fixes if needed
- Commit fixes to the release branch

### 4. Merge and Tag

Once satisfied with the release:

```bash
# Merge to main
git checkout main
git merge release/v0.42.61 --no-ff

# Push everything
git push origin main
git push origin v0.42.61
```

## Hotfix Workflow

For urgent fixes to production:

### 1. Create Hotfix Branch from Tag

```bash
# Branch from the last release tag
git checkout -b hotfix/v0.42.62 v0.42.61
```

### 2. Make Fix and Update CHANGELOG

```bash
# Make your fix
git commit -m "fix: critical bug in X"

# Update CHANGELOG.md [Unreleased] section
# Add ### Fixed section with your fix
```

### 3. Create Hotfix Release

```bash
# Run release script
./scripts/release.sh patch

# This creates v0.42.62
```

### 4. Merge Back to Main

```bash
# Push hotfix
git push origin v0.42.62

# Merge back to main
git checkout main
git merge hotfix/v0.42.62
git push origin main
```

## Manual Release Creation

If you need to create a release without the `/release` command:

1. Update CHANGELOG.md [Unreleased] section
2. Run: `./scripts/release.sh [patch|minor|major]`
3. Follow prompts and push when ready

## Troubleshooting

### Release Notes Not Appearing in GitHub Release

The release notes should come from the annotated git tag. To verify:

```bash
# Check tag annotation
git show v0.42.61

# Should show the release notes
```

If notes are missing, the workflow will fall back to extracting from CHANGELOG.md.

### Build Failed on GitHub Actions

Check the Actions tab in GitHub:
- https://github.com/nimbalyst/nimbalyst/actions

Common issues:
- Code signing certificates expired
- PUBLIC_REPO_PAT token needs renewal
- Dependency installation failed

### Can't Push to Main Branch

Repository has branch protection rules. You need admin access to bypass, or:
- Create a release branch
- Open a PR
- Merge after CI passes

## iOS Release Workflow

iOS uses a separate release process from Electron, with its own versioning, changelog, and git tags.

### Tag Convention

- **Electron**: `v0.55.2` (unchanged)
- **iOS**: `ios/v1.0.2` (platform-prefixed)

### Using /ios-release

Run the `/ios-release` slash command in Claude Code:

```
/ios-release patch    # For bug fixes (1.0.1 -> 1.0.2)
/ios-release minor    # For new features (1.0.1 -> 1.1.0)
/ios-release major    # For breaking changes (1.0.1 -> 2.0.0)
```

This command will:
1. Find commits since last `ios/*` tag touching `packages/ios/` and `packages/runtime/`
2. Generate developer changelog (for `IOS_CHANGELOG.md`) and App Store "What's New" text
3. Update `IOS_CHANGELOG.md` [Unreleased] section
4. Wait for your approval
5. Run `./scripts/ios-release.sh` which bumps Info.plist version + build number, commits, and creates an annotated `ios/v*` tag

### After Tagging

```bash
# Review the changes
git show HEAD
git show ios/v1.0.2

# Push commit and tag
git push origin main
git push origin ios/v1.0.2

# Build and upload
# 1. Open Xcode, select NimbalystApp scheme
# 2. Product > Archive
# 3. Upload to App Store Connect
# 4. Paste the App Store "What's New" text into the version description
```

### Build Number

The build number (`CFBundleVersion`) auto-increments by 1 with each release. It is independent of the marketing version (`CFBundleShortVersionString`). Apple requires the build number to increase monotonically for each upload.

## Files Involved

### Electron
- **CHANGELOG.md**: Release notes history
- **scripts/release.sh**: Release automation script
- **.claude/commands/release-alpha.md**: Claude Code slash command
- **.claude/commands/promote-public-release.md**: Claude Code slash command
- **.github/workflows/electron-build.yml**: CI/CD workflow
- **packages/electron/package.json**: Version number

### iOS
- **IOS_CHANGELOG.md**: iOS release notes history
- **scripts/ios-release.sh**: iOS release automation script
- **.claude/commands/ios-release.md**: Claude Code slash command
- **packages/ios/NimbalystApp/Sources/Info.plist**: Version and build number
