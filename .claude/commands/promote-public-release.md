---
description: Build, refine, and publish cumulative public release notes, then promote the current alpha prerelease to stable
---
Promote the current GitHub alpha prerelease to the public stable release.

This command's main job is to build the **proper cumulative public release notes** covering everything since the last stable public release, let the user edit them, then use the final text to update the existing GitHub release before making it public.

## Contract: `PUBLIC_RELEASE_NOTES.md` is regenerated every run

Every invocation of `/promote-public-release` overwrites `PUBLIC_RELEASE_NOTES.md` from scratch.

The expected workflow is:
1. Generate a fresh cumulative draft from `CHANGELOG.md`.
2. Let the user edit that file directly.
3. Re-read exactly what is on disk.
4. Commit the file for repository history.
5. Update the existing GitHub release notes from that file.
6. Clear the prerelease flag on the existing release.

Do **not** merge with old `PUBLIC_RELEASE_NOTES.md` content. Always rebuild it from scratch.

## PHASE 1: COLLECT RELEASE CONTEXT

1. **Get the version being promoted**:
   ```bash
   git describe --tags --abbrev=0
   ```
   This should be the current `v*` tag to promote.

2. **Inspect the existing GitHub release for that tag**:
   ```bash
   gh release view [VERSION] --json name,url,isPrerelease,isDraft
   ```
   Expectations:
   - the release already exists
   - `isPrerelease` should be `true`
   - `isDraft` should be `false`

   If the release does not exist, stop and tell the user the alpha prerelease has not been published yet.

3. **Find the last stable public release before the current tag**:
   ```bash
   gh release list --limit 50 --json tagName,isPrerelease,isDraft,publishedAt \
     | jq '[.[] | select(.isDraft == false and .isPrerelease == false and .tagName != "[VERSION]")] | sort_by(.publishedAt) | reverse | .[0]'
   ```
   Extract that `tagName`. This is the lower bound for cumulative notes.

   If there is no prior stable release, tell the user this is the first public stable release and use all release sections up to `[VERSION]`.

4. **Display the promotion summary and overwrite warning**:
   Show the user:
   - `Version to promote: [VERSION]`
   - `Current GitHub release: prerelease`
   - `Last stable public release: [LAST_PUBLIC_VERSION]` or `none`
   - A warning that `PUBLIC_RELEASE_NOTES.md` will be overwritten with a fresh cumulative draft

## PHASE 2: BUILD CUMULATIVE PUBLIC RELEASE NOTES

1. **Read `CHANGELOG.md` and extract cumulative notes**:
   - Include every release section after `[LAST_PUBLIC_VERSION]` through `[VERSION]`, inclusive.
   - Pull from `Added`, `Changed`, and `Fixed`.
   - Skip `Removed` unless it reflects a user-visible change that belongs in public notes.

2. **Transform into public-facing notes**:
   - Rewrite into concise user-facing language.
   - Group into:
     - `### New Features`
     - `### Improvements`
     - `### Fixed`
   - Remove internal-only items:
     - type fixes
     - refactors
     - tooling/CI
     - developer-only maintenance
   - Keep the notes cumulative across releases since the last stable public release.

3. **Overwrite `PUBLIC_RELEASE_NOTES.md`**:
   - Replace the file contents entirely with the new draft.
   - The file should be a clean public release-notes draft, not a changelog dump.

4. **Stop for user edits**:
   Tell the user:
   > I rebuilt `PUBLIC_RELEASE_NOTES.md` from `CHANGELOG.md` covering `[LAST_PUBLIC_VERSION] -> [VERSION]`. Please edit it directly. Tighten language, remove anything you don't want public, and adjust the framing. Tell me when you're ready and I'll publish exactly what is on disk.

   Do **not** proceed until the user confirms readiness.

## PHASE 3: COMMIT THE FINAL NOTES

1. **Re-read `PUBLIC_RELEASE_NOTES.md`** so you publish exactly what is on disk after the user's edits.

2. **Commit the file**:
   ```bash
   git add PUBLIC_RELEASE_NOTES.md
   git commit -m "docs: public release notes for [VERSION]"
   git push origin main
   ```

   If the user prefers not to commit yet, ask before skipping this step. The default is to commit it.

## PHASE 4: UPDATE THE EXISTING GITHUB RELEASE AND PROMOTE IT

1. **Update the GitHub release notes from the edited file**:
   ```bash
   gh release edit [VERSION] --notes-file PUBLIC_RELEASE_NOTES.md
   ```

2. **Promote the existing prerelease to stable**:
   ```bash
   gh release edit [VERSION] --prerelease=false
   ```

3. **Verify the result**:
   ```bash
   gh release view [VERSION] --json url,isPrerelease,isDraft
   ```
   Confirm:
   - `isPrerelease` is now `false`
   - `isDraft` is `false`

4. **Confirm to the user**:
   - Show the release URL
   - State that the alpha prerelease is now the public stable release

## Example Usage

```text
User: /promote-public-release
Assistant:
- Finds current tag
- Finds the previous stable public release
- Rebuilds PUBLIC_RELEASE_NOTES.md cumulatively across those releases
- Waits for edits
- Commits the final file
- Updates the GitHub release notes
- Clears the prerelease flag
```
