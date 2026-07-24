/**
 * Extension Marketplace Screenshots
 *
 * Captures screenshots of each extension's editor for the marketplace.
 * Reads the `marketplace.screenshots` field from each extension's manifest.json
 * to determine what files to open and what to capture.
 *
 * Output:
 *   - packages/electron/marketing/screenshots/{dark,light}/ext-{id}-{n}.png
 *   - packages/extensions/{ext}/screenshots/{id}-{n}-{theme}.png
 *
 * Run:
 *   cd packages/electron && npm run marketing:screenshots:grep -- "extension-"
 */

import { test } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs/promises';
import { execSync } from 'child_process';
import {
  launchMarketingApp,
  setTheme,
  openFile,
  createTempWorkspace,
  SCREENSHOT_DIR,
  type Theme,
} from '../utils/helpers';
import type { ElectronApplication, Page } from 'playwright';

interface ManifestScreenshot {
  alt: string;
  fileToOpen?: string;
  selector?: string;
}

interface ExtensionManifest {
  id: string;
  name: string;
  marketplace?: {
    screenshots?: ManifestScreenshot[];
  };
  contributions?: {
    panels?: Array<{ id: string; title: string }>;
    keybindings?: Array<{ key: string; command: string }>;
  };
}

interface ExtensionInfo {
  manifest: ExtensionManifest;
  extensionPath: string;
  screenshotsDir: string;
}

/**
 * Discover all extensions with marketplace screenshots declared.
 */
async function discoverExtensions(): Promise<ExtensionInfo[]> {
  const extensionsRoot = path.resolve(__dirname, '../../../../packages/extensions');
  const entries = await fs.readdir(extensionsRoot, { withFileTypes: true });
  const extensions: ExtensionInfo[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const manifestPath = path.join(extensionsRoot, entry.name, 'manifest.json');
    try {
      const raw = await fs.readFile(manifestPath, 'utf-8');
      const manifest: ExtensionManifest = JSON.parse(raw);

      if (manifest.marketplace?.screenshots && manifest.marketplace.screenshots.length > 0) {
        extensions.push({
          manifest,
          extensionPath: path.join(extensionsRoot, entry.name),
          screenshotsDir: path.join(extensionsRoot, entry.name, 'screenshots'),
        });
      }
    } catch {
      // No manifest or not JSON -- skip
    }
  }

  return extensions;
}

/**
 * Collapse the AI chat sidebar by sending the toggle IPC event.
 * Only collapses if the chat panel is currently visible.
 */
async function collapseAIChat(app: ElectronApplication, page: Page): Promise<void> {
  const chatPanel = page.locator('[data-testid="chat-sidebar-panel"]');
  const isVisible = await chatPanel.isVisible().catch(() => false);
  if (isVisible) {
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().forEach(win => {
        win.webContents.send('toggle-ai-chat-panel');
      });
    });
    await page.waitForTimeout(300);
  }
}

/**
 * Collapse the file tree sidebar by clicking the sidebar toggle in the tab bar.
 */
async function collapseSidebar(app: ElectronApplication, page: Page): Promise<void> {
  const sidebar = page.locator('.workspace-sidebar');
  const isVisible = await sidebar.isVisible().catch(() => false);
  if (isVisible) {
    // The sidebar toggle button is in the tab bar header area
    const toggle = page.locator('[data-testid="sidebar-toggle"]');
    if (await toggle.isVisible().catch(() => false)) {
      await toggle.click();
      await page.waitForTimeout(300);
    }
  }
}

/**
 * Expand the file tree sidebar.
 */
async function expandSidebar(app: ElectronApplication, page: Page): Promise<void> {
  const sidebar = page.locator('.workspace-sidebar');
  const isVisible = await sidebar.isVisible().catch(() => false);
  if (!isVisible) {
    const toggle = page.locator('[data-testid="sidebar-toggle"]');
    if (await toggle.isVisible().catch(() => false)) {
      await toggle.click();
      await page.waitForTimeout(300);
    }
  }
}

let electronApp: ElectronApplication;
let page: Page;
let workspaceDir: string;

test.beforeAll(async () => {
  // Discover extensions first so we can pre-stage sample files
  const extensions = await discoverExtensions();

  // Create temp workspace with sample files pre-copied
  workspaceDir = await createTempWorkspace();

  // Copy all sample files into workspace BEFORE launch so they appear in file tree
  for (const ext of extensions) {
    const screenshots = ext.manifest.marketplace!.screenshots!;
    for (const ss of screenshots) {
      if (ss.fileToOpen) {
        const samplePath = path.join(ext.extensionPath, ss.fileToOpen);
        const destPath = path.join(workspaceDir, path.basename(ss.fileToOpen));
        try {
          await fs.copyFile(samplePath, destPath);
        } catch {
          console.warn(`Sample file not found: ${samplePath}`);
        }
      }
    }
  }

  // Initialize git repo with sample commit history so the Git panel has content
  const git = (cmd: string) => execSync(cmd, { cwd: workspaceDir, stdio: 'pipe' });
  git('git init');
  git('git config user.email "demo@nimbalyst.com"');
  git('git config user.name "Nimbalyst Demo"');

  // Create a series of realistic commits
  const commits = [
    { files: ['README.md'], msg: 'Initial project setup with README' },
    { files: ['package.json', 'tsconfig.json'], msg: 'Add TypeScript configuration and dependencies' },
    { files: ['demo.csv'], msg: 'Add sample revenue data for spreadsheet demo' },
    { files: ['demo.excalidraw'], msg: 'Add architecture diagram for documentation' },
    { files: ['demo.prisma'], msg: 'Define database schema with user and project models' },
    { files: ['demo.mockup.html'], msg: 'Create team dashboard mockup for design review' },
    { files: ['demo.pdf'], msg: 'Add extension SDK developer guide' },
    { files: ['demo.db'], msg: 'Add sample SQLite database with project data' },
  ];
  for (const { files, msg } of commits) {
    const existing = files.filter(f => {
      try { return require('fs').existsSync(path.join(workspaceDir, f)); } catch { return false; }
    });
    if (existing.length > 0) {
      git(`git add ${existing.join(' ')}`);
      git(`git commit -m "${msg}" --allow-empty`);
    }
  }

  // Launch with default marketing viewport (1440x900)
  const result = await launchMarketingApp({ theme: 'dark', workspace: workspaceDir });
  electronApp = result.app;
  page = result.page;
});

test.afterAll(async () => {
  await electronApp?.close();
  await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
});

test.describe('extension-screenshots', () => {
  test.describe.configure({ mode: 'serial' });

  test('capture extension editor screenshots', async () => {
    const extensions = await discoverExtensions();

    if (extensions.length === 0) {
      console.log('No extensions with marketplace.screenshots found. Skipping.');
      return;
    }

    for (const ext of extensions) {
      const { manifest, screenshotsDir } = ext;
      const screenshots = manifest.marketplace!.screenshots!;

      console.log(`Capturing screenshots for ${manifest.name} (${screenshots.length} screenshots)...`);

      // Ensure output directories exist
      await fs.mkdir(screenshotsDir, { recursive: true });

      // Check if this extension provides a panel (e.g., Git log) instead of a file editor
      const isPanel = !!(manifest.contributions?.panels?.length);
      const panelKeybinding = manifest.contributions?.keybindings?.[0]?.key;

      for (let i = 0; i < screenshots.length; i++) {
        const ss = screenshots[i];

        if (ss.fileToOpen) {
          const fileName = path.basename(ss.fileToOpen);

          // Need sidebar visible to open file via file tree
          await expandSidebar(electronApp, page);
          await openFile(page, fileName);

          // Extra wait for custom editors (iframe-based) to render
          await page.waitForTimeout(2000);
        } else if (isPanel && panelKeybinding) {
          // Toggle the panel open via its keyboard shortcut
          const key = panelKeybinding
            .replace('ctrl+', 'Control+')
            .replace('shift+', 'Shift+')
            .replace('alt+', 'Alt+')
            .replace('cmd+', 'Meta+');
          await page.keyboard.press(key);
          await page.waitForTimeout(1000);
        }

        // Collapse sidebar and chat to maximize editor area for screenshots
        await collapseSidebar(electronApp, page);
        await collapseAIChat(electronApp, page);
        await page.waitForTimeout(300);

        // Dismiss any error toasts that may have appeared
        const errorCloseButtons = page.locator('.error-toast-close');
        const closeCount = await errorCloseButtons.count();
        for (let c = 0; c < closeCount; c++) {
          await errorCloseButtons.nth(c).click().catch(() => {});
        }
        if (closeCount > 0) await page.waitForTimeout(400);

        // Capture both dark and light themes
        for (const theme of ['dark', 'light'] as Theme[]) {
          await setTheme(electronApp, theme);
          await page.waitForTimeout(600);

          // Save to marketing screenshots dir
          const marketingDir = path.join(SCREENSHOT_DIR, theme);
          await fs.mkdir(marketingDir, { recursive: true });
          const marketingPath = path.join(marketingDir, `ext-${manifest.id}-${i}.png`);

          // Save to extension screenshots dir
          const extPath = path.join(screenshotsDir, `${manifest.id}-${i}-${theme}.png`);

          // Use element-level capture when selector is specified
          if (ss.selector) {
            const element = page.locator(ss.selector);
            if (await element.isVisible().catch(() => false)) {
              await element.screenshot({ path: marketingPath });
            } else {
              // Fallback to full page if selector not visible
              await page.screenshot({ path: marketingPath });
            }
          } else {
            await page.screenshot({ path: marketingPath });
          }
          await fs.copyFile(marketingPath, extPath);

          console.log(`  Captured: ${manifest.id}-${i}-${theme}.png`);
        }

        // Close panel if we opened one
        if (!ss.fileToOpen && isPanel && panelKeybinding) {
          const key = panelKeybinding
            .replace('ctrl+', 'Control+')
            .replace('shift+', 'Shift+')
            .replace('alt+', 'Alt+')
            .replace('cmd+', 'Meta+');
          await page.keyboard.press(key);
          await page.waitForTimeout(300);
        }
      }
    }
  });
});
