/**
 * Selective per-plan sharing gate — Collaborative E2E (NIM-876)
 *
 * Proves the HYBRID + per-item share gate end-to-end across two real Electron
 * apps + a real wrangler `TrackerRoom`:
 *
 *   - A `plan` (hybrid type) created via the REAL decision path
 *     (`document-service:create-tracker-item`) WITHOUT a share flag must NOT
 *     reach App B (no leak).
 *   - The same path WITH `share.status: 'team'` MUST reach App B.
 *
 * Unlike `tracker-sync-collab.spec.ts` (which drives `tracker-sync:upsert-item`
 * directly and so bypasses the policy gate), this spec drives the create IPC
 * that runs `shouldSyncTrackerItem(policy, item)` — the actual gate. The flagged
 * plan arriving on B is the positive signal that the sync pipe is live; once it
 * has arrived, the unflagged plan still being absent proves the gate held.
 *
 * Requires: Vite on 5273 + wrangler dev (started by this test).
 * Run ONE spec per command (see the sibling spec's note on PGLite locks).
 *
 * IMPORTANT: no OTHER Nimbalyst Electron instance may be running. A running
 * `npm run dev` (or `dev:user2`) holds the Electron remote-debugging port 9222
 * and the fixed internal MCP ports (3456-3559); the test app then fails to
 * launch with `bind() failed: Address already in use` -> `electron.launch`
 * timeout. Quit the dev Electron app(s) first (Vite itself can stay up). This is
 * why the spec is intended for CI / a clean local env.
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

// Distinct port from dev (8790), unit integration (8791) and the sibling
// collab spec (8792) so parallel local runs don't collide.
const WRANGLER_PORT = 8793;
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
  const app = await launchElectronApp({
    workspace,
    permissionMode: 'allow-all',
    preserveTestDatabase: true,
    env: { NIMBALYST_USER_DATA_PATH: dbDir },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await dismissAPIKeyDialog(page);
  await waitForWorkspaceReady(page);
  return { app, page, dbDir };
}

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
    async (payload) => (window as any).electronAPI.invoke('tracker-sync:connect-test', payload),
    opts,
  );
  if (!result?.success) {
    throw new Error(`tracker-sync:connect-test failed: ${result?.error}`);
  }
  await expect(async () => {
    const status = await page.evaluate(async (wp) => {
      const s = await (window as any).electronAPI.invoke('tracker-sync:get-status', { workspacePath: wp });
      return s.status;
    }, opts.workspacePath);
    expect(status).toBe('connected');
  }).toPass({ timeout: 10_000 });
}

/**
 * Create a `plan` through the REAL gated decision path. Passing
 * `syncMode: 'hybrid'` makes the effective policy hybrid even if the main-process
 * model registry isn't populated, so the per-item share flag is what decides.
 */
async function createPlanViaGate(
  page: Page,
  item: {
    id: string;
    title: string;
    workspace: string;
    shared: boolean;
  },
): Promise<void> {
  const result = await page.evaluate(async (data) => {
    return (window as any).electronAPI.invoke('document-service:create-tracker-item', {
      id: data.id,
      type: 'plan',
      title: data.title,
      status: 'draft',
      priority: 'medium',
      workspace: data.workspace,
      syncMode: 'hybrid',
      customFields: data.shared ? { share: { status: 'team', body: 'team' } } : {},
    });
  }, item);
  if (!result?.success) {
    throw new Error(`create-tracker-item failed: ${result?.error}`);
  }
}

test.describe('Selective per-plan share gate (hybrid)', () => {
  test.setTimeout(180_000);

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
    testInfo.setTimeout(300_000);
    await startWrangler(WRANGLER_PORT);

    const sharedKey = await generateAesKey();
    sharedKeyJwk = await exportKeyAsJwk(sharedKey);

    workspaceDirA = await createTempWorkspace();
    workspaceDirB = await createTempWorkspace();
    await fs.writeFile(path.join(workspaceDirA, 'README.md'), '# App A\n', 'utf8');
    await fs.writeFile(path.join(workspaceDirB, 'README.md'), '# App B\n', 'utf8');

    // Launch sequentially (not Promise.all): under load two simultaneous
    // Electron boots starve each other and blow the hook timeout.
    const instanceA = await launchIsolatedElectronApp(workspaceDirA, 'appA-gate');
    appA = instanceA.app; pageA = instanceA.page; dbDirA = instanceA.dbDir;
    const instanceB = await launchIsolatedElectronApp(workspaceDirB, 'appB-gate');
    appB = instanceB.app; pageB = instanceB.page; dbDirB = instanceB.dbDir;
  });

  test.afterAll(async () => {
    await appA?.close();
    await appB?.close();
    await stopWrangler();
    for (const dir of [workspaceDirA, workspaceDirB, dbDirA, dbDirB]) {
      if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test('a flagged plan reaches App B; an unflagged plan does not (no leak)', async () => {
    const teamProjectId = `e2e-share-gate-${Date.now()}`;
    const localId = `plan-local-${Date.now()}`;
    const sharedId = `plan-shared-${Date.now()}`;
    const localTitle = 'Local Plan (unflagged)';
    const sharedTitle = 'Shared Plan (flagged)';

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

    // App B -> tracker mode -> Plans.
    await openFileFromTree(pageB, 'README.md');
    await pageB.keyboard.press('Meta+t');
    const trackerSidebar = pageB.locator(PLAYWRIGHT_TEST_SELECTORS.trackerSidebar);
    await expect(trackerSidebar).toBeVisible({ timeout: 10_000 });
    await trackerSidebar
      .locator(`${PLAYWRIGHT_TEST_SELECTORS.trackerTypeButton}[data-tracker-type="plan"]`)
      .click();
    await expect(pageB.locator(PLAYWRIGHT_TEST_SELECTORS.trackerTable)).toBeVisible({ timeout: 5000 });

    const localRow = pageB.locator(
      `${PLAYWRIGHT_TEST_SELECTORS.trackerTableRow}[data-item-title="${localTitle}"]`,
    );
    const sharedRow = pageB.locator(
      `${PLAYWRIGHT_TEST_SELECTORS.trackerTableRow}[data-item-title="${sharedTitle}"]`,
    );
    await expect(localRow).not.toBeVisible();
    await expect(sharedRow).not.toBeVisible();

    // Create the UNFLAGGED plan first, then the FLAGGED one. When the flagged
    // plan arrives on B (sync pipe proven live), the unflagged one still being
    // absent proves the gate held.
    await createPlanViaGate(pageA, { id: localId, title: localTitle, workspace: workspaceDirA, shared: false });
    await createPlanViaGate(pageA, { id: sharedId, title: sharedTitle, workspace: workspaceDirA, shared: true });

    // Positive: flagged plan syncs through.
    await expect(sharedRow).toBeVisible({ timeout: 15_000 });

    // Negative: unflagged plan never leaked. Give it a settle window beyond the
    // time the flagged one already took to arrive.
    await pageB.waitForTimeout(3000);
    await expect(localRow).not.toBeVisible();
  });
});
