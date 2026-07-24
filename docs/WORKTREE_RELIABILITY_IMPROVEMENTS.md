# Worktree Reliability Improvements

This document outlines critical, high, and medium priority improvements to make git worktree operations bulletproof and ensure users are never left in a bad state.

## Critical Priority

### 1. Database-Git State Inconsistency on Create

**File**: `packages/electron/src/main/ipc/WorktreeHandlers.ts`
**Lines**: 111-147

**Problem**: The worktree creation flow creates the git worktree first, then inserts into the database. If the DB insert fails, an orphaned git worktree exists on disk but isn't tracked in the database.

**Current Code**:
```typescript
// Line 113: Git worktree created
const worktree = await gitWorktreeService.createWorktree(workspacePath, { name: finalName });

// Line 118: DB insert happens after - if this fails, worktree exists but isn't tracked
await worktreeStore.create(worktree);
```

**Solution**: Add cleanup in the catch block to remove the git worktree if DB insert fails. The catch block should check if `worktree` was created and clean it up before returning the error.

---

### 2. No Recovery for Partial Archive Failures

**File**: `packages/electron/src/main/ipc/WorktreeHandlers.ts`
**Lines**: 867-1046

**Problem**: The archive flow has a multi-step process:
1. Sessions archived in DB immediately (line 948)
2. Cleanup task queued (line 1020)
3. Disk deletion happens async
4. Worktree marked archived only AFTER disk deletion (line 990)

If the application crashes between steps 1 and 4, sessions are archived but the worktree isn't, leaving an inconsistent state. The recovery at line 1001-1009 only handles caught errors, not crashes.

**Solution**: Add a startup consistency check function that:
- Finds worktrees where `isArchived=false` but ALL associated sessions have `isArchived=true`
- Either completes the archive operation or reverts the session archiving
- Logs warnings about any inconsistencies found

This check should run during app initialization, after the database is ready.

---

## High Priority

### 3. Squash Operation is Destructive Without Backup

**File**: `packages/electron/src/main/services/GitWorktreeService.ts`
**Lines**: 1588-1650

**Problem**: `squashCommits` uses `git reset --soft` which rewrites history. If it fails partway through (after reset but before new commit), the user could lose commits with no recovery path.

**Solution**: Create a backup branch before squashing:
1. Before the reset, create a backup branch: `backup-before-squash-{timestamp}`
2. Proceed with the squash operation
3. On success, delete the backup branch
4. On failure, the backup branch remains for manual recovery

---

### 4. No Operation Locking for Critical Git Operations

**File**: `packages/electron/src/main/services/GitWorktreeService.ts`

**Problem**: Operations like merge and rebase modify git state but don't prevent concurrent operations. If a user triggers two merges rapidly or a rebase while merge is in progress, git state could become corrupted.

**Solution**: Add a per-repository operation lock mechanism:
1. Create a `operationLocks` Map that tracks ongoing operations per repository path
2. Create a `withLock` method that:
   - Waits for any existing operation on that repo to complete
   - Sets a lock promise for the duration of the operation
   - Clears the lock when done (success or failure)
3. Wrap `mergeToMain`, `rebaseFromBase`, and `squashCommits` with this lock

---

### 5. Archive Queue Has No Persistence

**File**: `packages/electron/src/main/services/ArchiveProgressManager.ts`

**Problem**: The archive queue is held in memory. If the app crashes, queued tasks are lost - worktrees may have sessions archived but cleanup never completes.

**Solution**: Persist the queue state:
1. On task add: Write task metadata to a JSON file in the app data directory
2. On task complete/fail: Remove from the persisted file
3. On app start: Check for incomplete tasks in the file and re-queue them
4. Use a simple JSON file like `archive-queue.json` in the app support directory

---

## Medium Priority

### 6. Stash Pop Failures Not Prominently Surfaced

**Files**:
- `packages/electron/src/main/services/GitWorktreeService.ts` (lines 1143-1148, 1383-1391)
- Relevant UI components

**Problem**: In `mergeToMain` and `rebaseFromBase`, if auto-stash succeeds but pop fails after the operation, the user's changes are stuck in stash. The code returns success with a warning message, but this may not be noticed by the user.

**Solution**:
1. Add a `stashWarning` boolean field to the merge/rebase result interfaces
2. Set this flag when stash pop fails
3. The UI should show a prominent alert (not just in the message) when this flag is true
4. Consider adding a "Restore Stash" helper action in the UI

---

### 7. No Worktree Health Validation

**File**: `packages/electron/src/main/services/GitWorktreeService.ts`

**Problem**: There's no health check that detects when a worktree exists in the database but:
- The directory doesn't exist on disk
- The `.git` file is missing or corrupted
- The branch no longer exists
- Git doesn't recognize it as a valid worktree

**Solution**: Add a `validateWorktree` method that checks:
1. Directory exists
2. `.git` file exists in the directory
3. `git rev-parse --is-inside-work-tree` succeeds
4. The branch from the database still exists

Return a structured result with `valid: boolean` and `issues: string[]`. This can be called:
- When fetching worktree status (log warning if invalid)
- In a periodic health check
- Before operations that depend on worktree validity

---

### 8. Worktree Deletion Doesn't Verify Git Index Cleanup

**File**: `packages/electron/src/main/services/GitWorktreeService.ts`
**Lines**: 267-353

**Problem**: `deleteWorktree` focuses on directory removal but doesn't verify that git's worktree list is actually updated. The `git worktree prune` is best-effort and its failure is only logged as a warning.

**Solution**: After successful deletion, verify the worktree is no longer in git's list:
1. Call `listWorktrees` on the main repository
2. Check that no entry matches the deleted worktree path
3. If still present, throw an error indicating incomplete cleanup

---

### 9. Name Deduplication Race Condition

**File**: `packages/electron/src/main/ipc/WorktreeHandlers.ts`
**Lines**: 85-108

**Problem**: Names are gathered from three sources (DB, filesystem, branches), but a concurrent creation request could pass the same deduplication check if both requests check before either creates.

**Solution**: Use optimistic concurrency with retry:
1. If `createWorktree` fails with "branch already exists" or similar collision error
2. Retry the entire creation with a new generated name
3. Limit retries to prevent infinite loops (e.g., max 3 retries)
4. Log when retries occur for debugging

---

## Implementation Notes

### File Locations
- IPC Handlers: `packages/electron/src/main/ipc/WorktreeHandlers.ts`
- Git Service: `packages/electron/src/main/services/GitWorktreeService.ts`
- Archive Manager: `packages/electron/src/main/services/ArchiveProgressManager.ts`
- Worktree Store: `packages/electron/src/main/services/WorktreeStore.ts`

### Testing Considerations
- Each fix should be testable in isolation
- Consider adding E2E tests for crash recovery scenarios
- Add unit tests for the new validation functions

### Backwards Compatibility
- All changes should be backwards compatible
- Existing worktrees should continue to work
- The startup consistency check should handle legacy data gracefully
