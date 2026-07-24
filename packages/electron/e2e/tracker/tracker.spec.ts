/**
 * Consolidated tracker system tests
 *
 * Combines tests from:
 * - custom-tracker.spec.ts (custom tracker YAML loading)
 * - plan-status-header.spec.ts (plan status document header)
 * - tracker-comprehensive.spec.ts (tracker creation and loading)
 * - tracker-inline-behavior.spec.ts (inline tracker behavior)
 * - tracker-sync-reactivity.spec.ts (reactive UI updates on programmatic item creation)
 *
 * All tests share a single app instance with beforeAll/afterAll.
 */

import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import {
  launchElectronApp,
  createTempWorkspace,
  TEST_TIMEOUTS,
  ACTIVE_EDITOR_SELECTOR,
} from '../helpers';
import {
  PLAYWRIGHT_TEST_SELECTORS,
  dismissAPIKeyDialog,
  waitForWorkspaceReady,
  openFileFromTree,
  waitForAutosave,
} from '../utils/testHelpers';
import * as fs from 'fs/promises';
import * as path from 'path';

test.describe.configure({ mode: 'serial' });

let electronApp: ElectronApplication;
let page: Page;
let workspaceDir: string;

test.beforeAll(async () => {
  workspaceDir = await createTempWorkspace();

  // --- Create all test files upfront ---

  // Custom tracker YAML schema (for custom-tracker test)
  const trackersDir = path.join(workspaceDir, '.nimbalyst', 'trackers');
  await fs.mkdir(trackersDir, { recursive: true });
  const characterTrackerYAML = `type: character
displayName: Character
displayNamePlural: Characters
icon: person
color: "#8b5cf6"

modes:
  inline: true
  fullDocument: false

idPrefix: chr
idFormat: ulid

fields:
  - name: name
    type: string
    required: true

  - name: role
    type: select
    default: supporting
    options:
      - value: protagonist
        label: Protagonist
      - value: antagonist
        label: Antagonist
      - value: supporting
        label: Supporting

  - name: series
    type: string
    required: true

inlineTemplate: "{icon} {name} ({role})"
`;
  await fs.writeFile(path.join(trackersDir, 'character.yaml'), characterTrackerYAML, 'utf8');

  // Test file for custom tracker typeahead
  await fs.writeFile(
    path.join(workspaceDir, 'custom-tracker-test.md'),
    '# Custom Tracker Test\n\nTest custom tracker.\n',
    'utf8'
  );

  // Plan status document (for plan-status-header test)
  const testPlanContent = `---
planStatus:
  planId: plan-test-simple
  title: Simple Test Plan
  status: draft
  planType: feature
  priority: high
  owner: tester
  stakeholders:
    - team-a
  tags:
    - test
    - tracker
  created: "2025-10-23"
  updated: "2025-10-23T19:45:00.000Z"
  progress: 25
---

# Simple Test Plan

This is a simple test plan document for e2e testing of the tracker document header.

## Goals

- Test document header rendering
- Verify header updates on external file changes

## Implementation

The tracker document header should update when the file is modified externally.
`;
  await fs.writeFile(path.join(workspaceDir, 'test-plan.md'), testPlanContent, 'utf-8');

  // File for tracker creation test
  await fs.writeFile(path.join(workspaceDir, 'tracker-create.md'), '# Test\n\n', 'utf8');

  // File with pre-existing tracker item (for load test)
  await fs.writeFile(
    path.join(workspaceDir, 'tracker-load.md'),
    '# Test Document\n\nFix authentication bug #bug[id:bug_test123 status:to-do]\n',
    'utf8'
  );

  // File for inline tracker behavior test
  await fs.writeFile(path.join(workspaceDir, 'inline-tracker.md'), '# Test\n\n', 'utf8');

  // File with pre-existing tracker for Enter key test
  await fs.writeFile(
    path.join(workspaceDir, 'inline-preexisting.md'),
    '# Test Document\n\n- Fix login issue #bug[id:bug_test status:to-do]\n',
    'utf8'
  );

  // Small delay to ensure files are fully written
  await new Promise(resolve => setTimeout(resolve, 500));

  // Launch app
  electronApp = await launchElectronApp({ workspace: workspaceDir, permissionMode: 'allow-all' });
  page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await dismissAPIKeyDialog(page);
  await waitForWorkspaceReady(page);
});

test.afterAll(async () => {
  await electronApp?.close();
  if (workspaceDir) {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});

test('custom tracker should load from YAML and appear in typeahead', async () => {
  await openFileFromTree(page, 'custom-tracker-test.md');

  // Wait for editor to be ready
  const editor = page.locator('.editor [contenteditable="true"]').first();
  await expect(editor).toBeVisible({ timeout: TEST_TIMEOUTS.EDITOR_LOAD });

  // Wait for custom trackers to load
  await page.waitForTimeout(2000);

  // Click in editor and type # to trigger typeahead
  await editor.click();
  await page.keyboard.type('#');

  // Wait for typeahead menu
  const typeaheadMenu = page.locator('.typeahead-menu, [role="menu"]');
  await typeaheadMenu.waitFor({ state: 'visible', timeout: 3000 });

  // Verify Character option is in the menu
  const menuText = await page.locator('body').textContent();
  expect(menuText).toContain('Character');
  expect(menuText).toContain('Track a character');

  // Dismiss typeahead and clean up typed character
  await page.keyboard.press('Escape');
  await page.keyboard.press('Backspace');
});

test('plan status header should update on external file change', async () => {
  const testPlanPath = path.join(workspaceDir, 'test-plan.md');

  await openFileFromTree(page, 'test-plan.md');

  // Wait for editor to load - scope to the document header which is unique to plan files
  const documentHeader = page.locator(PLAYWRIGHT_TEST_SELECTORS.documentHeaderContainer);
  await expect(documentHeader).toBeVisible({ timeout: TEST_TIMEOUTS.EDITOR_LOAD });

  const statusBar = page.locator(PLAYWRIGHT_TEST_SELECTORS.statusBar);
  await expect(statusBar).toBeVisible();

  // Verify initial progress value is 25
  const progressInput = page.locator(PLAYWRIGHT_TEST_SELECTORS.sliderNumberInput);
  await expect(progressInput).toHaveValue('25', { timeout: 5000 });

  // Externally modify the file (simulating agent edit)
  const updatedContent = `---
planStatus:
  planId: plan-test-simple
  title: Simple Test Plan
  status: completed
  planType: feature
  priority: high
  owner: tester
  stakeholders:
    - team-a
  tags:
    - test
    - tracker
  created: "2025-10-23"
  updated: "2025-10-23T19:45:00.000Z"
  progress: 100
---

# Simple Test Plan

This is a simple test plan document for e2e testing of the tracker document header.

## Goals

- Test document header rendering
- Verify header updates on external file changes

## Implementation

The tracker document header should update when the file is modified externally.
`;
  await fs.writeFile(testPlanPath, updatedContent, 'utf-8');

  // Wait for file watcher to detect change and update UI
  await expect(progressInput).toHaveValue('100', { timeout: 10000 });

  // Verify status select also updated to "completed"
  const statusField = statusBar.locator('.status-bar-field', {
    has: page.locator('label', { hasText: /^status$/i }),
  });
  const statusSelectValue = statusField.locator(PLAYWRIGHT_TEST_SELECTORS.customSelectValue);
  await expect(statusSelectValue).toContainText('Completed', { timeout: 5000 });
});

test('should create tracker item and display in bottom panel', async () => {
  await openFileFromTree(page, 'tracker-create.md');

  // Type tracker item in editor
  const editor = page.locator(ACTIVE_EDITOR_SELECTOR);
  await editor.click();
  await page.keyboard.press('Meta+ArrowDown');
  await page.keyboard.type('- Fix authentication bug #bug');
  await page.keyboard.press('Enter');

  // Wait for autosave
  await waitForAutosave(page, 'tracker-create.md');

  // Open bottom panel
  const plansNavButton = page.locator('.nav-button[aria-label*="Trackers"]');
  await plansNavButton.waitFor({ state: 'visible', timeout: TEST_TIMEOUTS.DEFAULT_WAIT });
  await plansNavButton.click();

  // Click Bugs tab
  const bugsTab = page.locator('.bottom-panel-tab').filter({ hasText: 'Bugs' });
  await bugsTab.waitFor({ state: 'visible', timeout: TEST_TIMEOUTS.DEFAULT_WAIT });
  await bugsTab.click();

  // Verify tracker item appears in table (filter by module to find our specific item)
  const trackerRow = page.locator('.tracker-table-row', { hasText: 'tracker-create.md' });
  await expect(trackerRow).toBeVisible({ timeout: 2000 });

  // Verify tab count shows at least 1
  const tabCount = bugsTab.locator('.tab-count');
  await expect(tabCount).toBeVisible();
  const countText = await tabCount.textContent();
  expect(parseInt(countText || '0')).toBeGreaterThan(0);
});

test('should load pre-existing tracker items from file', async () => {
  await openFileFromTree(page, 'tracker-load.md');

  // Wait for file to load and be indexed
  const editor = page.locator(ACTIVE_EDITOR_SELECTOR);
  await expect(editor).toBeVisible({ timeout: TEST_TIMEOUTS.EDITOR_LOAD });

  // Wait for document service to index
  await page.waitForTimeout(3000);

  // Ensure bottom panel is open - if already open from previous test, clicking toggles it closed,
  // so check if Bugs tab is visible first
  const bugsTab = page.locator('.bottom-panel-tab').filter({ hasText: 'Bugs' });
  const isBugsTabVisible = await bugsTab.isVisible().catch(() => false);
  if (!isBugsTabVisible) {
    const plansNavButton = page.locator('.nav-button[aria-label*="Trackers"]');
    await plansNavButton.click();
    await bugsTab.waitFor({ state: 'visible', timeout: 5000 });
  }
  await bugsTab.click();

  // Verify bug from tracker-load.md appears (filter by module)
  const trackerRow = page.locator('.tracker-table-row', { hasText: 'tracker-load.md' });
  await expect(trackerRow).toBeVisible({ timeout: 2000 });

  // Verify bug count is at least 1
  const tabCount = bugsTab.locator('.tab-count');
  await expect(tabCount).toBeVisible();
  const countText = await tabCount.textContent();
  expect(parseInt(countText || '0')).toBeGreaterThan(0);
});

test('inline tracker should survive text deletion and allow Enter for new item', async () => {
  await openFileFromTree(page, 'inline-tracker.md');

  const editor = page.locator(ACTIVE_EDITOR_SELECTOR);
  await editor.click();
  await page.keyboard.press('Meta+ArrowDown');

  // Type text and create tracker with #bug
  await page.keyboard.type('Fix the login issue #bug');
  await page.waitForTimeout(200);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);

  // Verify tracker item was created in a list (scoped to active editor's contenteditable)
  const trackerItem = editor.locator('.tracker-item-container');
  await expect(trackerItem).toBeVisible({ timeout: 2000 });
  const listItem = editor.locator('li:has(.tracker-item-container)');
  await expect(listItem).toBeVisible({ timeout: 1000 });

  // Delete all text from the bug title
  const trackerContent = editor.locator('.tracker-content');
  const textLength = (await trackerContent.textContent())?.length || 0;

  for (let i = 0; i < Math.min(textLength, 20); i++) {
    await page.keyboard.press('Backspace');
    if (i % 3 === 0) await page.waitForTimeout(10);
  }
  await page.waitForTimeout(200);

  // Verify tracker item still exists after deleting all text
  await expect(trackerItem).toBeVisible({ timeout: 1000 });

  // Type new text - cursor should be inside the tracker node
  await page.keyboard.type('New bug text');
  await page.waitForTimeout(200);

  const newText = await trackerContent.textContent();
  expect(newText).toContain('New bug text');

  // Press Enter at end of tracker to create new list item
  await page.keyboard.press('End');
  await page.waitForTimeout(100);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);

  // Verify a new list item was created (scoped to active editor)
  const listItems = editor.locator('li');
  const count = await listItems.count();
  expect(count).toBeGreaterThanOrEqual(2);
});

test('programmatically created tracker item appears in table reactively', async () => {
  // Open a file to ensure the workspace is loaded
  await openFileFromTree(page, 'tracker-create.md');
  const editor = page.locator(ACTIVE_EDITOR_SELECTOR);
  await expect(editor).toBeVisible({ timeout: TEST_TIMEOUTS.EDITOR_LOAD });

  // Switch to Tracker mode (Cmd+T)
  await page.keyboard.press('Meta+t');

  // Wait for the tracker sidebar
  const trackerSidebar = page.locator('.tracker-sidebar');
  await trackerSidebar.waitFor({ state: 'visible', timeout: 10000 });

  // Select "Bugs" in the sidebar
  const bugsSidebarButton = trackerSidebar.locator('button', { hasText: 'Bugs' });
  await bugsSidebarButton.click();

  // Wait for table to finish initial load
  await page.waitForTimeout(2000);

  // Verify no items with our test title exist yet
  const syncedRow = page.locator('.tracker-table-row', { hasText: 'Synced bug from remote' });
  await expect(syncedRow).not.toBeVisible();

  // Create a tracker item via IPC (simulates what TrackerSyncManager.hydrateTrackerItem does)
  const itemId = `sync_test_${Date.now()}`;
  await page.evaluate(
    async ({ itemId, workspacePath }) => {
      await (window as any).electronAPI.invoke('document-service:create-tracker-item', {
        id: itemId,
        type: 'bug',
        title: 'Synced bug from remote',
        description: 'This item was synced from another client',
        status: 'open',
        priority: 'high',
        workspace: workspacePath,
      });
    },
    { itemId, workspacePath: workspaceDir }
  );

  // The item should appear in the tracker table reactively (no navigate away needed)
  await expect(syncedRow).toBeVisible({ timeout: 5000 });

  // Switch back to Files mode for subsequent tests
  await page.keyboard.press('Meta+1');
  await page.waitForTimeout(500);
});

test('Enter at end of pre-existing tracker should create new list item', async () => {
  // Close bottom panel if open from previous test to give editor enough viewport space
  const bottomPanelClose = page.locator('.bottom-panel-close');
  if (await bottomPanelClose.isVisible().catch(() => false)) {
    await bottomPanelClose.click();
    await page.waitForTimeout(200);
  }

  await openFileFromTree(page, 'inline-preexisting.md');

  const editor = page.locator(ACTIVE_EDITOR_SELECTOR);
  await expect(editor).toBeVisible({ timeout: TEST_TIMEOUTS.EDITOR_LOAD });

  // Move to end of document
  await editor.click();
  await page.keyboard.press('Meta+ArrowDown');

  // Verify tracker item is visible - use .first() since the active tab's tracker is the one we want
  const trackerContainer = editor.locator('.tracker-item-container').first();
  await expect(trackerContainer).toBeVisible({ timeout: 2000 });

  // Click at end and press Enter
  await trackerContainer.click();
  await page.keyboard.press('End');
  await page.waitForTimeout(100);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);

  // Verify new list item was created - scope to the contenteditable area
  const listItems = editor.locator('li');
  await expect(listItems).toHaveCount(2);
});
