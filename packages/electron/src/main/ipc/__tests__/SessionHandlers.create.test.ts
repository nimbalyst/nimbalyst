// @vitest-environment node
import { beforeAll, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ handlers: new Map<string, Function>(), create: vi.fn(), get: vi.fn(), updateMetadata: vi.fn() }));
vi.mock('electron', () => ({ app: { getPath: () => '/tmp', on: vi.fn(), getName: () => 'x', getVersion: () => '1' }, ipcMain: { handle: vi.fn(), on: vi.fn() }, BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../../utils/ipcRegistry', () => ({ safeHandle: (k: string, f: Function) => h.handlers.set(k, f), safeOn: vi.fn(), removeHandler: vi.fn() }));
vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({ AISessionsRepository: { create: h.create, get: h.get, updateMetadata: h.updateMetadata } }));

// SessionHandlers pulls in most of main; import and register once for the file.
beforeAll(async () => {
  const { registerSessionHandlers } = await import('../SessionHandlers');
  await registerSessionHandlers();
}, 60_000);

it('creates a workstream container row and never lets the renderer type any other session', async () => {
  const create = (session: Record<string, unknown>) =>
    h.handlers.get('sessions:create')!({}, { session: { provider: 'claude-code', ...session }, workspaceId: '/p' });
  await create({ id: 'ws', sessionType: 'workstream', metadata: { userWorkstream: true } });
  await create({ id: 'other', sessionType: 'blitz' });
  expect(h.create.mock.calls[0][0]).toMatchObject({ id: 'ws', sessionType: 'workstream', metadata: { userWorkstream: true } });
  expect(h.create.mock.calls[1][0].sessionType).toBeUndefined();
});

it('moves a session without naming its new parent as manager; only an undo restores a manager', async () => {
  const rows: Record<string, any> = {
    s: { id: 's', workspacePath: '/p', parentSessionId: null, createdBySessionId: 'spawner' },
    ws: { id: 'ws', workspacePath: '/p', sessionType: 'workstream' },
    spawner: { id: 'spawner', workspacePath: '/p' },
  };
  h.get.mockImplementation(async (id: string) => rows[id] ?? null);
  const setParent = h.handlers.get('sessions:set-parent')!;
  expect(await setParent({}, { sessionId: 's', newParentId: 'ws', workspacePath: '/p' })).toMatchObject({ success: true });
  // Absent, so the store keeps or drops the existing manager by the move rule.
  expect(h.updateMetadata.mock.calls[0][1]).not.toHaveProperty('createdBySessionId');
  expect(h.updateMetadata.mock.calls[0][1]).toMatchObject({ parentSessionId: 'ws' });
  await setParent({}, { sessionId: 's', newParentId: null, workspacePath: '/p', restoreManagerId: 'spawner' });
  expect(h.updateMetadata.mock.calls[1][1]).toMatchObject({ parentSessionId: null, createdBySessionId: 'spawner' });
});
