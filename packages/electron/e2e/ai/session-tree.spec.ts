import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createTempWorkspace, launchElectronApp, waitForAppReady } from '../helpers';
import { switchToAgentMode } from '../utils/testHelpers';

let app: ElectronApplication;
let page: Page;
let workspace: string;

test.setTimeout(60_000);

async function invoke(channel: string, ...args: unknown[]): Promise<any> {
  return page.evaluate(({ channel, args }) => (window as any).electronAPI.invoke(channel, ...args), { channel, args });
}

test.beforeAll(async () => {
  workspace = await createTempWorkspace();
  await fs.writeFile(path.join(workspace, 'tree.md'), '# Session tree integration\n');
  app = await launchElectronApp({
    workspace,
    permissionMode: 'allow-all',
    // Test this worktree's built renderer instead of another checkout's dev server.
    env: { ELECTRON_RENDERER_URL: pathToFileURL(path.resolve(__dirname, '../../out/renderer/index.html')).href },
  });
  page = await app.firstWindow();
  await waitForAppReady(page);
});

test.afterAll(async () => {
  await app?.close();
  if (workspace) await fs.rm(workspace, { recursive: true, force: true });
});

test('nested sessions move, undo, archive, and lift through production IPC', async () => {
  const root = randomUUID();
  expect(await invoke('sessions:create', {
    session: { id: root, title: 'Tree integration root', provider: 'claude-code' }, workspaceId: workspace,
  })).toMatchObject({ success: true });
  const child = await invoke('sessions:create-child', { parentSessionId: root, workspacePath: workspace });
  expect(child).toMatchObject({ success: true });
  const leaf = await invoke('sessions:create-child', { parentSessionId: child.sessionId, workspacePath: workspace });
  expect(leaf).toMatchObject({ success: true });
  const subtree = await invoke('sessions:list-children', root, workspace);
  expect(subtree.success).toBe(true);
  expect(subtree.children).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: child.sessionId, parentSessionId: root, depth: 1 }),
    expect.objectContaining({ id: leaf.sessionId, parentSessionId: child.sessionId, depth: 2 }),
  ]));
  await invoke('sessions:update-title', child.sessionId, 'Tree integration child');
  await invoke('sessions:update-title', leaf.sessionId, 'Tree integration leaf');
  await page.reload();
  await waitForAppReady(page);
  await switchToAgentMode(page);
  const tree = page.getByRole('tree', { name: 'Session tree' }).filter({ hasText: 'Tree integration root' });
  await expect(tree).toBeVisible();
  const expandRoot = tree.getByRole('button', { name: 'Expand Tree integration root', exact: true });
  if (await expandRoot.isVisible()) await expandRoot.click();
  await expect(tree.getByText('Tree integration child', { exact: true })).toBeVisible();
  const expandChild = tree.getByRole('button', { name: 'Expand Tree integration child', exact: true });
  if (await expandChild.isVisible()) await expandChild.click();
  await expect(tree.getByRole('treeitem').filter({ hasText: 'Tree integration leaf' }))
    .toHaveAttribute('aria-level', '3');

  expect(await invoke('sessions:set-parent', { sessionId: root, newParentId: leaf.sessionId, workspacePath: workspace })).toMatchObject({ success: false });
  const detached = await invoke('sessions:set-parent', { sessionId: leaf.sessionId, newParentId: null, workspacePath: workspace });
  expect(detached).toMatchObject({ success: true, previousParentId: child.sessionId, previousManagerId: child.sessionId });
  expect((await invoke('sessions:get', leaf.sessionId)).session).toMatchObject({ parentSessionId: null, createdBySessionId: null });
  expect(await invoke('sessions:set-parent', {
    sessionId: leaf.sessionId, newParentId: detached.previousParentId,
    restoreManagerId: detached.previousManagerId, workspacePath: workspace,
  })).toMatchObject({ success: true });

  expect(await invoke('sessions:update-metadata', root, { isArchived: true })).toMatchObject({ success: true });
  expect((await invoke('sessions:list-children', root, workspace)).children).toHaveLength(0);
  expect((await invoke('sessions:list-children', root, workspace, { includeArchived: true })).children).toHaveLength(2);
  expect(await invoke('sessions:update-metadata', root, { isArchived: false })).toMatchObject({ success: true });
  expect((await invoke('sessions:list-children', root, workspace)).children).toHaveLength(2);

  expect(await invoke('sessions:delete', child.sessionId)).toMatchObject({ success: true });
  expect((await invoke('sessions:get', leaf.sessionId)).session.parentSessionId).toBe(root);
  expect((await invoke('sessions:list-children', root, workspace)).children).toEqual([
    expect.objectContaining({ id: leaf.sessionId, parentSessionId: root, depth: 1 }),
  ]);
});
