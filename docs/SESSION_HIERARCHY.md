# Session Hierarchy

`ai_sessions.parent_session_id` stores the session tree. Ordinary sessions may have children at any level, up to eight edges from the root (root depth zero). `created_by_session_id` stores the manager that receives completion reports and owns the session in `list_spawned_sessions`. Conversation branches continue to use `branched_from_session_id` independently.

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

## Placement and management

`spawn_session`, `create_session`, and action launches parent a same-container child directly to the caller and set its manager to that caller. An explicit new or different worktree keeps the caller as manager and creates a tree root. `isolated: true` also creates a root while retaining its manager. No spawn creates or promotes a wrapper row, and no spawn changes the caller's agent role.

Moving a session under another session changes both its immediate parent and manager. Moving to top level clears both, while retaining its worktree container. Moving between workspace trees is allowed; moving between different worktrees is rejected. The moved subtree retains its internal edges. A move must not introduce a cycle, nest a wrapper, or put any descendant beyond depth eight. The old and new managers receive queued reports, which do not interrupt a running turn. Drag-acquired sessions appear in the new manager's roster and count toward its running-session limit; they do not count against its lifetime spawn limit unless that manager originally spawned them.

`sessionHierarchy.ts` validates the entire moved subtree against the proposed parent's ancestor chain. All storage hierarchy writers share a serialized lane, so two concurrent moves cannot each validate against the other's old edges. Local optimistic guards reject a move if the parent or manager changed since its snapshot was read. Remote freshness callbacks are checked inside that lane and immediately before SQL. Each local parent or manager change, including migration, records a durable `metadata.hierarchySyncIntent` revision in the same write; deletion records intent for each lifted or unmanaged row. A stale remote snapshot cannot overwrite an unacknowledged local intent. The base store is authoritative for desktop IPC and incoming phone moves alike.

Agent spawning reserves per-manager capacity before side effects and counts pending launches while excluding their already-inserted rows from durable counts. Reservations remain held through initial queueing/start and are released on success or failure. Durable pending or executing prompts continue to count toward the four-session limit after release, including deferred launches and recovery after restart. Phone child creation resolves its parent first and inserts inherited worktree, parent, and manager together.

## Read and mutation contracts

- `sessions:list` retains `childCount` as a direct count and adds `descendantCount`. Header activity includes every descendant's latest activity.
- `sessions:list-children(parentSessionId, workspacePath, { includeArchived? })` returns the whole flat descendant list. Each row includes its immediate `parentSessionId`, `createdBySessionId`, relative `depth` (first child is one), direct `childCount`, and `descendantCount`. Fetching an expanded root requires one recursive SQL query.
- `sessions:create-child` inherits the parent's worktree and sets parent and manager in the insert. Explicit mismatched worktree placement is rejected.
- `sessions:set-parent({ sessionId, newParentId, workspacePath, restoreManagerId? })` applies the authoritative guard and returns `{ success, previousParentId, previousManagerId }`, or `{ success: false, error }`. A one-level undo sends the previous parent plus `restoreManagerId: previousManagerId`. The returned snapshot is guarded against concurrent writes.
- `SessionStore.listPendingHierarchyIntents()` lists durable local intent; `acknowledgeHierarchyIntent(id, revision, parent, manager)` clears only a matching intent and current row. `applyRemoteHierarchySnapshot(rows, isCurrent)` validates the final combined graph and applies all accepted placements in one transaction, permitting parent reversals that would fail as intermediate single-row writes. Matched server echoes with explicit parent and manager fields clear local intent; divergent pending rows remain authoritative. Remote changes emit `HierarchyMove.source = "remote"` for queued manager reports while sync callers suppress automatic echoes.
- Archive and restore apply to the entire subtree in a transaction. Publication sends the state of every affected row to personal sync.
- Deletion lifts direct children to the deleted row's own parent in the same transaction as the delete. Children managed by the deleted row inherit the surviving parent as manager; other manager edges remain intact. Lifted rows are republished.
- Overview and edited-file tools find the caller's tree root and include its entire subtree, including files edited by the root itself.

Remote mirror rows also expose direct and recursive counts, with traversal constrained to the same host and workspace. Incoming phone parent changes go through the desktop store, which assigns the new manager, queues manager reports, and republishes the accepted placement. Rejected moves republish the existing authoritative parent and manager. Canonical publication includes both `parentSessionId` and `createdBySessionId`, using explicit null to clear either relationship. Absent fields mean no update. Verified bootstrap and late listener registration also replay hierarchy rows, so offline phone moves receive the same validation. The authority subscribes to complete server-only snapshots through `onHierarchySnapshot(callback)`; ordinary list listeners remain quiet on bootstrap. Decisions and their echoes are serialized per session and reject superseded snapshots. Unpublished canonical rows are retained by ID and retried from current durable state on a timer, index readiness, and reconnect; no new synced hierarchy field is required.

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
