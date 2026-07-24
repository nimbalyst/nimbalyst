/**
 * NIM-1487: clicking a workspace-relative link in a markdown doc must open
 * the target file in a tab of the same window — historically it spawned a
 * default (blank white) Electron child window via unhandled window.open.
 *
 * Covers both node shapes:
 * - a markdown-imported link, which becomes a DocumentReferenceNode chip
 * - a pasted HTML anchor, which becomes a regular LinkNode — the shape that
 *   used to escape to window.open (LinkNodes with file hrefs also arrive via
 *   AI edit streaming and collab sync)
 */

import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import {
  launchElectronApp,
  createTempWorkspace,
  TEST_TIMEOUTS,
  waitForAppReady,
  ACTIVE_EDITOR_SELECTOR,
  ACTIVE_FILE_TAB_SELECTOR,
} from '../helpers';
import { openFileFromTree } from '../utils/testHelpers';
import * as fs from 'fs/promises';
import * as path from 'path';

test.describe.configure({ mode: 'serial' });

let electronApp: ElectronApplication;
let page: Page;
let workspacePath: string;

test.beforeAll(async () => {
  workspacePath = await createTempWorkspace();

  const samplesDir = path.join(workspacePath, 'samples');
  await fs.mkdir(samplesDir, { recursive: true });
  await fs.writeFile(
    path.join(samplesDir, 'link-target.md'),
    '# Link Target\n\nOpened via a pasted LinkNode.\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(samplesDir, 'other-target.md'),
    '# Other Target\n\nOpened via a markdown-imported link.\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(samplesDir, 'tooltip-target.md'),
    '# Tooltip Target\n\nOpened via the floating link editor tooltip.\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(workspacePath, 'notes.md'),
    [
      '# Notes',
      '',
      'Check [the other target](./samples/other-target.md) for details.',
      '',
    ].join('\n'),
    'utf8',
  );

  electronApp = await launchElectronApp({
    workspace: workspacePath,
    env: { NODE_ENV: 'test' },
  });
  page = await electronApp.firstWindow();
  await waitForAppReady(page);
});

test.afterAll(async () => {
  if (electronApp) {
    await electronApp.close();
  }
  await fs.rm(workspacePath, { recursive: true, force: true }).catch(() => undefined);
});

test('relative-link LinkNode (pasted anchor) opens the file in a tab, not a new window', async () => {
  await openFileFromTree(page, 'notes.md');
  await expect(page.locator(ACTIVE_FILE_TAB_SELECTOR)).toContainText('notes.md', {
    timeout: TEST_TIMEOUTS.TAB_SWITCH,
  });

  const editor = page.locator(ACTIVE_EDITOR_SELECTOR);
  await editor.click();
  await page.keyboard.press('End');

  // Paste an HTML anchor so the editor holds a genuine LinkNode with a raw
  // relative href — markdown import would turn the same link into a
  // DocumentReferenceNode chip, which is covered by the other test.
  await editor.evaluate((el) => {
    const dt = new DataTransfer();
    dt.setData('text/html', '<a href="./samples/link-target.md">pasted link</a>');
    el.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
    );
  });

  const anchor = editor.locator('a[href="./samples/link-target.md"]');
  await expect(anchor).toBeVisible({ timeout: TEST_TIMEOUTS.EDITOR_LOAD });

  const windowCountBefore = electronApp.windows().length;
  await anchor.click();

  await expect(page.locator(ACTIVE_FILE_TAB_SELECTOR)).toContainText('link-target.md', {
    timeout: TEST_TIMEOUTS.TAB_SWITCH,
  });
  expect(electronApp.windows().length).toBe(windowCountBefore);
});

test('clicking the URL in the floating link tooltip opens the file in a tab, not a new window', async () => {
  await openFileFromTree(page, 'notes.md');
  await expect(page.locator(ACTIVE_FILE_TAB_SELECTOR)).toContainText('notes.md', {
    timeout: TEST_TIMEOUTS.TAB_SWITCH,
  });

  const editor = page.locator(ACTIVE_EDITOR_SELECTOR);
  await editor.click();
  await page.keyboard.press('End');
  await editor.evaluate((el) => {
    const dt = new DataTransfer();
    dt.setData('text/html', '<a href="./samples/tooltip-target.md">tooltip link</a>');
    el.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
    );
  });
  await expect(editor.locator('a[href="./samples/tooltip-target.md"]')).toBeVisible({
    timeout: TEST_TIMEOUTS.EDITOR_LOAD,
  });

  // Move the caret into the link text with the keyboard — that raises the
  // floating link editor. Clicking the URL inside it was the original
  // white-window repro (an <a target="_blank"> with a relative href).
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');

  const tooltipLink = page.locator('.link-editor .link-view a');
  await expect(tooltipLink).toBeVisible({ timeout: TEST_TIMEOUTS.EDITOR_LOAD });

  const windowCountBefore = electronApp.windows().length;
  await tooltipLink.click();

  await expect(page.locator(ACTIVE_FILE_TAB_SELECTOR)).toContainText('tooltip-target.md', {
    timeout: TEST_TIMEOUTS.TAB_SWITCH,
  });
  expect(electronApp.windows().length).toBe(windowCountBefore);
});

test('markdown-imported relative link opens the file in a tab, not a new window', async () => {
  await openFileFromTree(page, 'notes.md');
  await expect(page.locator(ACTIVE_FILE_TAB_SELECTOR)).toContainText('notes.md', {
    timeout: TEST_TIMEOUTS.TAB_SWITCH,
  });

  const windowCountBefore = electronApp.windows().length;

  const editor = page.locator(ACTIVE_EDITOR_SELECTOR);
  await editor.getByText('the other target').first().click();

  await expect(page.locator(ACTIVE_FILE_TAB_SELECTOR)).toContainText('other-target.md', {
    timeout: TEST_TIMEOUTS.TAB_SWITCH,
  });
  expect(electronApp.windows().length).toBe(windowCountBefore);
});
