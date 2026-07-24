# Alpha Release Channel Setup Guide

This document describes the current alpha-channel release flow and the temporary migration bridge from Cloudflare R2 to GitHub pre-releases.

## Overview

The alpha channel now uses **published GitHub pre-releases**:
- Tag push builds all desktop artifacts and publishes a visible GitHub pre-release.
- Users who opt into `releaseChannel=alpha` receive updates from GitHub Releases by reading `alpha*.yml`.
- Stable users still read `latest*.yml` from the latest non-prerelease release.

During the migration, the workflow can also upload the same assets to the legacy R2 bucket so older alpha installs that still point at R2 can pull one transition build and move onto GitHub.

## In-App Channel Behavior

Users opt into alpha in the app via the hidden release-channel control:
1. Open Global Settings.
2. Go to Advanced Settings.
3. Command-click (macOS) or Ctrl-click (Windows/Linux) the "Advanced Settings" title.
4. Select `Alpha (Internal Testing)`.
5. Save and restart.

At startup, the app should log:
- Alpha: `Configuring alpha channel updates from GitHub prereleases`
- Stable: `Configuring stable channel updates from GitHub releases`

## GitHub Release Flow

### Alpha pre-release

Push a tag such as `v0.58.22`.

Result:
- A GitHub release is created automatically for that tag
- The release is published immediately
- The release is marked as a **pre-release**
- Assets include both `latest*.yml` and `alpha*.yml`

Alpha users discover that release through GitHub’s public releases feed plus the `alpha*.yml` assets.

### Stable promotion

After validating the alpha build, re-run `.github/workflows/electron-build.yml` for the same tag with:
- `release=true`
- `create_github_release=true`

Result:
- The existing GitHub release for that tag is updated
- The pre-release flag is cleared
- Stable users now see it as the latest release

## Transition Bridge for Existing Alpha Installs

Older alpha builds still point at:
- `https://pub-4357a3345db7463580090984c0e4e2ba.r2.dev/`

Those installs need exactly one transition build from R2 so they can install a version whose updater already points at GitHub.

The workflow-level switch:
- `LEGACY_ALPHA_TRANSITION_R2_UPLOAD`

controls that bridge. Keep it set to `'true'` for the transition release only. After that release is published and confirmed, set it to `'false'` or remove the R2 upload step entirely.

## R2 Secrets

R2 secrets are only needed while the transition bridge remains enabled:
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `CLOUDFLARE_ACCOUNT_ID`

If the bridge is disabled permanently, these secrets are no longer required for alpha distribution.

## Verification Checklist

### Verify alpha release assets

For a newly tagged release, check:
1. A GitHub release exists for the tag.
2. It is marked as a pre-release.
3. Assets include:
   - `alpha-mac.yml`
   - `alpha.yml`
   - `alpha-linux.yml`
   - `latest-mac.yml`
   - `latest.yml`
   - `latest-linux.yml`

### Verify alpha client behavior

1. Switch the app to `Alpha (Internal Testing)`.
2. Restart the app.
3. Confirm the log line says GitHub prereleases are configured.
4. Run Help → Check for Updates.
5. Confirm the app finds the tagged pre-release.

### Verify stable promotion

1. Re-run the workflow for the same tag with `create_github_release=true`.
2. Confirm the GitHub release is no longer marked as a pre-release.
3. On a stable-channel install, run Help → Check for Updates.
4. Confirm the app finds the promoted stable release.

### Verify the transition bridge

Only while `LEGACY_ALPHA_TRANSITION_R2_UPLOAD='true'`:
1. Check the workflow log for `Uploaded transition assets to the legacy R2 alpha channel`.
2. Verify the R2 bucket still contains `latest*.yml` plus release binaries.
3. Use an older alpha install and confirm it can update once from R2 onto the transition build.

## Troubleshooting

### Alpha install says no update is available

Check:
- The GitHub release is published, not just created locally in CI
- The release is marked as a pre-release
- `alpha*.yml` assets are attached to the release
- The app log says `Configuring alpha channel updates from GitHub prereleases`

### Stable install sees the alpha build

Check:
- The release is still marked as a pre-release and has not yet been promoted
- The stable install log says `Configuring stable channel updates from GitHub releases`

### Legacy alpha install never migrates

Check:
- The transition build was uploaded to R2 while `LEGACY_ALPHA_TRANSITION_R2_UPLOAD='true'`
- The R2 bucket still serves `latest-mac.yml`, `latest.yml`, and `latest-linux.yml`
- The legacy install actually launched and checked for updates after the transition release was published
