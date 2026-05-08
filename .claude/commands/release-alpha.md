---
description: Prepare and execute an alpha release (patch/minor/major)
---
**Arguments**: `{{arg1}}`
- First word: release type (`patch`, `minor`, `major`)
- If second word is `auto`: skip approval prompts and automatically push `main` and the release tag

Prepare an alpha release following this workflow.

## AUTO MODE DETECTION

If `{{arg1}}` contains `auto` (for example `patch auto`), run the full process without stopping for approval:
1. Find the last **successful** alpha release build.
2. Collect all commits since that successful release.
3. Generate two note sets:
   - developer changelog notes for `CHANGELOG.md`
   - public-facing draft notes for later use with `/promote-public-release`
4. Update `CHANGELOG.md`.
5. Run `./scripts/release.sh [type]`.
6. Push `main` and the new `v*` tag automatically.
7. Monitor the GitHub Actions release build until it completes.
8. On success, show the public draft notes for reference.

Otherwise, follow the interactive workflow below.

## MONITOR THE BUILD (auto mode)

After pushing the tag, babysit the run instead of handing it back to the user:

1. Find the run ID for the tag that was just pushed:
   ```bash
   gh run list --limit=5 --json databaseId,headBranch,status,conclusion,event \
     | jq '[.[] | select(.event == "push" and .headBranch == "v[VERSION]")][0]'
   ```
2. Watch the run to completion:
   ```bash
   gh run watch [RUN_ID] --exit-status --interval 30
   ```
3. On success, announce that the alpha release shipped and show the public draft notes.
4. On failure:
   - Pull failed logs: `gh run view [RUN_ID] --log-failed`
   - Diagnose the root cause and fix it on `main`
   - Re-run `/release-alpha patch auto`

Do **not** run `/promote-public-release` until the alpha prerelease build is green.

## ALPHA RELEASE WORKFLOW

1. **Find the last successful alpha release**:
   - Run:
     ```bash
     gh run list --limit=20 --json headBranch,conclusion,displayTitle,event \
       | jq '[.[] | select(.event == "push" and (.headBranch | startswith("v0.")))]'
     ```
   - Find the most recent tag where `conclusion == "success"`.
   - Use commits since that successful tag:
     ```bash
     git log [successful-tag]..HEAD --oneline
     ```

2. **Generate release notes**:
   - Create two versions:

   **A. Developer changelog notes (for `CHANGELOG.md`)**
   - Include all meaningful changes.
   - Technical language is fine.
   - Categorize as `Added`, `Changed`, `Fixed`, `Removed`.

   **B. Public release draft notes (for `/promote-public-release`)**
   - Only include user-facing changes.
   - Use user-friendly, product-facing language.
   - Answer "what can I now do?" or "what problem is fixed?"
   - Exclude internal refactors, tooling changes, and non-user-visible maintenance.

3. **Update `CHANGELOG.md`**:
   - Add the developer notes to `[Unreleased]`.
   - Use the standard `###` section headings.
   - Only include categories that actually have entries.

4. **Show both versions to the user**:
   - Display the developer changelog block.
   - Display the public draft notes separately.
   - Ask for approval before proceeding.

5. **Execute the alpha release**:
   - Run:
     ```bash
     ./scripts/release.sh [type]
     ```
   - The script will:
     - bump `packages/electron/package.json`
     - update `package-lock.json`
     - move `[Unreleased]` into a new versioned section
     - create the release commit
     - create the annotated `v*` tag

6. **Push `main` and the tag**:
   - Push:
     ```bash
     git push origin main
     git push origin v[VERSION]
     ```
   - Provide the Actions URL:
     `https://github.com/nimbalyst/nimbalyst/actions`

7. **Done**:
   - Remind the user that the tag push publishes a GitHub prerelease for alpha users.
   - Show the public draft notes for later refinement with `/promote-public-release`.

Valid release types: `patch`, `minor`, `major`

Example `CHANGELOG.md` format:
```markdown
## [Unreleased]

### Added
- New AI model support for GPT-4o

### Fixed
- Fixed crash when opening large files
- Fixed memory leak in file watcher

## [0.42.60] - 2025-10-30
...
```
