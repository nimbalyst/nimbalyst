import { test, expect, type ElectronApplication } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { launchElectronApp, createTempWorkspace, waitForAppReady, dismissProjectTrustToast } from '../helpers';
import { openFileFromTree, PLAYWRIGHT_TEST_SELECTORS as S } from '../utils/testHelpers';

const original = 'Name,Value\nApple,1\nBanana,2\n';
const modified = 'Name,Value\nApple,9\n';

for (const resolution of ['keep-with-snapshot-failure', 'revert-with-snapshot-failure', 'session-keep-all'] as const) {
  test(`CSV review exits after ${resolution}`, async () => {
    const workspace = await createTempWorkspace();
    const filePath = path.join(workspace, 'review.csv');
    let app: ElectronApplication | undefined;
    try {
      await fs.writeFile(filePath, original);
      app = await launchElectronApp({ workspace, env: { NIMBALYST_RELEASE_CHANNEL: 'alpha' } });
      const page = await app.firstWindow();
      await page.waitForLoadState('domcontentloaded');
      await waitForAppReady(page);
      await dismissProjectTrustToast(page);
      await openFileFromTree(page, 'review.csv');
      const grid = page.locator(S.spreadsheetGrid).filter({ visible: true });
      await expect(grid).toBeVisible();
      await page.evaluate(async ({ workspace, filePath, original }) => {
        await window.electronAPI.history.createTag(workspace, filePath, 'csv-keep-tag', original, 'csv-keep-session', 'csv-keep-tool');
      }, { workspace, filePath, original });
      await fs.writeFile(filePath, modified);
      const header = page.locator('.unified-diff-header');
      await expect(header).toBeVisible();
      await expect.poll(() => grid.evaluate((el: any) => el.readonly)).toBe(true);

      if (resolution !== 'session-keep-all') {
        // Only the disposable test app is affected. The resolution's file write
        // and tag update remain real; the later optional history snapshot fails.
        await app.evaluate(({ ipcMain }) => {
          ipcMain.removeHandler('history:create-snapshot');
          ipcMain.handle('history:create-snapshot', () => { throw new Error('Injected snapshot failure'); });
        });
        await header.getByTestId(resolution === 'revert-with-snapshot-failure' ? 'diff-revert-all' : 'diff-keep-all').click();
      } else {
        await page.evaluate(async (workspace) => {
          await window.electronAPI.history.clearPendingForSession(workspace, 'csv-keep-session');
        }, workspace);
      }
      await expect.poll(async () => page.evaluate(async (filePath) => {
        const tags = await window.electronAPI.invoke('history:get-all-tags', filePath);
        return tags.filter((tag: any) => tag.status === 'pending-review').length;
      }, filePath)).toBe(0);
      await expect(header).toHaveCount(0);
      await expect.poll(() => grid.evaluate((el: any) => el.readonly)).toBe(false);
      await expect.poll(() => grid.evaluate(async (el: any) => {
        const rows = [...await el.getSource('rowPinStart'), ...await el.getSource('rgRow')];
        return rows.filter((row: any) => row.A || row.B).map((row: any) => [String(row.A), String(row.B)]);
      })).toEqual(resolution === 'revert-with-snapshot-failure' ? [['Name', 'Value'], ['Apple', '1'], ['Banana', '2']] : [['Name', 'Value'], ['Apple', '9']]);
      expect(await fs.readFile(filePath, 'utf8')).toBe(resolution === 'revert-with-snapshot-failure' ? original : modified);
    } finally {
      await app?.close();
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
}
