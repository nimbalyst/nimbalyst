# Git Worktree Integration

Nimbalyst supports creating git worktrees for isolated AI coding sessions. This allows Claude Code to work in a separate branch without affecting the main workspace, enabling safe experimentation and parallel development workflows.

## Overview

Git worktrees allow you to have multiple working directories from a single git repository, each checked out to a different branch. Nimbalyst leverages this to create isolated environments for AI-assisted coding sessions.

## Key Concepts

### Worktree Sessions vs Regular Sessions

- **Regular AI Sessions**: Run in the main workspace directory, operate on the current branch
- **Worktree Sessions**: Run in a separate directory with their own branch, isolated from the main workspace

### Relationship Model

**One worktree can have multiple sessions, but one session can only belong to one worktree.**

This is implemented using a foreign key relationship:
- `ai_sessions.worktree_id` → `worktrees.id` (nullable, many-to-one)
- When `worktree_id` is NULL, the session is a regular session
- When `worktree_id` is set, the session belongs to that worktree

## Database Schema

### worktrees Table

Stores metadata about git worktrees created from Nimbalyst.

```sql
CREATE TABLE worktrees (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,  -- The main workspace/project path
  name TEXT NOT NULL,           -- Human-readable worktree name
  path TEXT NOT NULL,           -- Absolute path to worktree directory
  branch TEXT NOT NULL,         -- Git branch name for this worktree
  base_branch TEXT DEFAULT 'main',  -- Branch this worktree was created from
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_worktrees_workspace ON worktrees(workspace_id);
CREATE INDEX idx_worktrees_path ON worktrees(path);
```

### ai_sessions Table (Worktree Association)

The `ai_sessions` table includes a foreign key to associate sessions with worktrees.

```sql
ALTER TABLE ai_sessions ADD COLUMN worktree_id TEXT REFERENCES worktrees(id) ON DELETE SET NULL;
CREATE INDEX idx_ai_sessions_worktree ON ai_sessions(worktree_id);
```

When a worktree is deleted, the `worktree_id` is set to NULL for all associated sessions. This preserves the session history while marking that the worktree no longer exists.

### TypeScript Interface

The `Worktree` interface used in both main and renderer processes:

```typescript
interface Worktree {
  id: string;           // Unique identifier (ULID)
  name: string;         // Adjective-noun name (e.g., "swift-falcon")
  path: string;         // Absolute filesystem path to worktree
  branch: string;       // Git branch (e.g., "worktree/swift-falcon")
  baseBranch: string;   // Base branch for comparison (e.g., "main")
  projectPath: string;  // Path to main workspace (maps to workspace_id in DB)
  createdAt: number;    // Creation timestamp in milliseconds
  updatedAt?: number;   // Last update timestamp in milliseconds
}
```

## Architecture

### Main Process Services

#### GitWorktreeService

**Location**: `packages/electron/src/main/services/GitWorktreeService.ts`

Manages git worktree operations using the `simple-git` library.

**Key methods:**
- `createWorktree(workspacePath, options?)`: Creates a new git worktree
  - Generates unique name using adjective-noun pattern (e.g., `swift-falcon`)
  - Creates branch with `worktree/` prefix (e.g., `worktree/swift-falcon`)
  - Creates worktree in `../{project_name}_worktrees/` directory
  - Handles name conflicts by appending incrementing numbers
  - `branchSuffix` (a name the user typed) sets the branch exactly; see [Branch names](#branch-names)
  - Treats a path git still registers as taken even when its folder is missing (as on an unmounted drive), so the folder takes a `-N`; git would otherwise create the branch and then fail on the path. So is a path in `takenPaths`, which `worktree:create` fills with every path a worktree row records: an archived worktree's row keeps its path after its folder is gone, and the store refuses a second row with it
  - Refuses, before anything is created, a branch that conflicts with an existing one, with a message naming that branch
  - Runs `git branch` and then `git worktree add`, the two steps `worktree add -b` runs itself, so a failure shows whether the attempt made the branch
  - Refuses a base branch that starts with `-`, which `git branch` would read as an option (`-m` would rename the checked-out branch)
  - When `git worktree add` fails part way (a failing `post-checkout` hook leaves the folder, its registration and the branch), removes only what that attempt provably created, through `git worktree remove --force` and `git branch -D`: the branch its own `git branch` made, and a registration at the target with that branch checked out. A branch or registration that existed before stays (an empty folder git adopted at the target goes with the attempt's registration), and so does a worktree another app or a terminal registered at the same path meanwhile, or a folder git did not register in the attempt, which may be anyone's. The error names what the attempt provably created and could not remove; a registration a hook switched to another branch counts as someone else's, so it stays and is not named
  - Returns worktree metadata
- `getWorktreeStatus(worktreePath)`: Fetches git status for a worktree
  - Returns `hasUncommittedChanges` boolean
  - Returns `modifiedFileCount` for number of changed files
  - Returns `commitsAhead`/`commitsBehind` relative to base branch
  - Returns `isMerged` status
- `deleteWorktree(worktreePath, workspacePath, { expectedBranch? })`: Removes a git worktree
  - Deletes the worktree directory
  - Removes git worktree registration
  - Deletes the associated branch; with `expectedBranch` (the row's branch), no other branch, so a worktree switched to another branch keeps both. The checked-out branch comes from `git worktree list`, which reads HEAD through git on every ref format; the admin dir's `HEAD` file is used only when the list names the worktree under another spelling, and on the reftable format it names no branch, so the branch is then kept
  - Refuses, before deleting anything, each case below. The key is `WorktreeRemovalRefusedError.reason`:
    - `not-owned`: not a worktree of `workspacePath`, even at a path this repository still lists. Its `.git` file must point into this repository's admin area, and that admin dir must name this very directory back, compared by file identity; a `.git` directory or a link into another repository fails this
    - `main-worktree`: the repository's own working tree
    - `moved`: a checkout moved by hand; the message suggests `git worktree repair` run inside it
    - `copy`: a copy of a worktree git tracks elsewhere, including a hard-linked copy or one whose `.git` is a symlink to the live worktree's. No repair advice, since a repair there would take the live worktree's registration
    - `locked`: a locked worktree, with the lock read from the list and from the admin dir
    - `contains-worktree`: a worktree that holds another of the repository's registered worktrees inside its checkout, as Claude Code's own `.claude/worktrees/<name>` does, since deleting it would delete the inner one too. The message names `git worktree remove` and `git worktree move` as the ways out
    - `unverifiable`: any directory still on disk when git cannot be asked or its `.git` file cannot be read, and a registered path whose `.git` file names a different admin dir than the one git lists it under (only a hand edit of the admin area produces this)
    - `untracked`: a folder git no longer tracks, described below
  - Refusals throw `WorktreeRemovalRefusedError`; `checkWorktreeRemovable` answers the same question without changing anything, so `worktree:archive` and `worktree:delete` refuse before destroying terminals or stopping the ref watcher, and a refused archive cleanup always shows the sessions again
  - Deletes the directory before unregistering it, so a removal that fails part way (a file held open on Windows) keeps the registration and can be run again
  - Deletes through `original-fs` in Electron's main process: the asar-aware `fs.promises.rm` never settles on a tree holding an `.asar` file (any Electron project's `node_modules`), which would hold the repository lock for good. There is no time limit on the delete: a caller that gave up waiting would show the sessions again while the delete went on in the background. Other git operations on the repository stop waiting for its lock after 30 seconds on their own. Archive cleanups run one at a time through one queue for all repositories, and a pending one is replayed at the next launch, so a delete that never settles (a stalled network drive) holds up every later archive cleanup, in this run and again after each restart, until the drive answers. A `git worktree remove` that hung did the same before
  - Before unregistering, checks that nothing exists at the path git records, because `git worktree remove --force` on an existing directory deletes it
  - A worktree whose directory is gone and which git no longer lists (or git cannot be asked) counts as already removed; its branch is kept
  - A worktree whose directory is gone, or whose `.git` file is gone, but which git still lists is finished off and unregistered; its branch is deleted only when merged, because a checkout moved by hand may hold the only copy of its commits. Unregistering disconnects such a checkout (its `.git` file then points to a deleted admin dir, so git no longer treats it as a checkout), and `git worktree add <path> <branch>` can check the kept branch out again
  - A folder git no longer tracks is refused, and archiving it finishes once nothing is left at its path: a checkout whose `.git` file points into this repository at an admin dir that no longer exists (a `git worktree remove` that could not delete every file, a prune while the checkout was offline, or a repository cloned again at the same path, where the folder may hold the only copy of its commits), and an unregistered folder without a `.git` file. Git cannot check either for uncommitted changes
  - Not detected: a checkout of another repository, or another repository's linked worktree, nested inside the worktree's directory. Git lists only this repository's worktrees, and finding the others would mean walking the whole tree, so they are deleted with the directory
  - Needs git 2.17 or later (`git worktree remove`)
- `listWorktrees(workspacePath)`: Lists all git worktrees for a repository
  - Returns array of worktree paths, branches, and isMain flag

#### WorktreeStore

**Location**: `packages/electron/src/main/services/WorktreeStore.ts`

Database persistence layer for worktree metadata.

**Key methods:**
- `create(worktree)`: Insert new worktree record
- `get(id)`: Retrieve worktree by ID
- `getByPath(path)`: Retrieve worktree by filesystem path
- `list(workspaceId)`: List all worktrees for a workspace
- `update(id, updates)`: Update worktree fields (name, path, branch, etc.)
- `delete(id)`: Delete worktree record by ID
- `deleteByPath(path)`: Delete worktree record by filesystem path
- `exists(path)`: Check if worktree exists by path
- `getWorktreeSessions(worktreeId)`: Get all session IDs associated with a worktree

### IPC Communication

**Location**: `packages/electron/src/main/ipc/WorktreeHandlers.ts`

Exposes worktree operations to the renderer process via IPC.

**IPC Channels:**
- `worktree:create` - Create new worktree. Options: `name`, `baseBranch`, `sourceFolderPath`, and `nameSource` (`'user'` when the user typed or edited `name`, which then becomes the branch exactly and is validated before any git call; absent or `'suggested'` keeps the `-N` renaming)
- `worktree:get-status` - Get git status for worktree
- `worktree:delete` - Delete worktree and its database record
- `worktree:list` - List all worktrees for a workspace
- `worktree:get` - Get single worktree by ID

**Preload API** (`packages/electron/src/preload/index.ts`):
```typescript
window.electronAPI.worktreeCreate(workspacePath, name?)
window.electronAPI.worktreeGetStatus(worktreePath)
window.electronAPI.worktreeDelete(worktreeId, workspacePath)
window.electronAPI.worktreeList(workspacePath)
window.electronAPI.worktreeGet(worktreeId)
```

### Renderer Services

#### RendererWorktreeService

**Location**: `packages/electron/src/renderer/services/RendererWorktreeService.ts`

Type-safe wrapper around worktree IPC calls for the renderer process.

Returns consistent `{ success, data?, error? }` shape for all operations.

## UI Components

### WorktreeSingle Component

**Location**: `packages/electron/src/renderer/components/AgenticCoding/WorktreeSingle.tsx`

Displays a worktree session with distinctive visual treatment:

**Visual elements:**
- Worktree icon (git branch SVG) with small AI provider badge overlay in bottom-right corner
- Session title on first line
- Meta row showing: worktree name (blue) + git status badges (ahead/behind/uncommitted)
- Message count badge on right

**Props:**
```typescript
interface WorktreeSingleProps {
  session: SessionListItemData;
  worktreeName: string;
  worktreePath: string;
  gitStatus?: {
    ahead?: number;
    behind?: number;
    uncommitted?: boolean;
  };
  isActive: boolean;
  onClick: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}
```

### New Worktree Button

**Location**: `packages/electron/src/renderer/components/AgenticCoding/SessionHistory.tsx`

- Position: Agent mode sidebar header, next to the existing "New Session" button
- Icon: Git branch icon
- Tooltip: "New Worktree"
- Behavior: Creates worktree first, then creates a Claude Code session associated with it

## Workflow

### Creating a Worktree Session

1. User clicks "New Worktree" button in agent mode
2. `SessionHistory.tsx` calls `handleNewWorktreeSession()`
3. IPC call to `worktree:create` with workspace path
4. `GitWorktreeService` creates git worktree:
   - Generates unique branch name (e.g., `worktree-01JBCD3FG2H5K6M7N8P9QR`)
   - Creates directory: `../{project_name}_worktrees/{branch_name}/`
   - Checks out new branch in that directory
5. `WorktreeStore` saves worktree metadata to database
6. AI session created with `worktreeId` set
7. `SessionManager` passes `worktreePath` to `ClaudeCodeProvider`
8. Claude Code operations execute in the worktree directory

### Session-Worktree Association

When creating a session with worktree:

```typescript
// In AIService.ts
const session = await this.sessionManager.createSession({
  provider: 'claude-code',
  workspacePath: worktree.path,  // Use worktree path instead of main workspace
  worktreeId: worktree.id,        // Associate with worktree
  // ... other params
});
```

The `worktreePath` is used as the working directory for Claude Code, ensuring all file operations happen in the isolated worktree.

### Displaying Worktree Sessions

`SessionHistory.tsx` groups sessions by worktree association:

1. Sessions with `worktreeId` are rendered using `WorktreeSingle` component
2. Sessions without `worktreeId` are rendered as regular sessions
3. Worktree sessions appear first, followed by regular sessions

## File Locations

### Worktree Directory Structure

Worktrees are created outside the main workspace:

```
/path/to/project/                    # Main workspace
/path/to/project_worktrees/          # Worktrees directory
  └── swift-falcon/                  # Individual worktree (adjective-noun name)
      ├── .git (file pointing to main repo)
      └── ... (project files)
```

The branch name follows the pattern `worktree/{worktree-name}` (e.g., `worktree/swift-falcon`), except for a name the user typed (see below).

### Branch names

`packages/electron/src/shared/worktreeBranchNaming.ts` holds the rules, shared by the worktree dialog and the main process.

- **No name typed**: a generated name; folder and branch are `swift-falcon` and `worktree/swift-falcon`.
- **A name the user typed or edited** (`nameSource: 'user'`), e.g. `feat/x`: the branch is exactly `worktree/feat/x` and never takes a `-N`. The folder and the row's `name` are its one-segment form `feat-x` (`/` becomes `-`, characters Windows cannot hold in a file name are dropped, dashes collapse, leading and trailing dots and dashes go, and a Windows device name such as `con` gets a `_`). The folder still takes a `-N` when it is taken: on disk, registered with git, or recorded by a worktree row, archived ones included. A branch that conflicts with an existing one (the same name, a branch at a parent path such as `worktree/feat` or a bare `worktree`, or branches below it) fails with a message naming that branch; on macOS and Windows, and wherever git reports `core.ignorecase` (such as a Windows drive mounted in WSL), names that differ only in case count as the same.
- **Suggested names** keep folder and branch on the same final name, with `-N` added to both when the folder is taken: a tracker item's prefilled name the user did not edit, and PR review's `pr-<number>`. A branch conflict on a suggested name fails; only a generated name is retried with a fresh one. PR review (`pr:open-worktree`) creates its worktree outside `worktree:create` and does not yet pass the recorded paths, so a PR reviewed again after its worktree was archived still fails to record the new row.
- **Validation** of a typed name follows `git check-ref-format --branch` for `worktree/<name>`, plus Nimbalyst policy rules git itself does not have: at most 64 characters, no leading `-`, and nothing Git for Windows cannot store as a branch file, since a branch travels between machines: none of `< > " |`, no part between `/` that ends in `.`, and no part that is a Windows device name (`con`, `aux`, `nul.txt`, `com1`, `conin$`, ...).
- Only the name crosses IPC; the main process adds the `worktree/` prefix.

Earlier versions created nested folders for a typed name with `/` (`feat/x` became `{project_name}_worktrees/feat/x`), and nested worktree paths stay supported (#708): existing nested worktrees keep working. Only new typed names get one-segment folders.

This keeps worktrees separate from the main workspace while maintaining git connectivity.

## Provider Integration

### Claude Code Provider

**Location**: `packages/runtime/src/ai/server/providers/ClaudeCodeProvider.ts`

The provider accepts a `workspacePath` parameter. For worktree sessions:
- Main workspace sessions: `workspacePath = /path/to/project`
- Worktree sessions: `workspacePath = /path/to/project_worktrees/branch-name`

All Claude Code operations (file reads, writes, tool calls) execute in the specified workspace path, ensuring worktree isolation.

## Testing

### E2E Tests

**Location**: `packages/electron/e2e/worktree/worktree-session-creation.spec.ts`

Tests verify:
1. "New Worktree" button appears in agent mode
2. Clicking creates a git worktree in the filesystem
3. Session is created with worktree association
4. WorktreeSingle component renders with correct visual treatment
5. Claude Code runs in the worktree directory (when provider is configured)

**Test selectors** (`packages/electron/e2e/utils/testHelpers.ts`):
- `newWorktreeSessionButton`: `[data-testid="new-worktree-session-button"]`
- `worktreeSingle`: `.worktree-single`
- `worktreeSingleActive`: `.worktree-single.active`
- `worktreeSingleBadge`: `.worktree-single-wt-badge` (worktree icon badge)
- `worktreeSingleName`: `.worktree-single-name`
- `worktreeSingleTitle`: `.worktree-single-title`
- `worktreeSingleMessageCount`: `.worktree-single-message-count`

## Platform Compatibility

The implementation is cross-platform compatible:
- Uses Node.js `path` module for all path operations
- Git commands via `simple-git` work on Windows, macOS, and Linux
- Worktree paths are normalized for the current platform

## Error Handling

All worktree operations follow the project's error handling patterns:

1. **Parameter validation**: Required parameters throw if missing
2. **IPC responses**: Return `{ success, data?, error? }` shape
3. **Logging**: All operations logged with `log.scope('WorktreeHandlers')` or `log.scope('GitWorktreeService')`
4. **User feedback**: Errors should be surfaced to users (implementation TBD)

## Future Enhancements

Potential features for worktree sessions:

- Worktree renaming when session is named
- Diff view showing changes in worktree vs base branch
- Commit and merge operations from the UI
- Git status polling and real-time updates
- Multi-session worktree groups (multiple sessions sharing one worktree)

## Related Documentation

- [AI_PROVIDER_TYPES.md](AI_PROVIDER_TYPES.md) - AI provider architecture
- [INTERNAL_MCP_SERVERS.md](INTERNAL_MCP_SERVERS.md) - MCP server implementation
- [ANALYTICS_GUIDE.md](ANALYTICS_GUIDE.md) - Adding analytics events
