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
- `--limit <n>` / `--all`, `--archived`.

### Output

- TTY default: a compact, colored table.
- `--json` — the canonical `TrackerRecord` (the stable agent contract).
- `--csv` + `--columns a,b,c` — tabular export.
- `--quiet`/`-q` — ids only. `--no-color` (also honors `NO_COLOR` / non-TTY).

### Exit codes

`0` ok · `1` not found · `2` usage · `3` connection (incl. importers in offline
mode) · `4` schema-incompatible · `5` write-not-permitted (a live app owns the
DB, or a live-only command in offline mode).

### Env

`NIM_DB`, `NIM_WORKSPACE`, `NIM_ENDPOINT` + `NIM_TOKEN` (force live), `NIM_OWNER`
(resolves `--owner me`), `NO_COLOR`, `NIM_DEBUG` (stack traces).

## Notes for maintainers

- `src/vendor/trackerRecord.ts` is a vendored copy of
  `packages/runtime/src/core/TrackerRecord.ts` (the runtime's Vite build does not
  emit a Node-resolvable `dist/core/TrackerRecord.js`). Keep the `dbRowToRecord` /
  `recordToDbParams` logic in sync with the runtime; the CLI must agree
  byte-for-byte with the app on the `data` column / `type_tags` parsing.
- `src/vendor/trackerWrite.ts` mirrors the offline write helpers (`appendActivity`,
  the comment shape, git-config identity) from the app's MCP tool handlers +
  `TrackerIdentityService`. The offline write path in `DirectGateway` deliberately
  mirrors those handlers (not `recordToDbParams`) so a CLI-written row is
  byte-for-byte identical to an app-written one. Keep these in sync if the
  handlers change.
- `better-sqlite3` is a native dependency and must match the version the app
  ships, but built for the **Node** ABI (the app's copy is built for Electron's
  ABI and cannot be shared). Publishing should ship prebuilt Node-ABI binaries.
- `MAX_KNOWN_SCHEMA` in `src/gateway/schema.ts` pins the newest tracker schema
  this build was verified against; bump it as the app's schema advances.

## Develop

```
npm run build       # tsc -> dist/
npm run typecheck
npm test            # vitest (DirectGateway fixture tests)
```
