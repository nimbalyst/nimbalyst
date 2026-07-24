---
planStatus:
  planId: plan-collab-local-backup
  title: "Collab Local Backup: Plaintext Recovery Copies in userData"
  status: proposed
  planType: feature
  priority: high
  owner: ghinkle
  stakeholders:
    - development-team
  tags:
    - collaboration
    - documents
    - backup
    - recovery
    - encryption
    - org-migration
  created: "2026-06-18"
  updated: "2026-06-18"
  progress: 0
---
# Collab Local Backup: Plaintext Recovery Copies in userData

A local, plaintext, per-project copy of all collaborative content, written under the Electron `userData` directory, independent of both the local SQLite database and the collab server. The goal is a last-known-good recovery copy that survives a failure in the encryption rework or the org/project migration engine — including the case where a server-side Y.Doc becomes undecryptable or an org/project move loses data.

## Why now, and what is actually at risk

We are finishing the encryption rework and the server org/project migration system (Epic H3). Both touch the authoritative state of shared content. A bug in either can corrupt or lose server state, or make an encrypted Y.Doc undecryptable. Today there is no decrypted, server-independent snapshot to restore from.

- **File-backed shared docs** (markdown, csv, excalidraw, datamodel, mockup) already have a workspace copy at `collab_local_origins.relative_path`. But that disk file can lag the collab truth when the user never pulled remote changes back to disk, so it is not a reliable snapshot of the shared state.
- **Tracker bodies** (`tracker-content/{itemId}`) have **no** workspace file. They live only in the Y.Doc, `tracker_body_cache`, and on the server. This is the real recovery gap and the primary motivation.
- An **encrypted** backup would be useless precisely when the encryption work is what broke. The backup must therefore be **decrypted plaintext**.

## Decisions (locked 2026-06-18)

- **Capture scope:** live-on-open **plus a manual full sweep**. Each open document/body is backed up as it connects and changes; a user-triggered "Back up all now" connects to every known DocumentRoom, snapshots, and disconnects. No automatic periodic sweep.
- **Retention:** **latest only** — one plaintext file per document, overwritten on each backup, protected by a size-guard. No version history kept locally.
- **Plaintext at rest:** **accepted and documented.** Workspace files are already plaintext on disk; the backup tree is treated the same. Documented here and in support docs. Not encrypted at rest (encryption would reintroduce the dependency this backup is meant to survive).
- **Artifacts:** this design doc plus a decision tracker item.

## What already exists (hook points)

- **Local Y.Doc update observer** — `packages/runtime/src/sync/DocumentSync.ts:884` (`this.ydoc.on('update', handler)`); fires for local edits (origin not remote/snapshot).
- **Remote-update callback** — `DocumentSyncConfig.onRemoteUpdate` at `packages/runtime/src/sync/documentSyncTypes.ts:71`; fires after a decrypted remote update is applied.
- **Plaintext serialization** — `getCollabContentAdapter(documentType)` (`packages/collab-adapters/src/registry.ts:75`) returns an adapter with `toPlainText(yDoc)` / `exportToFile(yDoc)` (e.g. `MarkdownCollabContentAdapter.ts:111`). Adapters exist for markdown, csv, excalidraw, datamodel, mockup.html, mockupproject.
- **Document enumeration** — `collab_local_origins` table (`org_id`, `document_id`, `document_type`, `project_id`, `relative_path`, ...). Query by `org_id` + `project_id`.
- **Org/project identity** — `findTeamForWorkspace(workspacePath)` → `team.orgId`, `team.teamProjectId` (`CollabLocalOriginService.ts`).
- **Tracker bodies** — `MainBodyDocService.ts` constructs a DocumentSyncProvider with doc id `tracker-content/{itemId}`; same encryption and serialization path, but **not** present in `collab_local_origins`.
- **Database backup conventions to mirror** — `DatabaseBackupService.ts` / `SQLiteBackupService.ts`: atomic write, metadata file, verification, and a size-guard that rejects a new backup smaller than ~50% of the current one.

## Architecture

Filesystem and `userData` access stay in the Electron main process. The cross-platform runtime sync layer only surfaces serialized plaintext through callbacks it already has; it does not touch the filesystem.

### New: `CollabBackupService` (electron main)

Single entry point:

```
onContentChanged({ documentId, orgId, projectId, documentType, title, relativePath, getPlaintext })
```

- `getPlaintext()` calls `getCollabContentAdapter(documentType).toPlainText(yDoc)`. Missing adapter → skip and log, never throw.
- **Debounce** per document (~2–5s) to coalesce bursts of edits.
- **Atomic write**: write to a temp file, then rename into place.
- **Size-guard**: refuse to overwrite a non-empty backup with empty or much-smaller content (mirrors `DatabaseBackupService`). This stops a transient empty or still-initializing Y.Doc from clobbering a good backup.
- **Manifest update** after each successful write.

### Wiring the content-changed signal

The runtime sync layer already has both a local update observer and an `onRemoteUpdate` callback. Route both into a single content-changed signal that the Electron layer subscribes to:

- **File-backed docs** — wired in `ElectronDocumentService` / `DocumentSyncHandlers` when a DocumentSyncProvider is created. Identity and `relativePath` come from the `collab_local_origins` row; org/project from `findTeamForWorkspace`.
- **Tracker bodies** — wired in `MainBodyDocService`. Doc id `tracker-content/{itemId}`; title/source derived from the tracker item (NIM key). Backed up under `bodies/`.

### Manual full sweep

A user-triggered IPC ("Back up all now") that, per `(org, project)`:

1. Enumerates `collab_local_origins` rows plus known tracker items with bodies.
2. For each, connects a DocumentSyncProvider, waits for synced state, serializes plaintext, writes the backup, disconnects.
3. Updates the manifest and reports a summary (counts, skips, failures).

Heavier than live capture (one room connection per doc); intended as an explicit pre-migration safety action, not a background job.

### Directory layout

```
<userData>/collab-backups/
  <orgId>/
    <projectId | _primary>/
      manifest.json
      documents/<documentId>.<ext>
      bodies/<itemId>.md
```

`_primary` is used when `project_id` is NULL (legacy primary project). `<ext>` comes from the adapter's primary file extension.

`manifest.json` (latest-only, per document):

```json
{
  "orgId": "...",
  "projectId": "...",
  "updatedAt": "<iso>",
  "documents": {
    "<documentId>": {
      "kind": "document | body",
      "type": "markdown",
      "title": "...",
      "relativePath": "docs/foo.md",
      "ext": "md",
      "lastBackupAt": "<iso>",
      "contentHash": "sha256...",
      "byteSize": 1234
    }
  }
}
```

### Org/project migration interaction (the point of doing this now)

The tree is keyed by `orgId/projectId`. When the H3 move/merge engine changes those keys, new backups land under the **new** key while the **pre-migration tree is left intact** — exactly the recovery point we want if a migration goes wrong. The old manifest records `supersededBy: { orgId, projectId, at }` rather than being deleted. Cleanup of superseded trees is manual.

## Known limitations (no silent caps)

- **Live capture only covers opened content.** A document or body that is never opened during a session is not serialized locally, because serialization requires its decrypted Y.Doc. The manual full sweep is the way to capture everything; this limitation is documented rather than hidden.
- **Latest-only** means no local version history. A bad edit that propagates before the next good backup overwrites the prior good copy (size-guard only protects against empty/shrunk content, not against a valid-but-unwanted edit). History remains the server's responsibility via `document_history` / snapshots.
- **Plaintext at rest** in `userData`. Accepted; see Decisions.

## Restore path

- IPC to list backups for a project and to restore a single document or body back into its DocumentRoom (re-seed the Y.Doc from plaintext via the adapter's `applyFromFile`).
- A documented manual-restore procedure in `support/`, modeled on `support/force-restore-database-backup.md`.

## Workstreams

1. `CollabBackupService`: manifest, atomic write, debounce, size-guard, path helpers.
2. Surface a single content-changed signal from the runtime sync layer (local + remote callbacks already exist).
3. Wire file-backed docs (`ElectronDocumentService` / `DocumentSyncHandlers`).
4. Wire tracker bodies (`MainBodyDocService`).
5. Manual full-sweep IPC + minimal UI trigger.
6. Restore IPC + support doc.
7. Tests (failing-first): size-guard does not wipe a good backup with an empty Y.Doc; tracker-body backup → restore round-trip.

## Open follow-ups (not in v1)

- Automatic periodic sweep.
- Local version history / retention beyond latest.
- Encrypt-at-rest option behind an OS-keychain key.
