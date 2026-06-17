# GitHub Issues Importer Extension

Import GitHub issues into the Nimbalyst tracker as **native tracker items** that link back to their source. Imported items behave like any other tracker item — they sync across your team, can be re-typed, commented on, and linked to sessions — while remembering where they came from so you can re-snapshot them when the upstream issue changes.

Authentication and repository access go entirely through your installed [GitHub CLI](https://cli.github.com/) (`gh`). No token is ever read or stored by the extension.

## How It Works

1. Open a workspace whose git remote points at a GitHub repository.
2. From the tracker toolbar's **Import** menu, choose **Import from GitHub Issues** (or use the `tracker_import` AI tool).
3. On first use, Nimbalyst prompts you to enable the importer's backend module (it runs native code via `gh`). Approve it for the workspace.
4. The importer derives the target repo from your git remotes, lists open issues via `gh`, and you pick which to import.
5. Each imported issue becomes a native tracker item with its body, labels, status, author, and a source reference back to the GitHub issue.

The import **target (binding)** is derived automatically from the workspace's GitHub git remotes, so the importer is zero-config for any repo opened in Nimbalyst. There is no renderer UI in the extension itself — all behavior lives in the backend module; the host owns the import dialog, source chip, and re-snapshot controls.

## Requirements

- The [GitHub CLI](https://cli.github.com/) (`gh`) installed and on your `PATH`.
- Authenticated: run `gh auth status` to confirm; `gh auth login` if not.
- A workspace with a GitHub `origin` (or other) remote — `git remote -v` should show a `github.com` URL.

## Authentication & Access Model

- **No tokens stored.** The backend shells out to `gh`, which manages its own credentials. The extension never reads or persists a GitHub token.
- **Auth is per user, local.** `gh` runs as the local user. Imported items sync to teammates as native tracker items, but **re-snapshotting** an item requires the acting user to have their own `gh` auth.
- **Backend runs sandboxed.** The privileged work (spawning `gh`) happens in an Electron utility-process backend module, isolated from both the main process and the renderer. It carries a first-use consent gate (see `enablement` in `manifest.json`).

## What Gets Imported

Each GitHub issue maps to a tracker snapshot:

| Tracker field | GitHub source |
|---------------|---------------|
| `title` | issue title |
| `body` | issue body (markdown) |
| `status` | `open` / `closed` state |
| `labels` | issue labels |
| author identity | issue author `login` |
| `urn` | `github://owner/repo#number` |
| source URL | `html_url` |
| upstream timestamps | `created_at` / `updated_at` |

Pull requests are filtered out — the GitHub issues endpoint returns PRs too, and the importer excludes anything with a `pull_request` field.

Issues can be imported as the tracker's `bug`, `task`, or `feature` type (`importsAs` in the manifest). GitHub has no native "feature" concept; importing as `feature` simply files the issue under the tracker's feature type.

## Source Provenance & Re-snapshot

Imported items keep an `origin.external` reference (provider, external id, URN, source URL, and a body hash). This drives host features:

- A **source chip** on the tracker item detail links back to the GitHub issue.
- A **re-snapshot (⟳)** action re-fetches the upstream issue and updates title/status/labels.
- An **upstream-body-changed banner** appears when the remote body diverges from the imported copy, letting you apply or dismiss the change.

Because imported items are native tracker items, an issue imported by one teammate appears for everyone via the encrypted team tracker room without re-importing.

## RPC Methods

The backend module exposes the importer contract the host's `TrackerImporterRegistry` calls. Method keys match `TRACKER_IMPORTER_RPC_METHODS` in the extension SDK:

| Method | Purpose |
|--------|---------|
| `importer.isAuthenticated` | `gh auth status` — is the user logged in? |
| `importer.listBindings` | Derive importable `owner/repo` targets from the workspace git remotes |
| `importer.list` | List issues for a binding (`gh api repos/{repo}/issues`), with state filter, search, and cursor-based paging |
| `importer.fetch` | Fetch a single issue and return a `TrackerSnapshot` for import |

## Configuration

The importer is zero-config. One optional environment variable overrides the default (used mainly for testing):

| Variable | Default | Effect |
|----------|---------|--------|
| `NIMBALYST_GH_PATH` | `gh` | Path to the GitHub CLI binary |

The backend augments `PATH` with common install locations (`/usr/local/bin`, `/opt/homebrew/bin`, `~/.local/bin`, and the Windows equivalents) because Electron's GUI-launch `PATH` often omits them.

## Building

```bash
cd packages/extensions/github-issues-importer
npm run build      # builds both the inert renderer entry and the backend module
```

`npm run build` runs two Vite passes:

- `vite build` — `src/index.ts` → `dist/index.js` (inert renderer `main`; the manifest requires one)
- `vite build --config vite.backend.config.ts` — `src/backend.ts` → `dist/backend.js` (the utility-process backend)

Other scripts: `npm run dev` (watch build), `npm run typecheck`.

## Architecture

```
src/
  index.ts           # Inert renderer entry (no UI surface in v1; manifest requires a main)
  backend.ts         # Utility-process backend: gh spawning + importer.* RPC methods
  __tests__/
    backend.test.ts  # Remote parsing, externalId/URN round-trips, list/fetch shaping
manifest.json        # trackerImporters + backendModules contributions
vite.config.ts             # renderer entry build
vite.backend.config.ts     # backend module build
```

### Manifest Contributions

- **`trackerImporters`** — declares the `github-issues` importer: display name, icon, `urnScheme: "github"`, the `importsAs` types, and which backend module fulfills it.
- **`backendModules`** — declares `github-issues-backend` as a `utility-process` module, disabled by default with a `firstUse` consent prompt explaining it reads GitHub issues via your installed `gh`.

### Execution Flow

1. The host discovers the importer from the manifest and registers it (no backend started yet).
2. On first import, the host prompts for backend consent; once granted it persists for the workspace.
3. The host calls `importer.listBindings` → repos derived from `git remote -v`.
4. `importer.list` pages through `gh api repos/{repo}/issues` (PRs excluded, sorted by recently updated).
5. The user selects issues; `importer.fetch` returns a `TrackerSnapshot` per issue.
6. The **host** turns each snapshot into a native tracker item (`source='native'`, provenance in `data.origin.external`) and seeds the collaborative body Y.Doc.

## License

Part of Nimbalyst. Authored by Nimbalyst.
