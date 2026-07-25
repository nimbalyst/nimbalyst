/**
 * Wrangler-backed collaborative embed acceptance test.
 *
 * User A seeds a mockup room and a markdown room containing the canonical
 * collaborative embed link. User B then opens the markdown room from a fresh
 * app/workspace and must render the mockup inline from its own room.
 *
 * Requires: RUN_COLLAB_TESTS=1 and the nimbalyst-collab sibling repo.
 * Run with:
 *   RUN_COLLAB_TESTS=1 npx playwright test e2e/sync/collaborative-embed.spec.ts --max-failures=1
 */

import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { webcrypto } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  createTempWorkspace,
  launchElectronApp,
  waitForAppReady,
} from '../helpers';
import { startWrangler, stopWrangler } from '../utils/wranglerHelpers';

test.skip(() => !process.env.RUN_COLLAB_TESTS, 'Requires RUN_COLLAB_TESTS=1 and wrangler dev');
test.describe.configure({ mode: 'serial' });

const WRANGLER_PORT = 8794;
const RUN_ID = `${process.pid}-${Date.now()}`;
const TEST_ORG_ID = `e2e-collaborative-embed-org-${RUN_ID}`;
const AUTHOR_USER_ID = 'e2e-collaborative-embed-author';
const RECIPIENT_USER_ID = 'e2e-collaborative-embed-recipient';
const HOST_DOCUMENT_ID = `embedded-host-${RUN_ID}`;
const CHILD_DOCUMENT_ID = `team-demo-mockup-${RUN_ID}`;
const URL_EXTRA_QUERY = `test_user_id=${encodeURIComponent(RECIPIENT_USER_ID)}&test_org_id=${encodeURIComponent(TEST_ORG_ID)}`;
const CHILD_CONTENT = `<!doctype html>
<html>
  <body>
    <main id="team-embed-marker">Mockup loaded from the shared child room</main>
  </body>
</html>`;
const HOST_CONTENT = `# Shared design

[Team mockup](nimbalyst://doc/${encodeURIComponent(CHILD_DOCUMENT_ID)}?orgId=${encodeURIComponent(TEST_ORG_ID)} "height=300 embedType=.mockup.html")
`;

let authorApp: ElectronApplication | null = null;
let recipientApp: ElectronApplication | null = null;
let authorWorkspace = '';
let recipientWorkspace = '';
let encryptionKeyBase64 = '';

async function generateKeyBase64(): Promise<string> {
  const key = await webcrypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
  const raw = await webcrypto.subtle.exportKey('raw', key);
  return Buffer.from(raw).toString('base64');
}

async function waitForTestHelpers(page: Page): Promise<void> {
  await page.waitForFunction(() =>
    typeof (window as any).__registerCollabConfigTest === 'function'
    && typeof (window as any).__writeCollabDocTest === 'function'
    && typeof (window as any).__exportCollabDocTest === 'function'
    && typeof (window as any).__openCollabDocTest === 'function',
  );
}

async function registerTestConfig(
  page: Page,
  params: {
    documentId: string;
    title: string;
    documentType: string;
    userId: string;
  },
): Promise<void> {
  await page.evaluate(async ({ input, serverUrl, orgId, keyBase64 }) => {
    await (window as any).__registerCollabConfigTest({
      ...input,
      serverUrl,
      orgId,
      encryptionKeyBase64: keyBase64,
      urlExtraQuery: `test_user_id=${encodeURIComponent(input.userId)}&test_org_id=${encodeURIComponent(orgId)}`,
    });
  }, {
    input: params,
    serverUrl: `ws://localhost:${WRANGLER_PORT}`,
    orgId: TEST_ORG_ID,
    keyBase64: encryptionKeyBase64,
  });
}

async function writeRoom(
  page: Page,
  documentId: string,
  documentType: string,
  content: string,
): Promise<void> {
  const result = await page.evaluate(
    async input => (window as any).__writeCollabDocTest(input),
    { documentId, documentType, content },
  );
  expect(result?.status ?? result?.success).not.toBe(false);
}

async function exportRoom(
  page: Page,
  documentId: string,
  documentType: string,
): Promise<string> {
  const result = await page.evaluate(
    async input => (window as any).__exportCollabDocTest(input),
    { documentId, documentType },
  );
  if (typeof result === 'string') return result;
  if (typeof result?.content === 'string') return result.content;
  if (typeof result?.bytes === 'string') return result.bytes;
  throw new Error(`Unexpected export result: ${JSON.stringify(result)}`);
}

async function openHostAsRecipient(page: Page): Promise<void> {
  await page.evaluate(async ({ documentId, serverUrl, orgId, userId, keyBase64 }) => {
    await (window as any).__openCollabDocTest({
      documentId,
      title: 'Shared design',
      documentType: 'markdown',
      serverUrl,
      orgId,
      userId,
      encryptionKeyBase64: keyBase64,
      urlExtraQuery: `test_user_id=${encodeURIComponent(userId)}&test_org_id=${encodeURIComponent(orgId)}`,
    });
  }, {
    documentId: HOST_DOCUMENT_ID,
    serverUrl: `ws://localhost:${WRANGLER_PORT}`,
    orgId: TEST_ORG_ID,
    userId: RECIPIENT_USER_ID,
    keyBase64: encryptionKeyBase64,
  });
}

async function installRecipientConfigHandlers(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }, config) => {
    ipcMain.removeHandler('document-sync:open');
    ipcMain.handle('document-sync:open', async (_event, payload: {
      documentId: string;
      title?: string;
      documentType?: string;
    }) => ({
      success: true,
      config: {
        orgId: config.orgId,
        documentId: payload.documentId,
        title: payload.title ?? payload.documentId,
        documentType: payload.documentType,
        keyCustody: 'legacy-e2e',
        orgKeyBase64: config.keyBase64,
        serverUrl: config.serverUrl,
        urlExtraQuery: config.urlExtraQuery,
        accountId: config.userId,
        userId: config.userId,
        userName: 'Embed Recipient',
        userEmail: 'embed-recipient@example.test',
      },
    }));

    ipcMain.removeHandler('document-sync:get-jwt');
    ipcMain.handle('document-sync:get-jwt', async () => ({
      success: true,
      jwt: 'e2e-test-jwt',
    }));
  }, {
    orgId: TEST_ORG_ID,
    userId: RECIPIENT_USER_ID,
    keyBase64: encryptionKeyBase64,
    serverUrl: `ws://localhost:${WRANGLER_PORT}`,
    urlExtraQuery: URL_EXTRA_QUERY,
  });
}

test.beforeAll(async ({}, testInfo) => {
  testInfo.setTimeout(120_000);
  authorWorkspace = await createTempWorkspace();
  recipientWorkspace = await createTempWorkspace();
  encryptionKeyBase64 = await generateKeyBase64();
  await fs.writeFile(path.join(authorWorkspace, 'README.md'), '# Author workspace\n', 'utf8');
  await fs.writeFile(path.join(recipientWorkspace, 'README.md'), '# Recipient workspace\n', 'utf8');
  await startWrangler(WRANGLER_PORT);
});

test.afterAll(async () => {
  await authorApp?.close().catch(() => undefined);
  await recipientApp?.close().catch(() => undefined);
  await stopWrangler();
  await fs.rm(authorWorkspace, { recursive: true, force: true }).catch(() => undefined);
  await fs.rm(recipientWorkspace, { recursive: true, force: true }).catch(() => undefined);
});

test('recipient renders a canonical collaborative mockup embed from its child room', async () => {
  test.setTimeout(120_000);

  authorApp = await launchElectronApp({
    workspace: authorWorkspace,
    permissionMode: 'allow-all',
    env: { NIMBALYST_RELEASE_CHANNEL: 'alpha' },
  });
  const authorPage = await authorApp.firstWindow();
  await waitForAppReady(authorPage);
  await waitForTestHelpers(authorPage);

  await registerTestConfig(authorPage, {
    documentId: CHILD_DOCUMENT_ID,
    title: 'Team mockup',
    documentType: 'mockup.html',
    userId: AUTHOR_USER_ID,
  });
  await writeRoom(authorPage, CHILD_DOCUMENT_ID, 'mockup.html', CHILD_CONTENT);
  await registerTestConfig(authorPage, {
    documentId: HOST_DOCUMENT_ID,
    title: 'Shared design',
    documentType: 'markdown',
    userId: AUTHOR_USER_ID,
  });
  await writeRoom(authorPage, HOST_DOCUMENT_ID, 'markdown', HOST_CONTENT);

  expect(await exportRoom(authorPage, HOST_DOCUMENT_ID, 'markdown')).toContain(
    `nimbalyst://doc/${CHILD_DOCUMENT_ID}?orgId=${TEST_ORG_ID}`,
  );
  expect(await exportRoom(authorPage, CHILD_DOCUMENT_ID, 'mockup.html')).toContain(
    'Mockup loaded from the shared child room',
  );

  await authorApp.close();
  authorApp = null;

  recipientApp = await launchElectronApp({
    workspace: recipientWorkspace,
    permissionMode: 'allow-all',
    env: { NIMBALYST_RELEASE_CHANNEL: 'alpha' },
  });
  await installRecipientConfigHandlers(recipientApp);
  const recipientPage = await recipientApp.firstWindow();
  await waitForAppReady(recipientPage);
  await waitForTestHelpers(recipientPage);
  await registerTestConfig(recipientPage, {
    documentId: CHILD_DOCUMENT_ID,
    title: 'Team mockup',
    documentType: 'mockup.html',
    userId: RECIPIENT_USER_ID,
  });
  await openHostAsRecipient(recipientPage);

  const embed = recipientPage.locator(
    '[data-testid="embed-frame"][data-embed-collaborative="true"]',
  );
  await expect(embed).toBeVisible({ timeout: 20_000 });
  await expect(recipientPage.locator('[data-testid="collaborative-embed-unresolved"]')).toHaveCount(0);
  await expect(recipientPage.locator('[data-testid="collaborative-embed-error"]')).toHaveCount(0);

  const mockupFrame = embed.frameLocator('iframe[title^="Mockup:"]');
  await expect(mockupFrame.locator('#team-embed-marker')).toHaveText(
    'Mockup loaded from the shared child room',
    { timeout: 20_000 },
  );

  await expect.poll(async () => recipientPage.evaluate(
    async ({ workspacePath, accountId, orgId, documentIds }) => {
      const rows = await Promise.all(documentIds.map(documentId =>
        window.electronAPI.documentSync.replicaLoad(workspacePath, {
          accountId,
          orgId,
          documentId,
        }),
      ));
      return rows.map(row => ({
        persisted: Boolean(row && ((row.snapshot?.byteLength ?? 0) > 0 || row.updates.length > 0)),
        completeness: row?.completeness ?? null,
      }));
    },
    {
      workspacePath: recipientWorkspace,
      accountId: RECIPIENT_USER_ID,
      orgId: TEST_ORG_ID,
      documentIds: [HOST_DOCUMENT_ID, CHILD_DOCUMENT_ID],
    },
  ), { timeout: 20_000 }).toEqual([
    { persisted: true, completeness: 'complete' },
    { persisted: true, completeness: 'complete' },
  ]);
});
