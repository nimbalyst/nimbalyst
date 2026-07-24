/**
 * Walkthrough System E2E Tests
 *
 * Tests the walkthrough guide system by triggering walkthroughs,
 * navigating through steps, and capturing screenshots.
 */

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import {
  launchElectronApp,
  createTempWorkspace,
  waitForAppReady,
} from '../helpers';
import {
  PLAYWRIGHT_TEST_SELECTORS,
  openFileFromTree,
  waitForWalkthroughHelpers,
  resetWalkthroughState,
  startWalkthrough,
  getAvailableWalkthroughs,
  waitForWalkthroughCallout,
  clickWalkthroughNext,
  clickWalkthroughBack,
  dismissWalkthroughWithButton,
  verifyWalkthroughDismissed,
  verifyWalkthroughCompleted,
} from '../utils/testHelpers';
import * as fs from 'fs/promises';
import * as path from 'path';

// Walkthrough-specific helpers
const SELECTORS = PLAYWRIGHT_TEST_SELECTORS;

test.describe.configure({ mode: 'serial' });

test.describe('Walkthrough System', () => {
  let electronApp: ElectronApplication;
  let page: Page;
  let workspaceDir: string;

  test.beforeAll(async () => {
    workspaceDir = await createTempWorkspace();
    const testFilePath = path.join(workspaceDir, 'test.md');
    await fs.writeFile(testFilePath, '# Test File\n\nSome content here.', 'utf8');

    electronApp = await launchElectronApp({ workspace: workspaceDir });
    page = await electronApp.firstWindow();
    await waitForAppReady(page);

    // Wait for walkthrough helpers to be available
    await waitForWalkthroughHelpers(page);
  });

  test.afterAll(async () => {
    await electronApp.close();
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  // Reset walkthrough state before each test so they're independent
  test.beforeEach(async () => {
    await resetWalkthroughState(page);
    await page.waitForTimeout(300);
  });

  test('should list available walkthroughs', async () => {
    const walkthroughs = await getAvailableWalkthroughs(page);

    expect(walkthroughs).toContain('agent-mode-intro');
    expect(walkthroughs).toContain('files-mode-intro');
    expect(walkthroughs).toContain('ai-sessions-button');
    expect(walkthroughs).toContain('file-tree-tools');
  });

  test('file-tree-tools walkthrough', async () => {
    // Start the file tree tools walkthrough
    await startWalkthrough(page, 'file-tree-tools');

    // Wait for callout to appear and animation to complete
    await waitForWalkthroughCallout(page);
    await page.waitForTimeout(300);

    // Verify first step - Filter button
    const title = page.locator(SELECTORS.walkthroughCalloutTitle);
    const progress = page.locator(SELECTORS.walkthroughCalloutProgress);
    await expect(title).toHaveText('Filter Your File Tree');
    await expect(progress).toHaveText('1 of 2');

    // Screenshot step 1
    await page.screenshot({
      path: 'e2e/walkthroughs/screenshots/file-tree-tools-step1-filter.png',
      fullPage: true,
    });

    // Click Next
    await clickWalkthroughNext(page);

    // Verify second step - Quick Open
    await expect(title).toHaveText('Quick Open Files');
    await expect(progress).toHaveText('2 of 2');

    // Screenshot step 2
    await page.screenshot({
      path: 'e2e/walkthroughs/screenshots/file-tree-tools-step2-quickopen.png',
      fullPage: true,
    });

    // Click Done to complete
    await clickWalkthroughNext(page);

    // Verify callout is dismissed and walkthrough completed
    await verifyWalkthroughDismissed(page);
    await verifyWalkthroughCompleted(page, 'file-tree-tools');
  });

  test('ai-sessions-button walkthrough', async () => {
    // Open a file to make the AI sessions button visible
    await openFileFromTree(page, 'test.md');

    // Wait for editor to load and AI sessions button to appear
    const aiSessionsButton = page.locator(SELECTORS.aiSessionsButton);
    await expect(aiSessionsButton).toBeVisible({ timeout: 5000 });

    // Start the walkthrough
    await startWalkthrough(page, 'ai-sessions-button');

    // Wait for callout to appear
    await waitForWalkthroughCallout(page);

    // Verify step content
    const title = page.locator(SELECTORS.walkthroughCalloutTitle);
    await expect(title).toHaveText('Past AI Sessions');

    // Screenshot
    await page.screenshot({
      path: 'e2e/walkthroughs/screenshots/ai-sessions-button.png',
      fullPage: true,
    });

    // Dismiss with Escape
    await page.keyboard.press('Escape');

    // Verify callout is dismissed
    await verifyWalkthroughDismissed(page);
  });

  test('walkthrough can be dismissed by clicking outside', async () => {
    // Start a walkthrough
    await startWalkthrough(page, 'file-tree-tools');
    await waitForWalkthroughCallout(page);

    // Click outside the callout (on the workspace sidebar)
    const sidebar = page.locator(SELECTORS.workspaceSidebar);
    await sidebar.click({ position: { x: 10, y: 300 } });

    // Verify callout is dismissed
    await verifyWalkthroughDismissed(page);
  });

  test('walkthrough can be dismissed by clicking X button', async () => {
    await startWalkthrough(page, 'file-tree-tools');
    await waitForWalkthroughCallout(page);

    // Click dismiss button
    await dismissWalkthroughWithButton(page);

    // Verify callout is dismissed
    await verifyWalkthroughDismissed(page);
  });

  test('walkthrough Back button navigates to previous step', async () => {
    await startWalkthrough(page, 'file-tree-tools');
    await waitForWalkthroughCallout(page);

    const progress = page.locator(SELECTORS.walkthroughCalloutProgress);
    const title = page.locator(SELECTORS.walkthroughCalloutTitle);

    // Go to step 2
    await clickWalkthroughNext(page);
    await expect(progress).toHaveText('2 of 2');

    // Go back to step 1
    await clickWalkthroughBack(page);
    await expect(progress).toHaveText('1 of 2');
    await expect(title).toHaveText('Filter Your File Tree');
  });

  test('walkthrough state is persisted', async () => {
    // Complete a walkthrough
    await startWalkthrough(page, 'file-tree-tools');
    await waitForWalkthroughCallout(page);

    // Complete it (2 steps: Next -> Done)
    await clickWalkthroughNext(page);
    await clickWalkthroughNext(page);

    // Verify callout is dismissed and state persisted
    await verifyWalkthroughDismissed(page);
    await verifyWalkthroughCompleted(page, 'file-tree-tools');
  });
});
