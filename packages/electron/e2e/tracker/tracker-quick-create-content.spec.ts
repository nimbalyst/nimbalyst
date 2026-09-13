import { test, expect } from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { launchElectronApp, waitForAppReady } from '../helpers';
import {
  PLAYWRIGHT_TEST_SELECTORS as selectors,
  dismissAPIKeyDialog,
  waitForWorkspaceReady,
} from '../utils/testHelpers';

test('quick creation reopens with its text and locally staged screenshot', async ({}, testInfo) => {
  testInfo.setTimeout(90_000);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracker-create-e2e-'));
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, 'README.md'), '# Test workspace\n');
  let app: Awaited<ReturnType<typeof launchElectronApp>> | undefined;
  try {
    app = await launchElectronApp({
      mainPath: process.env.NIMBALYST_E2E_MAIN_PATH,
      workspace,
      preserveTestDatabase: true,
      recordVideo: { dir: path.join(testInfo.outputDir, 'video') },
      env: {
        NIMBALYST_USER_DATA_PATH: path.join(root, 'database'),
        NIMBALYST_USER_DATA_DIR: path.join(root, 'user-data'),
        NIMBALYST_CDP_PORT: '0',
      },
    });
    const page = await app.firstWindow();
    await waitForAppReady(page);
    await dismissAPIKeyDialog(page);
    await waitForWorkspaceReady(page);
    await page.keyboard.press('ControlOrMeta+Shift+I');
    const search = page.locator(selectors.trackerQuickCreateTypeSearch);
    await expect(search).toBeVisible();
    await search.fill('task');
    await search.press('Enter');
    const title = page.locator(selectors.trackerQuickCreateTitle);
    await title.fill('Creation content round trip');
    const body = page
      .locator(selectors.trackerQuickCreateContent)
      .locator(selectors.contentEditable);
    await body.fill('First paragraph Ω');
    await body.press('Enter');
    await body.press('Enter');
    await body.pressSequentially('Second paragraph');
    await page.locator(selectors.trackerQuickCreateImageInput).setInputFiles({
      name: 'screen.png',
      mimeType: 'image/png',
      buffer: await page
        .locator(selectors.trackerQuickCreateContent)
        .screenshot(),
    });
    const popupImage = page
      .locator(selectors.trackerQuickCreateContent)
      .getByRole('img', { name: 'screen.png', exact: true });
    await expect(popupImage).toBeVisible();
    await title.press('ControlOrMeta+Enter');
    await expect(title).not.toBeVisible();
    const detail = page.locator(selectors.trackerDetailContentEditor);
    await expect(detail).toContainText('First paragraph Ω');
    await expect(detail).toContainText('Second paragraph');
    const image = detail.getByRole('img', { name: 'screen.png', exact: true });
    await expect(image).toBeVisible();
    await expect
      .poll(() =>
        image.evaluate(
          (node: HTMLImageElement) => node.complete && node.naturalWidth > 0,
        ),
      )
      .toBe(true);
    await page.getByTitle('Close (Esc)', { exact: true }).click();
    await page
      .locator(selectors.trackerTableRow)
      .filter({ hasText: 'Creation content round trip' })
      .getByText('Creation content round trip', { exact: true })
      .click();
    await expect(detail).toContainText('First paragraph Ω');
    await expect(image).toBeVisible();
    await expect
      .poll(() =>
        image.evaluate(
          (node: HTMLImageElement) => node.complete && node.naturalWidth > 0,
        ),
      )
      .toBe(true);
    await page.screenshot({
      path: path.join(testInfo.outputDir, 'created-item.png'),
    });
  } finally {
    await app?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
