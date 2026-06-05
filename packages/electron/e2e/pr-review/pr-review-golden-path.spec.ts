/**
 * PR Review golden-path E2E (issue #307, Phase I).
 *
 * Stubs the GitHub CLI via NIMBALYST_GH_PATH (see e2e/_fixtures/mock-gh) so
 * the panel can be exercised without a GitHub account or network. The test
 * workspace has a github.com origin, which is what makes the PR-review gutter
 * button appear.
 *
 * Covered: gutter button -> pr-review mode -> PR #42 row -> detail panel
 * (Conversation) -> "Open in Worktree" action present.
 *
 * NOT covered here: actually creating the worktree (needs a fetchable origin
 * with a pull/N/head ref); the handler logic is exercised separately.
 *
 * Run (dev server must be up on :5273):
 *   npx playwright test e2e/pr-review/pr-review-golden-path.spec.ts --max-failures=1
 */

import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { launchElectronApp, createTempWorkspace, TEST_TIMEOUTS } from '../helpers';
import { dismissAPIKeyDialog, waitForWorkspaceReady } from '../utils/testHelpers';
import * as fs from 'fs/promises';
import * as path from 'path';
import { execSync } from 'child_process';

const MOCK_GH = path.resolve(__dirname, '../_fixtures/mock-gh/mock-gh.mjs');

function git(cwd: string, args: string): void {
  execSync(`git ${args}`, { cwd, stdio: 'pipe' });
}

test.describe('PR review golden path', () => {
  test.describe.configure({ mode: 'serial' });

  let electronApp: ElectronApplication;
  let page: Page;
  let workspaceDir: string;

  test.beforeAll(async () => {
    workspaceDir = await createTempWorkspace();
    git(workspaceDir, 'init');
    git(workspaceDir, 'config user.email "test@example.com"');
    git(workspaceDir, 'config user.name "Test User"');
    // The github.com origin is what gates the PR-review gutter button.
    git(workspaceDir, 'remote add origin git@github.com:nimbalyst/test.git');
    await fs.writeFile(path.join(workspaceDir, 'README.md'), '# Test\n', 'utf8');
    git(workspaceDir, 'add .');
    git(workspaceDir, 'commit -m "init"');

    electronApp = await launchElectronApp({
      workspace: workspaceDir,
      env: { NIMBALYST_GH_PATH: MOCK_GH },
    });
    page = await electronApp.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await dismissAPIKeyDialog(page);
    await waitForWorkspaceReady(page);
  });

  test.afterAll(async () => {
    if (electronApp) await electronApp.close();
    if (workspaceDir) await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  test('shows the PR-review gutter button and opens the mode', async () => {
    const button = page.locator('[data-testid="pr-review-mode-button"]');
    await expect(button).toBeVisible({ timeout: TEST_TIMEOUTS.SIDEBAR_LOAD });
    await button.click();
    await expect(page.locator('[data-testid="pr-list"]')).toBeVisible({
      timeout: TEST_TIMEOUTS.TAB_SWITCH,
    });
  });

  test('lists PR #42 and opens its detail', async () => {
    const row = page.locator('[data-testid="pr-row"][data-pr-number="42"]');
    await expect(row).toBeVisible({ timeout: TEST_TIMEOUTS.SIDEBAR_LOAD });
    await expect(row).toContainText('Add the answer to everything');

    await row.click();

    const detail = page.locator('[data-testid="pr-detail"]');
    await expect(detail).toBeVisible({ timeout: TEST_TIMEOUTS.TAB_SWITCH });
    await expect(detail).toContainText('Add the answer to everything');

    // Conversation tab is the default and should render the PR body.
    await expect(page.locator('[data-testid="pr-conversation-tab"]')).toBeVisible({
      timeout: TEST_TIMEOUTS.TAB_SWITCH,
    });

    // The worktree action is wired (Phase H) and present in the header.
    await expect(page.locator('[data-testid="pr-open-in-worktree"]')).toBeVisible();
  });

  test('switches to the Files Changed tab and renders a diff', async () => {
    await page.locator('[data-testid="pr-tab-files"]').click();
    await expect(page.locator('[data-testid="pr-files-tab"]')).toBeVisible({
      timeout: TEST_TIMEOUTS.TAB_SWITCH,
    });
    // The mock returns one changed file; the Monaco diff viewer should mount.
    await expect(page.locator('[data-testid="pr-files-tab"] .monaco-diff-viewer')).toBeVisible({
      timeout: TEST_TIMEOUTS.EDITOR_LOAD,
    });
  });
});
