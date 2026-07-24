/**
 * Phase 2 (Issue #146): verifies that the `nim-asset://` custom protocol
 * loads workspace images correctly with `webSecurity: true`. Also verifies
 * the path-traversal defense.
 */
import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { execSync } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  createTempWorkspace,
  launchElectronApp,
  waitForAppReady,
} from '../helpers';
import { dismissAPIKeyDialog, openFileFromTree } from '../utils/testHelpers';

test.describe.configure({ mode: 'serial' });

let electronApp: ElectronApplication;
let page: Page;
let workspacePath: string;

// Smallest valid PNG (1x1, transparent). Bytes are: PNG signature + IHDR + IDAT + IEND.
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=';

function nimAssetUrlForPath(absolutePath: string): string {
  const encoded = Buffer.from(absolutePath, 'utf8').toString('base64url');
  return `nim-asset://local/${encoded}`;
}

test.beforeAll(async () => {
  workspacePath = await createTempWorkspace();
  await fs.writeFile(path.join(workspacePath, 'README.md'), '# Asset Protocol Test\n', 'utf8');
  await fs.writeFile(
    path.join(workspacePath, 'tiny.png'),
    Buffer.from(TINY_PNG_BASE64, 'base64'),
  );
  execSync('git init', { cwd: workspacePath, stdio: 'pipe' });
  execSync('git config user.email "test@example.com"', { cwd: workspacePath, stdio: 'pipe' });
  execSync('git config user.name "Test User"', { cwd: workspacePath, stdio: 'pipe' });
  execSync('git add .', { cwd: workspacePath, stdio: 'pipe' });
  execSync('git commit -m "initial"', { cwd: workspacePath, stdio: 'pipe' });

  electronApp = await launchElectronApp({
    workspace: workspacePath,
    permissionMode: 'allow-all',
  });
  page = await electronApp.firstWindow();
  await waitForAppReady(page);
  await dismissAPIKeyDialog(page);
});

test.afterAll(async () => {
  await electronApp?.close();
  await fs.rm(workspacePath, { recursive: true, force: true }).catch(() => undefined);
});

test('opens a PNG via nim-asset:// and the image renders with naturalWidth > 0', async () => {
  await openFileFromTree(page, 'tiny.png');

  // ImageViewer renders <img> with the nim-asset URL. Wait until the image
  // loads (browsers set naturalWidth > 0 only after a successful load).
  await expect
    .poll(
      async () =>
        await page.evaluate(() => {
          const img = document.querySelector<HTMLImageElement>(
            'img[src^="nim-asset://"]',
          );
          if (!img) return null;
          return { src: img.src, naturalWidth: img.naturalWidth };
        }),
      { timeout: 5000 },
    )
    .toMatchObject({ naturalWidth: 1 });
});

test('rejects a request for a file outside the workspace allowlist (403)', async () => {
  // Try to fetch a file that is not in the allowlisted roots from the
  // renderer context. The custom protocol handler should return 403.
  const result = await page.evaluate(async (assetUrl) => {
    const response = await fetch(assetUrl);
    return { status: response.status };
  }, nimAssetUrlForPath('/etc/passwd.png'));

  expect(result.status).toBe(403);
});

test('rejects a path-traversal attempt (403)', async () => {
  // The validator rejects paths whose normalized form differs from the
  // input -- so `/${workspacePath}/../etc/passwd.png` is rejected.
  const traversal = `${workspacePath}/../etc/passwd.png`;
  const result = await page.evaluate(async (assetUrl) => {
    const response = await fetch(assetUrl);
    return { status: response.status };
  }, nimAssetUrlForPath(traversal));

  expect(result.status).toBe(403);
});

test('rejects a non-image extension inside an allowlisted root (403)', async () => {
  const readme = path.join(workspacePath, 'README.md');
  const result = await page.evaluate(async (assetUrl) => {
    const response = await fetch(assetUrl);
    return { status: response.status };
  }, nimAssetUrlForPath(readme));

  expect(result.status).toBe(403);
});
