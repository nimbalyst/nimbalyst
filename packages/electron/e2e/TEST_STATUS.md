# E2E Test Status Before Multi-Editor Tab Refactor

Date: 2025-09-30

## Overall Summary

**Total non-AI tests: 20**
- ✅ **16 passing (80%)**
- ❌ **4 failing (20%)**

All failures are from newly created tests that exposed gaps in functionality:
- No conflict detection for external file changes
- No deletion notification
- Dirty state not preserved across tabs
- App crash/timeout on specific file watcher scenario

## Tab Content Isolation Tests
File: `e2e/tabs/tab-content-isolation.spec.ts`

**Status: 2/3 passing**

### ✅ Passing Tests
1. **should preserve each file content independently when switching tabs**
   - Opens 3 files (alpha, beta, gamma)
   - Adds unique markers to each
   - Switches between tabs multiple times
   - Verifies content isolation is maintained
   - **Result**: PASS - Content is not getting mixed up

2. **should handle rapid tab switching without content corruption**
   - Opens 3 files with unique markers
   - Performs rapid tab switching with minimal waits
   - Verifies each file maintains its own content after rapid switching
   - **Result**: PASS - No corruption during rapid switching

### ❌ Failing Tests
1. **should preserve dirty state correctly per tab**
   - Opens alpha.md and makes edit (should show dirty indicator)
   - Switches to beta.md (alpha should still show dirty)
   - Makes beta.md dirty
   - **Failure**: Alpha's dirty indicator disappears after switching tabs
   - **Likely cause**: Autosave is happening too quickly, or dirty state not being tracked properly per tab
   - **Error**: `toBeVisible` failed on `.tab-dirty-indicator` after switching tabs

## File Watcher Tests
File: `e2e/files/file-watcher-updates.spec.ts`

**Status: 5/7 passing**

### ✅ Passing Tests
1. **should detect when file is modified on disk by external process**
   - Opens file, modifies it externally
   - Verifies editor content updates with external changes
   - **Result**: PASS - File watcher detects changes

2. **should reload content when switching to tab with externally modified file**
   - Opens file, switches to another tab
   - Modifies first file externally while inactive
   - Switches back to first tab
   - **Result**: PASS - Content reloads correctly

3. **should update file tree when new files are created by external process**
   - Creates new file externally (simulating AI agent)
   - Verifies new file appears in file tree
   - **Result**: PASS - File tree updates

4. **should detect rapid successive external changes**
   - Makes multiple rapid external edits to file
   - Verifies final state is reflected
   - **Result**: PASS - Handles rapid changes

5. **should preserve cursor position when file is reloaded from disk (if no conflicts)**
   - Positions cursor, appends content externally
   - Verifies content updated
   - **Result**: PASS - Content updates (cursor preservation not fully tested)

### ❌ Failing Tests
1. **should show notification when file is modified externally while editor has unsaved changes**
   - Opens file, makes local unsaved edits (dirty state)
   - Modifies file externally (creates conflict)
   - **Failure**: No dialog, notification, or warning shown
   - **Issue**: App does not detect or warn about conflicts between local and external changes
   - **Error**: `expect(hasDialog || hasNotification || hasWarning).toBe(true)` returned false

2. **should reload content when switching to tab with externally modified file**
   - Opens file, switches to another tab, modifies first file externally, switches back
   - **Failure**: Test timeout - app appears to crash or hang
   - **Issue**: Possible race condition or error handling issue with external modifications
   - **Error**: `Test timeout of 30000ms exceeded` - "Target page, context or browser has been closed"

3. **should handle file deletion while open in editor**
   - Opens file, deletes it externally
   - **Failure**: No indication that file was deleted
   - **Issue**: App does not show dialog, notification, or special tab state for deleted files
   - **Error**: `expect(hasDialog || hasNotification || tabHasWarning).toBe(true)` returned false
   - **Note**: Separate test `file-deletion-while-open.spec.ts` passes, which closes the tab on deletion

## Existing Tests (All Passing)

### Core App Tests
File: `e2e/core/app-startup.spec.ts` - **5/5 passing**
- ✅ App launches and shows workspace sidebar
- ✅ File tree displays test files
- ✅ Files open when clicked in sidebar
- ✅ Basic text editing works
- ✅ Save with Cmd+S works

### Tab Tests
File: `e2e/tabs/tab-reordering.spec.ts` - **3/3 passing**
- ✅ Drag and drop to reorder tabs
- ✅ Visual feedback during drag
- ✅ Clicking active tab doesn't reload

File: `e2e/tabs/autosave-navigation.spec.ts` - **1/1 passing**
- ✅ Saves dirty document when navigating via document link

### File Tests
File: `e2e/files/file-deletion-while-open.spec.ts` - **1/1 passing**
- ✅ Deleting an open file closes the tab (doesn't recreate file)

## Key Issues Identified

### Critical Issues
1. **No conflict detection**: When a file is modified externally while having unsaved local changes, the app provides no warning. This could lead to data loss.

2. **App crash/hang on specific file watcher scenario**: When switching back to a tab after external modification, the app crashes or hangs. This is a serious stability issue.

3. **Inconsistent deletion handling**: One test shows deletion closes the tab (passes), but another test expects notification (fails). Need to clarify expected behavior.

### Minor Issues
4. **Dirty state management**: The dirty indicator on tabs disappears after switching tabs, possibly due to aggressive autosave or improper state tracking.

## Impact on Multi-Editor Refactor

The passing tests confirm:
- Content isolation is working (good foundation)
- File watcher is detecting external changes
- File tree updates correctly
- No evidence of the "content overwriting" bug in these specific tests

The failing tests highlight needed improvements:
- Conflict detection and resolution UI
- File deletion detection and handling
- Per-tab dirty state preservation (will be naturally fixed by multi-editor approach)

## Recommendations Before Refactor

1. **Run full e2e suite**: Ensure no other tests are broken
2. **Document expected behaviors**: The multi-editor refactor should:
   - Fix the dirty state issue (separate editor instances)
   - Preserve the working content isolation
   - Maintain file watcher functionality
   - Still needs conflict detection (separate feature)

3. **Post-refactor validation**: Re-run these tests to ensure:
   - All currently passing tests still pass
   - Dirty state test should now pass
   - File watcher tests remain functional

## Test Infrastructure Improvements Made

1. **Fixed session restoration in tests**:
   - Tests were opening multiple windows due to session restoration
   - Fixed by skipping `restoreSessionState()` when `PLAYWRIGHT=1` env var is set
   - Location: `packages/electron/src/main/session/SessionState.ts`

2. **Created comprehensive test suites**:
   - `tab-content-isolation.spec.ts` - Tests for content isolation and state preservation
   - `file-watcher-updates.spec.ts` - Tests for external file change detection

## Other Notes

- Some "Internal error: step id not found: fixture@XX" warnings in test output (Playwright internal issue, not affecting test results)
- AI tests not run (require real API keys and models)
- Test run time: ~1.6 minutes for 20 tests
