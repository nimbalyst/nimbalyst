# File-Watcher-Based Diff Approval System

## Overview

AI edits are written to disk immediately, then detected by the file watcher and presented as red/green diffs for user approval.

**Key Principle**: The AI always sees the accepted state. Files are written to disk so the AI's context matches reality. Users review changes after they're written.

## Components

1. **PreToolUse Hook** - Creates "pre-edit tag" storing original content before AI tool executes
2. **File Watcher** - Detects file changes, checks for pending tags, triggers diff mode
3. **Diff Mode** - Shows red/green diff (tagged vs disk), user accepts or rejects
4. **Local History** - Stores tagged versions in database with partial unique index (one pending tag per file)

### Flow Diagram

```
┌─────────────────────────────────────────────────────────────┐
│ AI requests Edit/Write tool                                 │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│ PreToolUse Hook                                             │
│ - Read current file content                                 │
│ - Create tag in local history: {content, sessionId, status} │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│ Tool Executes                                               │
│ - AI writes changes directly to disk                        │
│ - No interception, no blocking                              │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│ File Watcher Detects Change                                 │
│ - Read new disk content                                     │
│ - Check for pending AI edit tags                            │
└────────────────────┬────────────────────────────────────────┘
                     │
         ┌───────────┴───────────┐
         │                       │
         ▼                       ▼
    Has Tag?                No Tag?
         │                       │
         │                       └──> Normal file reload
         ▼
┌─────────────────────────────────────────────────────────────┐
│ Enter Diff Mode                                             │
│ - Load tagged (old) content into editor                     │
│ - Apply diff: oldContent → newContent                       │
│ - Show Accept/Reject buttons                                │
└────────────────────┬────────────────────────────────────────┘
                     │
         ┌───────────┴───────────┐
         │                       │
         ▼                       ▼
    User Accepts           User Rejects
         │                       │
         │                       │
         ▼                       ▼
┌──────────────────┐    ┌──────────────────┐
│ Accept Handler   │    │ Reject Handler   │
│ - Keep disk      │    │ - Restore tagged │
│   content        │    │   content to disk│
│ - Mark tag as    │    │ - Mark tag as    │
│   'reviewed'     │    │   'reviewed'     │
│ - Exit diff mode │    │ - Exit diff mode │
└──────────────────┘    └──────────────────┘
```

## Key Features

1. **Works with any file modification** - AI tools, bash commands, manual edits
2. **Consecutive edits** - Multiple edits to same file update the diff (shows original → latest, not first → second)
3. **Multi-file support** - One pending tag per file, each shows independently
4. **Autosave compatible** - Tag check happens before autosave skip logic

## File Locations

- **PreToolUse Hook**: `packages/runtime/src/ai/server/providers/ClaudeCodeProvider.ts`
- **File Watcher**: `packages/electron/src/renderer/components/TabEditor/TabEditor.tsx`
- **Tag Management**: `packages/electron/src/main/HistoryManager.ts`
- **Database**: `packages/electron/src/main/database/worker.js` (document_history table with partial unique index)

## Critical Implementation Details

### File Watcher Logic Order

1. Check if content matches current or last saved → skip
2. **Check for pending AI tags FIRST** (before time-based heuristic)
3. If pending tag exists → enter or update diff mode
4. If no pending tag → apply time-based skip (< 2000ms since save)

**Why this order?** Ensures consecutive AI edits are processed even if they occur within 2000ms of autosave.

### Diff Update Strategy

Updates are wrapped in `setTimeout(..., 0)` to release the file watcher lock immediately, preventing subsequent changes from being blocked.

### Tag Lifecycle

- **Create**: PreToolUse hook stores original content with status='pending'
- **Update**: Accept/Reject handlers mark tag as status='reviewed'
- **Constraint**: Partial unique index prevents duplicate pending tags per file

## Edge Cases

1. **Duplicate file watcher events** - `processingFileChangeRef` lock prevents concurrent processing
2. **Tab switching** - `pendingAIEditTagRef` persists, diff mode restored on mount if tag exists
3. **Rapid consecutive edits** - Database constraint prevents duplicates, latest edit wins
4. **Session ends with pending diffs** - Tags persist across sessions, user can accept/reject on reopen

## Testing

E2E tests in `packages/electron/e2e/ai/consecutive-edits-diff-update.spec.ts` cover consecutive edits, rapid edits, and tab switching scenarios.

## Benefits Over MCP-Based Approach

| Aspect | MCP Approach | File Watcher Approach |
| --- | --- | --- |
| Tool compatibility | Only works with custom `applyDiff` tool | Works with any file modification |
| AI experience | AI must use specific tool | AI uses natural Edit/Write tools |
| Multi-file edits | Complex coordination needed | Naturally supported |
| Architecture | Extra MCP server layer | Simpler, leverages existing systems |
| Failure modes | AI might use Edit instead of applyDiff | All edits are caught |

## Troubleshooting

**Consecutive edits not updating**: Check that pending tag check happens before time-based heuristic in file watcher logic

**Diff mode stuck**: Verify `pendingAIEditTagRef` is cleared and tag status updated to 'reviewed'

**File watcher not firing**: Check if `processingFileChangeRef` lock is stuck (console shows "Skipping duplicate")
