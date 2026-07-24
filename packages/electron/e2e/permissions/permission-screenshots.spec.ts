/**
 * Permission Dialog Screenshots
 *
 * EXCLUDED FROM CI: These tests send real AI prompts to capture screenshots
 * of permission dialogs. Run manually when updating permission UI.
 *
 * Usage: ANTHROPIC_API_KEY=... npx playwright test e2e/permissions/permission-screenshots.spec.ts
 */

import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import { launchElectronApp, createTempWorkspace } from '../helpers';
import {
  PLAYWRIGHT_TEST_SELECTORS,
  dismissAPIKeyDialog,
  trustWorkspaceSmartPermissions,
  switchToAgentMode,
  submitChatPrompt,
} from '../utils/testHelpers';

// Skip entire file in CI - requires real AI API
test.skip(() => !process.env.ANTHROPIC_API_KEY, 'Requires ANTHROPIC_API_KEY - not for CI');
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Screenshot tests for permission dialogs.
 *
 * This test suite captures screenshots of various permission request dialogs
 * to provide a visual catalog for review.
 *
 * Screenshots are saved to: e2e_test_output/permissions/
 */

const SCREENSHOT_DIR = path.resolve(__dirname, '../../../../e2e_test_output/permissions');

test.describe.configure({ mode: 'serial' });
test.setTimeout(120000);

let electronApp: ElectronApplication;
let page: Page;
let workspaceDir: string;

test.beforeAll(async () => {
  // Ensure screenshot directory exists
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true });
});

test.beforeEach(async () => {
  workspaceDir = await createTempWorkspace();

  const testFilePath = path.join(workspaceDir, 'test.md');
  await fs.writeFile(testFilePath, '# Test Document\n\nTest content for permission screenshots.\n', 'utf8');

  electronApp = await launchElectronApp({ workspace: workspaceDir, permissionMode: 'none' });
  page = await electronApp.firstWindow();

  await page.waitForLoadState('domcontentloaded');
  await dismissAPIKeyDialog(page);

  // Trust with smart permissions so we get permission dialogs
  await trustWorkspaceSmartPermissions(page);

  // Switch to agent mode
  await switchToAgentMode(page);
  await page.waitForTimeout(1000);
});

test.afterEach(async () => {
  try {
    await electronApp.evaluate(async ({ app }) => {
      app.exit(0);
    });
  } catch {
    // App may already be closed
  }

  await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
});

async function waitForPermissionDialog(page: Page, timeoutMs = 30000): Promise<boolean> {
  const permissionConfirmation = page.locator(PLAYWRIGHT_TEST_SELECTORS.permissionConfirmation);
  try {
    await expect(permissionConfirmation).toBeVisible({ timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

async function capturePermissionScreenshot(page: Page, name: string): Promise<void> {
  const permissionConfirmation = page.locator(PLAYWRIGHT_TEST_SELECTORS.permissionConfirmation);

  // Wait for any animations to settle
  await page.waitForTimeout(500);

  // Capture just the permission dialog
  await permissionConfirmation.screenshot({
    path: path.join(SCREENSHOT_DIR, `${name}.png`),
  });

  // Also capture full page for context
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, `${name}-full.png`),
    fullPage: true,
  });

  console.log(`Screenshot captured: ${name}.png`);
}

async function denyPermission(page: Page): Promise<void> {
  const denyButton = page.locator(PLAYWRIGHT_TEST_SELECTORS.permissionConfirmationDenyButton);
  await denyButton.click();
  await page.waitForTimeout(500);
}

test.describe('Permission Dialog Screenshots', () => {
  test('WebSearch permission dialog', async () => {
    await submitChatPrompt(page, 'Search the web for "TypeScript best practices 2024"');

    if (await waitForPermissionDialog(page)) {
      await capturePermissionScreenshot(page, '01-websearch');
      await denyPermission(page);
    } else {
      console.log('WebSearch dialog did not appear - may be auto-allowed');
    }
  });

  test('WebFetch permission dialog', async () => {
    await submitChatPrompt(page, 'Fetch the contents of https://example.com and summarize it');

    if (await waitForPermissionDialog(page)) {
      await capturePermissionScreenshot(page, '02-webfetch');
      await denyPermission(page);
    } else {
      console.log('WebFetch dialog did not appear - may be auto-allowed');
    }
  });

  test('npm test permission dialog', async () => {
    await submitChatPrompt(page, 'Run npm test to check the tests');

    if (await waitForPermissionDialog(page)) {
      await capturePermissionScreenshot(page, '03-npm-test');
      await denyPermission(page);
    } else {
      console.log('npm test dialog did not appear - may be auto-allowed');
    }
  });

  test('npm install permission dialog', async () => {
    await submitChatPrompt(page, 'Run npm install to install dependencies');

    if (await waitForPermissionDialog(page)) {
      await capturePermissionScreenshot(page, '04-npm-install');
      await denyPermission(page);
    } else {
      console.log('npm install dialog did not appear - may be auto-allowed');
    }
  });

  test('git push permission dialog', async () => {
    await submitChatPrompt(page, 'Push the current branch to origin with git push');

    if (await waitForPermissionDialog(page)) {
      await capturePermissionScreenshot(page, '05-git-push');
      await denyPermission(page);
    } else {
      console.log('git push dialog did not appear - may be auto-allowed');
    }
  });

  test('git push --force permission dialog (destructive)', async () => {
    await submitChatPrompt(page, 'Force push to origin with git push --force');

    if (await waitForPermissionDialog(page)) {
      await capturePermissionScreenshot(page, '06-git-push-force-destructive');
      await denyPermission(page);
    } else {
      console.log('git push --force dialog did not appear');
    }
  });

  test('rm -rf permission dialog (destructive)', async () => {
    await submitChatPrompt(page, 'Remove the node_modules folder with rm -rf node_modules');

    if (await waitForPermissionDialog(page)) {
      await capturePermissionScreenshot(page, '07-rm-rf-destructive');
      await denyPermission(page);
    } else {
      console.log('rm -rf dialog did not appear');
    }
  });

  test('Edit file permission dialog', async () => {
    await submitChatPrompt(page, 'Add a new section to test.md called "Getting Started"');

    if (await waitForPermissionDialog(page)) {
      await capturePermissionScreenshot(page, '08-edit-file');
      await denyPermission(page);
    } else {
      console.log('Edit dialog did not appear - may be auto-allowed');
    }
  });

  test('Write new file permission dialog', async () => {
    await submitChatPrompt(page, 'Create a new file called README.md with project documentation');

    if (await waitForPermissionDialog(page)) {
      await capturePermissionScreenshot(page, '09-write-file');
      await denyPermission(page);
    } else {
      console.log('Write dialog did not appear - may be auto-allowed');
    }
  });

  test('Bash mkdir permission dialog', async () => {
    await submitChatPrompt(page, 'Create a new directory called src/components using mkdir');

    if (await waitForPermissionDialog(page)) {
      await capturePermissionScreenshot(page, '10-bash-mkdir');
      await denyPermission(page);
    } else {
      console.log('mkdir dialog did not appear - may be auto-allowed');
    }
  });

  test('git commit permission dialog', async () => {
    await submitChatPrompt(page, 'Commit all changes with message "Initial commit"');

    if (await waitForPermissionDialog(page)) {
      await capturePermissionScreenshot(page, '11-git-commit');
      await denyPermission(page);
    } else {
      console.log('git commit dialog did not appear');
    }
  });

  test('npm run build permission dialog', async () => {
    await submitChatPrompt(page, 'Build the project with npm run build');

    if (await waitForPermissionDialog(page)) {
      await capturePermissionScreenshot(page, '12-npm-run-build');
      await denyPermission(page);
    } else {
      console.log('npm run build dialog did not appear');
    }
  });

  test('curl permission dialog', async () => {
    await submitChatPrompt(page, 'Use curl to fetch https://api.github.com/users/octocat');

    if (await waitForPermissionDialog(page)) {
      await capturePermissionScreenshot(page, '13-bash-curl');
      await denyPermission(page);
    } else {
      console.log('curl dialog did not appear');
    }
  });

  test('python script permission dialog', async () => {
    await submitChatPrompt(page, 'Run python script.py to execute the Python code');

    if (await waitForPermissionDialog(page)) {
      await capturePermissionScreenshot(page, '14-bash-python');
      await denyPermission(page);
    } else {
      console.log('python dialog did not appear');
    }
  });

  test('docker permission dialog', async () => {
    await submitChatPrompt(page, 'Run docker build to build the container');

    if (await waitForPermissionDialog(page)) {
      await capturePermissionScreenshot(page, '15-bash-docker');
      await denyPermission(page);
    } else {
      console.log('docker dialog did not appear');
    }
  });
});
