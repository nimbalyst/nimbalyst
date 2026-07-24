# Git Integration Architecture

This document explains how Nimbalyst integrates with git to provide real-time status updates throughout the application.

## Overview

Nimbalyst uses an **event-driven architecture** for git integration. All git status updates are triggered by file system events, not polling. This provides immediate updates while minimizing system resource usage.

## Core Components

### 1. GitRefWatcher (Main Process)

**Location**: `packages/electron/src/main/file/GitRefWatcher.ts`

The GitRefWatcher is the heart of our git integration. It watches specific git internal files to detect state changes:

- **`.git/refs/heads/<branch>`** - Detects commits (file changes when HEAD moves)
- **`.git/index`** - Detects staging changes (file changes on `git add`/`git reset`)

When changes are detected, GitRefWatcher:
1. Invalidates the GitStatusService cache
2. Emits `git:status-changed` event to all windows
3. For commits: identifies changed files and auto-approves pending reviews
4. Emits `git:commit-detected` event with commit details

**Key principle**: GitRefWatcher detects ALL git operations regardless of source - Nimbalyst UI, CLI, VS Code, or any other git tool.

### 2. GitStatusService (Main Process)

**Location**: `packages/electron/src/main/services/GitStatusService.ts`

Provides git status queries with a short-lived cache:

- **Cache TTL**: 5 seconds (safety net, not primary update mechanism)
- **Cache invalidation**: Called by GitRefWatcher when git state changes
- **Methods**: `getFileStatus()`, `getUncommittedFiles()`, `getAllFileStatuses()`, etc.

The cache exists to prevent redundant git commands when multiple components query status in quick succession. It is NOT a polling mechanism.

### 3. IPC Events

Two events propagate git changes to the renderer:

| Event | Trigger | Payload |
|-------|---------|---------|
| `git:status-changed` | Any git state change (staging, commits, etc.) | `{ workspacePath }` |
| `git:commit-detected` | New commit detected | `{ workspacePath, commitHash, commitMessage, committedFiles }` |

## Data Flow

```
User/External Tool performs git operation
        │
        ▼
.git/refs or .git/index file changes
        │
        ▼
GitRefWatcher (Chokidar) detects change
        │
        ├──► GitStatusService.clearCache(workspacePath)
        │
        ├──► Emit 'git:status-changed' to all windows
        │
        └──► If commit detected:
                ├──► Auto-approve pending reviews for committed files
                └──► Emit 'git:commit-detected' to all windows
        │
        ▼
Renderer components receive events
        │
        ├──► GitOperationsPanel: refreshes branch/ahead/behind/commits
        ├──► WorkspaceSidebar: refreshes file tree badges
        └──► FilesEditedSidebar: updates via history:pending-count-changed
```

## Renderer Components

### GitOperationsPanel

**Location**: `packages/electron/src/renderer/components/AgentMode/GitOperationsPanel.tsx`

Displays branch info, ahead/behind counts, and commit controls.

**Git queries triggered by**:
- Initial mount (once)
- `git:status-changed` event
- `git:commit-detected` event
- After manual commit action

**NO POLLING** - removed as of 2026-01-23.

### WorkspaceSidebar (File Tree)

**Location**: `packages/electron/src/renderer/components/WorkspaceSidebar.tsx`

Shows git status badges (M, A, ?) on files in the tree.

**Git queries triggered by**:
- Initial mount (once)
- File tree changes (debounced 500ms) - reacts to workspace file watcher
- `git:status-changed` event

### FilesEditedSidebar

**Location**: `packages/runtime/src/components/FileEditsSidebar.tsx`

Shows files edited in AI sessions with pending review status.

Listens to `history:pending-count-changed` which is emitted when:
- User clicks "Keep All"
- GitRefWatcher auto-approves files on commit

## Important Rules

### DO NOT Add Polling

The previous implementation had a 30-second polling interval. This was removed because:

1. **Wasteful**: Runs git commands even when nothing changed
2. **Laggy**: Up to 30 seconds before UI reflects changes
3. **Redundant**: GitRefWatcher provides immediate updates

If you find yourself wanting to add `setInterval` for git status, STOP. Instead:
- Ensure the component listens to `git:status-changed` event
- Check that GitRefWatcher is running for the workspace

### Cache is Not Polling

The 5-second cache TTL in GitStatusService is NOT a polling mechanism. It:
- Prevents duplicate git commands within a 5-second window
- Gets invalidated immediately when GitRefWatcher detects changes
- Serves as a safety net if events are somehow missed

### Event-Driven Updates

All git UI updates should follow this pattern:

```typescript
// Initial fetch on mount
useEffect(() => {
  fetchGitStatus();

  // Listen for changes
  const unsubscribe = window.electronAPI?.git?.onStatusChanged?.(
    (data) => {
      if (data.workspacePath === workspacePath) {
        fetchGitStatus();
      }
    }
  );

  return () => unsubscribe?.();
}, [workspacePath]);
```

## Lifecycle

### Workspace Open

1. `WorkspaceWatcher` initializes for the workspace
2. `GitRefWatcher.start(workspacePath)` is called
3. Watcher begins monitoring `.git/refs/heads/<branch>` and `.git/index`

### Workspace Close

1. `GitRefWatcher.stop(workspacePath)` is called
2. File watchers are cleaned up
3. Cache entries for workspace are cleared

### Branch Switch

GitRefWatcher automatically handles branch switches by watching the current branch ref file.

## Auto-Approve Pending Reviews

When a commit is detected, GitRefWatcher:

1. Gets the list of files in the commit via `git diff`
2. For each file, checks for pending review tags in `document_history`
3. Marks matching tags as `'reviewed'`
4. Emits `history:pending-count-changed` to update UI

This means committing files (from any source) automatically "approves" the AI edits, just like clicking "Keep All" in the Files Edited sidebar.

## Debugging

### Check if GitRefWatcher is Running

Look for log messages:
```
[GitRefWatcher] Started watching: /path/to/workspace
[GitRefWatcher] New commit detected: { workspace: 'name', hash: 'abc1234', message: '...' }
```

### Verify Events are Firing

In renderer DevTools:
```javascript
window.electronAPI.git.onStatusChanged((data) => console.log('status changed', data));
window.electronAPI.git.onCommitDetected((data) => console.log('commit detected', data));
```

### Common Issues

| Symptom | Likely Cause | Solution |
|---------|--------------|----------|
| Git status not updating | GitRefWatcher not started | Check workspace initialization |
| Status updates delayed | Cache not invalidated | Verify `clearCache()` is called |
| External commits not detected | Watching wrong branch | Check branch detection logic |
