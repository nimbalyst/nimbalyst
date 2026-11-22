// @vitest-environment node
import { expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ authenticated: false, authorize: vi.fn(), handlers: new Map<string, Function>(), authListeners: [] as Array<(state: { isAuthenticated: boolean }) => void>, created: [] as string[], phase: null as string | null }));
vi.mock('electron', () => ({ net: { fetch: vi.fn() }, dialog: {} }));
vi.mock('../StytchAuthService', () => ({ isAuthenticated: () => mocks.authenticated, getAccounts: () => [],
  onAuthStateChange: (listener: (state: { isAuthenticated: boolean }) => void) => { mocks.authListeners.push(listener); return () => {}; } }));
// Counts constructions so a test can observe when decrypted recovery state was dropped.
vi.mock('../TeamRecoveryClient', async importOriginal => ({ ...(await importOriginal<typeof import('../TeamRecoveryClient')>()),
  TeamRecoveryClient: class {
    constructor(readonly orgId: string) { mocks.created.push(orgId); }
    overview() { return { orgId: this.orgId, counts: { projects: 0, items: 0, documents: 0, attachments: 0 }, blockers: [], notices: [], operation: mocks.phase ? { operationId: 'op', phase: mocks.phase, rooms: [] } : null }; }
    async status() { return this.overview(); }
  } }));
vi.mock('../TeamService', () => ({ getOrgScopedIdentity: mocks.authorize, resolveTeamForWorkspace: vi.fn() }));
vi.mock('../../utils/ipcRegistry', () => ({ safeHandle: (name: string, fn: Function) => mocks.handlers.set(name, fn) }));
vi.mock('../../utils/privateSettingsStore', () => ({ default: class {} }));
vi.mock('../../database/initialize', () => ({ getDatabase: vi.fn() }));
vi.mock('../CollabDocumentReplicaStore', () => ({ getCollabDocumentReplicaStore: vi.fn() }));
vi.mock('../CollabAssetStore', () => ({ getCollabAssetStore: vi.fn() }));
vi.mock('../LegacyRecoveryKeyFiles', () => ({ withLegacyRecoveryKeys: vi.fn() }));
vi.mock('../TrackerSyncManager', () => ({ trackerItemToPayload: vi.fn() }));
vi.mock('../../mcp/tools/trackerToolHandlers', () => ({ rowToTrackerItem: vi.fn() }));
vi.mock('../TeamCustodyService', () => ({ invalidateTeamKeyStatusCache: vi.fn() }));
vi.mock('../../utils/collabSyncUrl', () => ({ getCollabSyncHttpUrl: () => 'https://sync.test' }));
import { registerTeamRecoveryHandlers } from '../TeamRecoveryService';

it('requires authentication and an explicit organization before recovery IPC can access sources', async () => {
  registerTeamRecoveryHandlers();
  const handler = mocks.handlers.get('team:recovery')!;
  expect(await handler({}, 'org', 'inspect', {})).toMatchObject({ success: false });
  expect(mocks.authorize).not.toHaveBeenCalled();
  mocks.authenticated = true;
  expect(await handler({}, '', 'inspect', {})).toMatchObject({ success: false });
  expect(mocks.authorize).not.toHaveBeenCalled();
});

it('exports content-free diagnostics through the authenticated native save path', async () => {
  const { net, dialog } = await import('electron');
  const { readFile, mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'recovery-report-'));
  const filePath = join(directory, 'diagnostics.json');
  Object.assign(dialog, { showSaveDialog: vi.fn(async () => ({ filePath })) });
  mocks.authenticated = true;
  mocks.authorize.mockResolvedValue({ teamMemberId: 'admin', jwt: 'secret-token' });
  vi.mocked(net.fetch).mockResolvedValue({ ok: true, json: async () => ({ version: 1, orgId: 'org', status: 'legacy', rawCustodyMode: null, keyPresent: false, keyProbe: 'absent', projects: [], secretKey: 'do-not-export' }) } as Response);
  registerTeamRecoveryHandlers();
  try {
    expect(await mocks.handlers.get('team:recovery')!({}, 'org', 'export-diagnostics', {})).toMatchObject({ success: true });
    const report = await readFile(filePath, 'utf8');
    expect(JSON.parse(report)).toMatchObject({ orgId: 'org', diagnostics: { status: 'legacy', keyProbe: 'absent' } });
    expect(report).not.toMatch(/secret-token|do-not-export|secretKey/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

const diagnostics = (orgId: string, extra: Record<string, unknown> = {}) => ({ ok: true, json: async () => ({ version: 1, orgId, status: 'legacy', rawCustodyMode: null, keyPresent: false, keyProbe: 'absent', projects: [], ...extra }) } as Response);

it('refuses a malformed diagnostics response before writing a support report', async () => {
  const { net, dialog } = await import('electron');
  const showSaveDialog = vi.fn();
  Object.assign(dialog, { showSaveDialog });
  mocks.authenticated = true;
  mocks.authorize.mockResolvedValue({ teamMemberId: 'admin', jwt: 'jwt' });
  vi.mocked(net.fetch).mockResolvedValue(diagnostics('org-m', { projects: [{ projectId: 7 }] }));
  registerTeamRecoveryHandlers();
  expect(await mocks.handlers.get('team:recovery')!({}, 'org-m', 'export-diagnostics', {})).toMatchObject({ success: false, error: expect.stringContaining('Invalid recovery diagnostics') });
  expect(showSaveDialog).not.toHaveBeenCalled();
});

it('explains a diagnostics name collision rather than surfacing a raw EEXIST', async () => {
  const { net, dialog } = await import('electron');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'recovery-report-'));
  Object.assign(dialog, { showSaveDialog: vi.fn(async () => ({ filePath: join(directory, 'diagnostics.json') })) });
  mocks.authenticated = true;
  mocks.authorize.mockResolvedValue({ teamMemberId: 'admin', jwt: 'jwt' });
  vi.mocked(net.fetch).mockResolvedValue(diagnostics('org-e'));
  registerTeamRecoveryHandlers();
  const handler = mocks.handlers.get('team:recovery')!;
  try {
    expect(await handler({}, 'org-e', 'export-diagnostics', {})).toMatchObject({ success: true });
    expect(await handler({}, 'org-e', 'export-diagnostics', {})).toMatchObject({ success: false, error: 'A file with that name already exists. Recovery never overwrites an existing file; choose a new name.' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('drops decrypted recovery state on release, sign-out, and completion', async () => {
  const { net } = await import('electron');
  mocks.authenticated = true;
  mocks.authorize.mockReset().mockResolvedValue({ teamMemberId: 'admin', jwt: 'jwt' });
  vi.mocked(net.fetch).mockResolvedValue(diagnostics('org-r'));
  registerTeamRecoveryHandlers();
  const handler = mocks.handlers.get('team:recovery')!;
  const created = () => mocks.created.filter(orgId => orgId === 'org-r').length;
  await handler({}, 'org-r', 'status');
  await handler({}, 'org-r', 'status');
  expect(created()).toBe(1);

  // Release works signed out and without touching the organization's credentials.
  mocks.authenticated = false;
  const authorizations = mocks.authorize.mock.calls.length;
  expect(await handler({}, 'org-r', 'release')).toEqual({ success: true });
  expect(mocks.authorize.mock.calls.length).toBe(authorizations);
  mocks.authenticated = true;
  await handler({}, 'org-r', 'status');
  expect(created()).toBe(2);

  mocks.authListeners.forEach(listener => listener({ isAuthenticated: false }));
  await handler({}, 'org-r', 'status');
  expect(created()).toBe(3);

  mocks.phase = 'completed';
  expect(await handler({}, 'org-r', 'status')).toMatchObject({ success: true, overview: { operation: { phase: 'completed' } } });
  mocks.phase = null;
  await handler({}, 'org-r', 'status');
  expect(created()).toBe(4);
});
