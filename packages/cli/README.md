# nim — Nimbalyst companion CLI

`nim` drives Nimbalyst's tracker system from the terminal — list, get, and show
tracker items (bugs, tasks, decisions, imported records) without opening the
desktop app. It mirrors the semantics of Nimbalyst's tracker MCP tools so a
terminal agent works the way an agent inside Nimbalyst does.

> Status: **Phases 1–3 complete**. Tracker reads; create/update/comment/archive/
> link-session and `types define|rm` (live mode → WriteCoordinator + collab sync,
> plus **guarded offline direct writes** when the app is closed); and importers
> (`importers`, `import search`, `import <id>`, `import resnapshot`) in live mode.
> Only Phase 4 polish (`--jq`/`--template`, config file, shell completions, npm
> prebuilt-binary publishing) remains.

## Two access modes behind one interface

- **Live mode** — talks to a *running* Nimbalyst over its loopback MCP-HTTP
  server (reads reflect in-app state). Discovered via the endpoint descriptor the
  app writes at startup (`<userData>/mcp-endpoint.json`, mode 0600).
- **Direct mode** — opens the better-sqlite3 file directly when the app is not
  running. Reads use a **read-only** handle (safe even while the app is live,
  thanks to WAL). **Writes** open a writable WAL handle and run inside
  `BEGIN IMMEDIATE … COMMIT`, but only when no live app owns the DB — if the
  endpoint descriptor shows a running app on the default DB, every write is
  refused (exit 5) so the CLI never races the app's writer. Offline mutations of
  sync-eligible items set `sync_status='pending'`; the app drains them on next
  launch through its normal sync backfill.

The CLI auto-detects: it tries live discovery first and falls back to direct.
`--live` / `--offline` force a mode; `--db <file>` points at a specific database.

## Usage

```
nim <noun> <verb> [--flags]

nim status
nim workspace list
nim tracker ready --type bug
nim tracker list --type bug --status open --priority high --since 1d --limit 20
nim tracker list --where severity=critical --where tags~auth --json
nim tracker get  NIM-123
nim tracker get  github://owner/repo#42
nim tracker show NIM-123          # pretty body render
nim tracker types [show <type>]
nim session list                  # read-only (v1)
nim doc list / nim doc get <path> # read-only (v1)

# Writes (live mode — a running Nimbalyst)
nim tracker create bug "Login times out" --status to-do --priority high \
    --tag auth --field severity=critical --body-file repro.md
nim tracker update NIM-123 --status in-review --unset owner
nim tracker comment NIM-123 "Repro confirmed"
nim tracker archive NIM-123 / nim tracker unarchive NIM-123
nim tracker link-session NIM-123 [--session <id>]   # live only
nim tracker types define -f bug.yaml / nim tracker types rm bug

# Importers (live mode only — backends are hosted by the running app)
nim tracker importers
nim tracker import search github-issues --repo owner/repo --state open --search login --limit 20
nim tracker import github-issues "owner/repo#42" --type bug
nim tracker import resnapshot github://owner/repo#42
```

> In **live mode** writes route through the app's existing tracker MCP tools, so a
> CLI-written change is identical to an in-app one (validation, activity, sync).
> `--field` only persists schema-declared fields (the app validates against the
> type), and comments on synced trackers follow the app's normal sync
> reconciliation. In **offline (direct) mode** writes are shaped to match those
> handlers and cover native items only (file-backed inline/frontmatter items
> refuse, exit 5). Custom types that remap roles (e.g. `roles.title='name'`) are
> resolved offline by reading the app-materialized `tracker_type_defs` table;
> types the app hasn't materialized fall back to default field names.
> `link-session` and `types define|rm` are live-only.

### Filters

- `--type`, `--type-tag`, `--priority`, `--owner me|<o>`, `--search`
- `--status open|closed|<status>` — `open`/`closed` resolve against the set of
  terminal statuses (done/closed/completed/resolved/rejected/…).
- `--since` / `--until` — relative (`1d`, `2w`, `3h`) or absolute (`2026-06-01`);
  `--date-field created` switches off the default `updated`.
- `--where field<op>value` (repeatable) — ops `=`, `!=`, `~` (contains),
  `=in:a,b,c`.
- `nim tracker ready` is the preset for `nim tracker list --where readiness=ready`.
- `--limit <n>` / `--all`, `--archived`.

### Output

- TTY default: a compact, colored table.
- `--json` — the canonical `TrackerRecord` (the stable agent contract).
- `--csv` + `--columns a,b,c` — tabular export.
- `--quiet`/`-q` — ids only. `--no-color` (also honors `NO_COLOR` / non-TTY).

### Exit codes

`0` ok · `1` not found · `2` usage · `3` connection (incl. importers in offline
mode) · `4` schema-incompatible · `5` write-not-permitted (a live app owns the
DB, or a live-only command in offline mode). `6` is retired. `7` conflict (`nim wiki write --expected-version` on a page that changed).

### Env

`NIM_DB`, `NIM_WORKSPACE`, `NIM_ENDPOINT` + `NIM_TOKEN` (force live), `NIM_OWNER`
(resolves `--owner me`), `NO_COLOR`, `NIM_DEBUG` (stack traces).

## Wiki

For what the wiki is and how to use it from Claude Code, the app and the browser, see the [Nimbalyst Wiki README](../../plugins/nimbalyst-wiki/README.md).

`nim wiki` works on two wikis: the project's local wiki (files in the repository, no account) and its team project's wiki on the sync server. `init` and `write` are local only; `status`, `edit`, `create`, `items` and the other team verbs below are team only. `list` (or `ls`), `read`, `move` and `search` use the local wiki when the project has one, and the team wiki otherwise or when the call names a team target (a `collab://` uri, a console link, `--repo`, or `--org` with `--project`). `--team` or `--local` forces either one.

### Team wiki

The team commands work on a Nimbalyst team project's Wiki on the sync server with your Nimbalyst Teams sign-in, not through a running Nimbalyst app. Each one calls the same wiki tool a terminal agent uses through the `nimbalyst-wiki` Claude Code plugin, with the same arguments, so a script and an agent see the same results. A repository reaches its pages through the team project a team admin connected its remote to; who belongs is decided in Nimbalyst Teams. Only team pages are reachable; Personal pages live in the desktop app.

```sh
nim login                      # device code, approved in the Nimbalyst console
nim whoami / nim logout
nim wiki status               # unbound (with your teams) | bound | ambiguous
nim wiki bind --org <id> --project <id>                  # team admins
nim wiki create-project --org <id> --name <n> [--bind]   # team admins
nim wiki pin --org <id> --project <id>                   # one of the projects this repo resolves to

nim wiki list                                            # the page tree, with links
nim wiki read collab://org:<o>:doc:<id>                  # a page body as markdown
nim wiki edit <uri> --old "exact text" --new "replacement"
nim wiki create "Flag storage" --parent <pageId> --body-file notes.md
nim wiki move CFS-2 --kind item --parent <pageId>
nim wiki set-type <pageId> technology
nim wiki items --type technology --where maturity=beta --json
nim wiki create-item technology "Flagship" --field maturity=beta --body-file body.md
nim wiki comments --page <uri>                           # citable comments
```

`nim --help` lists every verb: `list`, `read`, `edit`, `create`, `create-folder`, `move`, `rename`, `delete`, `set-type`, `members`, `types`, `define-type`, `items`, `item`, `create-item`, `update-item`, `comments`. Edits land directly, as an agent's do; each page's history is how a person reverts one.

`repo` is `git remote get-url origin`. `.nimbalyst/wiki.json` holds an optional `{ orgId, projectId }` pin, sent as `project` to choose among projects you can already reach; it grants nothing. `--repo`, or `--org` with `--project`, targets something else and ignores the current directory's wiki.json. `nim wiki pin` only accepts a project the repository actually resolves to (one of an ambiguous match, or its bound project), and only for the current checkout. Tokens live in `credentials.json` (mode 0600, directory 0700) under the user config dir, are written under a lock, and refresh on their own; `nim logout` revokes the session on the server before deleting them.

Env: `NIM_SERVER` (default `https://sync.nimbalyst.com`; `http://` only for localhost), `NIM_CONFIG_DIR` (credentials location), `NIM_GITHUB_NATIVE=on` (the earlier GitHub sign-in for `nim login`, off by default; `NIM_GITHUB_CLIENT_ID` configures its device flow).

### Local wiki

A local wiki is a folder of markdown pages (and CSV tables for table types) in the project, with no account or running app needed. The format is `@nimbalyst/local-wiki`'s `FORMAT.md`; the desktop app reads and writes the same files.

```sh
nim wiki init                                  # nimbalyst-local/wiki, a Home page, .gitignore entry
nim wiki init --location docs/wiki             # a checked-in folder instead; .gitignore untouched
nim wiki list [--json]                         # or ls
nim wiki read <id|path|title> [--json]         # --json includes the body version
nim wiki write <id|path|title> [--file F] [--expected-version V] [--create [--parent P]]
nim wiki move <page> [--parent P | --root | --before P | --after P] [--title T]
nim wiki search <words> [--limit N] [--json]
nim wiki serve [--port N] [--no-open]          # opens the wiki in your browser (loopback only, token-protected)
```

- The folder is `--location`, else `location` in `.nimbalyst/local-wiki.json` (relative to the project root; `init` writes it), else `nimbalyst-local/wiki`. In a git worktree the project root is the main checkout, so worktrees share one wiki.
- `init` adds `nimbalyst-local/` to `.gitignore` only when the wiki is under it and git does not already ignore it.
- `write` reads the body from `--file` or stdin. With `--expected-version` (from `read --json`) it refuses to overwrite a page that changed since, with exit code `7` and nothing written.
- `nim tracker list/get/show/create/update` use the local wiki for wiki types: a type whose `.nimbalyst/trackers/<type>.yaml` declares `storage: pages` or `storage: table` (list and create, from its first item), a type that already has typed pages in the wiki (list), or the id of a typed page or table row there (get, show, update). `--local` forces the wiki. New items of a type without `storage:` are refused in the wiki (its items live in the app database). Everything else goes to the app database as before.

## `nim mcp`

`nim mcp` runs an MCP server on stdio for agents such as Claude Code: newline-delimited JSON-RPC (`initialize`, `tools/list`, `tools/call`, `ping`), with stdout reserved for protocol messages and all logging on stderr. It exits when stdin closes.

```sh
claude mcp add nimbalyst-local -- nim mcp
```

It serves the local wiki under the same tool names as the team wiki server: `listPages`, `searchPages`, `readCollabDoc`, `applyCollabDocEdit` (exact replacements, or `content` for the whole body, with an optional `expectedVersion`), `createSharedDoc`, `createSharedFolder`, `moveSharedItem`, `renameSharedItem`, `deleteSharedItem` (to the wiki's `.trash/`), `setPageType`, `setPageFields`, and `tracker_list_types`, `tracker_list`, `tracker_get`, `tracker_create`, `tracker_update` for types placed in the wiki. Pages are addressed as `local-wiki://<id>`, by id, or by path. It also serves `initLocalWiki`, which creates the wiki (default `nimbalyst-local/wiki`, or a `location` relative to the project root), so an agent can start one without anyone running `nim wiki init`. The list does not change during a session: without a wiki each tool answers that `initLocalWiki` creates one. Team data is never read or written here: a call with `section: 'team'`, a `collab://` uri, a console link or a team issue key is refused and names the tool to call on the `nimbalyst-team` server instead. `--workspace` and `--location` choose the wiki as for `nim wiki`.

## Notes for maintainers

- Pure tracker record, key, release, status, and readiness semantics come from `@nimbalyst/tracker-core`, the same built package consumed by the runtime. Direct mode injects materialized type models alongside the full item corpus.
- `src/gateway/trackerWrite.ts` owns only host-specific offline write helpers (activity mutation, the stored comment shape, git-config identity, and local ID generation). `DirectGateway` deliberately mirrors the app handlers rather than using `recordToDbParams`, and the cross-host regression test requires their stored activity bytes to remain identical.
- `better-sqlite3` is an optional native dependency and must match the version the app ships. It is loaded only when a command opens the database (`src/db/nativeBinding.ts`); never import it at module top level, or every command fails on hosts where it did not install. Version 13 uses Node-API prebuilds shared by supported Node and Electron hosts; the CLI's Node 22 floor matches its upstream engine requirement.
- `MAX_KNOWN_SCHEMA` in `src/gateway/schema.ts` pins the newest tracker schema
  this build was verified against; bump it as the app's schema advances.

## Develop

```
pnpm run build       # tsc -> dist/
pnpm run typecheck
pnpm test            # vitest (DirectGateway fixture tests)
```
