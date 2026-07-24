/**
 * Extension Testing Utilities
 *
 * Helpers for testing Nimbalyst extensions using Playwright against the running app.
 * Extensions connect to the live Nimbalyst instance via CDP (Chrome DevTools Protocol).
 *
 * ## Quick Start
 *
 * ```ts
 * // tests/my-extension.spec.ts
 * import { test, expect, extensionEditor } from '@nimbalyst/extension-sdk/testing';
 *
 * test('loads CSV data', async ({ page }) => {
 *   const editor = extensionEditor(page, 'com.nimbalyst.csv-spreadsheet');
 *   await expect(editor.locator('.header-row')).toBeVisible();
 *   await expect(editor.locator('.data-row')).toHaveCount(10);
 * });
 * ```
 *
 * ## Setup
 *
 * Requires Nimbalyst running in dev mode (`npm run dev`), which enables CDP on port 9222.
 *
 * ## Multi-Window Support
 *
 * When multiple Nimbalyst windows are open, the fixture finds the correct window
 * by checking which window's workspacePath is an ancestor of the test file's directory.
 * This works automatically — no configuration needed.
 *
 * @packageDocumentation
 */

import { test as base, expect } from '@playwright/test';
import { chromium } from 'playwright';
import type { Page, Locator } from 'playwright';

const CDP_PORT = process.env.NIMBALYST_CDP_PORT || '9222';
const CDP_ENDPOINT = `http://localhost:${CDP_PORT}`;

/**
 * Playwright test fixture that connects to the running Nimbalyst instance via CDP.
 *
 * Unlike standard Playwright tests that launch a browser, this fixture attaches
 * to the already-running Electron app. When multiple windows are open, the fixture
 * finds the window whose workspace contains the test file (via __dirname matching).
 *
 * ```ts
 * import { test, expect } from '@nimbalyst/extension-sdk/testing';
 *
 * test('my test', async ({ page }) => {
 *   // page is the Nimbalyst window whose workspace contains this test file
 *   await page.locator('.my-element').click();
 * });
 * ```
 */
export const test = base.extend<{ page: Page }>({
  page: async ({}, use, testInfo) => {
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

    // Use the test file's directory to find the matching workspace window.
    // The test file lives inside the workspace, so the window whose
    // workspacePath is a prefix of the test file path is the correct one.
    const testFileDir = testInfo.file
      ? testInfo.file.substring(0, testInfo.file.lastIndexOf('/'))
      : undefined;

    let target: Page | undefined;
    for (const ctx of browser.contexts()) {
      for (const p of ctx.pages()) {
        const url = p.url();
        if (url.startsWith('devtools://') || url.includes('mode=capture')) continue;
        try {
          const ws = await p.evaluate(async () =>
            (await (window as any).electronAPI.getInitialState?.())?.workspacePath
          );
          if (ws && testFileDir && testFileDir.startsWith(ws)) {
            target = p;
            break;
          }
        } catch {}
      }
      if (target) break;
    }

    // Fallback: if no workspace match (e.g. inline scripts in temp dirs),
    // find the first non-devtools, non-capture page
    if (!target) {
      for (const ctx of browser.contexts()) {
        for (const p of ctx.pages()) {
          const url = p.url();
          if (url.startsWith('devtools://') || url.includes('mode=capture')) continue;
          if (url.includes('theme=')) {
            target = p;
            break;
          }
        }
        if (target) break;
      }
    }

    if (!target) {
      throw new Error(
        `No Nimbalyst window found via CDP.\n` +
        (testFileDir
          ? `Looking for a window whose workspace contains: ${testFileDir}\n`
          : '') +
        `Make sure a Nimbalyst window is open with the correct project.`
      );
    }

    await use(target);

    // Don't close the browser -- it's the user's running app
    browser.close();
  },
});

export { expect };

/**
 * Create a locator scoped to an extension's custom editor container.
 *
 * Uses the `data-extension-id` and `data-file-path` attributes set by Nimbalyst's
 * TabEditor on extension editor containers.
 *
 * ```ts
 * const editor = extensionEditor(page, 'com.nimbalyst.csv-spreadsheet', '/path/to/data.csv');
 * await editor.locator('.cell').first().click();
 * await expect(editor.locator('.header')).toHaveText('Name');
 * ```
 *
 * @param page - The Playwright page connected to Nimbalyst
 * @param extensionId - The extension's manifest ID (e.g., 'com.nimbalyst.csv-spreadsheet')
 * @param filePath - Optional: scope to a specific file's editor (when multiple files are open)
 */
export function extensionEditor(
  page: Page,
  extensionId: string,
  filePath?: string
): Locator {
  if (filePath) {
    // Escape special CSS selector characters in file paths
    const escapedPath = filePath.replace(/([\\/"'[\](){}|^$*+?.])/g, '\\$1');
    return page.locator(
      `[data-extension-id="${extensionId}"][data-file-path="${escapedPath}"]`
    );
  }
  return page.locator(`[data-extension-id="${extensionId}"]`).first();
}

/**
 * Create a locator scoped to an extension's panel container.
 *
 * Uses the `data-extension-id` and `data-panel` attributes set by Nimbalyst's
 * PanelContainer on extension panel containers.
 *
 * ```ts
 * const panel = extensionPanel(page, 'com.nimbalyst.git', 'git-log');
 * await panel.locator('.commit-row').first().click();
 * ```
 *
 * @param page - The Playwright page connected to Nimbalyst
 * @param extensionId - The extension's manifest ID
 * @param panelId - The panel ID from the manifest
 */
export function extensionPanel(
  page: Page,
  extensionId: string,
  panelId: string
): Locator {
  return page.locator(
    `[data-extension-id="${extensionId}"][data-panel="${panelId}"]`
  );
}

/**
 * Call an extension's AI tool handler directly via the renderer's tool bridge.
 * Useful for testing that tools return correct data without full MCP round-trips.
 *
 * ```ts
 * const result = await callExtensionTool(page, 'excalidraw.get_elements', {});
 * expect(result.success).toBe(true);
 * expect(result.data.elements).toHaveLength(3);
 * ```
 *
 * @param page - The Playwright page connected to Nimbalyst
 * @param toolName - Fully qualified tool name (e.g., 'excalidraw.get_elements')
 * @param args - Arguments to pass to the tool handler
 */
export async function callExtensionTool(
  page: Page,
  toolName: string,
  args: Record<string, unknown> = {}
): Promise<{ success: boolean; message?: string; data?: unknown; error?: string }> {
  return await page.evaluate(
    async ({ toolName, args }) => {
      const bridge = (window as any).__nimbalyst_extension_tools__;
      if (!bridge) {
        return { success: false, error: '__nimbalyst_extension_tools__ not found. Is Nimbalyst running in dev mode?' };
      }
      return await bridge.executeExtensionTool(toolName, args, {});
    },
    { toolName, args }
  );
}

/**
 * List all MCP tool definitions registered by extensions.
 * Useful for verifying that an extension's tools are properly registered.
 *
 * ```ts
 * const tools = await listExtensionTools(page);
 * const myTool = tools.find(t => t.name === 'csv.export');
 * expect(myTool).toBeDefined();
 * ```
 */
export async function listExtensionTools(
  page: Page
): Promise<Array<{ name: string; description: string; inputSchema?: unknown }>> {
  return await page.evaluate(async () => {
    const bridge = (window as any).__nimbalyst_extension_tools__;
    if (!bridge) return [];
    return await bridge.getMCPToolDefinitions();
  });
}
