import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  appendLocalUpdateMock,
  browserWindowsMock,
  clearCollabAssetSenderMock,
  drainCoordinatorMock,
  estimateLocalAppendBytesMock,
  fetchAndUnwrapOrgKeyMock,
  fetchTeamKeyStatusMock,
  findTeamForWorkspaceMock,
  getArchivedOrgKeysMock,
  getLastKnownTeamKeyStatusMock,
  getOrgKeyMock,
  handlers,
  listPendingOutboxesMock,
  prepareForAppendMock,
  registerCollabAssetDocumentMock,
  safeHandleMock,
} = vi.hoisted(() => {
  const handlers = new Map<string, (...args: any[]) => any>();
  return {
    appendLocalUpdateMock: vi.fn(),
    browserWindowsMock: vi.fn(),
    clearCollabAssetSenderMock: vi.fn(),
    getLastKnownTeamKeyStatusMock: vi.fn(),
    drainCoordinatorMock: {
      clearSender: vi.fn(),
      getAttachedSenderIds: vi.fn(),
      isProviderAttached: vi.fn(),
    },
    estimateLocalAppendBytesMock: vi.fn(),
    fetchAndUnwrapOrgKeyMock: vi.fn(),
    fetchTeamKeyStatusMock: vi.fn(),
    findTeamForWorkspaceMock: vi.fn(),
    getArchivedOrgKeysMock: vi.fn(),
    getOrgKeyMock: vi.fn(),
    handlers,
    listPendingOutboxesMock: vi.fn(),
    prepareForAppendMock: vi.fn(),
    registerCollabAssetDocumentMock: vi.fn(),
    safeHandleMock: vi.fn((channel: string, handler: (...args: any[]) => any) => {
      handlers.set(channel, handler);
    }),
  };
});

vi.mock('electron', () => ({
  BrowserWindow: class {
    static getAllWindows() {
      return browserWindowsMock();
    }
  },
  dialog: {},
  net: { fetch: vi.fn() },
}));

vi.mock('../../utils/ipcRegistry', () => ({ safeHandle: safeHandleMock }));

vi.mock('../../utils/logger', () => ({
  logger: { main: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));

vi.mock('../../utils/collabSyncUrl', () => ({
  getCollabSyncWsUrl: () => 'wss://sync.test',
  getCollabSyncHttpUrl: () => 'https://sync.test',
}));

vi.mock('../../services/StytchAuthService', () => ({
  isAuthenticated: vi.fn(() => true),
  getStytchUserId: vi.fn(() => 'user-1'),
  getUserEmail: vi.fn(() => 'user@test.com'),
  getAuthState: vi.fn(() => ({ user: { name: { first_name: 'Test', last_name: 'User' } } })),
  getPersonalOrgId: vi.fn(() => 'personal-1'),
  getPersonalUserId: vi.fn(() => 'account-a'),
  getPersonalSessionJwt: vi.fn(() => 'personal-jwt'),
  refreshPersonalSession: vi.fn(async () => false),
}));

vi.mock('../../services/TeamService', () => ({
  findTeamForWorkspace: findTeamForWorkspaceMock,
  getOrgScopedJwt: vi.fn(async () => 'org-jwt'),
}));

vi.mock('../../services/jwtOrg', () => ({
  getOrgIdFromJwt: vi.fn(),
  getJwtExp: vi.fn(() => Date.now() + 60_000),
}));

vi.mock('../../services/OrgKeyService', () => ({
  getOrgKey: getOrgKeyMock,
  getOrgKeyFingerprint: vi.fn(() => null),
  getOrCreateIdentityKeyPair: vi.fn(async () => undefined),
  uploadIdentityKeyToOrg: vi.fn(async () => undefined),
  fetchAndUnwrapOrgKey: fetchAndUnwrapOrgKeyMock,
  clearOrgKey: vi.fn(),
  fetchTeamKeyStatus: fetchTeamKeyStatusMock,
  getLastKnownTeamKeyStatus: getLastKnownTeamKeyStatusMock,
  getArchivedOrgKeys: getArchivedOrgKeysMock,
}));

vi.mock('../../utils/store', () => ({
  getWorkspaceState: vi.fn(() => ({})),
  updateWorkspaceState: vi.fn(),
}));

vi.mock('../../services/SyncManager', () => ({}));
vi.mock('../collabDocumentTypeResolver', () => ({
  resolveCollabDocumentType: vi.fn(() => 'markdown'),
}));
vi.mock('../../services/DocSyncService', () => ({}));
vi.mock('../../protocols/collabAssetProtocol', () => ({
  registerCollabAssetDocument: registerCollabAssetDocumentMock,
  unregisterCollabAssetDocument: vi.fn(),
  isCollabAssetDocumentRegisteredForSender: vi.fn(() => true),
  clearCollabAssetSender: clearCollabAssetSenderMock,
}));
vi.mock('../../services/CollabAssetUploader', () => ({}));
vi.mock('../../services/markdownAssetScanner', () => ({}));
vi.mock('../../services/CollabLocalOriginService', () => ({}));
vi.mock('../../services/collabContentAdapterRegistration', () => ({}));
vi.mock('../../services/CollabDocumentReplicaStore', () => ({
  getCollabDocumentReplicaStore: () => ({
    appendLocalUpdate: appendLocalUpdateMock,
    estimateLocalAppendBytes: estimateLocalAppendBytesMock,
    prepareForAppend: prepareForAppendMock,
    listPendingOutboxes: listPendingOutboxesMock,
  }),
}));
vi.mock('../../services/CollabOutboxDrainerService', () => ({
  getCollabOutboxDrainCoordinator: () => drainCoordinatorMock,
}));

import { registerDocumentSyncHandlers } from '../DocumentSyncHandlers';
import { getOrgScopedJwt } from '../../services/TeamService';

describe('document-sync:open server-managed key path (NIM-2036)', () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    findTeamForWorkspaceMock.mockResolvedValue({ orgId: 'org-1', teamProjectId: null });
    fetchTeamKeyStatusMock.mockResolvedValue({ mode: 'server-managed', dekEpoch: 1, dekFingerprint: 'fp' });
    getLastKnownTeamKeyStatusMock.mockReturnValue(null);
    getOrgKeyMock.mockResolvedValue(null);
    getArchivedOrgKeysMock.mockReturnValue([]);
    fetchAndUnwrapOrgKeyMock.mockResolvedValue(null);
    listPendingOutboxesMock.mockResolvedValue([]);
    registerDocumentSyncHandlers();
  });

  it('never fetches a legacy org-key envelope while opening server-managed documents', async () => {
    const handler = handlers.get('document-sync:open');
    expect(handler).toBeTruthy();
    const sender = {
      id: 2036,
      isDestroyed: () => false,
      once: vi.fn(),
    };

    await handler!({ sender }, {
      workspacePath: '/workspace/one',
      documentId: 'doc-1',
      documentType: 'markdown',
    });
    await handler!({ sender }, {
      workspacePath: '/workspace/one',
      documentId: 'doc-1',
      documentType: 'markdown',
    });

    expect(fetchAndUnwrapOrgKeyMock).not.toHaveBeenCalled();
    expect(registerCollabAssetDocumentMock).toHaveBeenCalledTimes(2);
  });

  it('does not fetch a legacy org-key envelope while resolving the server-managed index', async () => {
    const result = await handlers.get('document-sync:resolve-index-config')!(
      null,
      { workspacePath: '/workspace/one' },
    );

    expect(result).toEqual(expect.objectContaining({ success: true }));
    expect(fetchAndUnwrapOrgKeyMock).not.toHaveBeenCalled();
  });

  it('still supplies locally persisted legacy epochs for best-effort recovery', async () => {
    const currentKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    );
    const currentRaw = Buffer.from(
      await crypto.subtle.exportKey('raw', currentKey),
    ).toString('base64');
    getOrgKeyMock.mockResolvedValue(currentKey);
    getArchivedOrgKeysMock.mockReturnValue([
      {
        rawKeyBase64: currentRaw,
        fingerprint: 'duplicate',
        archivedAt: new Date().toISOString(),
        reason: 'duplicate',
      },
      {
        rawKeyBase64: 'archived-key-base64',
        fingerprint: 'archived',
        archivedAt: new Date().toISOString(),
        reason: 'rotation',
      },
    ]);
    const sender = {
      id: 2037,
      isDestroyed: () => false,
      once: vi.fn(),
    };

    const result = await handlers.get('document-sync:open')!(
      { sender },
      {
        workspacePath: '/workspace/one',
        documentId: 'doc-legacy-recovery',
        documentType: 'markdown',
      },
    );

    expect(result.config.legacyOrgKeysBase64).toEqual([
      currentRaw,
      'archived-key-base64',
    ]);
    expect(fetchAndUnwrapOrgKeyMock).not.toHaveBeenCalled();
  });
});

describe('document-sync:resolve-index-config single-flight (RC4)', () => {
  beforeEach(() => {
    handlers.clear();
    findTeamForWorkspaceMock.mockReset();
    fetchTeamKeyStatusMock.mockReset();
    fetchTeamKeyStatusMock.mockResolvedValue({ mode: 'server-managed', dekEpoch: 1, dekFingerprint: 'fp' });
    getOrgKeyMock.mockReset().mockResolvedValue(null);
    getArchivedOrgKeysMock.mockReset().mockReturnValue([]);
    fetchAndUnwrapOrgKeyMock.mockReset().mockResolvedValue(null);
    listPendingOutboxesMock.mockReset();
    listPendingOutboxesMock.mockResolvedValue([]);

    registerDocumentSyncHandlers();
  });

  it('always scopes pending-outbox enumeration to the active account', async () => {
    const handler = handlers.get('document-sync:replica-list-pending-outboxes');
    expect(handler).toBeTruthy();

    await expect(
      handler!(null, { workspacePath: '/workspace/one' }),
    ).resolves.toEqual([]);
    expect(listPendingOutboxesMock).toHaveBeenCalledWith('account-a');

    await expect(
      handler!(null, { workspacePath: '/workspace/one', accountId: 'account-b' }),
    ).rejects.toThrow('Local replica account does not match the active account');
  });

  it('collapses N concurrent calls for the same workspace into one findTeamForWorkspace resolution', async () => {
    let resolveTeam: (value: unknown) => void;
    findTeamForWorkspaceMock.mockImplementation(() => new Promise((resolve) => { resolveTeam = resolve; }));

    const handler = handlers.get('document-sync:resolve-index-config');
    expect(handler).toBeTruthy();

    const calls = Array.from({ length: 5 }, () => handler!(null, { workspacePath: '/workspace/one' }));
    await Promise.resolve();
    await Promise.resolve();
    resolveTeam!({ orgId: 'org-1', teamProjectId: null });

    const results = await Promise.all(calls);

    expect(findTeamForWorkspaceMock).toHaveBeenCalledTimes(1);
    for (const result of results) {
      expect(result).toEqual(expect.objectContaining({ success: true }));
    }
  });

  it('does not dedupe calls for different workspaces', async () => {
    findTeamForWorkspaceMock.mockImplementation(async (workspacePath: string) => ({
      orgId: workspacePath === '/workspace/one' ? 'org-1' : 'org-2',
      teamProjectId: null,
    }));

    const handler = handlers.get('document-sync:resolve-index-config')!;
    await Promise.all([
      handler(null, { workspacePath: '/workspace/one' }),
      handler(null, { workspacePath: '/workspace/two' }),
    ]);

    expect(findTeamForWorkspaceMock).toHaveBeenCalledTimes(2);
  });

  it('runs a fresh resolution for a later, non-overlapping call', async () => {
    findTeamForWorkspaceMock.mockResolvedValue({ orgId: 'org-1', teamProjectId: null });

    const handler = handlers.get('document-sync:resolve-index-config')!;
    await handler(null, { workspacePath: '/workspace/one' });
    await handler(null, { workspacePath: '/workspace/one' });

    expect(findTeamForWorkspaceMock).toHaveBeenCalledTimes(2);
  });
});

describe('document-sync:resolve-index-config offline custody fallback (NIM-1778)', () => {
  beforeEach(() => {
    handlers.clear();
    findTeamForWorkspaceMock.mockReset();
    findTeamForWorkspaceMock.mockResolvedValue({ orgId: 'org-1', teamProjectId: null });
    fetchTeamKeyStatusMock.mockReset();
    getLastKnownTeamKeyStatusMock.mockReset();
    getLastKnownTeamKeyStatusMock.mockReturnValue(null);
    getOrgKeyMock.mockReset().mockResolvedValue(null);
    getArchivedOrgKeysMock.mockReset().mockReturnValue([]);
    fetchAndUnwrapOrgKeyMock.mockReset().mockResolvedValue(null);
    vi.mocked(getOrgScopedJwt).mockReset();
    registerDocumentSyncHandlers();
  });

  afterEach(() => {
    vi.mocked(getOrgScopedJwt).mockReset();
    vi.mocked(getOrgScopedJwt).mockImplementation(async () => 'org-jwt' as Awaited<ReturnType<typeof getOrgScopedJwt>>);
  });

  it('uses the last-known custody mode when the org JWT cannot be minted offline', async () => {
    vi.mocked(getOrgScopedJwt).mockRejectedValue(new Error('Failed to get JWT: net::ERR_INTERNET_DISCONNECTED'));
    getLastKnownTeamKeyStatusMock.mockReturnValue({ mode: 'server-managed', dekEpoch: 1, dekFingerprint: 'fp' });

    const handler = handlers.get('document-sync:resolve-index-config')!;
    const result = await handler(null, { workspacePath: '/workspace/one' });

    expect(result.success).toBe(true);
    expect(result.config.keyCustody).toBe('server-managed');
    expect(getLastKnownTeamKeyStatusMock).toHaveBeenCalledWith('org-1');
  });

  it('still lands on the legacy lane offline when the org has never been resolved', async () => {
    vi.mocked(getOrgScopedJwt).mockRejectedValue(new Error('Failed to get JWT: net::ERR_INTERNET_DISCONNECTED'));
    getLastKnownTeamKeyStatusMock.mockReturnValue(null);

    const handler = handlers.get('document-sync:resolve-index-config')!;
    const result = await handler(null, { workspacePath: '/workspace/one' });

    // Legacy lane with no obtainable org key fails closed rather than
    // resolving a server-managed config it has no evidence for.
    expect(result.success).toBe(false);
    expect(result.error).toContain('No encryption key available');
  });
});

describe('document-sync:replica-append-local fan-out', () => {
  beforeEach(() => {
    handlers.clear();
    appendLocalUpdateMock.mockReset().mockResolvedValue(undefined);
    prepareForAppendMock.mockReset().mockResolvedValue(undefined);
    estimateLocalAppendBytesMock.mockReset().mockReturnValue(128);
    drainCoordinatorMock.getAttachedSenderIds.mockReset().mockReturnValue([8]);
    drainCoordinatorMock.isProviderAttached.mockReset().mockReturnValue(false);
    registerDocumentSyncHandlers();
  });

  it('fans out only after durable append and excludes the sender', async () => {
    const senderSend = vi.fn();
    const siblingSend = vi.fn();
    const unattachedSend = vi.fn();
    browserWindowsMock.mockReturnValue([
      { webContents: { id: 7, isDestroyed: () => false, send: senderSend } },
      { webContents: { id: 8, isDestroyed: () => false, send: siblingSend } },
      { webContents: { id: 9, isDestroyed: () => false, send: unattachedSend } },
    ]);
    const input = {
      identity: {
        accountId: 'account-a',
        orgId: 'org-a',
        documentId: 'document-a',
      },
      documentType: 'markdown',
      updateId: 'local-update-1',
      update: new Uint8Array([1, 2, 3]),
      snapshotGeneration: 4,
    };

    await handlers.get('document-sync:replica-append-local')!(
      { sender: { id: 7 } },
      { workspacePath: '/workspace', input },
    );

    expect(prepareForAppendMock).toHaveBeenCalledWith(
      'account-a',
      128,
      expect.any(Function),
    );
    expect(appendLocalUpdateMock).toHaveBeenCalledWith(input);
    expect(prepareForAppendMock.mock.invocationCallOrder[0]).toBeLessThan(
      appendLocalUpdateMock.mock.invocationCallOrder[0],
    );
    expect(drainCoordinatorMock.getAttachedSenderIds).toHaveBeenCalledWith(
      input.identity,
      7,
    );
    expect(senderSend).not.toHaveBeenCalled();
    expect(unattachedSend).not.toHaveBeenCalled();
    expect(siblingSend).toHaveBeenCalledWith(
      'document-sync:replica-local-update',
      {
        identity: input.identity,
        updateId: input.updateId,
        update: input.update,
      },
    );
    expect(appendLocalUpdateMock.mock.invocationCallOrder[0]).toBeLessThan(
      siblingSend.mock.invocationCallOrder[0],
    );
  });

  it('does not append or fan out when pre-append budget admission fails', async () => {
    const siblingSend = vi.fn();
    browserWindowsMock.mockReturnValue([
      { webContents: { id: 8, isDestroyed: () => false, send: siblingSend } },
    ]);
    prepareForAppendMock.mockRejectedValueOnce(
      new Error('LOCAL_REPLICA_STORAGE_BUDGET_EXCEEDED'),
    );

    await expect(
      handlers.get('document-sync:replica-append-local')!(
        { sender: { id: 7 } },
        {
          workspacePath: '/workspace',
          input: {
            identity: {
              accountId: 'account-a',
              orgId: 'org-a',
              documentId: 'document-a',
            },
            documentType: 'markdown',
            updateId: 'rejected-before-commit',
            update: new Uint8Array([4]),
            snapshotGeneration: 4,
          },
        },
      ),
    ).rejects.toThrow('LOCAL_REPLICA_STORAGE_BUDGET_EXCEEDED');

    expect(appendLocalUpdateMock).not.toHaveBeenCalled();
    expect(siblingSend).not.toHaveBeenCalled();
  });
});
