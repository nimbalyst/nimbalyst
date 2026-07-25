/**
 * Collaborative Tracker Sync E2E Test
 *
 * Tests the real encrypted WebSocket sync path between TWO Electron apps
 * driving the post-rewrite `TrackerSyncEngine` against a real wrangler
 * `TrackerRoom` DO:
 *
 *   App A (upserts item via TrackerSyncManager)
 *     -> TrackerSyncEngine encrypts with AES-256-GCM
 *     -> WebSocket to TrackerRoom Durable Object (wrangler dev --local)
 *     -> broadcast to App B's TrackerSyncEngine
 *     -> decrypt
 *     -> PGLite hydrate via onItemApplied callback
 *     -> document-service:tracker-items-changed IPC
 *     -> TrackerTable reactively renders the new row
 *     -> ALSO: tracker-sync:item-upserted IPC fires for the row (regression
 *        guard on the renderer atom listener path)
 *
 * Both apps use the real TrackerSyncManager code path via a test-only
 * IPC handler (`tracker-sync:connect-test`) that bypasses Stytch /
 * team / key-envelope auth but uses the real `TrackerSyncEngine`,
 * encryption, PGLite hydration, and IPC notification. The handler is
 * registered only when `process.env.PLAYWRIGHT === '1'`, matching the
 * same gate used by `document-sync:open-test` for the sibling spec.
 *
 * Requires: npm run dev (Vite on 5273) + wrangler dev started by this test
 *
 * IMPORTANT: do NOT batch this spec with another in the same
 * `npx playwright test` invocation -- each spec launches its own Electron
 * instance(s) and the resulting PGLite locks fight. Run one spec per
 * command.
 */

import { test, expect } from '@playwright/test';
test.skip(() => !process.env.RUN_COLLAB_TESTS, 'Requires RUN_COLLAB_TESTS=1 and wrangler dev - not for CI');
import type { ElectronApplication, Page } from '@playwright/test';
import { webcrypto } from 'crypto';
import {
  launchElectronApp,
  createTempWorkspace,
} from '../helpers';
import {
  PLAYWRIGHT_TEST_SELECTORS,
  dismissAPIKeyDialog,
  waitForWorkspaceReady,
  openFileFromTree,
} from '../utils/testHelpers';
import {
  startWrangler,
  stopWrangler,
} from '../utils/wranglerHelpers';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

test.describe.configure({ mode: 'serial' });

// Use port 8792 to avoid conflicts with dev (8790) and unit integration tests (8791).
const WRANGLER_PORT = 8792;
const TEST_ORG_ID = 'e2e-test-org';

async function generateAesKey(): Promise<CryptoKey> {
  return webcrypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  ) as Promise<CryptoKey>;
}

async function exportKeyAsJwk(key: CryptoKey): Promise<JsonWebKey> {
  return webcrypto.subtle.exportKey('jwk', key);
}

async function launchIsolatedElectronApp(
  workspace: string,
  instanceName: string,
): Promise<{ app: ElectronApplication; page: Page; dbDir: string }> {
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), `nimbalyst-e2e-${instanceName}-`));
  const cdpPort = instanceName === 'appA' ? '9334' : '9335';
  const app = await launchElectronApp({
    workspace,
    permissionMode: 'allow-all',
    preserveTestDatabase: true,
    env: {
      NIMBALYST_USER_DATA_DIR: dbDir,
      NIMBALYST_USER_DATA_PATH: dbDir,
      NIMBALYST_CDP_PORT: cdpPort,
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await dismissAPIKeyDialog(page);
  await waitForWorkspaceReady(page);
  return { app, page, dbDir };
}

/**
 * Connect an Electron app's TrackerSyncManager to the test wrangler
 * server through the test-only IPC handler. Bypasses Stytch + team +
 * envelope unwrap but exercises the real `TrackerSyncEngine` for
 * encryption, queue lifecycle, and PGLite projection.
 */
async function connectTrackerSync(
  page: Page,
  opts: {
    workspacePath: string;
    serverUrl: string;
    teamProjectId: string;
    orgId: string;
    userId: string;
    encryptionKeyJwk: JsonWebKey;
  },
): Promise<void> {
  const result = await page.evaluate(
    async (payload) => {
      return (window as any).electronAPI.invoke('tracker-sync:connect-test', payload);
    },
    opts,
  );

  if (!result?.success) {
    throw new Error(`tracker-sync:connect-test failed: ${result?.error}`);
  }

  // Wait for the engine to reach 'connected' status. The poll uses the
  // existing `tracker-sync:get-status` channel which the new engine
  // continues to support (per phase 3 ipc preservation).
  await expect(async () => {
    const status = await page.evaluate(async (wp) => {
      const s = await (window as any).electronAPI.invoke('tracker-sync:get-status', { workspacePath: wp });
      return s.status;
    }, opts.workspacePath);
    expect(status).toBe('connected');
  }).toPass({ timeout: 10_000 });
}

/**
 * Upsert a tracker item through the real `tracker-sync:upsert-item` IPC,
 * which routes through `syncTrackerItem -> TrackerSyncEngine.upsertItem`
 * (the production path the host adapter takes).
 */
async function upsertTrackerItem(
  page: Page,
  item: {
    id: string;
    type: string;
    title: string;
    description: string;
    status: string;
    priority: string;
    workspace: string;
  },
): Promise<void> {
  const result = await page.evaluate(async (itemData) => {
    return (window as any).electronAPI.invoke('tracker-sync:upsert-item', { item: itemData });
  }, item);
  if (!result?.success) {
    throw new Error(`tracker-sync:upsert-item failed: ${result?.error}`);
  }
}

test.describe('Collaborative Tracker Sync', () => {
  // Wrangler startup + two Electron launches + WebSocket connections need time.
  test.setTimeout(120_000);

  let appA: ElectronApplication;
  let pageA: Page;
  let dbDirA: string;
  let appB: ElectronApplication;
  let pageB: Page;
  let dbDirB: string;
  let workspaceDirA: string;
  let workspaceDirB: string;
  let sharedKeyJwk: JsonWebKey;

  test.beforeAll(async ({}, testInfo) => {
    testInfo.setTimeout(120_000);

    await startWrangler(WRANGLER_PORT);

    const sharedKey = await generateAesKey();
    sharedKeyJwk = await exportKeyAsJwk(sharedKey);

    workspaceDirA = await createTempWorkspace();
    workspaceDirB = await createTempWorkspace();
    await fs.writeFile(path.join(workspaceDirA, 'README.md'), '# App A\n', 'utf8');
    await fs.writeFile(path.join(workspaceDirB, 'README.md'), '# App B\n', 'utf8');

    const [instanceA, instanceB] = await Promise.all([
      launchIsolatedElectronApp(workspaceDirA, 'appA'),
      launchIsolatedElectronApp(workspaceDirB, 'appB'),
    ]);
    appA = instanceA.app;
    pageA = instanceA.page;
    dbDirA = instanceA.dbDir;
    appB = instanceB.app;
    pageB = instanceB.page;
    dbDirB = instanceB.dbDir;
  });

  test.afterAll(async () => {
    await appA?.close();
    await appB?.close();
    await stopWrangler();
    for (const dir of [workspaceDirA, workspaceDirB, dbDirA, dbDirB]) {
      if (dir) {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }
  });

  test('App A creates a tracker item that appears in App B via encrypted WebSocket sync', async () => {
    const teamProjectId = `e2e-collab-${Date.now()}`;
    const testItemId = `sync-e2e-${Date.now()}`;
    const testTitle = 'Bug from another device';

    const connectOpts = {
      serverUrl: `http://localhost:${WRANGLER_PORT}`,
      teamProjectId,
      orgId: TEST_ORG_ID,
      encryptionKeyJwk: sharedKeyJwk,
    };

    // Subscribe to `tracker-sync:item-upserted` on B BEFORE the connect
    // races so we don't miss the IPC payload assertion. The handler
    // tracks the most-recent payload in a window-side global the test
    // reads after sync converges.
    await pageB.evaluate(() => {
      (window as any).__lastTrackerSyncUpserted = null;
      (window as any).electronAPI.trackerSync?.onItemUpserted?.((data: any) => {
        (window as any).__lastTrackerSyncUpserted = data;
      });
    });

    await Promise.all([
      connectTrackerSync(pageA, { ...connectOpts, workspacePath: workspaceDirA, userId: 'e2e-user-a' }),
      connectTrackerSync(pageB, { ...connectOpts, workspacePath: workspaceDirB, userId: 'e2e-user-b' }),
    ]);

    // Navigate App B to tracker mode -> Bugs.
    await openFileFromTree(pageB, 'README.md');
    await pageB.keyboard.press('Meta+t');

    const trackerSidebar = pageB.locator(PLAYWRIGHT_TEST_SELECTORS.trackerSidebar);
    await expect(trackerSidebar).toBeVisible({ timeout: 10_000 });
    const bugsButton = trackerSidebar.locator(
      `${PLAYWRIGHT_TEST_SELECTORS.trackerTypeButton}[data-tracker-type="bug"]`,
    );
    await bugsButton.click();
    const trackerTable = pageB.locator(PLAYWRIGHT_TEST_SELECTORS.trackerTable);
    await expect(trackerTable).toBeVisible({ timeout: 5000 });

    const targetRow = pageB.locator(
      `${PLAYWRIGHT_TEST_SELECTORS.trackerTableRow}[data-item-title="${testTitle}"]`,
    );
    await expect(targetRow).not.toBeVisible();

    await upsertTrackerItem(pageA, {
      id: testItemId,
      type: 'bug',
      title: testTitle,
      description: 'Synced from App A to App B via encrypted WebSocket',
      status: 'open',
      priority: 'high',
      workspace: workspaceDirA,
    });

    // Renderer atom + table render.
    await expect(targetRow).toBeVisible({ timeout: 15_000 });

    // IPC-layer regression guard: the renderer-side
    // `tracker-sync:item-upserted` event fires for the new row. The new
    // engine routes upserts through the existing channel; capturing it
    // here surfaces breakage at the host adapter <-> renderer seam.
    await expect(async () => {
      const last = await pageB.evaluate(() => (window as any).__lastTrackerSyncUpserted);
      expect(last?.itemId).toBe(testItemId);
      expect(last?.title).toBe(testTitle);
    }).toPass({ timeout: 10_000 });
  });

  test('comments and activity survive the shared sync round trip', async () => {
    const teamProjectId = `e2e-comments-${Date.now()}`;
    const testItemId = `sync-comments-${Date.now()}`;
    const connectOpts = {
      serverUrl: `http://localhost:${WRANGLER_PORT}`,
      teamProjectId,
      orgId: TEST_ORG_ID,
      encryptionKeyJwk: sharedKeyJwk,
    };

    await Promise.all([
      connectTrackerSync(pageA, { ...connectOpts, workspacePath: workspaceDirA, userId: 'e2e-user-a' }),
      connectTrackerSync(pageB, { ...connectOpts, workspacePath: workspaceDirB, userId: 'e2e-user-b' }),
    ]);

    await upsertTrackerItem(pageA, {
      id: testItemId,
      type: 'bug',
      title: 'Shared comment persistence',
      description: 'Comments and activity must survive projection writes',
      status: 'to-do',
      priority: 'high',
      workspace: workspaceDirA,
    });

    await expect(async () => {
      const item = await pageB.evaluate(async (id) => {
        const items = await (window as any).electronAPI.invoke('document-service:tracker-items-list');
        return items.find((candidate: any) => candidate.id === id);
      }, testItemId);
      expect(item?.title).toBe('Shared comment persistence');
    }).toPass({ timeout: 15_000 });

    const commentResult = await pageA.evaluate(async ({ itemId, body }) => {
      return (window as any).electronAPI.invoke('document-service:tracker-item-add-comment', { itemId, body });
    }, { itemId: testItemId, body: '**Persistent** shared comment' });
    expect(commentResult?.success).toBe(true);

    const updateResult = await pageA.evaluate(async (itemId) => {
      return (window as any).electronAPI.invoke('document-service:update-tracker-item', {
        itemId,
        updates: { status: 'in-progress' },
      });
    }, testItemId);
    expect(updateResult?.success).toBe(true);

    await expect(async () => {
      const item = await pageB.evaluate(async (id) => {
        const items = await (window as any).electronAPI.invoke('document-service:tracker-items-list');
        return items.find((candidate: any) => candidate.id === id);
      }, testItemId);
      expect(item?.customFields?.comments).toEqual(expect.arrayContaining([
        expect.objectContaining({ body: '**Persistent** shared comment' }),
      ]));
      expect(item?.customFields?.activity).toEqual(expect.arrayContaining([
        expect.objectContaining({ action: 'commented' }),
        expect.objectContaining({ action: 'status_changed', oldValue: 'to-do', newValue: 'in-progress' }),
      ]));
    }).toPass({ timeout: 15_000 });
  });
});
