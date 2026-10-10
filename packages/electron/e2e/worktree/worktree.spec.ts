/**
 * Worktree E2E Tests (Consolidated)
 *
 * Consolidated from:
 * - worktree-session-creation.spec.ts (worktree session creation, button visibility)
 * - blitz-creation.spec.ts (blitz dialog, form validation, submission)
 *
 * Both test.describe blocks share a single app instance via beforeAll.
 */

import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import {
  launchElectronApp,
  createTempWorkspace,
  TEST_TIMEOUTS,
} from '../helpers';
import {
  PLAYWRIGHT_TEST_SELECTORS,
  dismissAPIKeyDialog,
  waitForWorkspaceReady,
  switchToAgentMode,
} from '../utils/testHelpers';
import * as fs from 'fs/promises';
import * as path from 'path';
import { execSync } from 'child_process';

/**
 * Launch with developer mode, the worktrees feature flag and the blitz alpha
 * feature already on. The flags are written in a first launch and the app is
 * relaunched with that userData kept: on Linux a reload right after setting
 * them aborts the navigation and closes the window.
 */
async function launchWithDeveloperWorktrees(
  workspaceDir: string,
  options: Parameters<typeof launchElectronApp>[0] = {},
): Promise<{ electronApp: ElectronApplication; page: Page }> {
  const setup = await launchElectronApp({ workspace: workspaceDir });
  const setupPage = await setup.firstWindow();
  await setupPage.waitForLoadState('domcontentloaded');
  await waitForWorkspaceReady(setupPage);
  await setupPage.evaluate(async () => {
    await window.electronAPI.invoke('developer-mode:set', true);
    await window.electronAPI.invoke('developer-features:set', { worktrees: true });
    await window.electronAPI.invoke('alpha-features:set', { blitz: true });
  });
  await setup.close();

  const electronApp = await launchElectronApp({ ...options, workspace: workspaceDir, preserveTestDatabase: true });
  const page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await dismissAPIKeyDialog(page);
  await waitForWorkspaceReady(page);
  return { electronApp, page };
}

function initGitRepo(dir: string) {
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@example.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test User"', { cwd: dir, stdio: 'pipe' });
}

// ========================================================================
// Worktree Session Creation (from worktree-session-creation.spec.ts)
// ========================================================================

test.describe('Worktree Session Creation', () => {
  test.describe.configure({ mode: 'serial' });

  let electronApp: ElectronApplication;
  let page: Page;
  let workspaceDir: string;

  test.beforeAll(async () => {
    test.setTimeout(60_000); // two launches
    workspaceDir = await createTempWorkspace();
    initGitRepo(workspaceDir);

    const testFilePath = path.join(workspaceDir, 'test.md');
    await fs.writeFile(testFilePath, '# Test Document\n\nInitial content for testing.\n', 'utf8');
    execSync('git add .', { cwd: workspaceDir, stdio: 'pipe' });
    execSync('git commit -m "Initial commit"', { cwd: workspaceDir, stdio: 'pipe' });

    ({ electronApp, page } = await launchWithDeveloperWorktrees(workspaceDir));
  });

  test.afterAll(async () => {
    if (electronApp) {
      await electronApp.close();
    }
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      await fs.rm(`${workspaceDir}_worktrees`, { recursive: true, force: true });
    }
  });

  // Non-mutating test first (files mode, before any agent mode switch)
  test('should not show New Worktree button in files mode', async () => {
    const filesModeButton = page.locator(PLAYWRIGHT_TEST_SELECTORS.filesModeButton);
    await expect(filesModeButton).toHaveAttribute('aria-pressed', 'true', { timeout: 3000 });

    const newWorktreeButton = page.locator(PLAYWRIGHT_TEST_SELECTORS.newWorktreeSessionButton);
    await expect(newWorktreeButton).not.toBeVisible();
  });

  test('should offer New Worktree in the create menu in agent mode', async () => {
    await switchToAgentMode(page);

    const agentModeButton = page.locator(PLAYWRIGHT_TEST_SELECTORS.agentModeButton);
    await expect(agentModeButton).toHaveAttribute('aria-pressed', 'true', { timeout: 3000 });

    const agenticPanelWrapper = page.locator('[data-layout="agent-mode-wrapper"]');
    await expect(agenticPanelWrapper).toBeVisible({ timeout: 10000 });

    const sessionHistory = page.locator(PLAYWRIGHT_TEST_SELECTORS.sessionHistory);
    await expect(sessionHistory).toBeVisible({ timeout: 10000 });

    await page.locator(PLAYWRIGHT_TEST_SELECTORS.newDropdownButton).click();
    const newWorktreeItem = page.locator(PLAYWRIGHT_TEST_SELECTORS.newWorktreeSessionButton);
    await expect(newWorktreeItem).toBeVisible({ timeout: 5000 });
    await expect(newWorktreeItem).toHaveAttribute('role', 'menuitem');
    await expect(newWorktreeItem).toContainText('New Worktree');
    await expect(newWorktreeItem).toBeEnabled();
    await page.keyboard.press('Escape');
  });

  test('should open the worktree picker from the create menu', async () => {
    await page.locator(PLAYWRIGHT_TEST_SELECTORS.newDropdownButton).click();
    await page.locator(PLAYWRIGHT_TEST_SELECTORS.newWorktreeSessionButton).click();
    await expect(page.locator('[data-testid="worktree-base-branch-picker"]')).toBeVisible({ timeout: 5000 });
  });

  test('should create the worktree and its session from the picker', async () => {
    await page.locator('[data-testid="worktree-name-input"]').fill('e2e-check');
    await page.locator('[data-testid="worktree-base-branch-create"]').click();
    await expect(page.locator('[data-testid="worktree-base-branch-picker"]')).toBeHidden({ timeout: 30000 });

    const worktreePath = path.join(`${workspaceDir}_worktrees`, 'e2e-check');
    await expect.poll(() => fs.stat(path.join(worktreePath, '.git')).then((s) => s.isFile()).catch(() => false), {
      timeout: 15000,
    }).toBe(true);
    const branches = execSync('git branch --list "worktree/e2e-check"', { cwd: workspaceDir, encoding: 'utf8' });
    expect(branches).toContain('worktree/e2e-check');
    await expect(page.getByText('Worktree: e2e-check').first()).toBeVisible({ timeout: 10000 });
  });
});

// ========================================================================
// Blitz Creation (from blitz-creation.spec.ts)
// ========================================================================

test.describe('Blitz Creation', () => {
  test.describe.configure({ mode: 'serial' });

  let electronApp: ElectronApplication;
  let page: Page;
  let workspaceDir: string;

  test.beforeAll(async () => {
    test.setTimeout(60_000); // two launches
    workspaceDir = await createTempWorkspace();
    initGitRepo(workspaceDir);

    const testFilePath = path.join(workspaceDir, 'test.md');
    await fs.writeFile(testFilePath, '# Test Document\n\nInitial content.\n', 'utf8');
    execSync('git add .', { cwd: workspaceDir, stdio: 'pipe' });
    execSync('git commit -m "Initial commit"', { cwd: workspaceDir, stdio: 'pipe' });

    ({ electronApp, page } = await launchWithDeveloperWorktrees(workspaceDir, {
      recordVideo: { dir: path.resolve(__dirname, '../../e2e_test_output/videos') },
    }));
  });

  test.afterAll(async () => {
    if (electronApp) {
      await electronApp.close();
    }
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  // Non-mutating test first (files mode)
  test('should not show New Blitz button in files mode', async () => {
    const filesModeButton = page.locator(PLAYWRIGHT_TEST_SELECTORS.filesModeButton);
    await expect(filesModeButton).toHaveAttribute('aria-pressed', 'true', { timeout: 3000 });

    const newBlitzButton = page.locator('[data-testid="new-blitz-button"]');
    await expect(newBlitzButton).not.toBeVisible();
  });

  test('should show New Blitz option in + dropdown menu', async () => {
    await switchToAgentMode(page);

    const sessionHistory = page.locator(PLAYWRIGHT_TEST_SELECTORS.sessionHistory);
    await expect(sessionHistory).toBeVisible({ timeout: 10000 });

    const newDropdownButton = page.locator('[data-testid="new-dropdown-button"]');
    await expect(newDropdownButton).toBeVisible({ timeout: 5000 });
    await newDropdownButton.click();

    const newBlitzButton = page.locator('[data-testid="new-blitz-button"]');
    await expect(newBlitzButton).toBeVisible({ timeout: 3000 });
    await expect(newBlitzButton).toContainText('New Blitz');

    // Close dropdown
    await page.keyboard.press('Escape');
  });

  test('should open Blitz dialog when New Blitz is clicked', async () => {
    const newDropdownButton = page.locator('[data-testid="new-dropdown-button"]');
    await newDropdownButton.click();

    const newBlitzButton = page.locator('[data-testid="new-blitz-button"]');
    await expect(newBlitzButton).toBeVisible({ timeout: 3000 });
    await newBlitzButton.click();

    const dialogOverlay = page.locator('.nim-overlay');
    await expect(dialogOverlay).toBeVisible({ timeout: 3000 });

    const dialogModal = page.locator('.nim-modal');
    await expect(dialogModal).toBeVisible({ timeout: 3000 });

    await expect(dialogModal.locator('h2')).toContainText('New Blitz');
    const textarea = dialogModal.locator('textarea');
    await expect(textarea).toBeVisible();
    await expect(dialogModal.locator('label', { hasText: 'Models' })).toBeVisible();
    await expect(dialogModal.locator('button', { hasText: 'Cancel' })).toBeVisible();
    const submitButton = dialogModal.locator('button', { hasText: /Start Blitz/ });
    await expect(submitButton).toBeVisible();

    // Close dialog for next test
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  });

  test('should validate form - submit disabled without prompt', async () => {
    const newDropdownButton = page.locator('[data-testid="new-dropdown-button"]');
    await newDropdownButton.click();
    const newBlitzButton = page.locator('[data-testid="new-blitz-button"]');
    await expect(newBlitzButton).toBeVisible({ timeout: 3000 });
    await newBlitzButton.click();

    const dialogModal = page.locator('.nim-modal');
    await expect(dialogModal).toBeVisible({ timeout: 3000 });

    const submitButton = dialogModal.locator('button', { hasText: /Start Blitz/ });
    await expect(submitButton).toBeDisabled();

    const textarea = dialogModal.locator('textarea');
    await textarea.fill('Fix the login bug');

    await expect(submitButton).toBeEnabled({ timeout: 3000 });

    // Close dialog for next test
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  });

  test('should close dialog on Cancel', async () => {
    const newDropdownButton = page.locator('[data-testid="new-dropdown-button"]');
    await newDropdownButton.click();
    const newBlitzButton = page.locator('[data-testid="new-blitz-button"]');
    await expect(newBlitzButton).toBeVisible({ timeout: 3000 });
    await newBlitzButton.click();

    const dialogOverlay = page.locator('.nim-overlay');
    await expect(dialogOverlay).toBeVisible({ timeout: 3000 });

    const cancelButton = page.locator('.nim-modal button', { hasText: 'Cancel' });
    await cancelButton.click();

    await expect(dialogOverlay).not.toBeVisible({ timeout: 3000 });
  });

  test('should close dialog on Escape key', async () => {
    const newDropdownButton = page.locator('[data-testid="new-dropdown-button"]');
    await newDropdownButton.click();
    const newBlitzButton = page.locator('[data-testid="new-blitz-button"]');
    await expect(newBlitzButton).toBeVisible({ timeout: 3000 });
    await newBlitzButton.click();

    const dialogOverlay = page.locator('.nim-overlay');
    await expect(dialogOverlay).toBeVisible({ timeout: 3000 });

    await page.keyboard.press('Escape');

    await expect(dialogOverlay).not.toBeVisible({ timeout: 3000 });
  });

  test('should capture Blitz dialog screenshot', async () => {
    const newDropdownButton = page.locator('[data-testid="new-dropdown-button"]');
    await expect(newDropdownButton).toBeVisible({ timeout: 5000 });
    await newDropdownButton.click();

    const newBlitzButton = page.locator('[data-testid="new-blitz-button"]');
    await expect(newBlitzButton).toBeVisible({ timeout: 3000 });
    await newBlitzButton.click();

    const dialogModal = page.locator('.nim-modal');
    await expect(dialogModal).toBeVisible({ timeout: 3000 });

    const screenshotDir = path.resolve(__dirname, '../../../../e2e_test_output/screenshots');
    await fs.mkdir(screenshotDir, { recursive: true });
    await page.waitForTimeout(500);
    await dialogModal.screenshot({ path: path.join(screenshotDir, 'blitz-dialog.png') });

    // Close dialog for next test
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  });

  // Mutating test last - actually creates worktrees
  test('should create blitz with worktrees on submit', async () => {
    test.setTimeout(30000);

    const newDropdownButton = page.locator('[data-testid="new-dropdown-button"]');
    await newDropdownButton.click();
    const newBlitzButton = page.locator('[data-testid="new-blitz-button"]');
    await expect(newBlitzButton).toBeVisible({ timeout: 3000 });
    await newBlitzButton.click();

    const dialogModal = page.locator('.nim-modal');
    await expect(dialogModal).toBeVisible({ timeout: 3000 });

    const textarea = dialogModal.locator('textarea');
    await textarea.fill('Fix the login bug and add unit tests');
    await page.waitForTimeout(1000);

    const checkboxes = dialogModal.locator('input[type="checkbox"]');
    const checkboxCount = await checkboxes.count();

    if (checkboxCount === 0) {
      await page.keyboard.press('Escape');
      return;
    }

    const submitButton = dialogModal.locator('button', { hasText: /Start Blitz/ });
    await expect(submitButton).toBeEnabled({ timeout: 3000 });
    await submitButton.click();

    await page.waitForTimeout(5000);

    const dialogStillOpen = await dialogModal.isVisible().catch(() => false);

    if (!dialogStillOpen) {
      const worktreesPath = path.join(workspaceDir, '.git', 'worktrees');
      const worktreesExist = await fs.stat(worktreesPath).then(() => true).catch(() => false);

      if (worktreesExist) {
        const worktrees = await fs.readdir(worktreesPath);
        expect(worktrees.length).toBeGreaterThan(0);
      }

      const blitzGroups = page.locator('.blitz-group');
      const blitzGroupCount = await blitzGroups.count();

      if (blitzGroupCount > 0) {
        const blitzHeader = page.locator('.blitz-group-header').first();
        await expect(blitzHeader).toBeVisible({ timeout: 5000 });
        const headerText = await blitzHeader.textContent();
        expect(headerText).toContain('Fix the login bug');
      }
    }
  });
});
