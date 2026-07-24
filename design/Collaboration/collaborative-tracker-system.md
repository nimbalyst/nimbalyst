---
planStatus:
  planId: plan-collaborative-tracker-system
  title: Collaborative Realtime Tracker System
  status: implemented
  planType: system-design
  priority: high
  owner: ghinkle
  stakeholders:
    - development-team
  tags:
    - collaboration
    - tracker
    - sync
    - architecture
    - stytch-b2b
  created: "2026-02-17"
  updated: "2026-02-26T00:00:00.000Z"
  progress: 85
---
# Collaborative Realtime Tracker System

A design for making Nimbalyst's tracker system fully realtime collaborative, enabling teams to share bug statuses, manage work items with list and kanban views, and tie tracker items to AI sessions and git commits. Essentially: a Linear-like experience built on top of the existing tracker + collabv3 infrastructure.

## Current State

### Tracker System (65% of unified refactor complete)
- **5 built-in types**: plan, bug, task, idea, decision (YAML-defined in `.nimbalyst/trackers/`)
- **Storage**: JSONB in PGLite `tracker_items` table, workspace-scoped
- **Two modes**: inline (`#bug[...]` in markdown) and full-document (YAML frontmatter)
- **UI**: TrackerBottomPanel with sortable/filterable table, inline popovers, document header status bars
- **Entirely local**: No sync, no collaboration, single-user only

### CollabV3 Sync System (production-ready)
- **Architecture**: Cloudflare Workers + Durable Objects (SessionRoom per session, IndexRoom per user/org)
- **Protocol**: Append-only message log over WebSocket, cursor-based pagination
- **Encryption**: E2E AES-256-GCM, server is zero-knowledge for content
- **Auth**: Stytch B2B JWT, org-scoped room access
- **Currently syncs**: AI session messages, session index, device presence, settings, project config

### Stytch Auth (B2B, complete)
- Google OAuth via B2B discovery flow
- Every user has a personal Organization; team projects get their own Orgs
- JWT includes `org_id` claim for org-scoped authorization
- Room IDs are `org:{orgId}:user:{memberId}:*` - org-scoped
- [10,000 MAUs + unlimited orgs free](https://stytch.com/pricing)

---

## Design Questions & Decisions

### 1. Shared vs Local: Two tiers of tracking

There are two fundamentally different tracking modes with a clean separation:

**Inline trackers** (`#bug[fix auth crash]` in markdown): **Always local, never synced.** These are personal, low-friction annotations you make while writing. Your local Lexical plugin renders them with popovers and status badges, but they never leave your machine. They exist inside a document's content, not as standalone records.

**Tracked items** (created from kanban/list view, or promoted from inline): **Synced to TrackerRoom, visible to the team, encrypted.** These are proper collaborative records with assignees, labels, comments, and optionally linked DocumentRooms for rich content.

**Promotion flow:** If you have an inline `#bug[...]` and realize the team needs to see it, you "promote" it to a tracked item. This creates a proper TrackerRoom record and optionally replaces the inline reference with a link to the tracked item.

**Per-type sync policy:** Each tracker data model (YAML) gains a `sync` field controlling whether tracked items of that type sync:

```yaml
# .nimbalyst/trackers/bug.yaml
type: bug
sync:
  mode: shared          # shared | local | hybrid
  scope: project        # project | workspace | global
```

| Mode | Behavior |
| --- | --- |
| `local` | Tracked items never synced. Lives only in local PGLite. Default for ideas, scratch items. |
| `shared` | Tracked items synced to collabv3. Visible to all project members. Default for bugs, tasks. |
| `hybrid` | Item-level choice. Each tracked item has a `shared: boolean` field. Plans might work this way - some are personal drafts, others are shared specs. |

Note: inline trackers are always local regardless of the type's sync policy. Only tracked items participate in sync.

**Default sync policies:**
- **Bugs**: `shared` - the core collaborative use case
- **Tasks**: `shared` - team coordination
- **Plans**: `hybrid` - user chooses per-plan whether to share
- **Ideas**: `local` - personal brainstorming
- **Decisions**: `shared` - team needs visibility into decisions

Users can override these defaults in project settings.

### 2. Trust Model: Stytch B2B (Complete)

**See \*\***[stytch-b2b-migration.md](./stytch-b2b-migration.md) for design details.**

Done. Every user has a personal Organization. Team projects get their own Organizations. Single login, single JWT, org context determined by which project is open. No dual auth, no B2C fallback. [10,000 MAUs + unlimited orgs free](https://stytch.com/pricing).

All rooms become org-scoped:
```
org:{orgId}:user:{memberId}:session:{sessionId}   # personal sessions
org:{orgId}:user:{memberId}:index                  # personal session index
org:{orgId}:tracker                                 # shared tracker room (NEW)
org:{orgId}:tracker-index                           # shared tracker index (NEW)
```

**Open question:** Do AI sessions themselves become shared? Or just the tracker items? Initial proposal: **tracker items are shared, AI sessions remain personal**. A session can be linked to a shared bug, but the session transcript stays private. This avoids the complexity of shared session encryption while still giving teams the collaboration they need.

### 3. Project Identity: Git Remote Origin

How do multiple team members know they're working on the "same project" from different machines with different filesystem paths?

**Project identity = normalized git remote origin URL.**

```
git@github.com:acme/acme-app.git       -> github.com/acme/acme-app
https://github.com/acme/acme-app.git   -> github.com/acme/acme-app
ssh://git@github.com/acme/acme-app     -> github.com/acme/acme-app
```

When a user enables collaboration on a project, we read the git remote `origin` and use the normalized URL as the project identifier. When another team member opens their local clone of the same repo, we auto-match by remote origin and associate them with the same org project.

**Flow:**
```
Admin creates team, enables collaboration on ~/code/acme-app
  -> Read git remote origin: github.com/acme/acme-app
  -> Store as project identity in org's ProjectIndexEntry
  -> Encrypted and synced to collabv3

Bob joins team, opens /home/bob/projects/acme
  -> Read git remote origin: github.com/acme/acme-app
  -> Auto-match to existing org project
  -> Shared tracker items start syncing
  -> No manual project linking needed
```

**Normalization rules:**
1. Strip protocol (`git@`, `https://`, `ssh://`)
2. Strip `.git` suffix
3. Normalize `git@host:path` to `host/path`
4. Lowercase the host
5. Result: `host/owner/repo` (e.g., `github.com/acme/acme-app`)

**Edge cases:**

| Case | Behavior |
| --- | --- |
| No git remote (notes, non-code) | Fall back to user-defined project name. Manual matching by name. |
| Multiple remotes | Use `origin` by default. User can select a different remote in project settings. |
| Forks (`alice/repo` vs `acme/repo`) | Different identities. Correct - forks are different projects. If Alice wants to collaborate on upstream, she adds upstream as origin. |
| Monorepo | Whole repo = one project. Same as how GitHub/Linear treat monorepos. |
| Repo renamed/transferred | Git remote URL changes. Migration: server stores old + new identifiers, matches either. User updates their remote (`git remote set-url`). |
| Private git server | Works the same. `git.internal.acme.com/team/repo` normalizes fine. |

**Storage:** The normalized remote URL is stored encrypted in `ProjectIndexEntry` (the `encryptedProjectId` / `encryptedPath` fields already exist for this purpose). The server never sees the plaintext URL.

### 4. Sync Architecture for Tracker Items

The collabv3 system currently syncs AI session messages via an append-only log. Tracker items are different - they're mutable records, not append-only messages. We need a different sync primitive.

**Proposed: TrackerRoom Durable Object**

A new Durable Object type alongside SessionRoom and IndexRoom:

```
TrackerRoom (per org/project)
├── tracker_items table     # Current state of all shared items
├── tracker_changelog table # Ordered log of mutations for sync
└── WebSocket broadcast     # Real-time updates to connected clients
```

**Why not reuse the append-only message pattern:**
- Tracker items are mutable (status changes, reassignment, field edits)
- Need latest-state queries (show me all open bugs) not full history replay
- Need conflict resolution for concurrent edits
- Much smaller payloads than session transcripts

**Sync protocol for tracker items:**

```typescript
// Client -> Server
type TrackerClientMessage =
  | { type: 'trackerSync'; sinceVersion: number }        // Initial/catch-up sync
  | { type: 'trackerUpsert'; item: EncryptedTrackerItem } // Create or update
  | { type: 'trackerDelete'; itemId: string }             // Delete item
  | { type: 'trackerBatchUpsert'; items: EncryptedTrackerItem[] }

// Server -> Client
type TrackerServerMessage =
  | { type: 'trackerSyncResponse'; items: EncryptedTrackerItem[]; version: number }
  | { type: 'trackerBroadcast'; item: EncryptedTrackerItem; version: number }
  | { type: 'trackerDeleteBroadcast'; itemId: string; version: number }
```

**Conflict resolution: Last-Write-Wins with field-level merge**
- Each item has a `version` (monotonic counter on server)
- Each field has an `updatedAt` timestamp
- On conflict: per-field LWW using `updatedAt` - most recent field value wins
- This handles the common case: Alice changes status while Bob changes priority

**Encryption model: fully encrypted payloads, client-side querying**

All tracker item content is sensitive. A bug title like "Fix SQL injection in /api/auth/login" or a task name like "Migrate to new payment provider" leaks vulnerabilities and roadmap. The server must not see any of it.

```
PLAINTEXT (server needs for routing/lifecycle only):
├── itemId (opaque UUID)
├── version (monotonic counter for LWW)
├── createdAt, updatedAt (timestamps for TTL/GC)
└── orgId, projectId (for room routing, already known from room ID)

ENCRYPTED (AES-256-GCM, per-resource key distributed via ECDH):
├── encryptedPayload + iv
│   Single encrypted blob containing ALL item data:
│   ├── type, title, description
│   ├── status, priority
│   ├── assigneeId, reporterId
│   ├── labels[]
│   ├── comments[]
│   ├── linkedSessions[], linkedCommitSha
│   ├── customFields
│   └── per-field updatedAt timestamps (for LWW merge)
```

**The server is a dumb encrypted relay.** Same pattern as SessionRoom (encrypted message content, server sees only sequence/timestamps) and DocumentRoom (encrypted Yjs updates, server sees only sequence/timestamps).

**Client-side querying is sufficient.** A team of 50 people generates low thousands of tracker items. PGLite on the client handles filtering, sorting, and aggregation for that dataset trivially. We don't need server-side queries.

**Conflict resolution: client-side field-level LWW.** When a client syncs and detects a version conflict (two clients updated the same item), it decrypts both versions, does the per-field LWW merge using the `updatedAt` timestamps inside the encrypted payload, re-encrypts the merged result, and pushes it back. The server just stores blobs and version numbers.

**Key management: per-resource keys, same pattern everywhere.** Each shared resource (tracker project, document) gets its own random AES-256 key, wrapped for each participant via ECDH. TrackerRoom needs a `key_envelopes` table (same schema as DocumentRoom). For personal orgs (single-user multi-device), the personal QR seed derivation is still valid. For team orgs, per-resource ECDH keys are required. See [SECURITY_REVIEW.md](./SECURITY_REVIEW.md) Finding 0 and the Key Granularity Decision.

### 5. Data Model Extensions for Collaboration

The tracker YAML data model needs new fields for collaborative use:

```yaml
# Extended tracker fields for collaboration
fields:
  # ... existing fields (title, status, priority) ...

  - name: assignee
    type: user           # References a team member
    displayInline: true

  - name: reporter
    type: user
    displayInline: false

  - name: labels
    type: multiselect
    options: []          # Configured per-project

  - name: linkedSessions
    type: array
    itemType: reference
    referenceType: session  # Links to AI sessions

  - name: linkedCommit
    type: string           # Git commit SHA
    displayInline: false

  - name: comments
    type: array
    itemType: object
    schema:
      - name: author
        type: user
      - name: body
        type: text
      - name: createdAt
        type: datetime
```

### 6. Session-to-Tracker Linking

A key value prop: tie bug fixes to the AI sessions that produced them and the commits that landed them.

**Linking flow:**
1. User creates bug `#bug``````````[id:bug_abc status:to-do]`
2. User starts AI session to fix the bug, references it: "Fix bug_abc"
3. AI session metadata includes `linkedTrackerItems: ['bug_abc']`
4. When work is done, user commits. Commit message includes `Fixes: bug_abc`
5. Git commit hook (or AI commit tool) updates tracker item:
  - `linkedSessions: [session_xyz]`
  - `linkedCommit: 'a1b2c3d'`
  - `status: done` (auto-transition on commit)

**Implementation:**
- AI session metadata gets a `linkedTrackerItems` field
- The git commit proposal tool (`developer_git_commit_proposal`) gets a `linkedTrackerItems` param
- Post-commit hook updates tracker items with commit SHA
- TrackerBottomPanel shows linked sessions and commits as clickable links

### 7. Views: List and Kanban

**List View** (extends existing TrackerTable):
- Already exists as sortable/filterable table
- Add: assignee column, avatar display, labels
- Add: inline editing of status, priority, assignee
- Add: bulk operations (select multiple, change status, reassign)
- Add: saved filters/views (e.g., "My Bugs", "High Priority Open")

**Kanban View** (new):
- Columns = status values from tracker data model
- Cards = tracker items, showing title, priority badge, assignee avatar, labels
- Drag-and-drop between columns to change status
- Swimlanes by assignee or priority (optional)
- WIP limits per column (configurable)
- Real-time: cards appear/move as other team members make changes

**View switching:**
- Toggle between List and Kanban in TrackerBottomPanel header
- View preference persisted per tracker type per workspace
- Both views show the same filtered data, just different layout

### 8. Document Collaboration Integration

Tracker items have two kinds of data: **structured metadata** (status, priority, assignee) and **rich document content** (bug descriptions, plan specs, design docs). These are fundamentally different data types that need different sync primitives.

**Two-layer architecture: TrackerRoom for metadata, DocumentRoom for content.**

A tracker item is a thin encrypted metadata record synced through the TrackerRoom, with its `documentId` pointing to a collaboratively-edited document synced through a [DocumentRoom](./realtime-document-collaboration.md).

```
TrackerRoom (encrypted blobs, field-level LWW)
├── { itemId: "bug-123", encryptedPayload: "..." }
│     Contains: type, status, priority, assignee,
│     labels, documentId: "doc-456", ...
│
DocumentRoom (encrypted Yjs updates, CRDT merge)
├── doc-456: the actual bug description/spec/plan
│     Full collaborative editing with cursors,
│     awareness, review gate for remote edits
```

**Benefits:**
- **Tracker metadata** syncs fast and resolves conflicts cleanly via LWW
- **Document content** gets full realtime collaborative editing with Yjs CRDTs
- **Every tracker type benefits**: a shared plan is a tracked item (status: draft/review/approved) with a linked collaborative document containing the spec. A design decision is a tracked item with a linked ADR document.
- **Local vs remote editing**: the review gate from the document collaboration design applies directly -- remote edits merge into the Y.Doc in memory but don't autosave to disk until accepted

**Not all tracker items need a DocumentRoom.** Simple bugs with just a title and inline description can store their content entirely in the TrackerRoom encrypted payload. The DocumentRoom is created on demand when a tracker item needs rich collaborative editing (e.g., a plan document, a detailed bug report with embedded diagrams).

#### Inline Trackers Are Not Collaborative

Inline tracker items (`#bug[title]` in markdown) are always local-only (see Section 1). They are not wired to the TrackerRoom and do not participate in collaborative sync. If a shared document happens to contain inline tracker syntax, those nodes sync as part of the Yjs document content (they're just text/nodes in the document), but they have no connection to the TrackerRoom.

This is a deliberate design choice. Inline trackers are low-friction personal annotations. Building a bidirectional sync bridge between inline syntax and the TrackerRoom would add significant complexity (observer patterns, conflict resolution, authoritative source debates) for a use case that doesn't need it. If something is important enough to track collaboratively, promote it to a proper tracked item.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         Desktop App (Electron)                            │
│                                                                           │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────────────────┐  │
│  │ TrackerPlugin │  │ TrackerPanel │  │ TrackerSyncService             │  │
│  │ (Lexical)     │  │ (List/Kanban)│  │ - WebSocket to TrackerRoom     │  │
│  │ - inline items│  │ - table view │  │ - Encrypt/decrypt item blobs   │  │
│  │ - doc headers │  │ - kanban view│  │ - Client-side LWW merge        │  │
│  └──────┬───────┘  └──────┬───────┘  │ - Local cache in PGLite        │  │
│         │                  │          └───────────┬────────────────────┘  │
│         └──────────┬───────┘                      │                       │
│                    ▼                              │                       │
│  ┌──────────────────┐                             │                       │
│  │  PGLite DB       │◄────────────────────────────┘                       │
│  │  tracker_items   │  (decrypted local cache + local-only items)         │
│  └──────────────────┘                                                     │
│                                                                           │
│  ┌──────────────────────────────────────────────────────────────────────┐ │
│  │ DocumentSyncService (for tracker items with rich content)            │ │
│  │ - Yjs Y.Doc per shared document                                      │ │
│  │ - Encrypt/decrypt Yjs updates with document key                      │ │
│  │ - Review gate: remote edits held in-memory until accepted            │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────┬───────────────────────────────────────┘
                                   │ WebSocket (all data encrypted)
                                   ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                    Cloudflare Workers (collabv3)                           │
│                                                                           │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌─────────────┐  │
│  │ SessionRoom   │  │ IndexRoom    │  │ TrackerRoom  │  │ DocumentRoom│  │
│  │ (per session) │  │ (per user)   │  │ (per project)│  │ (per doc)   │  │
│  │ - AI messages │  │ - session idx│  │ - encrypted  │  │ - encrypted │  │
│  │ - metadata    │  │ - projects   │  │   item blobs │  │   Yjs blobs │  │
│  │ - sync cursor │  │ - devices    │  │ - version log│  │ - key envs  │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  └─────────────┘  │
│                                                                           │
│  ┌──────────────┐                                                         │
│  │ auth.ts       │  Stytch B2B JWT validation (org-scoped)                │
│  └──────────────┘                                                         │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## Implementation Phases

### Status Summary (updated 2026-02-23)

| Phase | Status | Notes |
| --- | --- | --- |
| 0: Stytch B2B | Auth complete, team UX remaining | ECDH infra built, needs org-level key wrapping UX |
| 1: DocumentRoom | **COMPLETE** | Sync layer, encryption, awareness, review gate all done. Desktop editor integration (Phase 6 of doc collab plan) is separate. |
| 2: TrackerRoom DO | **COMPLETE** | Server-side DO + 8 integration tests passing |
| 3: TrackerSyncService | **COMPLETE** | Runtime TrackerSyncProvider + 6 integration tests + Electron wiring (TrackerSyncManager, IPC, preload, PGLite hydration) |
| 4: Sync Policy & Data Model | **COMPLETE** | YAML sync policy, collaborative fields, PGLite sync_status column, mapping utilities |
| 5: Kanban View | Not started | UI only, no sync dependency |
| 6: Document-Linked Items | Not started | Links tracker items to DocumentRooms |
| 7: Session & Commit Linking | Not started | Links tracker items to AI sessions and git commits |
| 8: Comments & Activity | Not started | Comment threads, activity log, notifications |

**Key insight from rexical merge:** The `packages/rexical` package has been merged into `packages/runtime/src/editor/`. All references to "rexical" in this plan now refer to code at `packages/runtime/src/editor/`. The package name is `@nimbalyst/runtime`. This simplifies the build story for Phase 6 (document-linked items) and iOS mobile editing -- a single runtime package provides everything.

### Phase 0: Foundation - Stytch B2B -- COMPLETE (auth), REMAINING (team UX)
- ~~Replace B2C Stytch project with B2B project (all-in, no dual auth)~~
- ~~Auto-create personal Organization on signup (every user is an org)~~
- ~~Migrate existing B2C users to B2B Members + personal orgs~~
- ~~Update collabv3 JWT validation for B2B tokens (org\_id claim)~~
- ~~Migrate room IDs to org-scoped format~~
- Org-level encryption key derivation and sharing (for team orgs) -- ECDH infrastructure built in Phase 1, needs org-level key wrapping UX
- UI: "Create Team" / "Join Team" flows, org switcher concept tied to projects

**See [Team Management & Trust UI](./team-management-trust-ui.md)** for the full design of team creation, member management, roles/permissions, git remote linking, ECDH key distribution, and the Tracker Config panel (admin sync policy + local tracker management).

### Phase 1: DocumentRoom Durable Object (Realtime Document Collaboration) -- COMPLETE
**The foundational piece. Provides immediate value for any shared document and establishes the ECDH key exchange infrastructure that TrackerRoom reuses.**

See [Realtime Document Collaboration](./realtime-document-collaboration.md) for full design. All sync-layer work is done:
- DocumentRoom DO in collabv3 storing encrypted Yjs update blobs (`packages/collabv3/src/DocumentRoom.ts`)
- ECDH key exchange for per-document encryption keys (`packages/runtime/src/sync/ECDHKeyManager.ts`)
- Sync protocol: docSyncRequest, docUpdate, docCompact, docAwareness
- Client-side Yjs + AES-256-GCM encryption layer (`packages/runtime/src/sync/DocumentSync.ts`)
- Awareness: encrypted cursor positions with ~2Hz throttle and stale cleanup
- Autosave review gate: remote edits held in-memory until accepted, local edits autosave normally
- Integration tests for all of the above

**Remaining (Phase 6 of realtime doc collab plan):** Desktop editor integration -- `collab://` tab infrastructure, Lexical-Yjs binding, MCP agent tools, diff review UI, awareness UI. This is independent of the tracker system and can proceed in parallel.

### Phase 2: TrackerRoom Durable Object -- COMPLETE

Completed files:
- `packages/collabv3/src/TrackerRoom.ts` -- DO with SQLite schema (`tracker_items` + `changelog` tables), 4 message handlers (trackerSync, trackerUpsert, trackerDelete, trackerBatchUpsert), WebSocket broadcast, version auto-increment, hibernation, 90-day TTL alarm
- `packages/collabv3/src/types.ts` -- TrackerRoomId, TrackerClientMessage, TrackerServerMessage, EncryptedTrackerItem
- `packages/collabv3/src/index.ts` -- Routing (`org:{orgId}:tracker:{projectId}`), org-scoped auth (same pattern as DocumentRoom)
- `packages/collabv3/wrangler.toml` -- TRACKER_ROOM binding + v3 migration

Integration tests (`packages/collabv3/test/trackerRoom.integration.test.ts`, 8 tests):
1. Connect and receive empty sync response
2. Upsert item and broadcast to other clients
3. Persist items and serve on sync
4. Delta sync with sinceSequence
5. Version auto-increment on re-upsert
6. Delete item and broadcast
7. Deleted item IDs in sync response
8. Batch upsert

**Note:** Client-side field-level LWW conflict resolution is Phase 3 (TrackerSyncService) responsibility -- the server just auto-increments versions and stores opaque blobs.

### Phase 3: TrackerSyncService (Desktop Client) -- COMPLETE

**Sync layer (runtime package):**

Completed files:
- `packages/runtime/src/sync/trackerSyncTypes.ts` -- TrackerSyncConfig, TrackerItemPayload (generic `fields`/`system`/`fieldUpdatedAt` shape since April 2026 refactor), TrackerSyncResult, wire protocol types, mapping utilities (`recordToPayload`, `payloadToRecord`, legacy compat wrappers `trackerItemToPayload`/`payloadToTrackerItem`)
- `packages/runtime/src/sync/TrackerSync.ts` -- TrackerSyncProvider class: WebSocket lifecycle, AES-256-GCM encrypt/decrypt, sync protocol, generic field-level LWW merge (`mergeTrackerItems()` iterates all field keys), offline mutation queue with reconnect replay
- `packages/runtime/src/sync/index.ts` -- Exports TrackerSyncProvider, mergeTrackerItems, mapping utilities, and all types

Integration tests (`packages/collabv3/test/trackerSync.integration.test.ts`, 6 tests):
1. Connect, sync, reach connected status
2. Upsert item and sync to another provider
3. Broadcast upserts between connected providers
4. Broadcast deletes between connected providers
5. Verify encryption (no plaintext on wire)
6. Field-level LWW merge correctness

**Electron wiring:**

Completed files:
- `packages/electron/src/main/services/TrackerSyncManager.ts` -- Main process service that bridges TrackerSyncProvider to Electron:
  - Mirrors SyncManager pattern: lazy module load, PBKDF2 key derivation, cached JWT refresh
  - `initializeTrackerSync(workspacePath)`: detects git remote for project identity, creates TrackerSyncProvider with auth/key infrastructure, connects to TrackerRoom
  - `shutdownTrackerSync()` / `reinitializeTrackerSync()`: lifecycle management
  - PGLite hydration: `hydrateTrackerItem()` inserts/updates synced items with `sync_status='synced'`, `removeTrackerItem()` deletes
  - IPC broadcasting: status changes, item upserts, item deletes sent to all renderer windows
  - Public mutation API: `syncTrackerItem()` converts PGLite shape to payload and pushes to server, `unsyncTrackerItem()` deletes remotely
  - IPC handlers: `tracker-sync:get-status`, `tracker-sync:connect`, `tracker-sync:disconnect`, `tracker-sync:upsert-item`, `tracker-sync:delete-item`
- `packages/electron/src/preload/index.ts` -- Preload API: `trackerSync.getStatus()`, `.connect()`, `.disconnect()`, `.upsertItem()`, `.deleteItem()`, `.onStatusChanged()`, `.onItemUpserted()`, `.onItemDeleted()`
- `packages/electron/src/main/index.ts` -- Registers `registerTrackerSyncHandlers()` during IPC setup
- `packages/electron/src/main/services/RepositoryManager.ts` -- Calls `shutdownTrackerSync()` during cleanup

### Phase 4: Sync Policy & Data Model Extensions -- COMPLETE

Completed files:
- `packages/runtime/src/plugins/TrackerPlugin/models/TrackerDataModel.ts` -- Added `TrackerSyncMode`, `TrackerSyncPolicy` types, `sync` field on `TrackerDataModel`
- `packages/runtime/src/plugins/TrackerPlugin/models/YAMLParser.ts` -- Parses `sync:` block from YAML (mode + scope)
- `packages/runtime/src/plugins/TrackerPlugin/models/ModelLoader.ts` -- Sync defaults: bug/task/decision=shared, plan=hybrid, idea=local
- `packages/runtime/src/core/DocumentService.ts` -- Added `TrackerItemSyncStatus`, collaborative fields (assigneeId, reporterId, labels, linkedSessions, linkedCommitSha, documentId, syncStatus) to `TrackerItem`; widened `TrackerItemType` to accept custom types
- `packages/runtime/src/sync/trackerSyncTypes.ts` -- Added `trackerItemToPayload()` and `payloadToTrackerItem()` mapping utilities
- `packages/runtime/src/sync/index.ts` -- Exports mapping utilities
- `packages/electron/src/main/database/worker.js` -- Migration: adds `sync_status TEXT DEFAULT 'local'` column + index to `tracker_items`
- `packages/electron/src/main/services/ElectronDocumentService.ts` -- `rowToTrackerItem()` reads collaborative fields + sync_status; new `updateTrackerItemSyncStatus()` method; new IPC handler `document-service:tracker-item-update-sync-status`
- `.nimbalyst/trackers/*.yaml` (6 files) -- Added `sync:` section (bug/task/tech-debt/feature-request/user-story=shared, feedback=local)

**Not yet implemented (deferred):**
- User field type resolution to team member identity (depends on Phase 0 Stytch B2B team UX)
- "Promote to tracked item" UI in TrackerTable (deferred to Phase 3 Electron wiring, which will provide the sync dispatch)

### Phase 5: Tracker Mode & Kanban View

**See [Collaboration Navigation Design](./collaboration-navigation-design.md)** for the full Tracker mode layout, including sidebar, table/kanban views, saved views, shared docs section, and Files mode shared file toggle.

- New `TrackerMode` content mode in nav gutter (alongside Files and Agent)
- Tracker sidebar with type list, saved views, shared docs
- Full-width table view (upgraded from bottom panel TrackerTable)
- KanbanBoard component with columns from status field options
- Drag-and-drop with `status` field update + sync
- View toggle (table/kanban) in toolbar
- Search + filter chips + saved views

### Phase 6: Document-Linked Tracker Items
- Tracker items gain optional `documentId` linking to a DocumentRoom from Phase 1
- DocumentRoom created on demand when a tracker item needs rich editing (plans, detailed bug reports, design docs)
- Simple items (title + inline description only) stay entirely in TrackerRoom encrypted payload
- Review gate from document collaboration applies: remote edits to tracker documents held in-memory until accepted

### Phase 7: Session & Commit Linking
- Add `linkedTrackerItems` to AI session metadata
- Add `linkedSessions` and `linkedCommit` fields to tracker items
- Update git commit proposal tool to accept tracker item references
- Post-commit auto-update of linked tracker items
- UI: clickable links from tracker items to sessions and commits

### Phase 8: Comments & Activity
- Comment thread on each tracker item
- Activity log (status changes, reassignments, comments)
- Comments synced through TrackerRoom (append-only sub-log per item)
- @mention team members in comments
- Notification system (in-app, push to mobile)

---

## Open Questions

1. ~~**Encryption granularity**~~: **Resolved.** Fully encrypted payloads, client-side querying. All tracker item data (including status, priority, assignee, titles) encrypted as opaque blobs. Server sees only item IDs, versions, and timestamps. Client decrypts into local PGLite for all filtering/sorting/aggregation. Queryable encryption and plaintext-structural-metadata approaches both rejected -- titles and status values are sensitive data.

2. **CRDT vs LWW**: Field-level LWW is simple and handles 90% of cases. But for array fields (labels, comments, linked items), LWW can lose concurrent additions. Should we use a simple CRDT (e.g., add-wins set) for array fields specifically?

3. **Offline-first priority**: How important is offline editing of shared items? If we go full offline-first, we need a more sophisticated conflict resolution. If we treat it as online-primary with graceful degradation, LWW is sufficient.

4. **Mobile access**: Do mobile clients (Capacitor/iOS) get tracker views? Or is tracker collaboration desktop-only initially? The mobile app currently focuses on AI session viewing.

5. **~~Stytch B2B pricing~~**: **Resolved.** B2B migration complete. 10,000 MAUs + unlimited orgs free. Same tier as previous B2C usage.

6. ~~**Shared encryption key distribution**~~: **Partially resolved, critical bug found.** The QR-paired `encryptionKeySeed` is a personal per-user secret for single-user multi-device sync. TrackerSyncManager incorrectly uses it for team encryption -- each user derives a different key, so team members can't decrypt each other's items. The fix is to use ECDH-distributed per-project keys (the infrastructure exists in `ECDHKeyManager` but isn't wired to TrackerSyncManager). See [SECURITY_REVIEW.md](./SECURITY_REVIEW.md) Finding 0.

7. ~~**Plan documents as shared items**~~: **Resolved.** Two-layer architecture. Tracker metadata (status, assignee, priority) syncs through TrackerRoom as encrypted blobs. Document content (the actual plan text, bug description, design spec) syncs through DocumentRoom using Yjs CRDTs with E2E encryption. Each tracker item has an optional `documentId` linking to its DocumentRoom. See Section 8 and [Realtime Document Collaboration](./realtime-document-collaboration.md).

---

## Security Review Findings

A code-level security audit was conducted on 2026-02-23 covering all implementation files. See [SECURITY_REVIEW.md](./SECURITY_REVIEW.md) for the full report. Key items affecting this plan:

### P0 -- Must fix before team collaboration ships

1. **TrackerSyncManager uses wrong encryption key** (Finding 0, CRITICAL). Personal QR seed produces per-user keys; team members can't decrypt each other's tracker items. Must switch to ECDH-distributed per-project keys.
2. **Key envelope overwrite** (Finding 1, HIGH). Any org member can overwrite another user's key envelope in DocumentRoom. Must restrict addKeyEnvelope to document owner or authorized key distributors.
3. **No sender verification on key envelopes** (Finding 2, HIGH). Recipient trusts whatever senderPublicKey is in the envelope without cross-referencing the sender's registered identity key in D1.

### Enterprise readiness gaps (required for team/enterprise customers)

4. **SSO enforcement**: No org admin setting to require SSO and block magic-link/social login. Enterprise customers need all members to authenticate through corporate IdP. Stytch B2B supports SAML/OIDC natively; Nimbalyst needs to enforce it.
5. **Admin recovery key**: If an employee leaves and their ECDH private key is lost, documents/projects they held keys for become permanently inaccessible. Must wrap every project key for an org admin recovery key during distribution.
6. **Key distribution audit trail**: `key_envelopes` table uses INSERT OR REPLACE with no history. SOC 2 / ISO 27001 require records of who was granted access, when, and by whom.
7. **Key rotation on member removal**: Design exists but not implemented. Revoked user retains the old key and can decrypt all historical content.
8. **Device deauthorization**: No mechanism to invalidate a specific device's ECDH key pair or force re-keying after device loss.
9. **SCIM provisioning**: No automated member lifecycle via corporate directory. Stytch supports SCIM; needs wiring to ECDH key deregistration on deprovision.

---

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| ~~B2B auth migration~~ | ~~High~~ | ~~Complete. All-in on B2B, no dual auth, no B2C fallback.~~ |
| Conflict resolution edge cases | Medium | LWW is well-understood. Add CRDT for arrays later if needed. |
| ~~Encryption key management for teams~~ | ~~High~~ | Security review found TrackerSyncManager uses wrong key. Fix: ECDH-distributed per-project keys. See [SECURITY_REVIEW.md](./SECURITY_REVIEW.md). |
| Enterprise key lifecycle (recovery, rotation, audit) | High | Required for team customers. Admin recovery key, audit log, and key rotation not yet implemented. |
| Scope creep toward full Linear clone | High | Focus on bugs + tasks first. Kanban + comments in later phases. |
| Performance with many connected clients | Medium | Cloudflare DOs handle this well. Test with 20+ concurrent connections. |
| Migration complexity from local-only | Low | Default everything to local. Sharing is opt-in per project. |
