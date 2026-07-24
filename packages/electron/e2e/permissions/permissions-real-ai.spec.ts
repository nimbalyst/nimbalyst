/**
 * Permission tests requiring real AI API (skipped in CI).
 *
 * From:
 * - webfetch-permissions.spec.ts (WebFetch/WebSearch Allow Always flow)
 * - outside-path-permissions.spec.ts (outside workspace file access permission)
 *
 * All tests share a single Electron app instance with beforeAll/afterAll.
 */

import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import {
  launchElectronApp,
  createTempWorkspace,
  waitForAppReady,
  dismissProjectTrustToast,
  TEST_TIMEOUTS,
} from '../helpers';
import {
  PLAYWRIGHT_TEST_SELECTORS,
  dismissAPIKeyDialog,
  trustWorkspaceSmartPermissions,
  switchToAgentMode,
  submitChatPrompt,
  openAgentPermissionsSettings,
  getAllowedUrlPatterns,
  getAllowedToolPatterns,
} from '../utils/testHelpers';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// Skip entire file in CI - requires real AI API
test.skip(() => !process.env.ANTHROPIC_API_KEY, 'Requires ANTHROPIC_API_KEY - not for CI');

test.setTimeout(90000);

test.describe.configure({ mode: 'serial' });

let electronApp: ElectronApplication;
let page: Page;
let workspaceDir: string;
let outsideDir: string;
let outsideFilePath: string;

test.beforeAll(async () => {
  workspaceDir = await createTempWorkspace();
  outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nimbalyst-outside-'));

  // Create test files
  await fs.writeFile(
    path.join(workspaceDir, 'test.md'),
    '# Test Document\n\nTest content.\n',
    'utf8'
  );

  // Create file OUTSIDE workspace for outside-path test
  outsideFilePath = path.join(outsideDir, 'secret.txt');
  await fs.writeFile(outsideFilePath, 'This is a secret file outside the workspace.\n', 'utf8');

  electronApp = await launchElectronApp({ workspace: workspaceDir, permissionMode: 'none' });
  page = await electronApp.firstWindow();

  await page.waitForLoadState('domcontentloaded');
  await waitForAppReady(page);
  await dismissAPIKeyDialog(page);
  await dismissProjectTrustToast(page);

  // Trust with Smart Permissions
  await trustWorkspaceSmartPermissions(page);

  // Switch to agent mode for all tests
  await switchToAgentMode(page);
  await page.waitForTimeout(1000);
});

test.afterAll(async () => {
  // Cancel any active AI request
  try {
    const cancelButton = page.locator('button.ai-cancel-button, [aria-label="Cancel"]');
    if (await cancelButton.isVisible({ timeout: 500 }).catch(() => false)) {
      await cancelButton.click();
      await page.waitForTimeout(500);
    }
  } catch {
    // No cancel button visible
  }

  await electronApp?.close();
  await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(outsideDir, { recursive: true, force: true }).catch(() => {});
});

// ============================================================================
// WebFetch Permission Tests (from webfetch-permissions.spec.ts)
// ============================================================================

test('webfetch: Allow Always saves pattern and subsequent requests pass without asking', async () => {
  await submitChatPrompt(page, 'Fetch https://example.com and tell me the page title');

  const permissionConfirmation = page.locator(PLAYWRIGHT_TEST_SELECTORS.permissionConfirmation);
  await expect(permissionConfirmation).toBeVisible({ timeout: 30000 });

  await expect(permissionConfirmation.locator(PLAYWRIGHT_TEST_SELECTORS.permissionConfirmationTitle))
    .toContainText('permission');

  const commandText = await permissionConfirmation.locator(PLAYWRIGHT_TEST_SELECTORS.permissionConfirmationCommand).textContent();
  expect(commandText).toBeTruthy();
  expect(commandText?.toLowerCase()).toContain('example.com');

  const allowAlwaysButton = page.locator(PLAYWRIGHT_TEST_SELECTORS.permissionConfirmationAllowAlwaysButton);
  await expect(allowAlwaysButton).toBeVisible();
  await allowAlwaysButton.click();

  await expect(permissionConfirmation).not.toBeVisible({ timeout: 5000 });
  await page.waitForTimeout(3000);

  await submitChatPrompt(page, 'Fetch https://example.com/about and summarize it');
  await page.waitForTimeout(5000);

  const dialogAppeared = await permissionConfirmation.isVisible().catch(() => false);
  expect(dialogAppeared).toBe(false);

  await openAgentPermissionsSettings(page);
  const allowedPatterns = await getAllowedUrlPatterns(page);
  // console.log('Allowed URL patterns:', allowedPatterns);
  const hasExampleDomain = allowedPatterns.some(pattern =>
    pattern.toLowerCase().includes('example.com')
  );
  expect(hasExampleDomain).toBe(true);
});

test('websearch: Allow Always saves pattern and subsequent requests pass without asking', async () => {
  await switchToAgentMode(page);
  await page.waitForTimeout(1000);

  await submitChatPrompt(page, 'Search the web for "Anthropic Claude latest news"');

  const permissionConfirmation = page.locator(PLAYWRIGHT_TEST_SELECTORS.permissionConfirmation);
  await expect(permissionConfirmation).toBeVisible({ timeout: 30000 });

  await expect(permissionConfirmation.locator(PLAYWRIGHT_TEST_SELECTORS.permissionConfirmationTitle))
    .toContainText('permission');

  const commandText = await permissionConfirmation.locator(PLAYWRIGHT_TEST_SELECTORS.permissionConfirmationCommand).textContent();
  expect(commandText).toBeTruthy();
  expect(commandText?.toLowerCase()).toContain('search');

  const allowAlwaysButton = page.locator(PLAYWRIGHT_TEST_SELECTORS.permissionConfirmationAllowAlwaysButton);
  await expect(allowAlwaysButton).toBeVisible();
  await allowAlwaysButton.click();

  await expect(permissionConfirmation).not.toBeVisible({ timeout: 5000 });
  await page.waitForTimeout(3000);

  await submitChatPrompt(page, 'Search for "TypeScript 5.0 features"');
  await page.waitForTimeout(5000);

  const dialogAppeared = await permissionConfirmation.isVisible().catch(() => false);
  expect(dialogAppeared).toBe(false);

  await openAgentPermissionsSettings(page);
  const allowedPatterns = await getAllowedToolPatterns(page);
  // console.log('Allowed tool patterns:', allowedPatterns);
  const hasWebSearchPattern = allowedPatterns.some(pattern =>
    pattern.toLowerCase().includes('search') && pattern.toLowerCase().includes('web')
  );
  expect(hasWebSearchPattern).toBe(true);
});

// ============================================================================
// Outside Path Permission Tests (from outside-path-permissions.spec.ts)
// ============================================================================

test('smart permissions: accessing file outside workspace triggers permission request', async () => {
  await switchToAgentMode(page);
  await page.waitForTimeout(1000);

  await submitChatPrompt(page, `Read the file at ${outsideFilePath} and tell me what it says`);

  const permissionConfirmation = page.locator(PLAYWRIGHT_TEST_SELECTORS.permissionConfirmation);
  await expect(permissionConfirmation).toBeVisible({ timeout: TEST_TIMEOUTS.VERY_LONG });

  await expect(permissionConfirmation.locator(PLAYWRIGHT_TEST_SELECTORS.permissionConfirmationTitle))
    .toContainText('permission');

  const commandText = await permissionConfirmation.locator(PLAYWRIGHT_TEST_SELECTORS.permissionConfirmationCommand).textContent();
  expect(commandText).toBeTruthy();

  await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.permissionConfirmationDenyButton)).toBeVisible();
  await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.permissionConfirmationAllowOnceButton)).toBeVisible();
});
