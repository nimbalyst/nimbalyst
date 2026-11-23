/**
 * A user opens the hook editor from Settings, adds a hook with the palette,
 * and saves. The file gains the hook and keeps every other setting.
 */

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { createTempWorkspace, launchElectronApp, waitForAppReady } from '../helpers';

test.describe.configure({ mode: 'serial' });

let electronApp: ElectronApplication;
let page: Page;
let workspaceDir: string;
let configDir: string;

test.beforeAll(async () => {
  workspaceDir = await createTempWorkspace();
  // The app reads Claude settings from this empty folder, so the run never touches the real ~/.claude.
  configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hook-editor-config-'));
  await fs.mkdir(path.join(workspaceDir, '.claude'), { recursive: true });
  await fs.writeFile(
    path.join(workspaceDir, '.claude', 'settings.local.json'),
    JSON.stringify({ model: 'opus', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo first' }] }] } }, null, 2),
  );
  electronApp = await launchElectronApp({ workspace: workspaceDir, env: { CLAUDE_CONFIG_DIR: configDir } });
  page = await electronApp.firstWindow();
  await waitForAppReady(page);
});

test.afterAll(async () => {
  try {
    await electronApp?.close();
  } finally {
    if (workspaceDir) await fs.rm(workspaceDir, { recursive: true, force: true });
    if (configDir) await fs.rm(configDir, { recursive: true, force: true });
  }
});

test('adds a hook from the palette and saves only the hooks', async () => {
  await page.evaluate(() => (window as any).__testHelpers.openSettings('project-claude-hooks', 'project'));
  await page.getByTestId('hooks-edit-localSettings-PreToolUse/0/0').click();

  // Escape with the popover open closes only the popover. The editor stays open.
  await page.getByTestId('hook-do-input').click();
  await page.getByTestId('hook-do-option-runCommand').click();
  await page.getByTestId('hook-do-add').click();
  await expect(page.getByTestId('hook-ask-command')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('hook-ask-command')).toHaveCount(0);
  await expect(page.getByTestId('hook-editor')).toBeVisible();

  // Dragging a "When" chip onto the hooks starts a hook on that event. The test file has no Stop hook yet.
  await page.getByTestId('hook-when-input').click();
  await page.getByTestId('hook-when-option-Stop').click();
  const chip = page.getByTestId('hook-when-chip');
  const dropArea = page.getByTestId('hook-canvas-when-drop');
  const chipBox = (await chip.boundingBox())!;
  const dropBox = (await dropArea.boundingBox())!;
  await page.mouse.move(chipBox.x + chipBox.width / 2, chipBox.y + chipBox.height / 2);
  await page.mouse.down();
  // The drag starts only after a few pixels of real movement, so the pointer moves in steps.
  await page.mouse.move(dropBox.x + dropBox.width / 2, dropBox.y + dropBox.height / 2, { steps: 10 });
  await page.mouse.up();
  await expect(page.getByTestId('hook-event-Stop')).toBeVisible();
  // One drop is one change.
  await expect(page.getByTestId('hook-unsaved-count')).toHaveText('1 change not saved');
  // dnd-kit blocks every click for 50 ms after a drop, so a click on Undo here can be lost. The shortcut is not blocked.
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.getByTestId('hook-event-Stop')).toHaveCount(0);
  // The undo leaves the selection on the removed Stop hook, so pick the Bash group again for the next block.
  await page.getByTestId('hook-group-PreToolUse/0').click();

  await page.getByTestId('hook-do-input').click();
  await page.getByTestId('hook-do-option-runCommand').click();
  await page.getByTestId('hook-do-add').click();
  await page.getByTestId('hook-ask-command').fill('echo hello');
  await page.getByTestId('hook-ask-add').click();
  await expect(page.getByTestId('hook-json-text')).toContainText('echo hello');

  await page.getByTestId('hook-review').click();
  await page.getByTestId('hook-save').click();
  await expect(page.getByTestId('hook-unsaved-count')).toHaveCount(0);

  const saved = JSON.parse(await fs.readFile(path.join(workspaceDir, '.claude', 'settings.local.json'), 'utf8'));
  expect(saved.model).toBe('opus');
  expect(saved.hooks.PreToolUse[0].matcher).toBe('Bash');
  expect(saved.hooks.PreToolUse[0].hooks.map((hook: { command: string }) => hook.command)).toEqual(['echo first', 'echo hello']);
});
