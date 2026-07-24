import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import {
  launchElectronApp,
  createTempWorkspace,
  waitForAppReady,
  TEST_TIMEOUTS
} from '../helpers';
import path from 'path';
import fs from 'fs/promises';

test.describe.configure({ mode: 'serial' });

// Counter for unique versions to avoid reminder suppression conflicts between tests
let testVersionCounter = 0;

function getUniqueVersion(): string {
  testVersionCounter++;
  return `2.0.${testVersionCounter}`;
}

test.describe('Update Toast', () => {
  let electronApp: ElectronApplication;
  let page: Page;
  let workspacePath: string;

  test.beforeAll(async () => {
    workspacePath = await createTempWorkspace();
    const testFilePath = path.join(workspacePath, 'test.md');
    await fs.writeFile(testFilePath, '# Test Document\n\nThis is a test.');

    electronApp = await launchElectronApp({
      workspace: workspacePath,
      env: { NODE_ENV: 'test' }
    });

    page = await electronApp.firstWindow();

    page.on('console', msg => {
      const text = msg.text();
      console.log(`[BROWSER ${msg.type()}]`, text);
    });

    await waitForAppReady(page);
  });

  test.afterAll(async () => {
    if (electronApp) {
      await electronApp.close();
    }
    await fs.rm(workspacePath, { recursive: true, force: true }).catch(() => undefined);
  });

  // Clean up any lingering toast/dialog state between tests
  test.beforeEach(async () => {
    // Close any open dialog
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);

    // Dismiss any visible toast
    const container = page.locator('[data-testid="update-toast-container"]');
    if (await container.isVisible().catch(() => false)) {
      const dismiss = page.locator('[data-testid="update-toast-dismiss"]');
      if (await dismiss.isVisible().catch(() => false)) {
        await dismiss.click();
      }
      await expect(container).toHaveCount(0, { timeout: 2000 }).catch(() => {});
    }

    // Clear any reminder suppression
    await page.evaluate(async () => {
      await window.electronAPI.invoke('test:clear-update-suppression');
    });
  });

  test('should show update available toast with version and buttons', async () => {
    console.log('[TEST] Triggering update available event...');
    const testVersion = getUniqueVersion();

    // Trigger the update available event via IPC
    await page.evaluate(async (version) => {
      await window.electronAPI.invoke('test:trigger-update-available', {
        version: version,
        releaseNotes: `# Version ${version}

## Features
- New feature 1
- New feature 2

## Bug Fixes
- Fix bug 1
- Fix bug 2`,
        releaseDate: '2025-12-13'
      });
    }, testVersion);

    // Wait for toast to appear
    const toast = page.locator('[data-testid="update-available-toast"]');
    await expect(toast).toBeVisible({ timeout: 5000 });

    // Check version is displayed
    const versionText = page.locator('[data-testid="update-toast-version"]');
    await expect(versionText).toContainText(testVersion);

    // Check all buttons are visible
    await expect(page.locator('[data-testid="update-now-btn"]')).toBeVisible();
    await expect(page.locator('[data-testid="release-notes-btn"]')).toBeVisible();
    await expect(page.locator('[data-testid="remind-later-btn"]')).toBeVisible();
  });

  test('should show release notes dialog when clicking Release Notes button', async () => {
    console.log('[TEST] Testing release notes dialog...');
    const testVersion = getUniqueVersion();

    // Trigger update available
    await page.evaluate(async (version) => {
      await window.electronAPI.invoke('test:trigger-update-available', {
        version: version,
        releaseNotes: `# Version ${version}

## Features
- New feature 1
- New feature 2

## Code Example
\`\`\`javascript
console.log('Hello World');
\`\`\``,
      });
    }, testVersion);

    // Wait for toast
    const toast = page.locator('[data-testid="update-available-toast"]');
    await expect(toast).toBeVisible({ timeout: 5000 });

    // Click Release Notes button
    await page.locator('[data-testid="release-notes-btn"]').click();

    // Check dialog appears
    const dialog = page.locator('[data-testid="release-notes-dialog"]');
    await expect(dialog).toBeVisible({ timeout: 3000 });

    // Check version badges
    const currentVersionBadge = page.locator('[data-testid="current-version-badge"]');
    const newVersionBadge = page.locator('[data-testid="new-version-badge"]');
    await expect(currentVersionBadge).toBeVisible();
    await expect(newVersionBadge).toBeVisible();
    await expect(newVersionBadge).toContainText(testVersion);

    // Check release notes content is rendered as markdown
    const releaseNotes = page.locator('[data-testid="release-notes-content"]');
    await expect(releaseNotes).toBeVisible();

    // Verify markdown is rendered (check for headings and lists)
    const h1 = releaseNotes.locator('h1');
    await expect(h1).toContainText(`Version ${testVersion}`);

    const h2 = releaseNotes.locator('h2').first();
    await expect(h2).toContainText('Features');

    const listItems = releaseNotes.locator('li');
    expect(await listItems.count()).toBeGreaterThan(0);

    // Check action buttons
    await expect(page.locator('[data-testid="release-notes-later-btn"]')).toBeVisible();
    await expect(page.locator('[data-testid="release-notes-update-btn"]')).toBeVisible();
  });

  test('should transition to downloading state and show progress', async () => {
    console.log('[TEST] Testing download progress state...');
    const testVersion = getUniqueVersion();

    // Trigger update available
    await page.evaluate(async (version) => {
      await window.electronAPI.invoke('test:trigger-update-available', {
        version: version,
        releaseNotes: '## Release Notes\n\nTest release',
      });
    }, testVersion);

    // Wait for toast
    const toast = page.locator('[data-testid="update-available-toast"]');
    await expect(toast).toBeVisible({ timeout: 5000 });

    // Click Update Now button
    console.log('[TEST] Clicking Update Now button...');
    await page.locator('[data-testid="update-now-btn"]').click();

    // Simulate download progress events
    for (let i = 0; i <= 100; i += 20) {
      await page.evaluate(async (percent) => {
        await window.electronAPI.invoke('test:trigger-download-progress', {
          percent: percent,
          bytesPerSecond: 1024 * 1024 * 2, // 2 MB/s
          transferred: (50 * 1024 * 1024 * percent) / 100, // 50 MB total
          total: 50 * 1024 * 1024
        });
      }, i);
      await page.waitForTimeout(200);
    }

    // Check download progress toast is visible
    const downloadToast = page.locator('[data-testid="download-progress-toast"]');
    await expect(downloadToast).toBeVisible({ timeout: 5000 });

    // Check progress bar is updating
    const progressFill = page.locator('[data-testid="download-progress-fill"]');
    await expect(progressFill).toBeVisible();

    // Check progress text is shown
    const progressText = page.locator('[data-testid="download-progress-text"]');
    await expect(progressText).toBeVisible();

    // Check time remaining is shown
    const timeRemaining = page.locator('[data-testid="download-time-remaining"]');
    await expect(timeRemaining).toBeVisible();

    // Check cancel button is visible
    await expect(page.locator('[data-testid="download-cancel-btn"]')).toBeVisible();
  });

  test('should show ready to install toast after download', async () => {
    console.log('[TEST] Testing ready to install state...');
    const testVersion = getUniqueVersion();

    // Trigger update available first
    await page.evaluate(async (version) => {
      await window.electronAPI.invoke('test:trigger-update-available', {
        version: version,
        releaseNotes: '## Release Notes\n\nTest release',
      });
    }, testVersion);

    // Wait for toast to appear
    await expect(page.locator('[data-testid="update-available-toast"]')).toBeVisible({ timeout: 5000 });

    // Trigger ready state directly
    await page.evaluate(async (version) => {
      await window.electronAPI.invoke('test:trigger-update-ready', {
        version: version,
      });
    }, testVersion);

    // Check ready toast is shown
    const readyToast = page.locator('[data-testid="update-ready-toast"]');
    await expect(readyToast).toBeVisible({ timeout: 3000 });

    // Check buttons are visible
    await expect(page.locator('[data-testid="relaunch-btn"]')).toBeVisible();
    await expect(page.locator('[data-testid="do-it-later-btn"]')).toBeVisible();
  });

  test('should show error toast when update fails', async () => {
    console.log('[TEST] Testing error state...');
    const testVersion = getUniqueVersion();

    // Trigger update available first
    await page.evaluate(async (version) => {
      await window.electronAPI.invoke('test:trigger-update-available', {
        version: version,
        releaseNotes: '## Release Notes\n\nTest release',
      });
    }, testVersion);

    // Wait for toast to appear
    await expect(page.locator('[data-testid="update-available-toast"]')).toBeVisible({ timeout: 5000 });

    // Trigger error state
    await page.evaluate(async () => {
      await window.electronAPI.invoke('test:trigger-update-error', 'Network connection failed. Please check your internet connection and try again.');
    });

    // Check error toast is shown
    const errorToast = page.locator('[data-testid="update-error-toast"]');
    await expect(errorToast).toBeVisible({ timeout: 3000 });

    // Check error message
    const errorMessage = page.locator('[data-testid="error-message"]');
    await expect(errorMessage).toBeVisible();
    await expect(errorMessage).toContainText('Network connection failed');

    // Check dismiss button is visible
    await expect(page.locator('[data-testid="error-dismiss-btn"]')).toBeVisible();
  });

  test('should dismiss toast when Remind me later is clicked', async () => {
    console.log('[TEST] Testing toast dismissal with Remind me later...');
    const testVersion = getUniqueVersion();

    // Trigger update available
    await page.evaluate(async (version) => {
      await window.electronAPI.invoke('test:trigger-update-available', {
        version: version,
        releaseNotes: '## Release Notes\n\nTest release',
      });
    }, testVersion);

    // Wait for toast
    const toast = page.locator('[data-testid="update-available-toast"]');
    await expect(toast).toBeVisible({ timeout: 5000 });

    // Click Remind me later
    await page.locator('[data-testid="remind-later-btn"]').click();

    // Wait for toast to disappear
    await page.waitForTimeout(500);

    // Check that toast container is no longer visible
    const container = page.locator('[data-testid="update-toast-container"]');
    await expect(container).toHaveCount(0, { timeout: 3000 });
  });

  test('should dismiss toast when X button is clicked', async () => {
    console.log('[TEST] Testing toast dismissal with X button...');
    const testVersion = getUniqueVersion();

    // Trigger update available
    await page.evaluate(async (version) => {
      await window.electronAPI.invoke('test:trigger-update-available', {
        version: version,
        releaseNotes: '## Release Notes\n\nTest release',
      });
    }, testVersion);

    // Wait for toast
    const toast = page.locator('[data-testid="update-available-toast"]');
    await expect(toast).toBeVisible({ timeout: 5000 });

    // Click dismiss button
    await page.locator('[data-testid="update-toast-dismiss"]').click();

    // Wait for toast to disappear
    await page.waitForTimeout(500);

    // Check that toast container is no longer visible
    const container = page.locator('[data-testid="update-toast-container"]');
    await expect(container).toHaveCount(0, { timeout: 3000 });
  });

  test('should close release notes dialog when Later is clicked', async () => {
    console.log('[TEST] Testing release notes dialog dismissal...');
    const testVersion = getUniqueVersion();

    // Trigger update available
    await page.evaluate(async (version) => {
      await window.electronAPI.invoke('test:trigger-update-available', {
        version: version,
        releaseNotes: '## Release Notes\n\nTest release',
      });
    }, testVersion);

    // Wait for toast and open release notes
    await expect(page.locator('[data-testid="update-available-toast"]')).toBeVisible({ timeout: 5000 });
    await page.locator('[data-testid="release-notes-btn"]').click();

    // Wait for dialog
    const dialog = page.locator('[data-testid="release-notes-dialog"]');
    await expect(dialog).toBeVisible({ timeout: 3000 });

    // Click Later button
    await page.locator('[data-testid="release-notes-later-btn"]').click();

    // Dialog should close and toast should reappear
    await expect(dialog).toHaveCount(0, { timeout: 3000 });
    await expect(page.locator('[data-testid="update-available-toast"]')).toBeVisible({ timeout: 3000 });
  });

  test('should close release notes dialog when clicking outside', async () => {
    console.log('[TEST] Testing release notes dialog click-outside dismissal...');
    const testVersion = getUniqueVersion();

    // Trigger update available
    await page.evaluate(async (version) => {
      await window.electronAPI.invoke('test:trigger-update-available', {
        version: version,
        releaseNotes: '## Release Notes\n\nTest release',
      });
    }, testVersion);

    // Wait for toast and open release notes
    await expect(page.locator('[data-testid="update-available-toast"]')).toBeVisible({ timeout: 5000 });
    await page.locator('[data-testid="release-notes-btn"]').click();

    // Wait for dialog
    const dialog = page.locator('[data-testid="release-notes-dialog"]');
    await expect(dialog).toBeVisible({ timeout: 3000 });

    // Click on backdrop (outside dialog)
    const backdrop = page.locator('[data-testid="release-notes-dialog-backdrop"]');
    await backdrop.click({ position: { x: 10, y: 10 } });

    // Dialog should close
    await expect(dialog).toHaveCount(0, { timeout: 3000 });
  });

  test('should close release notes dialog when pressing Escape', async () => {
    console.log('[TEST] Testing release notes dialog Escape key dismissal...');
    const testVersion = getUniqueVersion();

    // Trigger update available
    await page.evaluate(async (version) => {
      await window.electronAPI.invoke('test:trigger-update-available', {
        version: version,
        releaseNotes: '## Release Notes\n\nTest release',
      });
    }, testVersion);

    // Wait for toast and open release notes
    await expect(page.locator('[data-testid="update-available-toast"]')).toBeVisible({ timeout: 5000 });
    await page.locator('[data-testid="release-notes-btn"]').click();

    // Wait for dialog
    const dialog = page.locator('[data-testid="release-notes-dialog"]');
    await expect(dialog).toBeVisible({ timeout: 3000 });

    // Press Escape
    await page.keyboard.press('Escape');

    // Dialog should close
    await expect(dialog).toHaveCount(0, { timeout: 3000 });
  });

  test('should start download from release notes dialog Update button', async () => {
    console.log('[TEST] Testing download start from release notes dialog...');
    const testVersion = getUniqueVersion();

    // Trigger update available
    await page.evaluate(async (version) => {
      await window.electronAPI.invoke('test:trigger-update-available', {
        version: version,
        releaseNotes: '## Release Notes\n\nTest release',
      });
    }, testVersion);

    // Wait for toast and open release notes
    await expect(page.locator('[data-testid="update-available-toast"]')).toBeVisible({ timeout: 5000 });
    await page.locator('[data-testid="release-notes-btn"]').click();

    // Wait for dialog
    const dialog = page.locator('[data-testid="release-notes-dialog"]');
    await expect(dialog).toBeVisible({ timeout: 3000 });

    // Click Update button in dialog
    await page.locator('[data-testid="release-notes-update-btn"]').click();

    // Send download progress to show downloading state
    await page.evaluate(async () => {
      await window.electronAPI.invoke('test:trigger-download-progress', {
        percent: 50,
        bytesPerSecond: 1024 * 1024 * 2,
        transferred: 25 * 1024 * 1024,
        total: 50 * 1024 * 1024
      });
    });

    // Dialog should close and download progress toast should appear
    await expect(dialog).toHaveCount(0, { timeout: 3000 });
    await expect(page.locator('[data-testid="download-progress-toast"]')).toBeVisible({ timeout: 5000 });
  });

  test('should show checking toast when manually checking for updates', async () => {
    console.log('[TEST] Testing checking for updates state...');

    // Trigger checking state
    await page.evaluate(async () => {
      await window.electronAPI.invoke('test:trigger-update-checking');
    });

    // Check checking toast is shown
    const checkingToast = page.locator('[data-testid="update-checking-toast"]');
    await expect(checkingToast).toBeVisible({ timeout: 3000 });

    // Should have a spinner
    const spinner = checkingToast.locator('.update-toast-spinner');
    await expect(spinner).toBeVisible();

    // Should show "Checking for updates..." text
    await expect(checkingToast).toContainText('Checking for updates');
  });

  test('should show up-to-date toast when no updates available', async () => {
    console.log('[TEST] Testing up-to-date state...');

    // Trigger up-to-date state
    await page.evaluate(async () => {
      await window.electronAPI.invoke('test:trigger-update-up-to-date');
    });

    // Check up-to-date toast is shown
    const upToDateToast = page.locator('[data-testid="update-up-to-date-toast"]');
    await expect(upToDateToast).toBeVisible({ timeout: 3000 });

    // Should show success message
    await expect(upToDateToast).toContainText("You're up to date");

    // Should have a dismiss button
    await expect(upToDateToast.locator('[data-testid="update-toast-dismiss"]')).toBeVisible();
  });

  test('should auto-dismiss up-to-date toast after timeout', async () => {
    console.log('[TEST] Testing up-to-date toast auto-dismiss...');

    // Trigger up-to-date state
    await page.evaluate(async () => {
      await window.electronAPI.invoke('test:trigger-update-up-to-date');
    });

    // Check up-to-date toast is shown
    const upToDateToast = page.locator('[data-testid="update-up-to-date-toast"]');
    await expect(upToDateToast).toBeVisible({ timeout: 3000 });

    // Wait for auto-dismiss (3 seconds + buffer)
    await page.waitForTimeout(3500);

    // Toast should be gone
    const container = page.locator('[data-testid="update-toast-container"]');
    await expect(container).toHaveCount(0, { timeout: 1000 });
  });

  test('should transition from checking to up-to-date', async () => {
    console.log('[TEST] Testing checking -> up-to-date transition...');

    // Trigger checking state
    await page.evaluate(async () => {
      await window.electronAPI.invoke('test:trigger-update-checking');
    });

    // Check checking toast is shown
    const checkingToast = page.locator('[data-testid="update-checking-toast"]');
    await expect(checkingToast).toBeVisible({ timeout: 3000 });

    // Simulate check completing with no updates
    await page.evaluate(async () => {
      await window.electronAPI.invoke('test:trigger-update-up-to-date');
    });

    // Checking toast should be gone, up-to-date should be visible
    await expect(checkingToast).toHaveCount(0, { timeout: 1000 });
    const upToDateToast = page.locator('[data-testid="update-up-to-date-toast"]');
    await expect(upToDateToast).toBeVisible({ timeout: 3000 });
  });

  test('should transition from checking to update available', async () => {
    console.log('[TEST] Testing checking -> update available transition...');
    const testVersion = getUniqueVersion();

    // Trigger checking state
    await page.evaluate(async () => {
      await window.electronAPI.invoke('test:trigger-update-checking');
    });

    // Check checking toast is shown
    const checkingToast = page.locator('[data-testid="update-checking-toast"]');
    await expect(checkingToast).toBeVisible({ timeout: 3000 });

    // Simulate check completing with an update available
    await page.evaluate(async (version) => {
      await window.electronAPI.invoke('test:trigger-update-available', {
        version: version,
        releaseNotes: '## New Release',
      });
    }, testVersion);

    // Wait for update available toast to be visible (this will happen after async suppression check)
    const availableToast = page.locator('[data-testid="update-available-toast"]');
    await expect(availableToast).toBeVisible({ timeout: 5000 });

    // Checking toast should be gone
    await expect(checkingToast).toHaveCount(0, { timeout: 1000 });
  });
});
