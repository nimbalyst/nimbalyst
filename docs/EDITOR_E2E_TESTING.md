# Editor E2E Testing Guide

This document defines the conventions and patterns for building consistent E2E test coverage across all editor types in Nimbalyst.

## Directory Structure

All editor tests live under `packages/electron/e2e/editors/`, organized by editor type:

```
packages/electron/e2e/editors/
  markdown/           # Lexical-based markdown editor
    dirty-close.spec.ts
    autosave.spec.ts
    external-change.spec.ts
    diff-accept.spec.ts
    diff-reject.spec.ts

  monaco/             # Monaco code editor (.ts, .js, .json, etc.)
    dirty-close.spec.ts
    autosave.spec.ts
    external-change.spec.ts
    diff-accept.spec.ts
    diff-reject.spec.ts

  csv/                # RevoGrid spreadsheet editor
    dirty-close.spec.ts
    autosave.spec.ts
    external-change.spec.ts

  excalidraw/         # Excalidraw diagram editor
    dirty-close.spec.ts
    autosave.spec.ts
    external-change.spec.ts

  mockup/             # Mockup HTML viewer
    diff-accept.spec.ts
    diff-reject.spec.ts
```

## Standard Test File Names

Each editor should have tests for these standard behaviors, using consistent file names:

### Core Editor Behaviors (All Editors)

| File Name | Behavior Tested |
|-----------|-----------------|
| `dirty-close.spec.ts` | Edit content, verify dirty indicator, close tab, verify content saved to disk |
| `autosave.spec.ts` | Edit content, wait for autosave interval, verify dirty indicator clears, verify saved |
| `external-change.spec.ts` | External file modification while editor is clean, verify auto-reload without dialog |

### Diff Mode Behaviors (Markdown, Monaco, Mockup)

| File Name | Behavior Tested |
|-----------|-----------------|
| `diff-accept.spec.ts` | AI edit creates pending diff, verify diff UI, accept changes, verify applied and saved |
| `diff-reject.spec.ts` | AI edit creates pending diff, verify diff UI, reject changes, verify reverted to original |

### Editor-Specific Tests

Additional tests specific to an editor go in the same directory with descriptive names:

```
csv/
  dirty-close.spec.ts         # Standard
  autosave.spec.ts            # Standard
  external-change.spec.ts     # Standard
  column-formatting.spec.ts   # CSV-specific
  keyboard-navigation.spec.ts # CSV-specific

excalidraw/
  dirty-close.spec.ts         # Standard
  autosave.spec.ts            # Standard
  external-change.spec.ts     # Standard
  mermaid-import.spec.ts      # Excalidraw-specific
  batch-operations.spec.ts    # Excalidraw-specific
```

## Test File Template

Every editor test file should follow this structure:

```typescript
/**
 * [Editor Name] [Behavior] E2E Test
 *
 * Tests that [brief description of what is being tested].
 */

import { test, expect, ElectronApplication, Page } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs/promises';
import {
  launchElectronApp,
  createTempWorkspace,
  waitForAppReady,
  dismissProjectTrustToast,
  TEST_TIMEOUTS,
} from '../../helpers';
import {
  PLAYWRIGHT_TEST_SELECTORS,
  openFileFromTree,
  closeTabByFileName,
  getTabByFileName,
} from '../../utils/testHelpers';

let electronApp: ElectronApplication;
let page: Page;
let workspaceDir: string;

test.beforeEach(async () => {
  workspaceDir = await createTempWorkspace();

  // Create test file(s) BEFORE launching app
  const testFilePath = path.join(workspaceDir, 'test.ext');
  await fs.writeFile(testFilePath, 'initial content', 'utf8');

  // Launch with appropriate env (include release channel for extensions)
  electronApp = await launchElectronApp({
    workspace: workspaceDir,
    // env: { NIMBALYST_RELEASE_CHANNEL: 'alpha' }  // For CSV/Excalidraw
  });
  page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await waitForAppReady(page);
  await dismissProjectTrustToast(page);
});

test.afterEach(async () => {
  await electronApp?.close();
  if (workspaceDir) {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});

test('descriptive test name matching the file purpose', async () => {
  // Test implementation
});
```

## Standard Test Implementations

### dirty-close.spec.ts

Tests the core dirty-save-on-close behavior:

```typescript
test('edited content is saved when tab is closed', async () => {
  const filePath = path.join(workspaceDir, 'test.ext');

  // 1. Open the file
  await openFileFromTree(page, 'test.ext');

  // 2. Wait for editor to load
  await page.waitForSelector('[editor-specific-selector]', { timeout: TEST_TIMEOUTS.EDITOR_LOAD });
  await page.waitForTimeout(500);

  // 3. Make an edit (editor-specific)
  // ... perform edit action ...

  // 4. Verify dirty indicator appears
  const tab = getTabByFileName(page, 'test.ext');
  await expect(tab.locator(PLAYWRIGHT_TEST_SELECTORS.tabDirtyIndicator))
    .toBeVisible({ timeout: 2000 });

  // 5. Close the tab
  await closeTabByFileName(page, 'test.ext');
  await page.waitForTimeout(500);

  // 6. Verify content was saved to disk
  const savedContent = await fs.readFile(filePath, 'utf-8');
  expect(savedContent).toContain('expected edited content');
});
```

### autosave.spec.ts

Tests autosave behavior:

```typescript
test('autosave clears dirty indicator and saves content', async () => {
  const filePath = path.join(workspaceDir, 'test.ext');

  // 1. Open the file
  await openFileFromTree(page, 'test.ext');
  await page.waitForSelector('[editor-specific-selector]', { timeout: TEST_TIMEOUTS.EDITOR_LOAD });

  // 2. Make an edit
  // ... perform edit action ...

  // 3. Verify dirty indicator appears
  const tab = getTabByFileName(page, 'test.ext');
  await expect(tab.locator(PLAYWRIGHT_TEST_SELECTORS.tabDirtyIndicator))
    .toBeVisible({ timeout: 2000 });

  // 4. Wait for autosave (2s interval + 200ms debounce + buffer)
  await page.waitForTimeout(3500);

  // 5. Verify dirty indicator cleared
  await expect(tab.locator(PLAYWRIGHT_TEST_SELECTORS.tabDirtyIndicator))
    .toHaveCount(0, { timeout: 1000 });

  // 6. Verify content saved to disk
  const savedContent = await fs.readFile(filePath, 'utf-8');
  expect(savedContent).toContain('expected edited content');
});
```

### external-change.spec.ts

Tests file watcher auto-reload behavior:

```typescript
test('external file change auto-reloads when editor is clean', async () => {
  const filePath = path.join(workspaceDir, 'test.ext');
  const externalContent = 'externally modified content';

  // 1. Open the file
  await openFileFromTree(page, 'test.ext');
  await page.waitForSelector('[editor-specific-selector]', { timeout: TEST_TIMEOUTS.EDITOR_LOAD });

  // 2. Verify no dirty indicator (editor is clean)
  const tab = getTabByFileName(page, 'test.ext');
  await expect(tab.locator(PLAYWRIGHT_TEST_SELECTORS.tabDirtyIndicator))
    .toHaveCount(0);

  // 3. Modify file externally
  await fs.writeFile(filePath, externalContent, 'utf8');

  // 4. Wait for file watcher to detect and reload
  await page.waitForTimeout(1000);

  // 5. Verify editor shows new content (no conflict dialog)
  // ... verify content in editor-specific way ...
});
```

### diff-accept.spec.ts

Tests AI diff acceptance:

```typescript
test('accepting diff applies changes and clears indicators', async () => {
  const filePath = path.join(workspaceDir, 'test.ext');
  const originalContent = 'original content';
  const modifiedContent = 'modified content';

  // 1. Create file with original content
  await fs.writeFile(filePath, originalContent, 'utf8');

  // 2. Open the file
  await openFileFromTree(page, 'test.ext');
  await page.waitForSelector('[editor-specific-selector]', { timeout: TEST_TIMEOUTS.EDITOR_LOAD });

  // 3. Simulate AI edit by creating pending tag and modifying file
  const tagId = `test-tag-${Date.now()}`;
  const sessionId = `test-session-${Date.now()}`;

  await page.evaluate(async ({ workspacePath, filePath, tagId, sessionId, originalContent }) => {
    await window.electronAPI.history.createTag(
      workspacePath,
      filePath,
      tagId,
      originalContent,
      sessionId,
      'test-tool-use'
    );
  }, { workspacePath: workspaceDir, filePath, tagId, sessionId, originalContent });

  await fs.writeFile(filePath, modifiedContent, 'utf8');

  // 4. Close and reopen to trigger pending tag detection
  await page.keyboard.press('Meta+w');
  await page.waitForTimeout(300);
  await openFileFromTree(page, 'test.ext');

  // 5. Verify diff UI appears
  await page.waitForSelector('[diff-approval-selector]', { timeout: 5000 });

  // 6. Verify unaccepted indicator on tab
  const tab = getTabByFileName(page, 'test.ext');
  await expect(tab.locator(PLAYWRIGHT_TEST_SELECTORS.tabUnacceptedIndicator))
    .toBeVisible({ timeout: 2000 });

  // 7. Accept the diff
  await page.locator('[accept-button-selector]').click();
  await page.waitForTimeout(500);

  // 8. Verify diff UI hidden
  await expect(page.locator('[diff-approval-selector]')).toHaveCount(0);

  // 9. Verify unaccepted indicator cleared
  await expect(tab.locator(PLAYWRIGHT_TEST_SELECTORS.tabUnacceptedIndicator))
    .toHaveCount(0);

  // 10. Verify disk has modified content
  const diskContent = await fs.readFile(filePath, 'utf-8');
  expect(diskContent).toContain('modified');
});
```

### diff-reject.spec.ts

Tests AI diff rejection:

```typescript
test('rejecting diff reverts to original and clears indicators', async () => {
  // Similar setup to diff-accept.spec.ts...

  // 7. Reject the diff
  await page.locator('[reject-button-selector]').click();
  await page.waitForTimeout(500);

  // 8. Verify diff UI hidden
  await expect(page.locator('[diff-approval-selector]')).toHaveCount(0);

  // 9. Verify unaccepted indicator cleared
  await expect(tab.locator(PLAYWRIGHT_TEST_SELECTORS.tabUnacceptedIndicator))
    .toHaveCount(0);

  // 10. Verify disk has ORIGINAL content (reverted)
  const diskContent = await fs.readFile(filePath, 'utf-8');
  expect(diskContent).toContain('original');
});
```

## Editor-Specific Details

### Markdown (Lexical)

- **File extension**: `.md`
- **Editor selector**: `ACTIVE_EDITOR_SELECTOR` (contenteditable)
- **Diff approval selectors**: `PLAYWRIGHT_TEST_SELECTORS.diffApprovalBar`, `diffAcceptAllButton`, `diffRejectAllButton`
- **Edit action**: Click editor, keyboard.press('End'), keyboard.type()

### Monaco (Code)

- **File extensions**: `.ts`, `.js`, `.json`, `.tsx`, `.jsx`, `.css`, `.html`, etc.
- **Editor selector**: `.monaco-editor`
- **Diff approval selectors**: `PLAYWRIGHT_TEST_SELECTORS.monacoDiffApprovalBar`, `monacoDiffAcceptButton`, `monacoDiffRejectButton`
- **Edit action**: Click `.monaco-editor .view-lines`, keyboard.type()

### CSV (RevoGrid)

- **File extension**: `.csv`
- **Editor selector**: `revo-grid`
- **Requires**: `env: { NIMBALYST_RELEASE_CHANNEL: 'alpha' }`
- **Edit action**: Double-click cell, clear input, type, press Enter

```typescript
const dataCells = page.locator('revogr-data [role="gridcell"]');
await dataCells.nth(0).dblclick();
const editInput = page.locator('revo-grid input');
await editInput.clear();
await page.keyboard.type('NEW VALUE');
await page.keyboard.press('Enter');
```

### Excalidraw

- **File extension**: `.excalidraw`
- **Editor selector**: `.excalidraw`
- **Requires**: `env: { NIMBALYST_RELEASE_CHANNEL: 'alpha' }`
- **Edit action**: Use Excalidraw API via page.evaluate()

```typescript
await page.evaluate((filePath: string) => {
  const getEditorAPI = (window as any).__excalidraw_getEditorAPI;
  const api = getEditorAPI(filePath);
  const rectangle = {
    id: 'test-' + Date.now(),
    type: 'rectangle',
    x: 100, y: 100, width: 100, height: 100,
    // ... other required properties
  };
  api.updateScene({ elements: [...api.getSceneElements(), rectangle] });
}, filePath);
```

### Mockup

- **File extension**: `.mockup.html`
- **Editor selector**: `iframe` (mockup viewer)
- **Diff approval selectors**: `.unified-diff-header`, button with "Keep", button with "Revert"
- **Note**: Mockup files are primarily read-only viewers; editing is via AI modifications

## Adding New Test Selectors

When adding new UI elements for testing, add selectors to `PLAYWRIGHT_TEST_SELECTORS` in `e2e/utils/testHelpers.ts`:

```typescript
export const PLAYWRIGHT_TEST_SELECTORS = {
  // ... existing selectors

  // Tab indicators
  tabDirtyIndicator: '.tab-dirty-indicator',
  tabUnacceptedIndicator: '.tab-unaccepted-indicator',
  tabProcessingIndicator: '.tab-processing-indicator',

  // Editor-specific diff selectors
  diffApprovalBar: '.diff-approval-bar',
  diffAcceptAllButton: 'button.diff-accept-all-button[data-action="accept-all"]',
  diffRejectAllButton: 'button.diff-reject-all-button[data-action="reject-all"]',

  monacoDiffApprovalBar: '.monaco-diff-approval-bar',
  monacoDiffAcceptButton: '.monaco-diff-approval-bar-button-accept',
  monacoDiffRejectButton: '.monaco-diff-approval-bar-button-reject',

  mockupDiffHeader: '.unified-diff-header',
};
```

## Running Editor Tests

```bash
# Run all editor tests
npx playwright test e2e/editors/

# Run tests for a specific editor
npx playwright test e2e/editors/markdown/
npx playwright test e2e/editors/csv/

# Run a specific behavior across editors
npx playwright test e2e/editors/**/dirty-close.spec.ts
npx playwright test e2e/editors/**/autosave.spec.ts
npx playwright test e2e/editors/**/diff-*.spec.ts
```

## Checklist for New Editor Coverage

When adding E2E coverage for a new editor type:

- [ ] Create directory: `e2e/editors/[editor-name]/`
- [ ] Implement `dirty-close.spec.ts`
- [ ] Implement `autosave.spec.ts`
- [ ] Implement `external-change.spec.ts`
- [ ] If editor supports diff mode:
  - [ ] Implement `diff-accept.spec.ts`
  - [ ] Implement `diff-reject.spec.ts`
- [ ] Add editor-specific selectors to `PLAYWRIGHT_TEST_SELECTORS`
- [ ] Document any editor-specific test patterns in this guide
- [ ] Run all tests: `npx playwright test e2e/editors/[editor-name]/`
