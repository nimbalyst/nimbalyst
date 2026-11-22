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
  - Bases the branch on `options.baseBranch` when given, otherwise on the project's default base (see [Default base branch](#default-base-branch))
  - Always passes `--no-track`, so `worktree/<name>` never gets an upstream
  - Returns worktree metadata
- `getWorktreeStatus(worktreePath)`: Fetches git status for a worktree
  - Returns `hasUncommittedChanges` boolean
  - Returns `modifiedFileCount` for number of changed files
  - Returns `commitsAhead`/`commitsBehind` relative to base branch
  - Returns `isMerged` status
- `deleteWorktree(worktreePath, workspacePath)`: Removes a git worktree
  - Deletes the worktree directory
  - Removes git worktree registration
  - Deletes the associated branch
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
- `worktree:create` - Create new worktree
- `worktree:get-status` - Get git status for worktree
- `worktree:delete` - Delete worktree and its database record
- `worktree:list` - List all worktrees for a workspace
- `worktree:get` - Get single worktree by ID
- `worktree:resolve-default-base` - Resolve the default base a new worktree would get (picker pre-select, settings panel); never fetches
- `worktree:set-default-base` - Set or clear the project's default base setting

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
2. `WorktreeBaseBranchPicker` opens: it lists local and cached remote branches, pre-selects the project's default base for the owning workspace (labeled "(project default)"; a default that is not in either list, such as a detached-HEAD SHA, gets its own "Project default" row), and runs `git:fetch` in the background. After the fetch it re-resolves the default and re-selects it only if the user has not picked a branch. A failed fetch shows a note instead of failing silently.
3. IPC call to `worktree:create` with the workspace path, the chosen base, an optional name, and the source folder for multi-root workspaces
4. `GitWorktreeService` creates git worktree:
   - Generates a unique adjective-noun name (e.g., `swift-falcon`) unless one was given
   - Creates directory: `../{project_name}_worktrees/{name}/`
   - Runs `git worktree add --no-track -b worktree/{name} <path> <base>`
5. `WorktreeStore` saves worktree metadata to database. `base_branch` stores the base as resolved, which may be a remote ref such as `origin/main`
6. AI session created with `worktreeId` set
7. `SessionManager` passes `worktreePath` to `ClaudeCodeProvider`
8. Claude Code operations execute in the worktree directory

### Default base branch

A worktree created without an explicit base (spawn_session and create_session with `useWorktree`, mobile, Blitz, Super Loop, the tip flow) gets the project's default base. The resolver is `services/worktreeBaseBranch.ts` and runs inside `GitWorktreeService.createWorktree`, so those entry points pass no base. An explicit base always wins: the picker passes the user's choice, and PR review worktrees pass the PR head.

The setting is `WorkspaceState.worktreeDefaultBase` (`{ mode: 'remote-default' | 'current-branch' | 'custom'; ref? }`), edited in Project Settings > Worktrees. Unset means `remote-default`. Resolution order:

- `remote-default`: pick `origin`, or the only remote if there is no `origin`. Use `<remote>/HEAD` if it points at an existing ref, then `<remote>/main`, then `<remote>/master`. With no usable remote ref (none, or a dangling `<remote>/HEAD`), use the local branch `resolveMainBranch` names (`utils/gitAgentContext.ts`), then local `main`, then local `master`, then the main checkout's current branch. Each step past the remote refs is reported as `source: 'fallback'` with a `fallbackReason`.
- `current-branch`: the main checkout's current branch, or its commit SHA on a detached HEAD. An unborn branch (no commits) resolves to nothing, so creation throws `WorkspaceHasNoCommitsError`.
- `custom`: the configured ref (local branch or remote ref) if it resolves to a commit in this repo; otherwise the `remote-default` order, with a reason such as `origin/develop not found locally`. For attached folders in a multi-root workspace this means a custom ref applies only where it exists.

Resolution never fails worktree creation because of the setting. It does not fetch: when the resolved default is a remote ref, `createWorktree` runs one `git fetch <remote> <branch>` bounded at 5 seconds BEFORE taking the git operation lock, so other operations on the repo do not queue behind it. On timeout the fetch's git process is killed (abort signal). Creation then resolves again inside the lock and uses whatever ref is cached, logging a failed fetch.

Resolved refs stay fully qualified (`refs/remotes/origin/main`, `refs/heads/main`) through the fetch and `git worktree add`, because a short `origin/main` is ambiguous when a local branch of that name exists and git would pick the local one. The short form (`origin/main`) is what `worktrees.base_branch` stores and the picker shows.

An explicit base is validated before `git worktree add`: it must not start with `-` and must resolve to a commit (`rev-parse --verify --quiet <ref>^{commit}`), otherwise creation fails with `Base branch "<ref>" not found`.

New branches use `--no-track`. Without it git's default `branch.autoSetupMerge` makes `worktree/<name>` track `origin/main`, and under `push.default=upstream` a bare `git push` from the worktree would push to `main`.

Remote-ref bases downstream: `worktree:get-status` with `fetchFirst` splits a stored base like `origin/main` into remote and branch (checked against `git remote`, so a local branch named `origin/foo` is not misread) and runs `git fetch origin main`. Ahead/behind, diff, commits and rebase work against the remote ref as is. `mergeToMain` still targets the branch from `inferBaseBranch`, not the stored base.

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

The branch name follows the pattern `worktree/{worktree-name}` (e.g., `worktree/swift-falcon`).

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
