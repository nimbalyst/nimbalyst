/**
 * Autosave deleted-file recreate tests.
 *
 * Reproduces a critical data-loss bug: a file the user previously deleted, that
 * an AI session later recreated with new content on disk, is silently
 * overwritten by an autosave from a stale editor buffer.
 *
 * No real AI calls -- the "AI recreation" is simulated with direct fs writes.
 *
 * Per repo testing rules: serial mode, single spec per command, short
 * timeouts where possible. The 12s+ waits are deliberate to step past the
 * autosave cycle (2s timer + 200ms debounce) and the legacy `recentlyDeletedFiles`
 * 10s TTL.
 */

import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import {
  launchElectronApp,
  createTempWorkspace,
  TEST_TIMEOUTS,
  waitForAppReady,
  ACTIVE_FILE_TAB_SELECTOR,
  ACTIVE_EDITOR_SELECTOR,
} from '../helpers';
import { switchToAgentMode, switchToFilesMode, openFileFromTree } from '../utils/testHelpers';
import * as fs from 'fs/promises';
import * as path from 'path';

// Each test sleeps ~13s to step past the 10s recentlyDeletedFiles TTL plus
// several autosave cycles, so the default 15s test budget is too tight.
test.describe.configure({ mode: 'serial', timeout: 25_000 });

let electronApp: ElectronApplication;
let page: Page;
let workspacePath: string;

const ORIGINAL_CONTENT = '# Original\n\nThis is the original content that the user opened.\n';

test.beforeAll(async () => {
  workspacePath = await createTempWorkspace();

  // One file per test, no cross-test bleed
  await fs.writeFile(path.join(workspacePath, 'recreate-target.md'), ORIGINAL_CONTENT, 'utf8');
  await fs.writeFile(path.join(workspacePath, 'recreate-dirty.md'), ORIGINAL_CONTENT, 'utf8');
  await fs.writeFile(path.join(workspacePath, 'recreate-files-mode.md'), ORIGINAL_CONTENT, 'utf8');

  electronApp = await launchElectronApp({
    workspace: workspacePath,
    env: { NODE_ENV: 'test' },
  });

  page = await electronApp.firstWindow();

  page.on('dialog', dialog => dialog.dismiss().catch(() => {}));
  await page.evaluate(() => {
    window.confirm = () => true;
  });

  await waitForAppReady(page);
});

test.afterAll(async () => {
  if (electronApp) {
    await electronApp.close();
  }
  await fs.rm(workspacePath, { recursive: true, force: true }).catch(() => undefined);
});

/**
 * Open a file in a real Agent Mode workstream tab via the test helper exposed
 * on `window.__testHelpers`. Mirrors the production user flow where the file
 * is opened inside an Agent Mode workstream's editor tabs.
 */
async function openFileInAgentWorkstream(
  pg: Page,
  workspace: string,
  filePath: string
): Promise<string> {
  const sessionId = await pg.evaluate(async ({ workspacePath: ws, filePath: fp }) => {
    const helpers = (window as any).__testHelpers;
    if (!helpers?.openFileInAgentMode) {
      throw new Error('openFileInAgentMode test helper not exposed');
    }
    return helpers.openFileInAgentMode(ws, fp);
  }, { workspacePath: workspace, filePath });

  await pg.waitForFunction((fp) => {
    const instances = document.querySelectorAll(`[data-file-path="${fp}"].multi-editor-instance`);
    return instances.length >= 1;
  }, filePath, { timeout: 10000 });

  return sessionId as string;
}

test('autosave must not overwrite AI-recreated content of a previously deleted file (workstream)', async () => {
  const filePath = path.join(workspacePath, 'recreate-target.md');

  await switchToAgentMode(page);
  await openFileInAgentWorkstream(page, workspacePath, filePath);

  const initialInstanceCount = await page.evaluate((fp) => {
    return document.querySelectorAll(`[data-file-path="${fp}"].multi-editor-instance`).length;
  }, filePath);
  expect(initialInstanceCount).toBeGreaterThanOrEqual(1);

  const initialDisk = await fs.readFile(filePath, 'utf8');
  expect(initialDisk).toBe(ORIGINAL_CONTENT);

  // Make the workstream editor dirty BEFORE the delete. This mirrors the
  // real bug: a user has the file open with unsaved edits when the delete
  // happens. Without a dirty editor, notifyFileChanged would propagate
  // recreated content into the buffer (no overwrite path); the bug only
  // manifests when the editor is dirty (DocumentModel.notifyFileChanged
  // skips dirty attachments).
  const agentEditor = page.locator(
    `[data-layout="agent-mode-wrapper"] .multi-editor-instance[data-file-path="${filePath}"] .editor [contenteditable="true"]`
  ).first();
  await agentEditor.waitFor({ state: 'visible', timeout: TEST_TIMEOUTS.EDITOR_LOAD });
  await agentEditor.click();
  await page.keyboard.press('End');
  await page.keyboard.type('S');

  // Brief pause so the dirty edit registers, but well below the 2s autosave
  // timer so we get to the delete before the dirty buffer is autosaved.
  await page.waitForTimeout(300);

  // Simulate user/external delete via direct fs removal. This drives the
  // OptimizedWorkspaceWatcher's file-deleted IPC path. (Direct fs.rm also
  // means `recentlyDeletedFiles` is NEVER populated, since that Set is only
  // populated by the UI delete handler -- so the bug should fire even
  // earlier than the 10s TTL would suggest.)
  await fs.rm(filePath);
  await page.waitForTimeout(800);

  // Simulate "AI session recreates the file on disk with new content"
  const aiContent = '# AI Recreated\n\nThis is the AI-written content that must NOT be lost.\n';
  await fs.writeFile(filePath, aiContent, 'utf8');

  // Wait past:
  //  - the legacy `recentlyDeletedFiles` 10s TTL, AND
  //  - several autosave cycles (2s timer + 200ms debounce).
  await page.waitForTimeout(13_000);

  // The file on disk MUST still contain the AI content. The dirty editor
  // buffer must NEVER have overwritten it.
  const onDisk = await fs.readFile(filePath, 'utf8');
  expect(onDisk).toBe(aiContent);
});

test('autosave with a heavily DIRTY editor buffer must not overwrite AI-recreated content (workstream)', async () => {
  const filePath = path.join(workspacePath, 'recreate-dirty.md');

  await switchToAgentMode(page);
  await openFileInAgentWorkstream(page, workspacePath, filePath);

  const agentEditor = page.locator(
    `[data-layout="agent-mode-wrapper"] .multi-editor-instance[data-file-path="${filePath}"] .editor [contenteditable="true"]`
  ).first();
  await agentEditor.waitFor({ state: 'visible', timeout: TEST_TIMEOUTS.EDITOR_LOAD });
  await agentEditor.click();
  await page.keyboard.press('End');

  // Type a substantial amount that's clearly NOT the original content. The
  // worst case is a buffer the user expects to keep -- this proves that even
  // a meaningful dirty buffer must not silently overwrite the recreated
  // file. The buffer is preserved (in memory) but disk wins.
  const dirtyMarker = ' DIRTY_BUFFER_MARKER_LINE';
  await page.keyboard.type(dirtyMarker);

  // Brief pause so the dirty edit registers, but well below the 2s autosave
  // timer so we get to the delete before the dirty buffer is autosaved.
  await page.waitForTimeout(300);

  // External delete (mimics user deleting via terminal or file tree)
  await fs.rm(filePath);
  await page.waitForTimeout(800);

  // AI recreates the file
  const aiContent = '# AI Recreated\n\nDirty-buffer test: AI content that must survive autosave.\n';
  await fs.writeFile(filePath, aiContent, 'utf8');

  // Wait past the legacy TTL and several autosave cycles.
  await page.waitForTimeout(13_000);

  // The file on disk must still contain the AI content.
  const onDisk = await fs.readFile(filePath, 'utf8');
  expect(onDisk).toBe(aiContent);
  // And specifically must not contain the dirty marker.
  expect(onDisk).not.toContain('DIRTY_BUFFER_MARKER_LINE');
});

test('EditorMode tab: external delete then recreate must not be overwritten by autosave', async () => {
  const filePath = path.join(workspacePath, 'recreate-files-mode.md');

  // Switch to Files Mode (EditorMode) and open the file there
  await switchToFilesMode(page);
  await openFileFromTree(page, 'recreate-files-mode.md');
  await expect(page.locator(ACTIVE_FILE_TAB_SELECTOR)).toContainText(
    'recreate-files-mode.md',
    { timeout: TEST_TIMEOUTS.TAB_SWITCH }
  );

  const editor = page.locator(ACTIVE_EDITOR_SELECTOR);
  await expect(editor).toContainText('Original');

  // Type to dirty the buffer (same reasoning as test 1: autosave only fires on dirty)
  await editor.click();
  await page.keyboard.press('End');
  await page.keyboard.type('X');
  await page.waitForTimeout(300);

  // External delete via fs.rm (drives the watcher path; bypasses delete-file IPC)
  await fs.rm(filePath);
  await page.waitForTimeout(800);

  // External recreation with new content (mimics an AI tool writing the file)
  const aiContent = '# Files Mode Recreated\n\nExternal recreation must be preserved.\n';
  await fs.writeFile(filePath, aiContent, 'utf8');

  // Wait well past the legacy 10s TTL plus an autosave cycle
  await page.waitForTimeout(13_000);

  const onDisk = await fs.readFile(filePath, 'utf8');
  expect(onDisk).toBe(aiContent);
});
