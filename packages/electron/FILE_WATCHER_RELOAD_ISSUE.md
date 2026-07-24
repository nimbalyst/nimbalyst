# File Watcher Reload Issue

## Status: RESOLVED WITH WORKAROUND ✅

The original issue (external file changes not reloading in active tabs) has been fixed. However, a related issue was discovered with inactive tabs. A workaround has been implemented.

- ✅ External file changes reload the editor content without remounting (ACTIVE TABS)
- ✅ Autosave does not cause editor repaint or focus loss
- ⚠️ Inactive tabs require manual reload via dialog when becoming active (workaround)

See [Resolution](#resolution) and [Inactive Tab Workaround](#inactive-tab-workaround) sections below for details.

---

## Problem Statement

We have two conflicting requirements:

1. **External file changes must reload the editor content** - When a file is modified externally (e.g., by an AI agent or another process), the editor must detect the change and update to show the new content.

2. **Autosave must not cause editor repaint/remount** - When autosave occurs, the editor must NOT lose focus or remount, as this disrupts the user's typing experience.

## Current Architecture

### File Watching Flow
1. `TabEditor.tsx` listens for `file-changed-on-disk` IPC events from main process
2. `ChokidarFileWatcher` (main process) watches files and sends events when changes detected
3. When file change detected, `TabEditor` checks if it's an external change or our own save
4. If external, calls `applyReload()` to update editor content

### Editor Mounting
- `NimbalystEditor` component uses React `key` to control remounting
- Key format: `${filePath}-theme-${theme}`
- When key changes, React creates a new component instance (remount)
- `initialContent` prop is only used on initial mount

## The Conflict

### Approach 1: Use `reloadVersion` in Key (FAILS)
```tsx
key={`${filePath}-v${reloadVersion}-theme-${theme}`}
```

**How it works:**
- Bump `reloadVersion` when external changes detected
- React remounts editor with new `initialContent`
- Content successfully updates ✅

**Why it fails:**
- User types text after autosave
- Autosave completes and saves to disk
- File watcher fires (can be delayed)
- File watcher checks fail to detect it's our own save
- `reloadVersion` gets bumped
- Editor remounts with stale `content` state
- User's typed text disappears ❌
- Focus is lost ❌

**Test failures:**
- ✅ `e2e/files/file-watcher-updates.spec.ts:43` (external changes) - PASSES
- ❌ `e2e/files/autosave-focus.spec.ts:47` (autosave focus) - FAILS

### Approach 2: Programmatic Content Update (CURRENT - FAILS)
```tsx
// In applyReload():
editorRef.current.update(() => {
  const root = $getRoot();
  root.clear();
  $convertFromEnhancedMarkdownString(newContent, transformers);
});
```

**How it works:**
- Capture Lexical editor instance via `onEditorReady`
- Use Lexical API to update content directly
- No remount, preserves focus ✅

**Why it fails:**
- File watcher event never fires or is filtered out
- Editor content never updates ❌
- Likely issue: The protective checks (lines 324-344) are TOO aggressive
- Checks prevent legitimate external changes from loading

**Test failures:**
- ❌ `e2e/files/file-watcher-updates.spec.ts:43` (external changes) - FAILS
- ⁇ `e2e/files/autosave-focus.spec.ts:47` (autosave focus) - Unknown

## File Watcher Protection Logic

Current checks in `TabEditor.tsx` (lines 323-344):

```tsx
// 1. Check if disk content matches current editor content
if (newContent === currentContent) {
  return; // Skip reload
}

// 2. Check if disk content matches last saved content
if (newContent === lastSavedContentRef.current) {
  return; // Skip reload - assumes it's our own save
}

// 3. Time-based heuristic
if (timeSinceLastSave < 3000) {
  return; // Skip reload - within 3s of our save
}
```

### The Race Condition

**Scenario:**
1. File opened: `content = "A"`
2. User types: `content = "A + B"`
3. Autosave saves "A + B" to disk
4. User types more: `content = "A + B + C"`
5. File watcher fires for autosave
   - `newContent` (from disk) = "A + B"
   - `currentContent` (in editor) = "A + B + C"
   - `lastSavedContentRef.current` = "A + B" ✅
   - **Check 2 matches!** Skip reload ✅
6. External process changes file to "A + B + D"
7. File watcher fires for external change
   - `newContent` (from disk) = "A + B + D"
   - `currentContent` (in editor) = "A + B + C"
   - `lastSavedContentRef.current` = "A + B"
   - **No checks match!** Apply reload ✅

This SHOULD work! But tests show it's not working.

## Attempted Solutions

### Solution 1: ReloadVersion in Key ✅❌
- ✅ External changes work
- ❌ Autosave causes repaint
- **Status:** Abandoned - breaks user experience

### Solution 2: Programmatic Update with Lexical API ❌
- Current implementation
- External changes don't load
- **Status:** Not working - investigating why

### Solution 3: Hybrid Approach (NOT TRIED)
- Remove `reloadVersion` from key entirely
- Use programmatic update ONLY
- Add better debugging to understand why it's not working
- Ensure `editorRef.current` is valid when `applyReload()` is called
- Check if dynamic import timing is the issue

## Root Cause Analysis Needed

### Questions:
1. Why is the file watcher event not triggering `applyReload()` in the programmatic approach?
2. Is `editorRef.current` null when we try to update?
3. Is the dynamic import of rexical functions failing?
4. Are the protective checks incorrectly filtering out external changes?
5. Is there a timing issue with when the editor ref is set vs when file changes occur?

### Debugging Steps:
1. Add extensive logging to `applyReload()` to see if it's called
2. Log `editorRef.current` status
3. Log result of dynamic import
4. Add try-catch around Lexical API calls to catch errors
5. Verify file watcher IS firing by checking main process logs
6. Add logging to all three protective checks to see which one is triggering

## Potential Solutions

### Option A: Make Protective Checks Smarter
- Track save IDs to definitively identify our own saves
- Use file modification timestamps more precisely
- Add a "pending external change" flag during autosave window

### Option B: Debounce File Watcher Events
- Don't process file changes immediately after save
- Queue changes and process after save completes
- Risk: Delays legitimate external changes

### Option C: Use Lexical's Built-in State Management
- Investigate if Lexical has a way to update content without clearing/recreating
- Use `editor.setEditorState()` instead of `root.clear()` + convert
- Preserve undo/redo history

### Option D: Separate External Changes from Autosave Detection
- Add explicit flag in file watcher: `isOwnSave: boolean`
- Main process tracks which saves are ours
- Renderer doesn't need to guess

## Files Involved

- `/packages/electron/src/renderer/components/TabEditor/TabEditor.tsx` - Editor component with file watching
- `/packages/electron/src/main/file/ChokidarFileWatcher.ts` - Main process file watcher
- `/packages/rexical/src/NimbalystEditor.tsx` - Editor component
- `/packages/electron/e2e/files/file-watcher-updates.spec.ts` - External change tests
- `/packages/electron/e2e/files/autosave-focus.spec.ts` - Autosave focus tests

## Resolution

### Root Cause
The programmatic update approach was failing because `$getRoot` was being imported from `rexical` instead of `lexical`. The error was:
```
TypeError: $getRoot is not a function
```

This happened because:
1. `$getRoot` is a Lexical function from the `lexical` package, not from `rexical`
2. The dynamic import statement was: `const { $getRoot, ... } = await import('rexical')`
3. This should have been split into two imports:
   - `const { $getRoot } = await import('lexical')`
   - `const { $convertFromEnhancedMarkdownString, getEditorTransformers } = await import('rexical')`

### The Fix
Updated TabEditor.tsx in two locations (file watcher reload and conflict resolution):

**Before:**
```tsx
const { $convertFromEnhancedMarkdownString, getEditorTransformers, $getRoot } = await import('rexical');
```

**After:**
```tsx
const { $getRoot } = await import('lexical');
const { $convertFromEnhancedMarkdownString, getEditorTransformers } = await import('rexical');
```

### Test Results
Both test suites now pass:
- ✅ `e2e/files/file-watcher-updates.spec.ts:43` (external changes) - PASSES
- ✅ `e2e/files/autosave-focus.spec.ts:47` (autosave focus) - PASSES

### Final Solution: Programmatic Update ✅
The programmatic update approach works correctly:
- External changes are detected and loaded without remounting
- Autosave does not cause editor repaint or focus loss
- Protective checks prevent own saves from being reloaded
- Editor content is updated using Lexical API directly

### Files Modified
- `/packages/electron/src/renderer/components/TabEditor/TabEditor.tsx` (lines 157, 387-388)
  - Fixed `$getRoot` import in conflict resolution handler
  - Fixed `$getRoot` import in external change reload handler

## Inactive Tab Workaround

### Problem

While fixing the active tab file watcher issue, a second issue was discovered: **inactive tabs do not receive file watcher events in development mode**.

**Root Cause:** React StrictMode causes rapid component re-mounting and cleanup cycles. IPC event listeners are registered, then immediately cleaned up, then re-registered. During this dance, file change events can be sent by the main process but have no listener to receive them (timing issue).

**Test vs Reality:** Playwright tests pass because they don't exhibit the same re-mounting behavior. In tests, components mount once and listeners stay registered.

### Solution

Implemented a safety net check (TabEditor.tsx lines 95-153):

**When a tab becomes active:**
1. Read the current file content from disk
2. Compare disk content with editor content
3. If they differ, show a dialog asking if user wants to reload
4. If user confirms, update the editor content from disk

**Benefits:**
- Catches ALL missed file watcher events
- Works regardless of React lifecycle timing issues
- Provides user control over whether to reload

**Implementation:** See `INACTIVE_TAB_FILE_WATCHER_BUG.md` for full analysis
