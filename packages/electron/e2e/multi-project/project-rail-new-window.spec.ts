import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createTempWorkspace, launchElectronApp } from '../helpers';
import { PLAYWRIGHT_TEST_SELECTORS as selectors } from '../utils/testHelpers';

let app: ElectronApplication | undefined;
let root: string;

test.afterEach(async () => {
  await app?.close();
  if (root) await fs.rm(root, { recursive: true, force: true });
});

test('opens a rail project in its own window and preserves each window through reload and close', async () => {
  test.setTimeout(60_000);
  root = await createTempWorkspace();
  const projectA = path.join(root, 'ProjectA');
  const projectB = path.join(root, 'ProjectB');
  for (const directory of [projectA, projectB]) {
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, 'README.md'), `# ${path.basename(directory)}\n`);
  }

  // Isolate settings before main's module initializers run, as well as the DB.
  const electronRoot = path.resolve(__dirname, '../..');
  const mainPath = process.env.NIMBALYST_E2E_MAIN_PATH ?? path.join(electronRoot, 'out/main/index.js');
  const launcher = path.join(root, 'launch.cjs');
  await fs.writeFile(launcher, `
    const { app } = require('electron');
    app.setPath('userData', ${JSON.stringify(path.join(root, 'profile'))});
    app.setPath('appData', ${JSON.stringify(root)});
    app.setAppPath(${JSON.stringify(electronRoot)});
    require(${JSON.stringify(mainPath)});
  `);
  app = await launchElectronApp({ workspace: projectA, mainPath: launcher,
    env: { NIMBALYST_USER_DATA_DIR: path.join(root, 'profile') } });
  const source = await app.firstWindow();
  await source.locator(selectors.windowTopBar).waitFor();
  await source.evaluate(async ({ projectA, projectB }) => {
    await window.electronAPI.invoke('app:set-multi-project-mode', true);
    await window.electronAPI.invoke('app:set-restore-previous-projects', true);
    await window.electronAPI.invoke('app-settings:set', 'recent.workspaces', [
      { path: projectB, name: 'ProjectB', timestamp: Date.now() },
      { path: projectA, name: 'ProjectA', timestamp: Date.now() },
    ]);
  }, { projectA, projectB });
  await source.reload();
  await source.getByRole('button', { name: 'Add project to rail', exact: true }).click();
  await source.getByRole('button', { name: new RegExp(`^ProjectB`) }).click();
  await source.getByRole('button', { name: 'Switch to project ProjectA', exact: true }).click();

  const expectActiveProject = async (page: Page, name: string, workspacePath: string) => {
    await expect(page.getByRole('button', { name: `Switch to project ${name}`, exact: true })).toHaveAttribute('aria-current', 'true');
    await expect.poll(() => page.evaluate(() => window.electronAPI.getInitialState())).toMatchObject({ activeWorkspacePath: workspacePath });
  };
  await expectActiveProject(source, 'ProjectA', projectA);
  await source.getByRole('button', { name: 'Switch to project ProjectB', exact: true }).click({ button: 'right' });
  const opened = app.waitForEvent('window');
  await source.getByRole('button', { name: 'Open in new window', exact: true }).click();
  const second = await opened;
  await expectActiveProject(second, 'ProjectB', projectB);
  await expect(second.locator(selectors.projectRailItem)).toHaveCount(1);
  await expectActiveProject(source, 'ProjectA', projectA);
  await expect.poll(() => source.evaluate(() => window.electronAPI.invoke('workspace-manager:get-open-workspaces'))).toEqual([projectA, projectB]);

  // Both windows keep their own rail, despite the shared saved rail setting.
  await source.reload();
  await expect(source.locator(selectors.projectRailItem)).toHaveCount(2);
  await expectActiveProject(source, 'ProjectA', projectA);
  await second.reload();
  await expect(second.locator(selectors.projectRailItem)).toHaveCount(1);
  await expectActiveProject(second, 'ProjectB', projectB);

  const closed = second.waitForEvent('close');
  await (await app.browserWindow(second)).evaluate(window => window.close());
  await closed;
  await source.getByRole('button', { name: 'Switch to project ProjectB', exact: true }).click();
  await expectActiveProject(source, 'ProjectB', projectB);
  await expect(source.locator(selectors.windowTopBarWorkspaceName)).toHaveText('ProjectB');
});
