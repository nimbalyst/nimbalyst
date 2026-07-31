import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import * as fs from 'fs/promises';
import {
  createTempWorkspace,
  dismissProjectTrustToast,
  getKeyboardShortcut,
  launchElectronApp,
  waitForAppReady,
} from '../helpers';
import { PLAYWRIGHT_TEST_SELECTORS } from '../utils/testHelpers';

let electronApp: ElectronApplication;
let page: Page;
let workspaceDir: string;

async function overflowingShortcuts(): Promise<string[]> {
  return page
    .locator(PLAYWRIGHT_TEST_SELECTORS.unifiedQuickOpenTabShortcut)
    .evaluateAll((shortcuts, tabSelector) =>
      shortcuts.flatMap((shortcut) => {
        const badgeBounds = shortcut.getBoundingClientRect();
        const tabBounds = shortcut.closest(tabSelector)?.getBoundingClientRect();
        const textRange = document.createRange();
        textRange.selectNodeContents(shortcut);
        const textBounds = textRange.getBoundingClientRect();
        const overflows =
          !tabBounds ||
          textBounds.left < badgeBounds.left ||
          textBounds.right > badgeBounds.right ||
          badgeBounds.left < tabBounds.left ||
          badgeBounds.right > tabBounds.right;

        return overflows ? [shortcut.textContent ?? 'unknown shortcut'] : [];
      }),
      PLAYWRIGHT_TEST_SELECTORS.unifiedQuickOpenTab,
    );
}

test.beforeAll(async () => {
  workspaceDir = await createTempWorkspace();
  electronApp = await launchElectronApp({ workspace: workspaceDir, env: { NODE_ENV: 'test' } });
  page = await electronApp.firstWindow();
  await waitForAppReady(page);
  await dismissProjectTrustToast(page);
});

test.afterAll(async ({}, testInfo) => {
  testInfo.setTimeout(30_000);
  await electronApp?.close();
  if (workspaceDir) await fs.rm(workspaceDir, { recursive: true, force: true });
});

test('Unified Quick Open keeps shortcut text inside its tab at wide and narrow widths', async () => {
  await page.setViewportSize({ width: 2560, height: 1400 });
  await page.keyboard.press(getKeyboardShortcut('Mod+Shift+P'));

  const tabStrip = page.locator(PLAYWRIGHT_TEST_SELECTORS.unifiedQuickOpenTabs);
  await expect(tabStrip).toBeVisible();
  await expect.poll(overflowingShortcuts).toEqual([]);

  await page.setViewportSize({ width: 700, height: 800 });
  await expect.poll(overflowingShortcuts).toEqual([]);

  const stripWidths = await tabStrip.evaluate((strip) => ({
    client: strip.clientWidth,
    scroll: strip.scrollWidth,
    overflowX: getComputedStyle(strip).overflowX,
  }));
  expect(stripWidths.scroll).toBeGreaterThan(stripWidths.client);
  expect(stripWidths.overflowX).toBe('auto');
});
