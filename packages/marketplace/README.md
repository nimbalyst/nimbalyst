# Nimbalyst Extension Marketplace

Cloudflare Worker that serves the extension registry and routes downloads to the CDN.

## Architecture

```
Electron App                         Cloudflare
    |                                    |
    |-- GET /registry ---------> Worker (reads R2, injects KV download counts, 5 min cache)
    |                                    |
    |-- GET /dl/:id/:ver ------> Worker (HEAD check R2, increment KV count, 302 -> CDN)
    |                                    |
    |-- GET /screenshots/:id --> Worker (302 -> CDN)
    |                                    |
    |                            cdn.extensions.nimbalyst.com (R2 public bucket)
    |                                    |
    |<--- .nimext zip, screenshots ------+
```

The Worker never streams file bytes. Downloads and screenshots are served directly from the R2 public bucket (`cdn.extensions.nimbalyst.com`). The Worker only handles:

- **`/registry`** -- Reads `registry.json` from R2 and injects live download counts from KV before returning it. Cached via the Cloudflare Cache API for 5 minutes.
- **`/dl/:id/:version`** -- Verifies the `.nimext` exists (HEAD), increments the KV download counter, then returns a 302 redirect to the CDN URL.
- **`/screenshots/:id/:filename`** -- Returns a 302 redirect to the CDN URL.
- **`/health`** -- Returns Worker version and status.

## R2 Bucket Layout

```
nimbalyst-extensions/
  registry.json                              # Generated registry
  extensions/{id}/{version}.nimext           # Extension packages
  screenshots/{id}/{filename}.png            # Extension screenshots
```

## Extension Package Format (.nimext)

A `.nimext` file is a zip containing:

```
manifest.json        # Standard Nimbalyst extension manifest (required)
dist/                # Built extension bundle (JS, CSS, assets)
screenshots/         # Screenshots captured by the pipeline
README.md            # Optional
```

## Manifest Marketplace Fields

Extensions declare marketplace metadata in their `manifest.json`:

```json
{
  "id": "com.nimbalyst.csv-spreadsheet",
  "name": "CSV Spreadsheet",
  "version": "1.2.0",
  "marketplace": {
    "categories": ["data"],
    "tags": ["csv", "spreadsheet", "data"],
    "icon": "table_chart",
    "featured": true,
    "repositoryUrl": "https://github.com/nimbalyst/csv-spreadsheet",
    "changelog": "1.2.0: Added formula support",
    "screenshots": [
      {
        "alt": "CSV editor with formula bar",
        "fileToOpen": "samples/demo.csv"
      }
    ]
  }
}
```

The `screenshots` array tells the Playwright screenshot pipeline which sample files to open and capture. See `packages/electron/marketing/specs/extension-screenshots.spec.ts`.

## Scripts

All scripts are in `scripts/` and are meant to be run from the `packages/marketplace/` directory.

### Build a single extension

```bash
./scripts/build-extension.sh ../../extensions/csv-spreadsheet
```

Runs the extension's build step, zips it into a `.nimext` file in `dist/`, and writes a `.sha256` checksum file alongside it.

### Build all extensions

```bash
./scripts/build-all-extensions.sh
```

Builds the curated release set listed in `release-extensions.txt`. That file is the source of truth for which extensions are public right now, including external extension repos that live alongside the monorepo. The script clears stale `.nimext` packages and `registry.json` from `dist/` before rebuilding.

Each line in `release-extensions.txt` is a path relative to `packages/marketplace/`. Append `|skip-build` for external repos that should package their checked-in `dist/` output instead of running a local build, for example:

```text
../extensions/csv-spreadsheet
../../../nimbalyst-mindmap|skip-build
```

### Generate the registry

```bash
./scripts/generate-registry.sh
```

Reads each `.nimext` in `dist/`, extracts the manifest, and generates `dist/registry.json` with download URLs, screenshot URLs, and checksums pointing at `extensions.nimbalyst.com`.

### Publish to R2

```bash
./scripts/publish-extensions.sh --env production
```

Uploads all `.nimext` files, screenshots, and `registry.json` to the R2 bucket using `wrangler r2 object put`.

### Full publish pipeline

```bash
./scripts/build-all-extensions.sh
./scripts/generate-registry.sh
./scripts/publish-extensions.sh --env production
```

### Capture marketplace screenshots

Requires the Nimbalyst dev server running (`cd packages/electron && npm run dev`):

```bash
cd packages/electron
npm run marketing:screenshots:grep -- "extension-"
```

This runs the Playwright spec at `marketing/specs/extension-screenshots.spec.ts`, which reads each extension's `marketplace.screenshots` from its manifest, opens the sample files, and captures dark/light theme screenshots into the extension's `screenshots/` directory.

## Deploying the Worker

```bash
# Staging
npm run deploy:staging

# Production (bumps version automatically)
npm run deploy:production
```

The deploy script bumps the version in `package.json`, passes it to the Worker as a build-time define, and runs `wrangler deploy`.

## Cloudflare account isolation

This Worker deploys to the **Nimbalyst** Cloudflare account
(`454b0e55f2d7f9abc0d52d4217ecdc3c`). Every npm script and shell script
that shells out to wrangler sets:

```
XDG_CONFIG_HOME="$HOME/.config/nimbalyst"
```

Wrangler reads its OAuth tokens from `~/.config/nimbalyst/.wrangler/`,
isolated from any other Cloudflare accounts on this machine. The same
`XDG_CONFIG_HOME` is reused by `packages/collabv3` and
`packages/collabv3-metrics` so one `npm run login` covers all three.

Always go through the npm scripts. Running `wrangler` directly from the
shell will use the default config dir and may pick a different account.

```bash
npm run login        # one-time: sign in to the Nimbalyst account
npm run whoami       # sanity-check the active account
npm run wrangler -- <subcommand>   # any unaliased wrangler command
```

## Infrastructure Setup (one-time)

These steps create the Cloudflare resources referenced in `wrangler.toml`.

### 1. Create the R2 bucket

```bash
wrangler r2 bucket create nimbalyst-extensions
```

Then enable public access and attach the custom domain `cdn.extensions.nimbalyst.com` in the Cloudflare dashboard under R2 > nimbalyst-extensions > Settings > Public Access.

### 2. Create the KV namespace

```bash
wrangler kv namespace create DOWNLOAD_COUNTS
```

Copy the output ID into `wrangler.toml` replacing the placeholder values for each environment.

### 3. Set up the custom domain

In the Cloudflare dashboard, add a DNS record for `extensions.nimbalyst.com` and configure it as the Worker custom domain (already declared in `wrangler.toml` routes).

### 4. Set up the CDN domain

Add a DNS record for `cdn.extensions.nimbalyst.com` pointing at the R2 bucket's public access hostname. This is where `.nimext` files and screenshots are served directly without going through the Worker.

## How the Electron Client Uses This

The client code is in `packages/electron/src/main/ipc/ExtensionMarketplaceHandlers.ts`.

1. **Registry fetch** -- `net.fetch('https://extensions.nimbalyst.com/registry')`. Falls back to a bundled mock registry if the live endpoint is unreachable.
2. **Install** -- Downloads the `.nimext` from the `downloadUrl` in the registry entry (which points to `/dl/:id/:version`, which 302s to CDN). Verifies the SHA-256 checksum. Extracts with `extract-zip` to `~/.nimbalyst/extensions/{id}/`.
3. **Screenshots** -- Displayed in the marketplace detail modal. URLs point to `/screenshots/:id/:filename` which 302s to CDN.

The marketplace is gated behind an alpha feature flag (`marketplace` in `alphaFeatures.ts`) and requires users to accept a security warning before browsing.

## Reviewing Extensions for the Marketplace

Before publishing a new extension to the registry:

1. **Check the manifest** -- Verify `id`, `name`, `version`, `description`, `author` are accurate. Check that `permissions` only requests what is needed (`filesystem`, `ai`, `network`).
2. **Review the code** -- Extensions execute in the renderer process with access to the Nimbalyst extension API. Look for:
  - Unexpected network calls (especially if `permissions.network` is not declared)
  - File system access outside the workspace (if `permissions.filesystem` is declared)
  - Malicious or obfuscated code in `dist/`
  - Dependencies with known vulnerabilities
3. **Build and test locally** -- Install via the "Install from GitHub" flow in the marketplace panel and verify the extension loads, renders correctly, and does what it claims.
4. **Verify screenshots** -- Run the screenshot pipeline to ensure the screenshots accurately represent the extension.
5. **Check the \****`.nimext`**\*\* package** -- Unzip it and verify it only contains `manifest.json`, `dist/`, `screenshots/`, and optionally `README.md`. No source code, `.env` files, or credentials should be included.
6. **Publish** -- Run the build + generate + publish pipeline described above.
