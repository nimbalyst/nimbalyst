# Playwright End-to-End Testing

This repository uses [Playwright](https://playwright.dev) for automated end-to-end coverage across the web playground and the Electron desktop shell.

## Installation

```bash
npm install -D @playwright/test
npx playwright install --with-deps
```

> **Tip:** run these commands at the repository root so all workspace projects share the same Playwright binaries.

## Running Tests

- `npm run test:e2e` runs every Playwright project defined in `playwright.config.ts`.
- `npm run test:e2e -- --project=electron` executes only the Electron scenario.
- `npx playwright test e2e/ai/diff-reliability.spec.ts` runs a specific test file.
- `npx playwright test e2e/ai/diff-reliability.spec.ts:55` runs a specific test by line number.

> **Build first:** make sure `npm run build --workspace @nimbalyst/electron` has been executed so `packages/electron/out/main/index.js` exists before launching the Electron project.

Artifacts (traces, screenshots, videos) are captured on the first retry or failure and saved under `playwright-report/`.

## Test File Organization

Tests are organized by feature area under `packages/electron/e2e/`:

- `e2e/ai/` - AI-related tests (diff reliability, file mentions, etc.)
- `e2e/core/` - Core app functionality (window restore, workspace tabs, etc.)
- `e2e/editors/` - Editor-specific tests (one consolidated file per editor type)
- `e2e/files/` - File operations (manual save, autosave, file watching, etc.)
- `e2e/tabs/` - Tab management (reordering, autosave navigation, etc.)
- `e2e/theme/` - Theme switching tests
- `e2e/plugins/` - Plugin-specific tests

## Test Consolidation (Performance Critical)

**IMPORTANT:** Electron E2E tests have significant startup overhead (~4-5 seconds per app launch). To keep the test suite fast, we consolidate related tests to share a single app instance.

### Why Consolidate?

- Each `launchElectronApp()` call costs 4-5 seconds
- With 300+ tests, launching separately = 20-25 minutes of pure overhead
- Consolidation reduces this dramatically (e.g., 5 separate files -> 1 file = 16-20 seconds saved)

### The Pattern: One App Per Spec File

Instead of launching the app in `beforeEach`, use `beforeAll` to share one instance:

```typescript
// GOOD: Consolidated test file
let electronApp: ElectronApplication;
let page: Page;
let workspaceDir: string;

test.beforeAll(async () => {
  workspaceDir = await createTempWorkspace();

  // Create ALL test files upfront for all scenarios
  await fs.writeFile(path.join(workspaceDir, 'test1.md'), '# Test 1\n');
  await fs.writeFile(path.join(workspaceDir, 'test2.md'), '# Test 2\n');
  await fs.writeFile(path.join(workspaceDir, 'test3.md'), '# Test 3\n');

  electronApp = await launchElectronApp({ workspace: workspaceDir });
  page = await electronApp.firstWindow();
  await waitForAppReady(page);
});

test.afterAll(async () => {
  await electronApp?.close();
  await fs.rm(workspaceDir, { recursive: true, force: true });
});

test('scenario 1', async () => {
  await openFileFromTree(page, 'test1.md');
  // ... test logic ...
  await closeTabByFileName(page, 'test1.md'); // Clean up for next test
});

test('scenario 2', async () => {
  await openFileFromTree(page, 'test2.md');
  // ... test logic ...
  await closeTabByFileName(page, 'test2.md');
});
```

```typescript
// BAD: Separate launches per test (slow!)
test.beforeEach(async () => {
  workspaceDir = await createTempWorkspace();
  electronApp = await launchElectronApp({ workspace: workspaceDir }); // 4-5 sec each time!
  page = await electronApp.firstWindow();
});
```

### Key Rules for Consolidation

1. **Pre-create all test files in beforeAll** - Create every file any test might need upfront
2. **Use different files per test** - Each test opens a different pre-created file to avoid state conflicts
3. **Close tabs between tests** - Call `closeTabByFileName()` at the end of each test
4. **Keep spec files focused** - Group by editor type or feature (e.g., all markdown tests together)

### When Tests CANNOT Share an App

Some tests require a fresh app instance:
- Tests for app startup behavior
- Tests for session restore across app restarts
- Tests that intentionally corrupt or reset app state
- Tests for permission mode switching (which is set at launch)

For these, use `beforeEach`/`afterEach` but keep them in separate spec files.

### CRITICAL: Worker Restart on Test Failure

**Playwright restarts the worker process when a test fails, which re-runs `beforeAll`.**

This is documented Playwright behavior ([GitHub Issue #34249](https://github.com/microsoft/playwright/issues/34249)). When a test fails:
1. Playwright terminates the current worker
2. A new worker starts for the next test
3. `beforeAll` runs again in the new worker
4. This creates a NEW app instance with a NEW workspace

**This means failing tests will still cause app restarts, even with proper `beforeAll`/`afterAll` structure.**

#### Implications for Test Development

1. **Fix tests one at a time** - When working on a consolidated test file, get the FIRST test passing before moving to the next. A failing test will cause all subsequent tests to start fresh app instances.

2. **Use `test.describe.configure({ mode: 'serial' })` for debugging** - This prevents worker restarts within the serial group, but tests will still restart if they timeout.

3. **Don't rely on shared state across failing tests** - If test A fails, test B will get a fresh app, not the state left by test A.

#### The Correct Approach When Consolidating Tests

```typescript
// Step 1: Structure your file correctly (no test.describe wrappers)
let electronApp: ElectronApplication;
let page: Page;
let workspaceDir: string;

test.beforeAll(async () => {
  // Setup once for all tests
});

test.afterAll(async () => {
  // Cleanup once after all tests
});

// Step 2: Write ONE test and get it passing
test('first scenario', async () => {
  // Get this working completely before writing more tests
});

// Step 3: Only after test 1 passes, add test 2
test('second scenario', async () => {
  // ...
});
```

#### DO NOT use `test.describe` blocks with module-level hooks

When you have `test.describe` blocks, even with module-level `beforeAll`/`afterAll`, the worker restart behavior becomes unpredictable. The safest pattern is:

```typescript
// GOOD: All tests at module level, no describe wrappers
test.beforeAll(async () => { /* ... */ });
test.afterAll(async () => { /* ... */ });

test('test 1', async () => { /* ... */ });
test('test 2', async () => { /* ... */ });
test('test 3', async () => { /* ... */ });

// BAD: describe blocks with module-level hooks
test.beforeAll(async () => { /* ... */ });
test.afterAll(async () => { /* ... */ });

test.describe('Group A', () => {
  test('test 1', async () => { /* ... */ });
});

test.describe('Group B', () => {
  test('test 2', async () => { /* ... */ });
});
```

Use comments (like `// ============ Section Name ============`) instead of `test.describe` blocks if you want visual organization.

### Consolidation Examples

| Before | After | Savings |
|--------|-------|---------|
| `markdown/autosave.spec.ts`, `markdown/dirty-close.spec.ts`, etc. (5 files) | `markdown.spec.ts` (1 file) | 4 app launches (~16-20s) |
| `csv/autosave.spec.ts`, `csv/keyboard-nav.spec.ts`, etc. (8 files) | `csv.spec.ts` (1 file) | 7 app launches (~28-35s) |

## Using Test Helpers

### Overview

To keep tests clean and maintainable, we use shared utilities from `e2e/utils/testHelpers.ts`. These utilities encapsulate common test patterns and reduce code duplication.

**Key principles:**
1. **Use constants over hardcoded selectors** - Import selectors from `PLAYWRIGHT_TEST_SELECTORS` instead of using raw CSS strings
2. **Use utility functions over inline code** - Call helper functions instead of repeating the same operations
3. **Keep tests readable** - Tests should read like documentation, not implementation details

### Test Helpers Location

All shared test utilities are in:
- **Constants & Utilities**: `e2e/utils/testHelpers.ts`
- **Base Helpers**: `e2e/helpers.ts` (app launch, workspace setup)
- **AI Tool Simulator**: `e2e/utils/aiToolSimulator.ts` (AI-specific testing)

### Using Selectors from PLAYWRIGHT_TEST_SELECTORS

Always import and use selectors from `PLAYWRIGHT_TEST_SELECTORS` instead of hardcoding CSS selectors:

```typescript
import { PLAYWRIGHT_TEST_SELECTORS } from '../utils/testHelpers';

// GOOD: Using constants
const editor = page.locator(PLAYWRIGHT_TEST_SELECTORS.contentEditable);
await page.locator(PLAYWRIGHT_TEST_SELECTORS.fileTreeItem, { hasText: 'test.md' }).click();
await page.waitForSelector(PLAYWRIGHT_TEST_SELECTORS.historyDialog);

// BAD: Hardcoded selectors scattered throughout tests
const editor = page.locator('[contenteditable="true"]');
await page.locator('.file-tree-name', { hasText: 'test.md' }).click();
await page.waitForSelector('.history-dialog');
```

**Why?** When UI changes, you only need to update one place (the constant) instead of every test.

### Using Utility Functions

Import utility functions to handle common operations:

```typescript
import {
  dismissAPIKeyDialog,
  waitForWorkspaceReady,
  openFileFromTree,
  editDocumentContent,
  manualSaveDocument,
  openHistoryDialog,
  restoreFromHistory
} from '../utils/testHelpers';

// GOOD: Clean, readable test
test('should restore previous version', async () => {
  await dismissAPIKeyDialog(page);
  await waitForWorkspaceReady(page);
  await openFileFromTree(page, 'test.md');

  const editor = page.locator(ACTIVE_EDITOR_SELECTOR);
  await editDocumentContent(page, editor, '# Updated content');
  await manualSaveDocument(page);

  await openHistoryDialog(page);
  await selectHistoryItem(page, 1);
  await restoreFromHistory(page);
});

// BAD: Lots of implementation details, harder to read and maintain
test('should restore previous version', async () => {
  const apiDialog = page.locator('.api-key-dialog-overlay');
  if (await apiDialog.isVisible()) {
    await page.locator('.api-key-dialog-button.secondary').click();
  }

  await page.waitForSelector('.workspace-sidebar', { timeout: 5000 });
  await page.locator('.file-tree-name', { hasText: 'test.md' }).click();
  await expect(page.locator('.tab', { hasText: 'test.md' }))
    .toBeVisible({ timeout: 3000 });

  const editor = page.locator('[contenteditable="true"]');
  await editor.click();
  await page.keyboard.press('Meta+a');
  await page.keyboard.type('# Updated content');
  await page.keyboard.press('Meta+s');
  await page.waitForTimeout(2000);

  // ... and so on
});
```

### Available Utility Functions

**Workspace & Files:**
- `dismissAPIKeyDialog(page)` - Dismiss API key dialog if present
- `waitForWorkspaceReady(page)` - Wait for workspace sidebar to load
- `openFileFromTree(page, fileName)` - Open file from tree and wait for tab

**Document Editing:**
- `editDocumentContent(page, editor, content)` - Select all and type new content
- `manualSaveDocument(page)` - Trigger Cmd+S save
- `waitForAutosave(page, fileName)` - Wait for autosave to complete

**History Operations:**
- `openHistoryDialog(page)` - Open history with Cmd+Y
- `selectHistoryItem(page, index)` - Select history item by index
- `getHistoryItemCount(page)` - Get count of history items
- `findHistoryItemByContent(page, searchText)` - Find item by content
- `restoreFromHistory(page)` - Click restore button

**Mode Switching:**
- `switchToEditorMode(page)` - Switch to editor mode
- `switchToAgentMode(page)` - Switch to agent mode
- `switchToFilesMode(page)` - Switch to files mode

**AI Chat:**
- `submitChatPrompt(page, prompt, options)` - Submit AI chat message
- `createNewAgentSession(page)` - Create new AI session
- `switchToSessionTab(page, index)` - Switch between sessions

### When to Create New Utilities

Create a new utility function when:

1. **The same operation appears in 3+ tests** - DRY principle
2. **The operation is complex** - Multiple steps that obscure test intent
3. **The operation might change** - UI refactoring would require updating many tests
4. **The operation has reusable logic** - Not specific to one test case

Example of when to extract:

```typescript
// This pattern appears in 5 different tests - extract it!
const tab = page.locator('.file-tabs-container .tab', {
  has: page.locator('.tab-title', { hasText: fileName })
});
await expect(tab.locator('.tab-dirty-indicator')).toBeVisible({ timeout: 1000 });
await page.waitForTimeout(3000);
await expect(tab.locator('.tab-dirty-indicator')).toHaveCount(0, { timeout: 1000 });

// Extract to utility:
export async function waitForAutosave(page: Page, fileName: string): Promise<void> {
  const tab = page.locator(PLAYWRIGHT_TEST_SELECTORS.fileTabsContainer).locator(PLAYWRIGHT_TEST_SELECTORS.tab, {
    has: page.locator(PLAYWRIGHT_TEST_SELECTORS.tabTitle, { hasText: fileName })
  });
  await expect(tab.locator(PLAYWRIGHT_TEST_SELECTORS.tabDirtyIndicator)).toBeVisible({ timeout: 1000 });
  await page.waitForTimeout(3000);
  await expect(tab.locator(PLAYWRIGHT_TEST_SELECTORS.tabDirtyIndicator)).toHaveCount(0, { timeout: 1000 });
}
```

### Adding New Constants to PLAYWRIGHT_TEST_SELECTORS

When adding new UI elements that will be tested, add their selectors to `PLAYWRIGHT_TEST_SELECTORS`:

```typescript
// In e2e/utils/testHelpers.ts
export const PLAYWRIGHT_TEST_SELECTORS = {
  // ... existing selectors

  // New feature selectors
  myNewDialog: '.my-new-dialog',
  myNewButton: 'button.my-action-button',
  myNewInput: 'input[data-testid="my-input"]',
};
```

## Writing Tests

### Test Setup Best Practices

**CRITICAL: Always create test files BEFORE launching the app!** Tests will fail if files are created after the app starts because the file tree won't be populated.

**Use `beforeAll` to share the app instance** - see the [Test Consolidation](#test-consolidation-performance-critical) section above. Only use `beforeEach` when tests CANNOT share app state (e.g., tests for app startup, session restore, or permission mode switching).

```typescript
// GOOD: Consolidated pattern - one app for all tests in the file
test.beforeAll(async () => {
  workspaceDir = await createTempWorkspace();

  // Create ALL test files upfront
  await fs.writeFile(path.join(workspaceDir, 'test1.md'), '# Test 1\n');
  await fs.writeFile(path.join(workspaceDir, 'test2.md'), '# Test 2\n');

  electronApp = await launchElectronApp({ workspace: workspaceDir });
  page = await electronApp.firstWindow();
  await waitForAppReady(page);
});
```

### Workspace Setup Pattern

The recommended pattern uses `beforeAll`/`afterAll` to share a single app instance across all tests in the file. Each test uses a different pre-created file to avoid state conflicts.

```typescript
import {
  launchElectronApp,
  createTempWorkspace,
  waitForAppReady,
  TEST_TIMEOUTS
} from '../helpers';
import {
  openFileFromTree,
  closeTabByFileName,
} from '../utils/testHelpers';
import * as fs from 'fs/promises';
import * as path from 'path';

let electronApp: ElectronApplication;
let page: Page;
let workspaceDir: string;

// Share app instance across all tests
test.beforeAll(async () => {
  workspaceDir = await createTempWorkspace();

  // Create ALL files needed by any test in this spec
  await fs.writeFile(path.join(workspaceDir, 'autosave-test.md'), '# Autosave\n');
  await fs.writeFile(path.join(workspaceDir, 'edit-test.md'), '# Edit Test\n');
  await fs.writeFile(path.join(workspaceDir, 'save-test.md'), '# Save Test\n');

  electronApp = await launchElectronApp({ workspace: workspaceDir });
  page = await electronApp.firstWindow();
  await waitForAppReady(page);
});

test.afterAll(async () => {
  await electronApp?.close();
  await fs.rm(workspaceDir, { recursive: true, force: true });
});

test('autosave works', async () => {
  await openFileFromTree(page, 'autosave-test.md');
  // ... test logic ...
  await closeTabByFileName(page, 'autosave-test.md'); // Clean up for next test
});

test('edit functionality', async () => {
  await openFileFromTree(page, 'edit-test.md');
  // ... test logic ...
  await closeTabByFileName(page, 'edit-test.md');
});
```

### Opening Files in Tests

After the app is ready, open files using the file tree:

```typescript
// Click file in file tree using locator
await page.locator('.file-tree-name', { hasText: 'test.md' }).click();

// Wait for tab to become active
await expect(page.locator('.tab.active .tab-title'))
  .toContainText('test.md', { timeout: TEST_TIMEOUTS.TAB_SWITCH });

// Wait for editor to be ready
await waitForEditorReady(page);
```

### Saving Files in Tests

**Use manual save utilities instead of waiting for autosave:**

```typescript
import { triggerManualSave, waitForSave } from '../utils/aiToolSimulator';

// After making changes to the editor...

// Trigger manual save via IPC (simulates Cmd+S)
await triggerManualSave(electronApp);

// Wait for save to complete (dirty indicator disappears)
await waitForSave(page, 'test.md');

// Now verify content on disk
const diskContent = await fs.readFile(testFilePath, 'utf8');
expect(diskContent).toContain('expected text');
```

**Why not use keyboard shortcuts?** Using `page.keyboard.press('Meta+s')` simulates browser keyboard events, which don't trigger Electron menu actions. Always use `triggerManualSave()` to properly simulate Cmd+S.

## IPC Communication in Tests

The Electron app uses IPC (Inter-Process Communication) between main and renderer processes. Understanding this is crucial for writing reliable tests.

### How IPC Works

1. **Main Process** (Node.js) handles file operations, window management, etc.
2. **Renderer Process** (Browser/React) handles UI
3. **IPC Bridge** (`window.electronAPI`) connects them

### Key IPC Events

#### File Operations

```typescript
// Save file (triggered by Cmd+S menu)
// Main process sends 'file-save' event to renderer
window.electronAPI.on('file-save', handleSave);

// To simulate in tests:
await electronApp.evaluate(({ BrowserWindow }) => {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused) {
    focused.webContents.send('file-save');
  }
});
```

#### Document Operations

```typescript
// Open file
const result = await window.electronAPI.openFile();

// Save file as
const result = await window.electronAPI.saveFileAs(content);

// Create file
await window.electronAPI.createFile(filePath, content);

// Get folder contents
const tree = await window.electronAPI.getFolderContents(workspacePath);
```

#### Editor Registry

The EditorRegistry is exposed on `window` for test access:

```typescript
// Tests can access the editor registry directly
const editorRegistry = (window as any).__editorRegistry;

// Apply diff replacements
await editorRegistry.applyReplacements(filePath, [
  { oldText: 'foo', newText: 'bar' }
]);

// Get content
const content = editorRegistry.getContent(filePath);

// Stream content
editorRegistry.startStreaming(filePath, config);
editorRegistry.streamContent(filePath, streamId, chunk);
editorRegistry.endStreaming(filePath, streamId);
```

### AI Tool Simulator

For testing AI operations without actual AI calls, use the AI Tool Simulator utilities:

```typescript
import {
  simulateApplyDiff,
  simulateStreamContent,
  triggerManualSave,
  waitForSave,
  waitForEditorReady
} from '../utils/aiToolSimulator';

// Simulate applying a diff (text replacement)
const result = await simulateApplyDiff(page, testFilePath, [
  { oldText: 'hello', newText: 'world' }
]);

// After AI edits, accept the changes
await page.click('button:has-text("Accept All")');
await page.waitForTimeout(200);

// Save the changes
await triggerManualSave(electronApp);
await waitForSave(page, 'test.md');
```

## Environment Variables for Testing

```typescript
const testEnv = {
  ANTHROPIC_API_KEY: 'playwright-test-key', // Dummy key for tests
  ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
  ELECTRON_RENDERER_URL: 'http://localhost:5273', // Dev server for HMR
  PLAYWRIGHT: '1', // Skips session restoration by default
};

// To enable session restoration in tests:
electronApp = await launchElectronApp({
  workspace: workspaceDir,
  env: { ENABLE_SESSION_RESTORE: '1' }
});
```

### Permission Mode for Tests

Use the `permissionMode` option to auto-trust workspaces and skip the trust toast:

```typescript
// Launch with "Always Allow" mode - no permission prompts
electronApp = await launchElectronApp({
  workspace: workspaceDir,
  permissionMode: 'allow-all'
});

// Launch with "Smart Permissions" mode - will prompt for tools
electronApp = await launchElectronApp({
  workspace: workspaceDir,
  permissionMode: 'ask'
});

// Launch without setting permission mode - shows trust toast (default)
electronApp = await launchElectronApp({
  workspace: workspaceDir
});
```

This is useful for:
- **Most E2E tests**: Use `permissionMode: 'allow-all'` to avoid permission prompts
- **Permission-specific tests**: Use `permissionMode: 'ask'` to test permission dialogs
- **Trust toast tests**: Omit `permissionMode` to test the trust toast UI

## Common Test Patterns

### Testing File Changes

```typescript
test('should detect external file changes', async () => {
  // Open file
  await page.locator('.file-tree-name', { hasText: 'test.md' }).click();
  await waitForEditorReady(page);

  // Modify file externally
  await fs.writeFile(testFilePath, 'New content', 'utf8');

  // App should detect the change (file watcher)
  await page.waitForTimeout(500);

  // Verify editor updated
  const content = await page.evaluate(() => {
    const editor = document.querySelector('.editor');
    return editor?.textContent || '';
  });
  expect(content).toContain('New content');
});
```

### Testing Diff Operations

```typescript
test('should apply diff correctly', async () => {
  // Set up initial content
  const content = '# Title\n\nOriginal text.\n';
  await fs.writeFile(testFilePath, content, 'utf8');

  // Open file
  await page.locator('.file-tree-name', { hasText: 'test.md' }).click();
  await waitForEditorReady(page);

  // Apply diff
  const result = await simulateApplyDiff(page, testFilePath, [
    { oldText: 'Original text', newText: 'Modified text' }
  ]);

  expect(result.success).toBe(true);

  // Accept changes
  await page.click('button:has-text("Accept All")');
  await page.waitForTimeout(200);

  // Save
  await triggerManualSave(electronApp);
  await waitForSave(page, 'test.md');

  // Verify on disk
  const updatedContent = await fs.readFile(testFilePath, 'utf8');
  expect(updatedContent).toContain('Modified text');
});
```

### Testing Streaming Content

```typescript
test('should stream content correctly', async () => {
  await fs.writeFile(testFilePath, '# Document\n', 'utf8');

  await page.locator('.file-tree-name', { hasText: 'test.md' }).click();
  await waitForEditorReady(page);

  // Stream content to end of document
  await simulateStreamContent(page, '\n- Item 1\n- Item 2', {
    insertAtEnd: true
  });

  // Save
  await triggerManualSave(electronApp);
  await waitForSave(page, 'test.md');

  const content = await fs.readFile(testFilePath, 'utf8');
  expect(content).toContain('Item 1');
  expect(content).toContain('Item 2');
});
```

## Test Utilities Reference

### Helper Functions

```typescript
// From e2e/helpers.ts

// Launch Electron app with options
launchElectronApp(options?: { workspace?: string; env?: Record<string, string> })

// Create temporary workspace directory
createTempWorkspace(): Promise<string>

// Wait for app to be ready (sidebar loaded)
waitForAppReady(page: Page): Promise<void>

// Wait for editor to be ready (contenteditable visible)
waitForEditor(page: Page): Promise<void>

// Get keyboard shortcut for current platform
getKeyboardShortcut(key: string): string
```

### AI Tool Simulator Functions

```typescript
// From e2e/utils/aiToolSimulator.ts

// Apply diff replacements
simulateApplyDiff(page, filePath, replacements): Promise<{ success: boolean }>

// Stream content to document
simulateStreamContent(page, content, config?): Promise<void>

// Get document content
simulateGetDocumentContent(page, filePath?): Promise<string>

// Trigger manual save (Cmd+S)
triggerManualSave(electronApp): Promise<void>

// Wait for file to be saved
waitForSave(page, fileName?, timeout?): Promise<void>

// Wait for editor to be ready
waitForEditorReady(page, timeout?): Promise<void>

// Verify text exists in editor
verifyEditorContains(page, text, shouldExist?): Promise<boolean>
```

## Timeouts

Standard timeouts are defined in `e2e/helpers.ts`:

```typescript
export const TEST_TIMEOUTS = {
  APP_LAUNCH: 5000,       // App should launch quickly
  SIDEBAR_LOAD: 5000,     // Sidebar should appear fast
  FILE_TREE_LOAD: 5000,   // File tree items should load fast
  TAB_SWITCH: 3000,       // Tab switching is instant
  EDITOR_LOAD: 3000,      // Editor loads quickly
  SAVE_OPERATION: 2000,   // Saves are fast
  DEFAULT_WAIT: 500,      // Standard wait between operations
};
```

## Selectors Reference

Common CSS selectors used in tests:

```typescript
// Editor
'.multi-editor-instance.active .editor [contenteditable="true"]'
'.editor [contenteditable="true"]'

// Tabs
'.tab.active'
'.tab-title'
'.tab-dirty-indicator'  // Dot showing unsaved changes

// File Tree
'.file-tree-name'
'.workspace-sidebar'

// Buttons
'button:has-text("Accept All")'
'button:has-text("Reject All")'
```

## Debugging Tests

### Run with UI

```bash
npx playwright test --ui
npx playwright test e2e/ai/diff-reliability.spec.ts --ui
```

### Run in headed mode

```bash
npx playwright test --headed
```

### Debug specific test

```bash
npx playwright test e2e/ai/diff-reliability.spec.ts:55 --headed --debug
```

### View test report

```bash
npx playwright show-report
```

### Enable verbose logging

Tests include console.log statements for debugging. Check the test output or use:

```bash
npx playwright test --reporter=line
```

## Making the App More Testable

When building UI components, follow these practices to make them easier to test:

### Add Test IDs to UI Elements

Use `data-testid` attributes for elements that will be tested frequently:

```typescript
// GOOD: Easy to test, won't break if styling changes
<button data-testid="history-restore-button" className="restore-btn">
  Restore
</button>

// In test:
await page.locator('[data-testid="history-restore-button"]').click();

// BAD: Fragile, breaks if class names change
<button className="restore-btn">Restore</button>

// In test:
await page.locator('button.restore-btn').click();
```

### Use Semantic Data Attributes

Add data attributes to indicate state and important properties:

```typescript
// GOOD: State is queryable
<div
  className="ai-session-view"
  data-active={isActive}
  data-session-id={sessionId}
>
  {children}
</div>

// In test:
const activeSession = page.locator('.ai-session-view[data-active="true"]');

// GOOD: Mode is queryable
<button
  data-mode="editor"
  className={mode === 'editor' ? 'active' : ''}
>
  Editor
</button>

// In test:
await page.locator('[data-mode="editor"]').click();
```

### Use Stable Class Names

Prefer semantic class names over generated/hashed ones:

```typescript
// GOOD: Stable selector
<div className="history-dialog">
  <div className="history-item">...</div>
  <div className="history-preview-content">...</div>
</div>

// BAD: Generated class names that change with build
<div className="Dialog_xyz123">
  <div className="Item_abc456">...</div>
</div>
```

### Structure for Testability

Make related elements easy to query together:

```typescript
// GOOD: Tab structure makes it easy to find dirty indicator for specific tab
<div className="file-tabs-container">
  <div className="tab">
    <span className="tab-title">test.md</span>
    <span className="tab-dirty-indicator" />
  </div>
</div>

// In test (can target specific tab):
const tab = page.locator('.tab', { has: page.locator('.tab-title', { hasText: 'test.md' }) });
await expect(tab.locator('.tab-dirty-indicator')).toBeVisible();

// BAD: Flat structure makes it hard to associate elements
<div>
  <span className="title">test.md</span>
  <span className="dirty" />
  <span className="title">other.md</span>
  <span className="dirty" />
</div>
```

### Expose Test Hooks Conditionally

For complex interactions, expose test-only APIs:

```typescript
// In component:
if (process.env.NODE_ENV === 'test' || window.PLAYWRIGHT) {
  (window as any).__editorRegistry = editorRegistry;
}

// In test:
const editorRegistry = await page.evaluate(() => (window as any).__editorRegistry);
```

### Best Practices Summary

1. **Use \****`data-testid`** for critical interactive elements (buttons, inputs, dialogs)
2. **Use \****\`data-*`**\*\* attributes** for state and mode indicators
3. **Use semantic class names** that won't change with styling refactors
4. **Structure HTML** to make relationships between elements clear
5. **Expose test hooks** for complex internal state when necessary
6. **Document selectors** in `PLAYWRIGHT_TEST_SELECTORS` immediately when adding new UI

### Example: Well-Structured Testable Component

```typescript
export function HistoryDialog({ isOpen, onClose, onRestore }) {
  return (
    <div
      className="history-dialog"
      data-testid="history-dialog"
      data-open={isOpen}
    >
      <div className="history-sidebar">
        {items.map((item, index) => (
          <div
            key={item.id}
            className="history-item"
            data-testid={`history-item-${index}`}
            data-selected={selectedIndex === index}
            onClick={() => setSelectedIndex(index)}
          >
            <span className="history-item-timestamp">{item.timestamp}</span>
            <span className="history-item-type" data-type={item.saveType}>
              {item.saveType === 'manual' ? 'Manual' : 'Auto'}
            </span>
          </div>
        ))}
      </div>

      <div className="history-preview">
        <pre className="history-preview-content">{selectedItem?.content}</pre>
      </div>

      <div className="history-actions">
        <button
          className="history-restore-button"
          data-testid="history-restore-button"
          disabled={!selectedItem}
          onClick={onRestore}
        >
          Restore
        </button>
      </div>
    </div>
  );
}
```

This structure makes it easy to:
- Find the dialog: `page.locator('[data-testid="history-dialog"]')`
- Check if open: `page.locator('.history-dialog[data-open="true"]')`
- Select items: `page.locator('[data-testid="history-item-0"]')`
- Find selected item: `page.locator('.history-item[data-selected="true"]')`
- Click restore: `page.locator('[data-testid="history-restore-button"]')`

## Conventions

- Electron specs live under `packages/electron/e2e/` and use TypeScript (`.ts`) extension.
- **Use `beforeAll`/`afterAll` by default** - Share app instance across tests for performance. Only use `beforeEach` when tests cannot share state.
- Keep specs self-cleaning: temporary files and launched apps must be disposed in `test.afterAll()` (or `test.afterEach()` if using per-test isolation).
- Prefer Playwright locators over raw selectors to benefit from auto-waiting and improved error messages.
- Always create test files BEFORE launching the app to ensure file tree is populated.
- Use manual save utilities (`triggerManualSave`, `waitForSave`) instead of keyboard shortcuts or autosave waits.
- Use AI Tool Simulator utilities for testing AI features without actual API calls.
- Use test helper functions and constants instead of hardcoding selectors and repeating operations.
- Add `data-testid` and semantic attributes to new UI components for easier testing.

## Common Pitfalls

1. **Creating files after app launch** - File tree won't update. Always create files before `launchElectronApp()`.
2. **Using keyboard shortcuts for save** - `page.keyboard.press('Meta+s')` doesn't trigger Electron menus. Use `manualSaveDocument()`.
3. **Waiting for autosave** - Slow and unreliable. Use `manualSaveDocument()` or `waitForAutosave()` utility instead.
4. **Importing EditorRegistry dynamically** - Use `window.__editorRegistry` instead of dynamic imports.
5. **Not waiting for editor ready** - Always call `waitForEditorReady()` after opening a file.
6. **Forgetting to accept diffs** - After applying diffs, click "Accept All" before saving.
7. **Hardcoding selectors** - Import from `PLAYWRIGHT_TEST_SELECTORS` instead of using raw CSS strings throughout tests.
8. **Not using test helpers** - Check `testHelpers.ts` before writing repetitive code. The utility probably already exists.
9. **Repeating complex operations** - If you're copying code between tests, extract it to a utility function.
10. **Not creating markdown files** - Tests that wait for an editor MUST create and open a markdown file first. See "The Fixture Error" section below.
11. **Using `beforeEach` when `beforeAll` works** - Each app launch costs 4-5 seconds. Use `beforeAll` to share the app unless tests truly cannot share state (e.g., testing startup, session restore, or permission mode switching).
12. **Using excessively long timeouts** - The app is very fast (sub-second for most operations). Use short timeouts (500-1000ms) by default. Long timeouts (5s+) mask real bugs and slow down test failures. Only use longer timeouts for operations that genuinely take time (e.g., AI API calls).
13. **Using wrong selectors for buttons** - When clicking buttons fails silently, add `data-testid` attributes to the component rather than trying different CSS selectors. Example: `data-testid="diff-keep-all"` is more reliable than `.unified-diff-header-button-accept`.
14. **Known Lexical table diff bug** - Table diffs in Lexical may require clicking "Keep All" twice. Use a workaround pattern: click once, wait briefly, check if header is still visible, click again if needed.

## The Fixture Error Pattern

### Symptom
Tests fail with misleading error: `Internal error: step id not found: fixture@XX`

### Root Cause
The error message is misleading. The actual problem is:
1. Test waits for an editor selector (e.g., `ACTIVE_EDITOR_SELECTOR`)
2. No markdown file was created or opened
3. The app has no active editor, so the selector never appears
4. The app times out or crashes
5. Playwright reports this as a "fixture error" (internal implementation detail)

### Solution
**ALWAYS create at least one markdown file and open it before waiting for the editor:**

```typescript
// Using consolidated pattern (recommended)
test.beforeAll(async () => {
  workspaceDir = await createTempWorkspace();

  // REQUIRED: Create at least one markdown file
  await fs.writeFile(path.join(workspaceDir, 'test.md'), '# Test Document\n\nTest content.\n', 'utf8');
  // Create other test files upfront
  await fs.writeFile(path.join(workspaceDir, 'another.md'), '# Another\n', 'utf8');

  // Launch app
  electronApp = await launchElectronApp({ workspace: workspaceDir });
  page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await waitForWorkspaceReady(page);
});

test.afterAll(async () => {
  await electronApp?.close();
  await fs.rm(workspaceDir, { recursive: true, force: true });
});

test('example test', async () => {
  // Open the file using utility
  await openFileFromTree(page, 'test.md');

  // NOW it's safe to wait for editor
  await page.waitForSelector(ACTIVE_EDITOR_SELECTOR, { timeout: TEST_TIMEOUTS.EDITOR_LOAD });

  // ... test logic ...

  await closeTabByFileName(page, 'test.md'); // Clean up
});
```

### What NOT To Do
```typescript
// BAD: No markdown file created, app has no editor
test.beforeAll(async () => {
  workspaceDir = await createTempWorkspace();

  // Only creating non-markdown files (images, etc.)
  await fs.writeFile(path.join(workspaceDir, 'image.png'), imageBuffer);

  electronApp = await launchElectronApp({ workspace: workspaceDir });
  page = await electronApp.firstWindow();
});

test('will fail', async () => {
  // THIS WILL FAIL WITH "fixture error"
  await page.waitForSelector(ACTIVE_EDITOR_SELECTOR); // No editor exists!
});
```

### Key Principle
**If your test needs to interact with the editor or AI chat (which requires an open document), you MUST create and open a markdown file first.**

## Future Work

- Add smoke test for the web playground once the existing Playwright setup is extended with a web project.
- Capture additional regression scenarios such as AI interactions with multiple files and complex markdown structures.
- Add tests for collaborative editing features when implemented.
- Expand theme switching tests to cover all theme variants.
- Continue extracting common patterns from existing tests into shared utilities.
- Add more `data-testid` attributes to UI components for easier, more stable testing.
- Create utilities for more complex workflows (project switching, multi-file operations, etc.).
