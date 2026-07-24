/**
 * Extension Test Fixture
 *
 * Connects Playwright to the running Nimbalyst instance via CDP (Chrome DevTools Protocol).
 * Used by the extension_test_run MCP tool and by extension test files.
 *
 * Unlike the standard E2E helpers that launch a fresh Electron instance, this fixture
 * connects to the already-running dev instance -- same app the user sees.
 *
 * Requires: Nimbalyst running in dev mode (which enables --remote-debugging-port=9222).
 */

import { test as base, expect } from '@playwright/test';
import { chromium } from 'playwright';

const CDP_PORT = process.env.NIMBALYST_CDP_PORT || '9222';
const CDP_ENDPOINT = `http://localhost:${CDP_PORT}`;

export const test = base.extend<{ page: import('playwright').Page }>({
  page: async ({}, use) => {
    let browser;
    try {
      browser = await chromium.connectOverCDP(CDP_ENDPOINT);
    } catch (error) {
      throw new Error(
        `Could not connect to Nimbalyst via CDP at ${CDP_ENDPOINT}.\n` +
        `Make sure Nimbalyst is running in dev mode (npm run dev).\n` +
        `Original error: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const contexts = browser.contexts();
    if (contexts.length === 0) {
      throw new Error('No browser contexts found. Is a Nimbalyst window open?');
    }

    // Find the main editor page (skip offscreen capture windows and DevTools)
    let mainPage: import('playwright').Page | undefined;
    for (const ctx of contexts) {
      for (const p of ctx.pages()) {
        const url = p.url();
        if (url.includes('theme=') && !url.includes('mode=capture') && !url.startsWith('devtools://')) {
          mainPage = p;
          break;
        }
      }
      if (mainPage) break;
    }
    if (!mainPage) {
      throw new Error('No Nimbalyst editor window found via CDP.');
    }

    await use(mainPage);

    // Do NOT close the browser or page -- it's the user's running app.
    // Just disconnect the CDP connection.
    browser.close();
  },
});

export { expect };

/**
 * Helper to create a locator scoped to an extension's editor container.
 *
 * Usage:
 *   const editor = extensionEditor(page, 'com.nimbalyst.csv-spreadsheet', '/path/to/data.csv');
 *   await editor.locator('.cell').first().click();
 */
export function extensionEditor(
  page: import('playwright').Page,
  extensionId: string,
  filePath?: string
): import('playwright').Locator {
  if (filePath) {
    return page.locator(
      `[data-extension-id="${extensionId}"][data-file-path="${CSS.escape(filePath)}"]`
    );
  }
  return page.locator(`[data-extension-id="${extensionId}"]`).first();
}

/**
 * Helper to create a locator scoped to an extension's panel container.
 *
 * Usage:
 *   const panel = extensionPanel(page, 'com.nimbalyst.git', 'git-log');
 *   await panel.locator('.commit-row').first().click();
 */
export function extensionPanel(
  page: import('playwright').Page,
  extensionId: string,
  panelId: string
): import('playwright').Locator {
  return page.locator(
    `[data-extension-id="${extensionId}"][data-panel="${panelId}"]`
  );
}
