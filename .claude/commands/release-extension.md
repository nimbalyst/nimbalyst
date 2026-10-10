---
description: Release a new version of a marketplace extension
---
**Arguments**: `$ARGUMENTS`

Release a new version of a Nimbalyst marketplace extension. Handles version bumping, building, registry generation, and publishing to the CDN.

## Argument Parsing

`$ARGUMENTS` may contain:
- **Extension name or path** (optional): Either a folder name in `packages/extensions/` (e.g., `csv-spreadsheet`, `excalidraw`) or an absolute path to an extension outside the monorepo (e.g., `/Users/ghinkle/sources/nimbalyst-mindmap`)
- **Bump type** (optional, default `patch`): `patch`, `minor`, or `major`

**If no extension name/path is given, run [Detect Mode](#detect-mode-no-arguments) first** to find which extensions have changed since their last publish, then release the ones the user picks.

Examples:
- `/release-extension` -- scan all extensions, report which need re-publishing, let the user choose
- `/release-extension csv-spreadsheet` -- patch bump csv-spreadsheet
- `/release-extension excalidraw minor` -- minor bump excalidraw
- `/release-extension /Users/ghinkle/sources/nimbalyst-mindmap patch` -- patch bump external mindmap extension

## Detect Mode (no arguments)

Goal: find every extension whose source has changed since it was last pushed to the marketplace, so the user doesn't have to remember.

### D1. Run the status report

```bash
pnpm run marketplace:status
```

This does the whole comparison -- do NOT hand-roll it with `curl` and `git log`. It reads `packages/marketplace/release-extensions.txt`, resolves each extension's `manifest.json`, fetches the live registry, and for anything declaring a collaborative editor it also downloads the **published bundle** and compares its `collaboration` declarations against the local manifest.

Statuses it emits:

- **`publish (already bumped)`** -- local version is ahead of the registry. Skip the bump; just build, package, and publish.
- **`bump+publish`** -- versions match but the extension's own source changed since the version was set (committed or uncommitted; manifest-only changes are ignored, since a pending bump is the release itself).
- **`bump+publish (collab drift)`** -- the shipped bundle's collaboration declaration disagrees with the local manifest. When the published side says `true` and local says `false`, users are being offered a share path that was deliberately withdrawn -- treat as urgent.
- **`never published`** -- not in the registry at all. First release.
- **`LOCAL BEHIND LIVE`** -- unusual; flag it rather than publishing over a newer build.

Notes:
- An extension's `package.json` `version` is NOT maintained in this repo. `manifest.json` is the only source of truth -- never "fix" a package.json to match.
- Add `--no-bundles` to skip the published-bundle downloads when you only need version comparison.
- `pnpm --dir packages/marketplace run status:check` exits non-zero when anything needs shipping (for CI).

### D2. Present the results and let the user choose

Show a table: extension name, id, local version, live version, status. List only extensions needing action (`publish`, `bump+publish`, `missing`) prominently; summarize the `up-to-date` count.

Then use `AskUserQuestion` (or `PromptForUserInput` multiSelect if several qualify) to let the user pick which extensions to release and confirm the bump type for each `bump+publish` one (default `patch`).

### D3. Release each chosen extension

For each selected extension, run the standard [Workflow](#workflow) below (steps 1-10). For `publish (already bumped)` extensions, **skip the version bump (step 3)** -- the version is already set; just build, package, regenerate the registry, and publish. For `bump+publish` extensions, do the full flow including the bump. Regenerate the registry once after all packaging (generate-registry.sh rescans the whole dist/ dir either way), then publish once, then verify and update the bundled fallback.

## Workflow

### 1. Resolve the extension path

If the argument is a simple name (no `/`), resolve it to `packages/extensions/{name}/`. Otherwise use the path as-is.

Verify `manifest.json` exists at the resolved path. If not, list available extensions and ask the user which one they meant.

### 2. Read current state

Read `manifest.json` and display:
- Extension ID, name, current version
- Whether it has a build step (`package.json` with `scripts.build`)
- Whether it has marketplace metadata (`manifest.marketplace`)

### 3. Bump the version

Bump the `version` field in `manifest.json` according to the bump type (patch/minor/major). Use semver rules:
- patch: `1.2.3` -> `1.2.4`
- minor: `1.2.3` -> `1.3.0`
- major: `1.2.3` -> `2.0.0`

Also update `manifest.marketplace.changelog` if present -- prepend a new entry for the new version. Ask the user what changed to write the changelog entry.

### 4. Build the extension

If the extension has a `package.json` with a `build` script:
```bash
cd {extension-path} && pnpm install && pnpm run build
```

Verify that `dist/` exists after the build.

### 5. Package as .nimext

Run the build-extension script from the marketplace package:
```bash
cd packages/marketplace && ./scripts/build-extension.sh {extension-path}
```

This creates a `.nimext` zip in `packages/marketplace/dist/` with a `.sha256` checksum file.

### 6. Generate the registry

```bash
cd packages/marketplace && ./scripts/generate-registry.sh
```

This regenerates `packages/marketplace/dist/registry.json` from all `.nimext` files in the dist directory. `dist/` accumulates one file per release, so older builds of the same id are still sitting there; the script keeps the highest version per id and prints a `Superseded:` line for each one it drops. If you see an unexpected `Superseded:` line, stop -- it means a version you just built lost to a higher one already in `dist/`.

### 7. Show summary and confirm

Display:
- Extension name and new version
- Package file path and size
- Checksum
- Ask user to confirm before publishing to production

### 8. Publish to R2

After user confirmation:
```bash
cd packages/marketplace && ./scripts/publish-extensions.sh --env production
```

### 9. Verify

**Verify the shipped bundle, not just the registry entry.** The registry is metadata the generator wrote; it can say 1.0.3 while the archive behind that URL is missing the change you just made. Download what a user would download and look inside it:

```bash
curl -sL https://extensions.nimbalyst.com/dl/{extension-id}/{new-version} -o /tmp/verify.nimext
shasum -a 256 /tmp/verify.nimext        # must equal the checksum from step 5
unzip -p /tmp/verify.nimext manifest.json | node -p "
  const m = JSON.parse(require('fs').readFileSync(0, 'utf8'));
  m.id + ' v' + m.version + '  editors: ' + JSON.stringify(
    (m.contributions?.customEditors || []).map(e => [e.filePatterns, e.collaboration?.supported]))
"
```

Confirm the version, the checksum match, and -- for a collaborative editor -- that `collaboration.supported` is what you expect. A shared document silently fails to open for every recipient when that flag is missing from the shipped bundle.

Then re-run `pnpm run marketplace:status` and confirm the extension no longer appears under "Needs shipping".

### 10. Update the bundled mock registry

Copy the generated `registry.json` over the bundled fallback:
```bash
cp packages/marketplace/dist/registry.json packages/electron/src/main/data/extensionRegistry.json
```

This ensures the app has a recent fallback if the live registry is unreachable.

### 11. Done

Report:
- Extension name, old version -> new version
- CDN URL for the .nimext package
- Remind user that installed clients will auto-update on next launch
- Note: changes to `manifest.json`, `extensionRegistry.json`, and `packages/marketplace/dist/` are uncommitted -- ask if they want to commit
