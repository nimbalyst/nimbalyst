# Session Hierarchy

`ai_sessions.parent_session_id` stores the session tree. Ordinary sessions may have children at any level. Depth is bounded at 256 edges from the root (root depth zero) only to stop runaway recursion; `spawn_session` that would pass the bound places the new session beside its spawner instead of failing, and `besideCaller=true` requests that placement explicitly so handoff chains stay flat. `created_by_session_id` stores the manager that receives completion reports and owns the session in `list_spawned_sessions`. Conversation branches continue to use `branched_from_session_id` independently.

## Containers and roles

| Role | `session_type` | `parent_session_id` | `worktree_id` |
| --- | --- | --- | --- |
| Workspace tree root | `session` | `NULL` | `NULL` |
| Workspace tree node | `session` | Immediate parent | `NULL` |
| Worktree tree root | `session` | `NULL` | Worktree ID |
| Worktree tree node | `session` | Immediate parent | Same worktree ID as parent |
| User-created grouping wrapper | `workstream` | `NULL` | `NULL` |
| Blitz container | `blitz` | `NULL` | `NULL` |

A worktree remains the checkout container. It may contain multiple tree roots, each with descendants carrying the same worktree ID. Spawning inside a worktree does not create a workstream wrapper. Workstream and Blitz rows remain roots and cannot belong to worktrees. Blitz retains its existing special placement: its direct workers may point to the Blitz root while running in separate worktrees. Ordinary edges within each worker's tree still obey the same-worktree rule.

### Workstream containers

A `workstream` row is a named group the user makes to hold peer sessions; the sidebar and the session board show it with a folder icon. It has no agent and no transcript. It is created empty from the create menu or from "Move to workstream...", through `sessions:create` with `sessionType: 'workstream'`, the only typed row that handler accepts. Sessions enter it by a move, by a drop on its row, or by being started while it is selected.

- A container is never a manager. `sessionHierarchy.ts` clears `created_by_session_id` when it names a `workstream` row, on create and on move, whatever the caller sends, so sessions inside one are peers and a session started inside one has a parent but no manager.
- A container is never the active session, a session tab, or a prompt target. The renderer shows an empty state when it has no unarchived sessions. The queued-prompt store and the direct send path both refuse a `workstream` session id.
- `metadata.userWorkstream = true` marks a container the user created. The sidebar merges an unmarked container that holds exactly one session into that session, because builds before the session tree wrapped sessions automatically; a marked one always keeps its row. A new session never lands in a merged container.
- The marker is local to the desktop that created the container. It is not in the synced metadata keys, so on another desktop a marked container holding one session shows merged. Carrying it needs a change to the personal sync protocol and the mobile clients.

## Placement and management

`spawn_session`, `create_session`, and action launches parent a same-container child directly to the caller and set its manager to that caller. An explicit new or different worktree keeps the caller as manager and creates a tree root. `isolated: true` also creates a root while retaining its manager. No spawn creates or promotes a wrapper row, and no spawn changes the caller's agent role.

Moving a session is organizational: it changes the immediate parent and never assigns a manager (#1858). A manager receives the session's completion reports and is woken by them, so only a spawn creates that relationship. The moved session keeps its manager while the manager is still an ancestor at the new position, and loses it once moved out from under it, including a move to top level. No session is sent a prompt or a transcript note because of a move. Moving to top level retains the worktree container. Moving between workspace trees is allowed; moving between different worktrees is rejected. The moved subtree retains its internal edges. `sessions:set-parent` names a manager only when an undo passes `restoreManagerId`; otherwise the store applies this rule. A move must not introduce a cycle, nest a wrapper, or put any descendant beyond the depth bound. Rows a drag reassigned before this rule (marked `managerReassignedByUser` with a different `originalSpawnerSessionId`) still count toward the current manager's running-session limit but not its lifetime spawn limit.

`sessionHierarchy.ts` validates the entire moved subtree against the proposed parent's ancestor chain. All storage hierarchy writers share a serialized lane, so two concurrent moves cannot each validate against the other's old edges. Local optimistic guards reject a move if the parent or manager changed since its snapshot was read. Remote freshness callbacks are checked inside that lane and immediately before SQL. Each local parent or manager change, including migration, records a durable `metadata.hierarchySyncIntent` revision in the same write; deletion records intent for each lifted or unmanaged row. A stale remote snapshot cannot overwrite an unacknowledged local intent. The base store is authoritative for desktop IPC and incoming phone moves alike.

Agent spawning reserves per-manager capacity before side effects and counts pending launches while excluding their already-inserted rows from durable counts. Reservations remain held through initial queueing/start and are released on success or failure. Durable pending or executing prompts continue to count toward the four-session limit after release, including deferred launches and recovery after restart. Phone child creation resolves its parent first and inserts inherited worktree, parent, and manager together.

## Read and mutation contracts

- `sessions:list` retains `childCount` as a direct count and adds `descendantCount`. Header activity includes every descendant's latest activity.
- `sessions:list-children(parentSessionId, workspacePath, { includeArchived? })` returns the whole flat descendant list. Each row includes its immediate `parentSessionId`, `createdBySessionId`, relative `depth` (first child is one), direct `childCount`, and `descendantCount`. Fetching an expanded root requires one recursive SQL query.
- `sessions:create-child` inherits the parent's worktree and sets parent and manager in the insert. Explicit mismatched worktree placement is rejected.
- `sessions:set-parent({ sessionId, newParentId, workspacePath, restoreManagerId? })` applies the authoritative guard and returns `{ success, previousParentId, previousManagerId }`, or `{ success: false, error }`. A one-level undo sends the previous parent plus `restoreManagerId: previousManagerId`. The returned snapshot is guarded against concurrent writes.
- `SessionStore.listPendingHierarchyIntents()` lists durable local intent; `acknowledgeHierarchyIntent(id, revision, parent, manager)` clears only a matching intent and current row. `applyRemoteHierarchySnapshot(rows, isCurrent)` validates the final combined graph and applies all accepted placements in one transaction, permitting parent reversals that would fail as intermediate single-row writes. Matched server echoes with explicit parent and manager fields clear local intent; divergent pending rows remain authoritative. Remote snapshots apply the same manager rule as local moves and emit `HierarchyMove.source = "remote"` so sync callers suppress automatic echoes.
- Archive and restore apply to the entire subtree in a transaction. Publication sends the state of every affected row to personal sync.
- Deletion lifts direct children to the deleted row's own parent in the same transaction as the delete. Children managed by the deleted row inherit the surviving parent as manager; other manager edges remain intact. Lifted rows are republished.
- Overview and edited-file tools find the caller's tree root and include its entire subtree, including files edited by the root itself.

Remote mirror rows also expose direct and recursive counts, with traversal constrained to the same host and workspace. Incoming phone parent changes go through the desktop store, which applies the same manager rule as a desktop move and republishes the accepted placement. Rejected moves republish the existing authoritative parent and manager. Canonical publication includes both `parentSessionId` and `createdBySessionId`, using explicit null to clear either relationship. Absent fields mean no update. Verified bootstrap and late listener registration also replay hierarchy rows, so offline phone moves receive the same validation. The authority subscribes to complete server-only snapshots through `onHierarchySnapshot(callback)`; ordinary list listeners remain quiet on bootstrap. Decisions and their echoes are serialized per session and reject superseded snapshots. Unpublished canonical rows are retained by ID and retried from current durable state on a timer, index readiness, and reconnect; no new synced hierarchy field is required.

## Migration and recovery

`sessionTreeMigration.ts` runs once after the app becomes usable, through the common database adapter on both PGLite and better-sqlite3. It processes creator ancestors before descendants, moves eligible same-container parent pointers to their managers, and skips cycles, over-depth placements, wrapper rows, user-reassigned rows, and explicitly isolated rows. Wrapper rows are retained. No session row is deleted by this migration.

Each changed row stores its old parent, including a null parent, in `metadata.preTreeParentSessionId` and records `metadata.sessionTreeMigrationVersion = 1`. The same update records durable `hierarchySyncIntent` for the new parent and manager. Updates merge these keys, preserving concurrent metadata changes. A database marker in `session_tree_migrations` prevents repeat runs. If interrupted between batches, backups prevent already-migrated rows from being rewritten on retry and reconstruct their original containers for descendants not yet moved. Nullable provenance uses explicit JSON-set semantics on SQLite so a null backup or original spawner remains present. The stored backup is the recovery source; restoration must use the authoritative mutation path and its guards.

Legacy PGLite startup conversion only changes legacy interaction-mode session types. It must never turn a real session into a wrapper merely because it has children, or delete an empty tree parent in a worktree.

## Relevant implementation

- [Hierarchy rules and recursive reads](../packages/electron/src/main/services/sessionHierarchy.ts)
- [Session store](../packages/electron/src/main/services/PGLiteSessionStore.ts)
- [IPC handlers](../packages/electron/src/main/ipc/SessionHandlers.ts)
- [Spawn and manager reports](../packages/electron/src/main/services/MetaAgentService.ts)
- [Migration](../packages/electron/src/main/services/sessionTreeMigration.ts)
- [Phone move authority](../packages/electron/src/main/services/ai/mobileSessionHierarchy.ts)
