/**
 * Image paste E2E tests.
 *
 * Tests content-addressed asset storage and deduplication.
 * All tests share a single Electron app instance with beforeAll/afterAll.
 */

import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import {
  launchElectronApp,
  createTempWorkspace,
  waitForAppReady,
  ACTIVE_EDITOR_SELECTOR,
} from '../helpers';
import { openFileFromTree } from '../utils/testHelpers';
import * as path from 'path';
import * as fs from 'fs';
import * as fsp from 'fs/promises';

test.describe.configure({ mode: 'serial' });

let electronApp: ElectronApplication;
let page: Page;
let workspace: string;

test.beforeAll(async () => {
  workspace = await createTempWorkspace();

  await fsp.writeFile(
    path.join(workspace, 'test.md'),
    '# Test Document\n\nPaste image here.\n',
    'utf8'
  );

  await fsp.writeFile(
    path.join(workspace, 'test-dup.md'),
    '# Deduplication Test\n\n',
    'utf8'
  );

  await fsp.writeFile(
    path.join(workspace, 'test-render.md'),
    '# Render Test\n\nPaste image here.\n',
    'utf8'
  );

  electronApp = await launchElectronApp({ workspace });
  page = await electronApp.firstWindow();
  await waitForAppReady(page);
});

test.afterAll(async () => {
  await electronApp?.close();
  await fsp.rm(workspace, { recursive: true, force: true }).catch(() => {});
});

async function pasteImage(p: Page, svgContent: string) {
  await p.evaluate(async (svgData) => {
    const blob = new Blob([svgData], { type: 'image/svg+xml' });
    const file = new File([blob], 'test-image.svg', { type: 'image/svg+xml' });

    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);

    const editorElement = document.querySelector('.editor [contenteditable="true"]');
    if (!editorElement) throw new Error('Editor not found');

    const pasteEvent = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: dataTransfer as any,
    });

    editorElement.dispatchEvent(pasteEvent);
  }, svgContent);
}

test('should store pasted image as content-addressed asset', async () => {
  await openFileFromTree(page, 'test.md');
  await page.waitForTimeout(500);

  const editor = page.locator(ACTIVE_EDITOR_SELECTOR);
  await editor.click();

  const svgContent = '<svg width="100" height="100" xmlns="http://www.w3.org/2000/svg"><circle cx="50" cy="50" r="40" fill="red"/></svg>';
  await pasteImage(page, svgContent);

  await page.waitForTimeout(1000);

  // Check that .nimbalyst/assets directory was created
  const assetsDir = path.join(workspace, '.nimbalyst', 'assets');
  const assetsDirExists = fs.existsSync(assetsDir);
  expect(assetsDirExists).toBe(true);

  if (assetsDirExists) {
    const files = fs.readdirSync(assetsDir);
    expect(files.length).toBeGreaterThan(0);

    const svgFiles = files.filter(f => f.endsWith('.svg'));
    expect(svgFiles.length).toBe(1);

    const assetContent = fs.readFileSync(path.join(assetsDir, svgFiles[0]), 'utf-8');
    expect(assetContent).toContain('circle');
    expect(assetContent).toContain('fill="red"');
  }

  const hasImage = await page.evaluate(() => {
    const editorElement = document.querySelector('.editor [contenteditable="true"]');
    const images = editorElement?.querySelectorAll('img');
    if (images && images.length > 0) {
      return {
        count: images.length,
        src: images[0].getAttribute('src'),
      };
    }
    return null;
  });

  expect(hasImage).not.toBeNull();
  expect(hasImage?.count).toBeGreaterThan(0);
  expect(hasImage?.src).toContain('.nimbalyst/assets/');
  expect(hasImage?.src).not.toContain('data:image');
});

test('renders pasted image via nim-asset:// so it loads under webSecurity:true', async () => {
  // Regression for issue #146 follow-up: webSecurity hardening blocks
  // <img src="file://..."> in the main window, so the markdown editor
  // must route pasted-image URLs through the nim-asset:// custom
  // protocol. If this asserts file:// (or fails to load), localAssetUrl
  // is not registered or ImageComponent is bypassing it.
  await openFileFromTree(page, 'test-render.md');
  await page.waitForTimeout(500);

  const editor = page.locator(ACTIVE_EDITOR_SELECTOR);
  await editor.click();

  const svgContent = '<svg width="40" height="40" xmlns="http://www.w3.org/2000/svg"><rect width="40" height="40" fill="green"/></svg>';
  await pasteImage(page, svgContent);

  // Poll until ImageComponent has resolved the src to a nim-asset URL and
  // the image has actually loaded (browsers only set naturalWidth > 0 on
  // success, so this catches a 403 from the protocol handler too).
  await expect
    .poll(
      async () =>
        await page.evaluate(() => {
          const editorEl = document.querySelector('.editor [contenteditable="true"]');
          const img = editorEl?.querySelector<HTMLImageElement>('img');
          if (!img) return null;
          return {
            scheme: img.src.split('://')[0],
            loaded: img.naturalWidth > 0,
          };
        }),
      { timeout: 3000 },
    )
    .toEqual({ scheme: 'nim-asset', loaded: true });
});

test('should deduplicate identical pasted images', async () => {
  await openFileFromTree(page, 'test-dup.md');
  await page.waitForTimeout(500);

  const editor = page.locator(ACTIVE_EDITOR_SELECTOR);
  await editor.click();

  const svgContent = '<svg width="50" height="50"><rect width="50" height="50" fill="blue"/></svg>';

  // Paste the same image twice
  for (let i = 0; i < 2; i++) {
    await pasteImage(page, svgContent);
    await page.waitForTimeout(500);
  }

  // Check that only ONE asset file for this SVG was created (deduplication)
  const assetsDir = path.join(workspace, '.nimbalyst', 'assets');
  const files = fs.readdirSync(assetsDir);
  const svgFiles = files.filter(f => f.endsWith('.svg'));

  // The first test created one SVG, this test should add exactly one more (deduplicated)
  // So we expect 2 total SVG files (one from each test, but not 3)
  expect(svgFiles.length).toBe(2);
});
