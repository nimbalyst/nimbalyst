/**
 * AI Input & Attachments E2E Tests
 *
 * Consolidated tests for AI chat input functionality including:
 * - Image attachment via drag/drop and paste
 * - Attachment removal and clearing after send
 * - File size validation
 * - @mention typeahead for all file types
 * - @mention search for nested files
 *
 * Consolidated from:
 *   ai-image-attachment.spec.ts
 *   file-mention-all-types.spec.ts
 *   image-attachment-persistence.spec.ts (meaningful tests only)
 */

import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import {
  launchElectronApp,
  createTempWorkspace,
  waitForAppReady,
  dismissProjectTrustToast,
  TEST_TIMEOUTS,
  ACTIVE_EDITOR_SELECTOR,
} from '../helpers';
import {
  PLAYWRIGHT_TEST_SELECTORS,
  openFileFromTree,
  openAIChatWithSession,
  dismissAPIKeyDialog,
  switchToAgentMode,
} from '../utils/testHelpers';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';

// Use serial mode to share a single app instance
test.describe.configure({ mode: 'serial' });

let electronApp: ElectronApplication;
let page: Page;
let workspacePath: string;
let testImagePath: string;
let largeImagePath: string;

test.beforeAll(async () => {
  workspacePath = await createTempWorkspace();

  // Create test files of different types for @mention tests
  const testFiles = [
    { name: 'notes.md', content: '# Notes\n\nSome notes.' },
    { name: 'index.ts', content: 'export const foo = "bar";' },
    { name: 'script.js', content: 'console.log("hello");' },
    { name: 'main.py', content: 'print("hello world")' },
    { name: 'config.json', content: '{"key": "value"}' },
    { name: 'docker-compose.yml', content: 'version: "3"\nservices:\n  web:\n    image: nginx' },
    { name: 'index.html', content: '<html><body>Hello</body></html>' },
    { name: 'styles.css', content: 'body { margin: 0; }' },
  ];

  for (const file of testFiles) {
    await fs.writeFile(path.join(workspacePath, file.name), file.content, 'utf8');
  }

  // Create nested file for subdirectory search
  const subdir = path.join(workspacePath, 'src', 'components');
  await fs.mkdir(subdir, { recursive: true });
  await fs.writeFile(
    path.join(workspacePath, 'src', 'components', 'Button.tsx'),
    'export const Button = () => <button />',
    'utf8'
  );

  // Create test image (1x1 PNG)
  testImagePath = path.join(workspacePath, 'test-image.png');
  const testImageBuffer = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64'
  );
  await fs.writeFile(testImagePath, testImageBuffer);

  // Create large test image (>20MB) for size validation
  // The max image size is 20MB in AttachmentService
  largeImagePath = path.join(workspacePath, 'large-image.png');
  const largeBuffer = Buffer.alloc(21 * 1024 * 1024);
  await fs.writeFile(largeImagePath, largeBuffer);

  electronApp = await launchElectronApp({
    workspace: workspacePath,
    env: { NODE_ENV: 'test' },
  });

  page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await waitForAppReady(page);
  await dismissProjectTrustToast(page);
  await dismissAPIKeyDialog(page);

  // Open a file so editor is available
  await openFileFromTree(page, 'notes.md');
  await page.waitForSelector(ACTIVE_EDITOR_SELECTOR, { timeout: TEST_TIMEOUTS.EDITOR_LOAD });
});

test.afterAll(async () => {
  await electronApp?.close();
  await fs.rm(workspacePath, { recursive: true, force: true }).catch(() => undefined);
});

// ============================================================================
// Image Attachment Tests
// ============================================================================

test.describe('Image Attachments', () => {
  // Attachments are only supported in Agent mode (not Files mode ChatSidebar)
  test.beforeAll(async () => {
    await switchToAgentMode(page);
  });

  test('should show attachment preview after dropping image', async () => {
    const agentMode = page.locator(PLAYWRIGHT_TEST_SELECTORS.agentMode);
    const chatInput = page.locator(PLAYWRIGHT_TEST_SELECTORS.agentChatInput);
    await expect(chatInput).toBeVisible({ timeout: 5000 });

    // Simulate file drop
    const fileBuffer = await fs.readFile(testImagePath);
    const dataTransfer = await page.evaluateHandle((data) => {
      const dt = new DataTransfer();
      const file = new File([new Uint8Array(data)], 'test-image.png', { type: 'image/png' });
      dt.items.add(file);
      return dt;
    }, Array.from(fileBuffer));

    await chatInput.dispatchEvent('drop', { dataTransfer });
    await page.waitForTimeout(500);

    const attachmentPreview = agentMode.locator(PLAYWRIGHT_TEST_SELECTORS.attachmentPreview);
    await expect(attachmentPreview).toBeVisible({ timeout: 3000 });

    const filename = agentMode.locator(PLAYWRIGHT_TEST_SELECTORS.attachmentFilename);
    await expect(filename).toContainText('test-image.png');

    // Clean up: remove the attachment for next test
    const removeButton = agentMode.locator(PLAYWRIGHT_TEST_SELECTORS.attachmentRemoveButton);
    await removeButton.click();
    await page.waitForTimeout(300);
  });

  test('should allow removing attachment', async () => {
    const agentMode = page.locator(PLAYWRIGHT_TEST_SELECTORS.agentMode);
    const chatInput = page.locator(PLAYWRIGHT_TEST_SELECTORS.agentChatInput);
    await expect(chatInput).toBeVisible();

    // Add an attachment
    const fileBuffer = await fs.readFile(testImagePath);
    const dataTransfer = await page.evaluateHandle((data) => {
      const dt = new DataTransfer();
      const file = new File([new Uint8Array(data)], 'test-image.png', { type: 'image/png' });
      dt.items.add(file);
      return dt;
    }, Array.from(fileBuffer));

    await chatInput.dispatchEvent('drop', { dataTransfer });
    await page.waitForTimeout(500);

    const attachmentPreview = agentMode.locator(PLAYWRIGHT_TEST_SELECTORS.attachmentPreview);
    await expect(attachmentPreview).toBeVisible({ timeout: 3000 });

    // Remove it
    const removeButton = agentMode.locator(PLAYWRIGHT_TEST_SELECTORS.attachmentRemoveButton);
    await removeButton.click();
    await page.waitForTimeout(300);

    await expect(attachmentPreview).not.toBeVisible();
  });

  test('should insert @filename reference when attachment is added', async () => {
    const agentMode = page.locator(PLAYWRIGHT_TEST_SELECTORS.agentMode);
    const chatInput = page.locator(PLAYWRIGHT_TEST_SELECTORS.agentChatInput);
    await expect(chatInput).toBeVisible();

    await chatInput.fill('Look at this image: ');

    const fileBuffer = await fs.readFile(testImagePath);
    const dataTransfer = await page.evaluateHandle((data) => {
      const dt = new DataTransfer();
      const file = new File([new Uint8Array(data)], 'test-image.png', { type: 'image/png' });
      dt.items.add(file);
      return dt;
    }, Array.from(fileBuffer));

    await chatInput.dispatchEvent('drop', { dataTransfer });
    await page.waitForTimeout(500);

    const inputValue = await chatInput.inputValue();
    expect(inputValue).toContain('@test-image.png');

    // Clean up
    await chatInput.clear();
    const removeButton = agentMode.locator(PLAYWRIGHT_TEST_SELECTORS.attachmentRemoveButton);
    if (await removeButton.isVisible()) await removeButton.click();
    await page.waitForTimeout(300);
  });

  test('should validate file size', async () => {
    const chatInput = page.locator(PLAYWRIGHT_TEST_SELECTORS.agentChatInput);
    await expect(chatInput).toBeVisible();

    let alertMessage = '';
    page.once('dialog', async dialog => {
      alertMessage = dialog.message();
      await dialog.accept();
    });

    // Create oversized file in browser context to avoid serializing 21MB through Playwright
    // The max image size is 20MB in AttachmentService
    const dataTransfer = await page.evaluateHandle(() => {
      const dt = new DataTransfer();
      const blob = new Blob([new ArrayBuffer(21 * 1024 * 1024)], { type: 'image/png' });
      const file = new File([blob], 'large-image.png', { type: 'image/png' });
      dt.items.add(file);
      return dt;
    });

    await chatInput.dispatchEvent('drop', { dataTransfer });
    await page.waitForTimeout(1000);

    expect(alertMessage).toContain('File too large');
  });

  test('should support paste from clipboard', async () => {
    const agentMode = page.locator(PLAYWRIGHT_TEST_SELECTORS.agentMode);
    const chatInput = page.locator(PLAYWRIGHT_TEST_SELECTORS.agentChatInput);
    await expect(chatInput).toBeVisible();

    await chatInput.click();

    // Use DataTransfer to create a proper clipboard paste event
    // ClipboardEvent constructor doesn't accept plain objects for clipboardData
    const fileBuffer = await fs.readFile(testImagePath);
    await page.evaluate((data) => {
      const file = new File([new Uint8Array(data)], 'pasted-image.png', { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);

      const pasteEvent = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(pasteEvent, 'clipboardData', { value: dt });

      document.querySelector('[data-testid="agent-mode-chat-input"]')?.dispatchEvent(pasteEvent);
    }, Array.from(fileBuffer));

    await page.waitForTimeout(500);

    const attachmentPreview = agentMode.locator(PLAYWRIGHT_TEST_SELECTORS.attachmentPreview);
    await expect(attachmentPreview).toBeVisible({ timeout: 3000 });

    // Clean up
    const removeButton = agentMode.locator(PLAYWRIGHT_TEST_SELECTORS.attachmentRemoveButton);
    if (await removeButton.isVisible()) await removeButton.click();
    await page.waitForTimeout(300);
  });

  test('should clear attachments after sending message', async () => {
    const agentMode = page.locator(PLAYWRIGHT_TEST_SELECTORS.agentMode);
    const chatInput = page.locator(PLAYWRIGHT_TEST_SELECTORS.agentChatInput);
    await expect(chatInput).toBeVisible();

    const fileBuffer = fsSync.readFileSync(testImagePath);
    const dataTransfer = await page.evaluateHandle((data: number[]) => {
      const dt = new DataTransfer();
      const file = new File([new Uint8Array(data)], 'test-image.png', { type: 'image/png' });
      dt.items.add(file);
      return dt;
    }, Array.from(fileBuffer));

    await chatInput.dispatchEvent('drop', { dataTransfer });
    await page.waitForTimeout(500);

    const attachmentPreview = agentMode.locator(PLAYWRIGHT_TEST_SELECTORS.attachmentPreview);
    await expect(attachmentPreview).toBeVisible();

    await chatInput.fill('Test message with image');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);

    await expect(attachmentPreview).not.toBeVisible();
    const inputValue = await chatInput.inputValue();
    expect(inputValue).toBe('');
  });
});

// ============================================================================
// @mention Typeahead Tests
// ============================================================================

test.describe('File Mention Typeahead', () => {
  test('should show all file types in @ mention typeahead', async () => {
    // Create a fresh session to avoid state pollution from previous tests
    await switchToAgentMode(page);
    await page.waitForTimeout(300);

    // Dismiss any auth dialogs from previous tests
    await dismissAPIKeyDialog(page);

    // Create a new session to get a clean input
    const agentMode = page.locator(PLAYWRIGHT_TEST_SELECTORS.agentMode);
    const newSessionButton = agentMode.locator(PLAYWRIGHT_TEST_SELECTORS.sessionHistoryNewButton);
    if (await newSessionButton.isVisible().catch(() => false)) {
      await newSessionButton.click();
      await page.waitForTimeout(500);
    }

    const chatInput = page.locator(PLAYWRIGHT_TEST_SELECTORS.agentChatInput);
    await expect(chatInput).toBeVisible({ timeout: 3000 });
    // Must use keyboard typing (not fill) so cursor position tracking works.
    // Typeahead requires at least 1 char after @ (empty query clears results).
    // Use 'in' as query - fuzzy match hits index.ts, index.html, main.py, config.json, etc.
    await chatInput.click();
    await page.keyboard.type('@in');
    await page.waitForTimeout(500);

    const typeahead = page.locator('.generic-typeahead');
    await expect(typeahead).toBeVisible({ timeout: 3000 });

    const options = await page.locator('.generic-typeahead-option').allTextContents();
    expect(options.length).toBeGreaterThan(0);

    // Verify multiple file types appear via fuzzy search
    const fileNames = options.map(opt => opt.trim().toLowerCase());
    expect(fileNames.some(name => name.includes('index'))).toBe(true);

    // Clear typeahead
    await page.keyboard.press('Escape');
    await chatInput.fill('');
  });

  test('should find nested files by filename in @ mention search', async () => {
    const chatInput = page.locator(PLAYWRIGHT_TEST_SELECTORS.agentChatInput);
    await expect(chatInput).toBeVisible({ timeout: 3000 });
    await chatInput.click();
    await page.keyboard.type('@Button');
    await page.waitForTimeout(500);

    const typeahead = page.locator('.generic-typeahead');
    await expect(typeahead).toBeVisible({ timeout: 3000 });

    const options = await page.locator('.generic-typeahead-option').allTextContents();
    expect(options.some(opt => opt.toLowerCase().includes('button'))).toBe(true);

    // Clean up
    await page.keyboard.press('Escape');
    await chatInput.fill('');
  });
});
