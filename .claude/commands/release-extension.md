---
description: Release a new version of a marketplace extension
---
**Arguments**: `$ARGUMENTS`

Release a new version of a Nimbalyst marketplace extension. Handles version bumping, building, registry generation, and publishing to the CDN.

## Argument Parsing

`$ARGUMENTS` should contain:
- **Extension name or path** (required): Either a folder name in `packages/extensions/` (e.g., `csv-spreadsheet`, `excalidraw`) or an absolute path to an extension outside the monorepo (e.g., `/Users/ghinkle/sources/nimbalyst-mindmap`)
- **Bump type** (optional, default `patch`): `patch`, `minor`, or `major`

Examples:
- `/release-extension csv-spreadsheet` -- patch bump csv-spreadsheet
- `/release-extension excalidraw minor` -- minor bump excalidraw
- `/release-extension /Users/ghinkle/sources/nimbalyst-mindmap patch` -- patch bump external mindmap extension

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
cd {extension-path} && npm install && npm run build
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

This regenerates `packages/marketplace/dist/registry.json` from all `.nimext` files in the dist directory.

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

Fetch the live registry to confirm the new version is present:
```bash
curl -s https://extensions.nimbalyst.com/registry | node -e "
  const data = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf8'));
  const ext = data.extensions.find(e => e.id === '{extension-id}');
  if (ext) console.log(ext.id + ' v' + ext.version + ' -- live');
  else console.log('NOT FOUND in registry');
"
```

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
