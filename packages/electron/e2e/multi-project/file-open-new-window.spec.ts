import { test, expect, type ElectronApplication } from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createTempWorkspace, launchElectronApp, ACTIVE_EDITOR_SELECTOR, ACTIVE_FILE_TAB_SELECTOR } from '../helpers';
import { PLAYWRIGHT_TEST_SELECTORS as selectors } from '../utils/testHelpers';

let app: ElectronApplication | undefined;
let root: string;

test.afterEach(async () => {
  await app?.close();
  if (root) await fs.rm(root, { recursive: true, force: true });
});

test('OS file opens wait for a new project editor and survive saved-tab restoration', async () => {
  test.setTimeout(60_000);
  root = await createTempWorkspace();
  const sourceProject = path.join(root, 'Source');
  const targetProject = path.join(root, 'Target');
  await fs.mkdir(sourceProject);
  await fs.mkdir(targetProject);
  await fs.writeFile(path.join(sourceProject, 'README.md'), '# Source\n');
  for (const name of ['saved', 'first', 'second']) {
    await fs.writeFile(path.join(targetProject, `${name}.md`), `# ${name} file content\n`);
  }

  const electronRoot = path.resolve(__dirname, '../..');
  const mainPath = process.env.NIMBALYST_E2E_MAIN_PATH ?? path.join(electronRoot, 'out/main/index.js');
  const launcher = path.join(root, 'launch.cjs');
  // Gate the actual renderer's initial-state response, not a substitute editor.
  // This forces the OS events to precede workspace/editor readiness on every run.
  await fs.writeFile(launcher, `
    const { app, ipcMain } = require('electron');
    app.setPath('userData', ${JSON.stringify(path.join(root, 'profile'))});
    app.setPath('appData', ${JSON.stringify(root)});
    app.setAppPath(${JSON.stringify(electronRoot)});
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    global.__fileOpenRelease = release;
    global.__fileOpenBlocked = false;
    const handle = ipcMain.handle.bind(ipcMain);
    ipcMain.handle = (channel, listener) => handle(channel, async (event, ...args) => {
      const result = await listener(event, ...args);
      if (channel === 'get-initial-state' && result?.workspacePath === ${JSON.stringify(targetProject)}) {
        global.__fileOpenBlocked = true;
        await gate;
      }
      return result;
    });
    require(${JSON.stringify(mainPath)});
  `);
  app = await launchElectronApp({ workspace: sourceProject, mainPath: launcher,
    env: { NIMBALYST_USER_DATA_DIR: path.join(root, 'profile') } });
  const source = await app.firstWindow();
  await source.locator(selectors.windowTopBar).waitFor();
  await source.evaluate(async targetProject => {
    await window.electronAPI.invoke('app:set-multi-project-mode', false);
    await window.electronAPI.invoke('app-settings:set', 'recent.workspaces', [
      { path: targetProject, name: 'Target', timestamp: Date.now() },
    ]);
    await window.electronAPI.invoke('workspace:update-state', targetProject, {
      tabs: { tabs: [{ id: 'saved-tab', filePath: `${targetProject}/saved.md`, fileName: 'saved.md', isPinned: false, isDirty: false }], activeTabId: 'saved-tab', tabOrder: ['saved-tab'] },
    });
  }, targetProject);

  const newWindow = app.waitForEvent('window');
  await app.evaluate(({ app }, filePath) => app.emit('open-file', { preventDefault() {} } as any, filePath), path.join(targetProject, 'first.md'));
  const target = await newWindow;
  await expect.poll(() => app!.evaluate(() => (globalThis as any).__fileOpenBlocked)).toBe(true);
  // An existing but still loading window must queue the next request as well.
  await app.evaluate(({ app }, filePath) => app.emit('open-file', { preventDefault() {} } as any, filePath), path.join(targetProject, 'second.md'));
  await expect(target.locator('.file-tabs-container .tab')).toHaveCount(0);
  await app.evaluate(() => (globalThis as any).__fileOpenRelease());

  for (const name of ['saved.md', 'first.md', 'second.md']) {
    await expect(target.locator('.file-tabs-container .tab-title', { hasText: name })).toHaveCount(1);
  }
  await expect(target.locator(ACTIVE_FILE_TAB_SELECTOR)).toHaveText('second.md');
  await expect(target.locator(ACTIVE_EDITOR_SELECTOR)).toContainText('second file content');
  await expect.poll(() => target.evaluate((workspacePath) => window.electronAPI.invoke('file:pending-opens', workspacePath), targetProject)).toEqual([]);
  await expect(source.locator('.file-tabs-container .tab-title', { hasText: 'first.md' })).toHaveCount(0);

  // Preserve #1787: reopening a closed last-opened file creates its tab again.
  await target.locator('.file-tabs-container .tab.active .tab-close-button').click();
  await app.evaluate(({ app }, filePath) => app.emit('open-file', { preventDefault() {} } as any, filePath), path.join(targetProject, 'second.md'));
  await expect(target.locator(ACTIVE_FILE_TAB_SELECTOR)).toHaveText('second.md');
  await expect(target.locator(ACTIVE_EDITOR_SELECTOR)).toContainText('second file content');
});
