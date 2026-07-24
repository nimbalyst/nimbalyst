# File Watching and AI Change Tracking

This document covers the file watching infrastructure, AI change tracking pipeline, and red/green diff display system. It spans the full lifecycle from disk-level file events through to rendered diff UI.

## Architecture Overview

```
┌─────────────────────────────────────────────┐
│  React UI Layer (Renderer)                  │
│  - TabEditor (conflict handling, diff mode) │
│  - HistoryDialog (snapshot comparison)      │
│  - DiffPreview / TextDiffViewer             │
│  - MonacoDiffViewer / DiffPreviewEditor     │
│  - FilesEditedSidebar (file list)           │
└──────────────┬──────────────────────────────┘
               │ Reads from Jotai atoms
┌──────────────▼──────────────────────────────┐
│  Jotai Atoms (State Management)             │
│  - sessionFileEditsAtom (per session)       │
│  - sessionGitStatusAtom (per session)       │
│  - sessionPendingReviewFilesAtom            │
│  - workstreamFileEditsAtom (derived)        │
│  - worktreeChangedFilesAtom (per worktree)  │
│  - rawFileTreeAtom (workspace tree)         │
└──────────────┬──────────────────────────────┘
               │ Updated by central listeners
┌──────────────▼──────────────────────────────┐
│  Central IPC Listeners (Renderer)           │
│  - fileStateListeners.ts                    │
│  - fileTreeListeners.ts                     │
└──────────────┬──────────────────────────────┘
               │ IPC events from main process
┌──────────────▼──────────────────────────────┐
│  Main Process                               │
│  - ChokidarFileWatcher (per-file)           │
│  - OptimizedWorkspaceWatcher (per-workspace)│
│  - GitRefWatcher (commits & staging)        │
│  - SessionFileWatcher (AI change capture)   │
│  - FileSnapshotCache (before/after state)   │
│  - HistoryManager (snapshot storage)        │
│  - SessionFileTracker (tool execution)      │
│  - ToolCallMatcher (file-to-tool linking)   │
└──────────────┬──────────────────────────────┘
               │ SQL queries
┌──────────────▼──────────────────────────────┐
│  PGLite Database                            │
│  - document_history (compressed snapshots)  │
│  - session_files (file-session links)       │
│  - ai_tool_call_file_edits (tool matching)  │
└─────────────────────────────────────────────┘
```

---

## 1. File Watchers (Main Process)

Four watcher types handle different scopes of file observation.

### ChokidarFileWatcher - Individual File Watching

**File:** `packages/electron/src/main/file/ChokidarFileWatcher.ts`

Watches individual open files for external changes (e.g., another editor or AI modifying the file on disk).

**Configuration:**
- `ignoreInitial: true` - Skip initial state events
- `persistent: true` - Keep process running
- `atomic: true` - Handle atomic writes (vim-style save)
- `awaitWriteFinish: { stabilityThreshold: 10 }` - 10ms threshold for fast AI edit detection
- `usePolling: false` - Uses native fs.watch

**Data structure:** `Map<windowId, Map<filePath, FSWatcher>>` - per-window watcher tracking.

**Key methods:**
- `start(window, filePath)` - Begin watching a file (called when tab opens)
- `stop(windowId)` - Stop all watchers for a window
- `stopFile(windowId, filePath)` - Stop watching a specific file

**Events emitted:**
- `file-changed-on-disk` - File content changed externally
- `file-deleted` (via `notifyFileDeleted`) - File removed from disk

**Error handling:** EMFILE/ENFILE errors are logged as warnings (file descriptor limits), other errors are rejected.

### OptimizedWorkspaceWatcher - Workspace Directory Watching

**File:** `packages/electron/src/main/file/OptimizedWorkspaceWatcher.ts`

Watches entire workspace directories to keep the file tree sidebar updated.

**Platform-specific strategy:**
- **macOS/Windows:** Uses `fs.watch(dir, { recursive: true })` - single file descriptor for the entire tree (FSEvents/ReadDirectoryChangesW)
- **Linux:** Falls back to chokidar with per-file inotify watches

**Ignore patterns** (hardcoded):
```
node_modules, .git, dist, build, out, coverage, .next, .nuxt,
.vscode, .idea, target, worktrees, .cache, .turbo, .svelte-kit,
.DS_Store, Thumbs.db
```

**Debouncing:** 500ms timeout before emitting file tree updates.

**Key methods:**
- `start(window, workspacePath)` - Begin watching workspace
- `addWatchedFolder(windowId, folderPath)` - Expand folder coverage (called on sidebar expand)
- `removeWatchedFolder(windowId, folderPath)` - Collapse folder coverage

**Events emitted:**
- `workspace-file-tree-updated` - File tree structure changed

### GitRefWatcher - Git Commit and Staging Detection

**File:** `packages/electron/src/main/file/GitRefWatcher.ts`

Detects commits and staging changes in real-time by watching git internals.

**Watches:**
- `.git/refs/heads/<branch>` - Detects new commits
- `.git/index` - Detects staging changes
- Handles worktrees where `.git` is a file pointing to shared refs

**Key behaviors:**
- Auto-approves pending reviews for committed files
- Debounces index changes at 100ms
- Clears git status cache on changes

**Events emitted:**
- `git:commit-detected` - Payload: `{ workspacePath, commitHash, commitMessage, committedFiles }`
- `git:status-changed` - Payload: `{ workspacePath }`

### SessionFileWatcher - Per-Session AI Change Detection

**File:** `packages/electron/src/main/file/SessionFileWatcher.ts`

Tracks file changes within a specific AI session for the change tracking pipeline.

**Architecture:** Uses ref-counted shared watchers so multiple sessions on the same workspace share a single filesystem watcher.

**Key features:**
- Gitignore-aware filtering (respects .gitignore)
- Binary file detection (excludes images, videos, archives)
- Editor save marking to exclude user saves from AI change matching
- Change deduplication (250ms threshold)
- Snapshot caching with before/after content tracking

**Key methods:**
- `start(workspacePath, sessionId, cache, onFileChanged)` - Begin tracking for a session
- `markEditorSave(filePath)` - Mark a file as user-saved (prevents false AI attribution)
- `handleChange(filePath)` / `handleAdd(filePath)` / `handleUnlink(filePath)` - Process detected changes

### WorkspaceEventBus Gitignore Bypass System

**File:** `packages/electron/src/main/file/WorkspaceEventBus.ts`

The gitignore bypass mechanism ensures that files written by AI tools to gitignored directories (e.g., `build/`, `dist/`, `node_modules/`) still trigger file change events. Without this, the watcher's gitignore filter silently drops events for AI-edited files in ignored paths, so the editor never learns about the change.

#### Why It Exists

WorkspaceEventBus loads `.gitignore` (or fallback patterns) and filters all file events through it. This is correct for user-facing file tree updates (nobody wants `node_modules/` flooding the sidebar), but breaks AI change detection when Claude Code writes to a gitignored path. The bypass system lets specific paths opt out of gitignore filtering.

#### API

| Function | Description |
|----------|-------------|
| `addGitignoreBypass(workspacePath, absolutePath)` | Register a path to bypass gitignore. Validates the path is inside the workspace. Events for this path dispatch with `gitignoreBypassed=true`. Also replays any recently dropped events from the replay buffer. |
| `removeGitignoreBypass(workspacePath, absolutePath)` | Remove a path from the bypass set. |
| `hasGitignoreBypass(workspacePath, absolutePath)` | Check if a path is in the bypass set (testing/diagnostics). |
| `clearGitignoreBypasses(workspacePath)` | Clear all bypass paths and the replay buffer for a workspace. Called during session cleanup. Also automatically runs when the last subscriber unsubscribes. |

All paths are normalized to forward slashes internally for cross-platform consistency.

#### Replay Buffer

Because `fs.watch` events typically arrive within a few milliseconds of a file write, the bypass registration (which arrives via the AI streaming chunk) may come *after* the event has already been dropped. The replay buffer solves this race:

- **Max entries:** 50 per workspace
- **TTL:** 5 seconds (expired entries are pruned on each insertion)
- **Behavior:** When `addGitignoreBypass` is called, matching entries in the replay buffer are re-dispatched to all listeners with `gitignoreBypassed=true`
- **Rename handling:** Buffered `rename` events use an async `fs.access` check on replay to determine whether the event is an `add` or `unlink`, matching the live watcher behavior

#### Who Registers Bypasses

| Caller | When | Purpose |
|--------|------|---------|
| `ToolExecutor.executeTool()` | Before tool execution | Pre-registers the target path so the watcher bypass is in place before the file write occurs |
| `SessionFileTracker.trackSingleFile()` | After tool execution, for edited files | Ensures bypass is registered for files tracked as AI edits |
| `FileHandlers` (`start-watching-file`) | When a tab opens a file | Ensures gitignored files opened in tabs receive change events |
| `FileHandlers` (`stop-watching-file`) | When a tab closes | Removes the bypass so closed gitignored files stop generating events |

#### How OptimizedWorkspaceWatcher Handles Bypassed Events

When events arrive with `gitignoreBypassed=true`:

- **`onChange`**: Ignored entirely (no editor notification). SessionFileWatcher handles change detection for bypassed files.
- **`onAdd`**: File tree refresh is triggered (so new AI-created files appear in the sidebar), but no `file-changed-on-disk` event is sent to editors.
- **`onUnlink`**: File tree refresh is triggered, but no `file-changed-on-disk` or `file-deleted` event is sent to editors.

#### Markdown Always Bypasses

Files with a `.md` extension always bypass gitignore filtering regardless of whether they are in the bypass set. This ensures documentation files in gitignored directories are always visible.

---

## 2. Snapshot and Before/After State

### FileSnapshotCache

**File:** `packages/electron/src/main/file/FileSnapshotCache.ts`

Maintains before/after state for AI change detection with memory management.

**Memory limits:** 100MB total cap, max 1MB per file.

**Two-tier lookup:**
1. **In-memory cache** - For files changed during the current session
2. **Git on-demand lookup** - At session start SHA, for files not yet in cache

**Key methods:**
- `startSession(workspacePath, sessionId)` - Initialize cache for a new session
- `getBeforeState(filePath)` - Get pre-change content (checks memory, then git)
- `updateSnapshot(filePath, content)` - Store current content as new "before" state
- `initGitCache(workspacePath)` - Read git status, cache dirty files
- `initFullScan(workspacePath)` - Non-git fallback (scans directory)

### HistoryManager - Persistent Snapshot Storage

**File:** `packages/electron/src/main/HistoryManager.ts`

Stores compressed file snapshots in PGLite for version history and diff baselines.

**Snapshot types:**
| Type | Description |
|------|-------------|
| `pre-edit` | Captured before AI session begins |
| `pre-apply` | Captured before AI applies a specific change |
| `ai-diff` | Captured after AI writes file |
| `ai-edit` | AI-generated edit |
| `incremental-approval` | Partial approval during review |
| `auto-save` | Periodic auto-save |
| `manual` | User-triggered save |
| `external-change` | Change from outside the app |

**Deduplication:** SHA256 hash comparison, skips if identical content within 1500ms window.

**Cleanup:** Keeps 250 most recent snapshots per file, deletes snapshots older than 30 days.

**Content compression:** All snapshots gzip-compressed before storage, decompressed on read.

---

## 3. AI Change Capture Pipeline

When Claude Code executes a tool, changes flow through a multi-step pipeline:

### Step 1: Tool Execution Capture

**File:** `packages/electron/src/main/services/SessionFileTracker.ts`

`SessionFileTracker.trackToolExecution()` extracts file paths and operation metadata from tool calls (Write, Edit, Bash, etc.):
- File path from tool arguments
- Link type: `'edited'`, `'read'`, or `'referenced'`
- Metadata: `toolName`, `operation` (create/edit/delete/bash), `linesAdded`, `linesRemoved`

### Step 2: Session-File Link Storage

**File:** `packages/electron/src/main/services/PGLiteSessionFileStore.ts`

`SessionFilesRepository.addFileLink()` stores the file-session relationship in the `session_files` table with deduplication to prevent duplicate entries when the same file is re-processed.

### Step 3: Snapshot Creation

`HistoryManager.createSnapshot()` captures before and after states:
- **Before AI changes:** `pre-apply` snapshot with original content
- **After AI changes:** `ai-diff` snapshot with new content
- Content hashed (SHA256) and compressed (gzip) before storage

### Step 4: Tool Call Matching

**File:** `packages/electron/src/main/services/ToolCallMatcher.ts`

Correlates file edits with specific AI tool calls using a scoring heuristic:
- `+100` points: toolUseId exact match
- `+40` points: filename appears in tool arguments
- `+30` points: filename appears in tool output
- Minimum score threshold: 30
- Time window: 10 seconds before/after tool call

Results stored in `ai_tool_call_file_edits` table.

---

## 4. Database Schema

### `document_history` - File Snapshots

```sql
CREATE TABLE document_history (
  id INTEGER PRIMARY KEY,
  workspace_id TEXT,
  file_path TEXT,
  content BYTEA,              -- gzip-compressed file content
  size_bytes INTEGER,         -- compressed size
  timestamp INTEGER,          -- Date.now() in milliseconds
  version INTEGER,
  metadata JSONB              -- {type, description, baseMarkdownHash, sessionId, status}
);
```

Metadata `status` values: `'pending-review'`, `'reviewed'`, `'archived'`

### `session_files` - File-Session Links

```sql
CREATE TABLE session_files (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  workspace_id TEXT,
  file_path TEXT,
  link_type TEXT,             -- 'edited', 'read', 'referenced'
  timestamp BIGINT,
  metadata JSONB              -- {operation, linesAdded, linesRemoved, toolName, bashCommand}
);
```

### `ai_tool_call_file_edits` - Tool Call Matching

```sql
CREATE TABLE ai_tool_call_file_edits (
  id INTEGER PRIMARY KEY,
  session_id TEXT,
  session_file_id TEXT,       -- references session_files.id
  message_id INTEGER,         -- references ai_agent_messages.id
  tool_call_item_id TEXT,
  tool_use_id TEXT,
  match_score INTEGER,        -- 30-100+ confidence score
  match_reason TEXT,
  file_timestamp BIGINT,
  created_at TIMESTAMPTZ
);
```

---

## 5. IPC Event Flow

### Main -> Renderer Events

| Channel | Payload | Source | Purpose |
|---------|---------|--------|---------|
| `file-changed-on-disk` | `{ path: string }` | ChokidarFileWatcher | File content changed externally |
| `file-deleted` | `{ filePath: string }` | ChokidarFileWatcher | File removed from disk |
| `file-renamed` | `{ oldPath, newPath }` | File handlers | File renamed |
| `workspace-file-tree-updated` | `{ fileTree: any[] }` | OptimizedWorkspaceWatcher | File tree structure changed |
| `session-files:updated` | `sessionId: string` | SessionFileTracker | AI session edited files |
| `git:commit-detected` | `{ workspacePath, commitHash, commitMessage, committedFiles }` | GitRefWatcher | New git commit |
| `git:status-changed` | `{ workspacePath }` | GitRefWatcher | Git staging/index changed |
| `history:pending-count-changed` | `{ workspacePath, count }` | HistoryManager | Pending AI edit count changed |
| `history:pending-cleared` | `{ workspacePath }` | HistoryManager | Pending tags cleared |

### Central Listeners (Renderer)

**File:** `packages/electron/src/renderer/store/listeners/fileStateListeners.ts`

Follows the centralized listener pattern (see IPC_LISTENERS.md). Components never subscribe to IPC events directly.

**`initFileStateListeners(workspacePath)`** subscribes to:
1. `session-files:updated` -> fetches edits, enriches with tool call matches, updates `sessionFileEditsAtom`
2. `git:status-changed` -> refreshes `sessionGitStatusAtom`, `workspaceUncommittedFilesAtom`, `worktreeChangedFilesAtom`, `worktreeGitStatusAtom`
3. `history:pending-count-changed` -> updates `sessionPendingReviewFilesAtom`

**File:** `packages/electron/src/renderer/store/listeners/fileTreeListeners.ts`

**`initFileTreeListeners(workspacePath)`** subscribes to:
1. `workspace-file-tree-updated` -> updates `rawFileTreeAtom`

### IPC Handlers (Main Process)

**File watcher control:**
- `start-watching-file` - Starts ChokidarFileWatcher for a single file (called when tab opens)
- `stop-watching-file` - Stops watching a specific file (called when tab closes)

**Folder events (selective watching):**
- `workspace-folder-expanded` - Adds folder to OptimizedWorkspaceWatcher
- `workspace-folder-collapsed` - Removes folder from OptimizedWorkspaceWatcher

**File operations:**
- `save-file` - Saves file, marks as editor save (prevents false AI attribution)
- `create-document` - Creates new files in workspace

---

## 6. Jotai Atoms

**File:** `packages/electron/src/renderer/store/atoms/sessionFiles.ts`

### Per-Session Atoms

```typescript
sessionFileEditsAtom(sessionId)        // FileEditWithSession[] - files edited by AI
sessionGitStatusAtom(sessionId)        // Record<string, FileGitStatus> - git status per file
sessionPendingReviewFilesAtom(sessionId) // Set<string> - files with pending AI edits
```

### Derived Workstream Atoms

```typescript
workstreamFileEditsAtom(workstreamId)  // Combines edits from all child sessions
workstreamGitStatusAtom(workstreamId)  // Combines git status from all child sessions
workstreamPendingReviewFilesAtom(workstreamId) // Combines pending files from all child sessions
```

### Per-Workspace/Worktree Atoms

```typescript
workspaceUncommittedFilesAtom(workspacePath) // string[] - all uncommitted files
worktreeChangedFilesAtom(worktreeId)         // WorktreeChangedFile[] - added/modified/deleted
worktreeGitStatusAtom(worktreeId)            // ahead/behind/uncommitted counts
```

### File Tree Atoms

**File:** `packages/electron/src/renderer/store/atoms/fileTree.ts`

```typescript
rawFileTreeAtom          // Complete file tree from workspace watcher
gitStatusMapAtom         // Map<filePath, gitStatus>
fileGitStatusAtom(path)  // Derived per-file git status
expandedDirsAtom         // Directory expansion state
visibleNodesAtom         // Flattened tree for virtualized rendering
```

---

## 7. TabEditor File Change Handling

**File:** `packages/electron/src/renderer/components/TabEditor/TabEditor.tsx`

TabEditor is the central component handling file change events for open files.

### Key Refs

- `contentRef` - Current editor content
- `lastSaveTimeRef` / `lastSavedContentRef` - Last save state (for own-save detection)
- `pendingAIEditTagRef` - Current pending AI edit tag if in diff mode
- `processingFileChangeRef` - Lock to prevent concurrent file change processing

### File Change Handler Flow (`file-changed-on-disk`)

1. **Lock** processing with `processingFileChangeRef` to prevent races
2. **Read** new content from disk
3. **Check pending AI edit tags** (checked BEFORE time-based heuristic):
   - If pending tag exists: enter/update diff mode (red/green diff display)
   - Fetch oldContent from tag baseline
   - Monaco: `showDiff(oldContent, newContent)`
   - Lexical: `APPLY_MARKDOWN_REPLACE_COMMAND` with diff nodes
   - Set `pendingAIEditTagRef` and `editorHasUnacceptedChangesAtom`
4. **If no pending tag**, apply time-based heuristic:
   - Skip if < 2000ms since last save AND content matches last saved content (own save echo)
   - Otherwise reload from disk
5. **Conflict detection** (dirty file + no pending tag + time > 2000ms):
   - Show conflict dialog: "Reload from Disk" or "Keep Local Changes"

### EditorHost Integration

**File:** `packages/electron/src/renderer/components/TabEditor/createEditorHost.ts`

Custom editors receive file changes via the EditorHost contract:

```typescript
onFileChanged(callback: (newContent: string) => void): () => void
```

Custom editors subscribe and decide whether to reload.

---

## 8. Red/Green Diff Display

### Diff Computation

Diffs are computed on-demand in the renderer. The algorithm varies by content type:

**File type routing (HistoryDialog.tsx):**
- **Markdown files:** Rich Lexical diff (`DiffPreviewEditor`) or line-based text diff (`TextDiffViewer`)
- **Code files:** Monaco built-in diff editor (`MonacoDiffViewer`)
- **Images:** Pixel-level comparison (`ImageDiffViewer`)
- **Other files:** `DiffPreview` with inline red/green spans

**Size-based fallback (DiffPreview.tsx):**
- Content > 500 chars: `diffLines()` (line-based)
- Content <= 500 chars: `diffWords()` (word-based)

Both use the `diff` npm package.

### UI Components

#### DiffPreview (Inline Red/Green)

**File:** `packages/electron/src/renderer/components/DiffPreview/DiffPreview.tsx`

Simple inline diff with colored spans:
- **Added:** `bg-green-500/15 text-green-500`
- **Removed:** `bg-red-500/15 text-red-500 line-through`
- **Unchanged:** `text-[var(--nim-text)] opacity-70`

#### TextDiffViewer (Side-by-Side Lines)

**File:** `packages/electron/src/renderer/components/HistoryDialog/TextDiffViewer.tsx`

Two-column view with old and new lines, synced scrolling, and change group navigation. Each line classified as `'added'`, `'removed'`, or `'unchanged'`.

#### MonacoDiffViewer (Code Files)

**File:** `packages/electron/src/renderer/components/HistoryDialog/MonacoDiffViewer.tsx`

Uses Monaco's built-in `createDiffEditor` for side-by-side code diffs with syntax highlighting. Monaco handles all diff computation and rendering internally.

#### DiffPreviewEditor (Rich Markdown)

**File:** `packages/electron/src/renderer/components/HistoryDialog/DiffPreviewEditor.tsx`

Uses the rexical package for semantic markdown diffs. Groups changes into `DiffChangeGroup` objects (removed/added/modified) and highlights them with CSS classes:
- `diff-group-highlight-removed`
- `diff-group-highlight-added`
- `diff-group-highlight-modified`

Supports navigation between change groups via `scrollToChangeGroup()`.

### Pending Review Flow (Live AI Edits)

When an AI edits a file that's currently open:

1. AI writes to disk -> ChokidarFileWatcher detects change
2. TabEditor receives `file-changed-on-disk` event
3. TabEditor checks for pending tags in `document_history` (status = `'pending-review'`)
4. If pending tag found: enters diff mode (Monaco diff or Lexical diff with red/green nodes)
5. **DiffApprovalBar** appears with accept/reject controls and session info
6. User accepts or rejects -> tag status updated to `'reviewed'`
7. `history:pending-cleared` event fires
8. TabEditor exits diff mode, reloads content from disk

---

## 9. Worktree Integration

Worktrees get dedicated change tracking for isolated AI coding sessions.

### State Setup

`loadInitialWorktreeState(worktreeId, worktreePath)` in `fileStateListeners.ts`:
1. Registers worktree path
2. Fetches initial changed files and git status
3. Calls `worktree:start-watching` to enable real-time git change detection

### Change Types

```typescript
interface WorktreeChangedFile {
  path: string;                    // relative path within worktree
  status: 'added' | 'modified' | 'deleted';
  staged: boolean;
}
```

### Git Status Refresh

When `git:status-changed` fires, the listener checks if the event is for any registered worktree and refreshes `worktreeChangedFilesAtom` and `worktreeGitStatusAtom` accordingly.

### File Staging

FilesEditedSidebar provides toggle-staging UI via `worktree:stage-file` IPC. The worktree state is automatically updated by the `git:status-changed` event listener after staging completes.

---

## 10. Lifecycle Summary

### Workspace Open
1. `startWorkspaceWatcher(window, workspacePath)` creates OptimizedWorkspaceWatcher + GitRefWatcher
2. IPC handlers `workspace-folder-expanded/collapsed` enable selective watching
3. `initFileStateListeners(workspacePath)` and `initFileTreeListeners(workspacePath)` start renderer subscriptions

### File Open (Tab)
1. TabEditor mounts -> `start-watching-file` IPC creates ChokidarFileWatcher
2. `file-changed-on-disk` events flow to TabEditor for conflict/diff handling

### AI Session Start
1. SessionFileWatcher initialized with ref-counted shared watcher
2. FileSnapshotCache captures workspace state (git baseline or full scan)
3. SessionFileTracker begins tracking tool executions

### AI Makes a Change
1. Tool execution captured by SessionFileTracker -> `session_files` record created
2. HistoryManager creates `pre-apply` + `ai-diff` snapshots in `document_history`
3. File watcher detects disk change -> `file-changed-on-disk` event
4. fileStateListeners updates `sessionFileEditsAtom`
5. TabEditor checks for pending tags -> enters diff mode if present
6. ToolCallMatcher correlates the file edit with the specific tool call

### User Reviews Change
1. DiffApprovalBar shows accept/reject controls
2. User accepts -> tag marked `'reviewed'` -> `history:pending-cleared` event
3. TabEditor exits diff mode, reloads from disk
4. GitRefWatcher auto-approves any remaining pending reviews on commit

### AI Session End
1. `SessionFileWatcher.stop()` releases shared watcher reference
2. When ref count reaches 0, shared watcher is closed

### App Quit
1. `stopAllFileWatchers()` closes all ChokidarFileWatcher instances
2. `stopAllWorkspaceWatchers()` closes OptimizedWorkspaceWatcher + GitRefWatcher (with 1000ms safety timeout for chokidar close)

---

## 11. Deletion Lifecycle and Four-Layer Autosave Defense

A real data-loss bug motivated this design: a file the user deleted, that an AI session later recreated with new content, was silently overwritten by an autosave from a stale editor buffer. The new content was lost.

The defense lands four independent guards. Any one missed pathway is still caught by the others.

### Layer A: Centralized `file-deleted` listener + atom family

`file-deleted` IPC events route through a single listener in `store/listeners/fileChangeListeners.ts`, which increments `fileDeletedAtomFamily(path)` (counter atom). Every tab system subscribes:

- `EditorMode` (Files mode) — closes any tab whose `filePath` matches
- `WorkstreamEditorTabsInner` (Agent mode) — closes its workstream tabs
- `HiddenTabManager` — unmounts hidden editors holding the deleted path

This is what eliminates the original bug: previously only `EditorMode` heard the deletion, leaving Agent Mode workstream tabs alive with stale buffers that could autosave a recreated file.

### Layer B: DocumentModel `deleted` flag

Each `DocumentModel` subscribes (via `DiskBackedStore.onDeletion`) to deletion events for its path. While `deleted === true`:

- `saveFromEditor` throws `FileDeletedError` without touching disk
- The autosave timer no-ops
- `lastPersistedContent` is set to `null` so a recreated file's `notifyFileChanged` does not get echo-suppressed against the pre-deletion content

The flag clears automatically on `loadContent()` or on `handleExternalChange` reading fresh content from disk. Both clear paths fire `editor:released-deleted-path` IPC so the main process can release the lifecycle entry (Layer C).

### Layer C: Lifecycle-bound `recentlyDeleted` map (no TTL)

`WindowManager` exposes `markRecentlyDeleted` / `clearRecentlyDeleted` / `isRecentlyDeleted`. The map is populated from three sources:

- `WorkspaceHandlers` `delete-file`, `rename-file`, and `move-file` IPC handlers
- `OptimizedWorkspaceWatcher.onUnlink` (covers external deletions discovered by the watcher, not just UI-initiated ones)

Entries are removed when the renderer fires `editor:released-deleted-path` after `loadContent` or `handleExternalChange` establishes a fresh baseline. A 5-minute absolute fallback prevents the map from growing without bound on a renderer crash. **No 10-second TTL** — that was the original (insufficient) approach.

### Layer D: Autosave `lastKnownContent` conflict detection

`TabEditor.saveWithHistory` captures `lastSavedContentRef.current` BEFORE the optimistic update and passes it to `electronAPI.saveFile(content, filePath, lastKnownContent)`. `FileHandlers.save-file` does:

1. If `recentlyDeletedFiles.has(filePath)` and the file exists on disk, return `{ success: false, conflict: true, diskContent }`. (File was deleted then recreated by something else.)
2. If `recentlyDeletedFiles.has(filePath)` and file does not exist, return `{ success: false, deleted: true }`.
3. Otherwise, if `lastKnownContent !== diskContent`, return a conflict.

For autosaves, the renderer never auto-overwrites on conflict. It surfaces a non-blocking banner: `"File changed on disk. Reload to see new content (your unsaved edits are preserved)."` with Reload / Dismiss buttons. The buffer stays dirty. Manual save retains the original prompt path.

### Deletion Sequence (ASCII)

```
User deletes file F (or external process / watcher detects unlink)
  |
  +-- WorkspaceHandlers / Watcher: markRecentlyDeleted(F)            <-- Layer C
  |
  +-- IPC file-deleted broadcast to renderer
       |
       +-- fileChangeListeners increments fileDeletedAtomFamily(F)   <-- Layer A
            |
            +-- EditorMode subscription -> tabsActions.removeTab     <-- Layer A
            +-- WorkstreamEditorTabsInner -> tabsActions.removeTab   <-- Layer A
            +-- HiddenTabManager -> unmountEditor                    <-- Layer A
            +-- DocumentModel via DiskBackedStore.onDeletion         <-- Layer B
                 |
                 +-- markDeleted(): sets deleted=true,
                                    clears lastPersistedContent
                 +-- saveFromEditor now throws FileDeletedError
                 +-- autosaveTimer ticks no-op while deleted
```

### Recreation / Reload Sequence (ASCII)

```
File reappears on disk (AI recreates, user reverts, etc.)
  |
  +-- Watcher onAdd / onChange -> file-changed-on-disk IPC
       |
       +-- DocumentModel.handleExternalChange reads fresh content
            |
            +-- if deleted: deleted=false; emit editor:released-deleted-path
                 |
                 +-- WorkspaceHandlers clears recentlyDeleted entry (Layer C)
            +-- notifyFileChanged(content) to all attachments
       |
       +-- TabEditor reload path picks up new content

OR (explicit user reload):
  User clicks Reload on the autosave-conflict-banner
  |
  +-- DocumentModel.loadContent
       |
       +-- deleted=false; editor:released-deleted-path
       +-- lastPersistedContent = freshContent
```

### Why all four layers

- **A alone** doesn't help if a future tab system forgets to subscribe.
- **B alone** doesn't help if a save bypass path skips DocumentModel (extension-defined editors writing directly).
- **C alone** doesn't help if the original 10-second TTL races a recreation more than 10 seconds later.
- **D alone** doesn't help if `lastKnownContent` is forgotten by a future caller.

Defense in depth: a missed pathway anywhere is still caught somewhere else, with telemetry visibility on which layer caught it.

---

## Key Files Reference

### Main Process - Watchers

| File | Purpose |
|------|---------|
| `packages/electron/src/main/file/ChokidarFileWatcher.ts` | Per-file watcher for open tabs |
| `packages/electron/src/main/file/OptimizedWorkspaceWatcher.ts` | Workspace directory watcher (platform-optimized) |
| `packages/electron/src/main/file/GitRefWatcher.ts` | Git commit and staging detection |
| `packages/electron/src/main/file/SessionFileWatcher.ts` | Per-session AI change tracking |
| `packages/electron/src/main/file/FileSnapshotCache.ts` | Before/after state cache for AI diffs |

### Main Process - Change Tracking

| File | Purpose |
|------|---------|
| `packages/electron/src/main/HistoryManager.ts` | Snapshot storage, compression, dedup, cleanup |
| `packages/electron/src/main/services/SessionFileTracker.ts` | Captures tool executions, links files to sessions |
| `packages/electron/src/main/services/PGLiteSessionFileStore.ts` | Database abstraction for session_files |
| `packages/electron/src/main/services/ToolCallMatcher.ts` | Correlates file edits with AI tool calls |

### Main Process - IPC Handlers

| File | Purpose |
|------|---------|
| `packages/electron/src/main/ipc/FileHandlers.ts` | File watcher control, save, create |
| `packages/electron/src/main/ipc/SessionFileHandlers.ts` | Session file operations |
| `packages/electron/src/main/ipc/HistoryHandlers.ts` | Snapshot and pending tag operations |

### Renderer - State

| File | Purpose |
|------|---------|
| `packages/electron/src/renderer/store/atoms/sessionFiles.ts` | Jotai atoms for file edit/git/pending state |
| `packages/electron/src/renderer/store/atoms/fileTree.ts` | File tree atoms |
| `packages/electron/src/renderer/store/listeners/fileStateListeners.ts` | Central IPC listeners for file state |
| `packages/electron/src/renderer/store/listeners/fileTreeListeners.ts` | Central IPC listeners for file tree |

### Renderer - UI Components

| File | Purpose |
|------|---------|
| `packages/electron/src/renderer/components/TabEditor/TabEditor.tsx` | File change handling, conflict resolution, diff mode |
| `packages/electron/src/renderer/components/TabEditor/createEditorHost.ts` | EditorHost contract for custom editors |
| `packages/electron/src/renderer/components/HistoryDialog/HistoryDialog.tsx` | Snapshot comparison and diff viewer routing |
| `packages/electron/src/renderer/components/HistoryDialog/TextDiffViewer.tsx` | Line-based side-by-side diff |
| `packages/electron/src/renderer/components/HistoryDialog/MonacoDiffViewer.tsx` | Monaco-powered code diff |
| `packages/electron/src/renderer/components/HistoryDialog/DiffPreviewEditor.tsx` | Rich Lexical markdown diff |
| `packages/electron/src/renderer/components/DiffPreview/DiffPreview.tsx` | Inline red/green diff spans |
| `packages/electron/src/renderer/components/AgentMode/FilesEditedSidebar.tsx` | Session file list with staging UI |
