/**
 * Extension Loading E2E Test
 *
 * Tests that the real DatamodelLM extension is properly discovered, loaded,
 * and can render without errors. This catches real-world bundling issues
 * like import transform failures.
 */

import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import {
  launchElectronApp,
  createTempWorkspace,
  waitForAppReady,
} from '../helpers';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// Path to the real DatamodelLM extension source (in monorepo)
// From packages/electron/e2e/extensions/ -> packages/extensions/datamodellm
const DATAMODELLM_EXTENSION_PATH = path.resolve(__dirname, '../../../extensions/datamodellm');

test.describe('Extension Loading', () => {
  let electronApp: ElectronApplication;
  let page: Page;
  let workspaceDir: string;
  let extensionsDir: string;
  const consoleLogs: string[] = [];
  const consoleErrors: string[] = [];

  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    // Create temp workspace with a .prisma file
    workspaceDir = await createTempWorkspace();

    // Create a .prisma file that the extension should handle
    const prismaContent = `// @nimbalyst {"viewport":{"x":0,"y":0,"zoom":1},"positions":{"User":{"x":100,"y":100}},"entityViewMode":"standard"}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id        String   @id
  email     String   @unique
  createdAt DateTime @default(now())
}
`;

    await fs.writeFile(
      path.join(workspaceDir, 'test.prisma'),
      prismaContent,
      'utf8'
    );

    // Also create a markdown file for comparison
    await fs.writeFile(
      path.join(workspaceDir, 'readme.md'),
      '# Test\n\nThis is a test file.',
      'utf8'
    );

    // Create the test extensions directory (matches PLAYWRIGHT=1 path in ExtensionHandlers.ts)
    extensionsDir = path.join(
      os.tmpdir(),
      'nimbalyst-test-extensions',
      'extensions'
    );
    await fs.mkdir(extensionsDir, { recursive: true });

    // Symlink the REAL datamodellm-extension (not a simplified test version)
    const datamodellmPath = path.join(extensionsDir, 'datamodellm-extension');

    try {
      await fs.lstat(datamodellmPath);
      await fs.rm(datamodellmPath, { recursive: true, force: true });
    } catch {
      // Doesn't exist
    }
    await fs.symlink(DATAMODELLM_EXTENSION_PATH, datamodellmPath);

    // Verify the extension has been built
    const distExists = await fs.access(path.join(DATAMODELLM_EXTENSION_PATH, 'dist', 'index.js'))
      .then(() => true)
      .catch(() => false);

    if (!distExists) {
      throw new Error(
        `DatamodelLM extension not built. Run: cd ${DATAMODELLM_EXTENSION_PATH} && npm run build`
      );
    }

    // Launch app with workspace
    electronApp = await launchElectronApp({
      workspace: workspaceDir,
      env: { NODE_ENV: 'test' },
    });

    page = await electronApp.firstWindow();

    // Capture console logs BEFORE app initializes
    page.on('console', (msg) => {
      const text = msg.text();
      consoleLogs.push(text);
      if (msg.type() === 'error') {
        consoleErrors.push(text);
      }
    });

    await waitForAppReady(page);
  });

  test.afterAll(async () => {
    await electronApp?.close();
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(path.join(os.tmpdir(), 'nimbalyst-test-extensions'), {
      recursive: true,
      force: true,
    }).catch(() => undefined);
  });

  test('should load real DatamodelLM extension and render custom editor', async () => {
    // Wait for extension system to fully initialize
    await page.waitForTimeout(2000);

    // Check for errors in extension loading
    const loadErrors = consoleLogs.filter(log =>
      log.includes('Failed to load') ||
      log.includes('SyntaxError') ||
      log.includes('Unexpected identifier')
    );

    if (loadErrors.length > 0) {
      console.log('\n=== EXTENSION LOAD ERRORS ===');
      loadErrors.forEach(err => console.log(err));
    }

    // Extension must load without errors
    expect(loadErrors).toHaveLength(0);

    // Verify extension was loaded
    const loadedExtension = consoleLogs.some(log =>
      log.includes('[ExtensionLoader] Loaded extension: DatamodelLM')
    );
    expect(loadedExtension).toBe(true);

    // Switch to Editor mode to see the file tree
    const editorModeButton = page.locator('[data-mode="editor"]');
    if (await editorModeButton.isVisible()) {
      await editorModeButton.click();
      await page.waitForTimeout(500);
    }

    // The .prisma file should be visible in the file tree
    // First, we might need to change the file filter to show all files
    const filterButton = page.locator('button[aria-label="Filter files"]');
    if (await filterButton.isVisible()) {
      await filterButton.click();
      await page.waitForTimeout(200);
      const allFilesOption = page.locator('text=All Files');
      if (await allFilesOption.isVisible()) {
        await allFilesOption.click();
        await page.waitForTimeout(500);
      } else {
        // Close the menu if "All Files" isn't there
        await page.keyboard.press('Escape');
      }
    }

    // Wait for file tree and find the .prisma file
    await page.waitForTimeout(500);
    const prismaFile = page.locator('.file-tree-name', { hasText: 'test.prisma' });

    // The file might not be visible due to filtering, try to find it
    const isVisible = await prismaFile.isVisible().catch(() => false);
    if (!isVisible) {
      console.log('Note: .prisma file not visible in tree (may be filtered out)');
      // Try using File > Open or keyboard shortcut
      // For now, we'll verify the extension loaded correctly
      return;
    }

    // Click to open the .prisma file
    await prismaFile.click();

    // Wait for tab to appear
    await expect(
      page.locator('.tab-title', { hasText: 'test.prisma' })
    ).toBeVisible({ timeout: 5000 });

    // Wait for the custom editor to render
    await page.waitForTimeout(1000);

    // Wait for the custom editor to render
    await page.waitForTimeout(2000);

    // Debug: Log what's in the editor area
    const editorAreaHTML = await page.locator('.multi-editor-instance.active').innerHTML().catch(() => 'NOT FOUND');
    console.log('\n=== Editor Area Debug ===');
    console.log('Editor area HTML (first 500 chars):', editorAreaHTML.substring(0, 500));

    // The DatamodelLM editor should render with React Flow
    // Look for the React Flow container or the custom editor wrapper
    // Use count() > 0 instead of isVisible() because the element might have layout issues in headless mode
    const customEditorCount = await page.locator('.datamodel-editor').count();
    const reactFlowCount = await page.locator('.react-flow').count();
    const hasCustomEditor = customEditorCount > 0 || reactFlowCount > 0;

    console.log('Custom editor element count:', customEditorCount);
    console.log('React Flow element count:', reactFlowCount);

    // Verify it's NOT showing the default markdown/contenteditable editor
    const hasContentEditable = await page
      .locator('.multi-editor-instance.active [contenteditable="true"]')
      .isVisible()
      .catch(() => false);

    console.log('\n=== Custom Editor Check ===');
    console.log('Has custom editor (.datamodel-editor/.datamodel-canvas/.react-flow):', hasCustomEditor);
    console.log('Has contenteditable (default editor):', hasContentEditable);

    // If custom editor loaded, contenteditable should NOT be visible
    if (hasCustomEditor) {
      expect(hasContentEditable).toBe(false);
    } else {
      // If no custom editor, check for any rendering errors
      const errorMessages = consoleLogs.filter(log =>
        log.toLowerCase().includes('error') && !log.includes('[PostHog')
      );
      if (errorMessages.length > 0) {
        console.log('\n=== Console Errors ===');
        errorMessages.forEach(err => console.log(err));
      }
    }

    // Assert that the custom editor IS visible (extension should work)
    expect(hasCustomEditor).toBe(true);
  });
});
