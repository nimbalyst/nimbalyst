import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  appendLocalUpdateMock,
  browserWindowsMock,
  clearCollabAssetSenderMock,
  drainCoordinatorMock,
  estimateLocalAppendBytesMock,
  findTeamForWorkspaceMock,
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
    drainCoordinatorMock: {
      clearSender: vi.fn(),
      getAttachedSenderIds: vi.fn(),
      isProviderAttached: vi.fn(),
    },
    estimateLocalAppendBytesMock: vi.fn(),
    findTeamForWorkspaceMock: vi.fn(),
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
  refreshPersonalSessionDetailed: vi.fn(async () => ({ ok: true })),
}));

vi.mock('../../services/TeamService', () => ({
  findTeamForWorkspace: findTeamForWorkspaceMock,
  getOrgScopedJwt: vi.fn(async () => 'org-jwt'),
}));

vi.mock('../../services/jwtOrg', () => ({
  getOrgIdFromJwt: vi.fn(),
  getJwtExp: vi.fn(() => Date.now() + 60_000),
  getSubFromJwt: vi.fn(() => 'team-member-1'),
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
import { getPersonalSessionJwt, refreshPersonalSessionDetailed } from '../../services/StytchAuthService';
import { getJwtExp } from '../../services/jwtOrg';

// @vitest-environment node
/**
 * This handler used to ignore the refresh result entirely and hand back
 * whatever JWT happened to be cached -- including an expired one, after either
 * an auth rejection or an unreachable server. An expired token guarantees the
 * reconnect is refused again, so the loop never escapes and the reported cause
 * is wrong in both directions.
 */
describe('document-sync:get-personal-jwt failure classification', () => {
  const futureExpSeconds = Math.floor(Date.now() / 1000) + 300;
  const pastExpSeconds = Math.floor(Date.now() / 1000) - 300;

  beforeEach(() => {
    handlers.clear();
    vi.mocked(getPersonalSessionJwt).mockReturnValue('personal-jwt' as never);
    vi.mocked(getJwtExp).mockReturnValue(futureExpSeconds);
    vi.mocked(refreshPersonalSessionDetailed).mockResolvedValue({ ok: true } as never);
    registerDocumentSyncHandlers();
  });

  it('returns the refreshed JWT when the refresh succeeds', async () => {
    await expect(handlers.get('document-sync:get-personal-jwt')!(null)).resolves.toEqual({
      success: true,
      jwt: 'personal-jwt',
    });
  });

  it('reports an unreachable sync server instead of handing back an expired JWT', async () => {
    vi.mocked(getJwtExp).mockReturnValue(pastExpSeconds);
    vi.mocked(refreshPersonalSessionDetailed).mockResolvedValue({
      ok: false,
      reason: 'network',
      detail: 'ECONNREFUSED (connect ECONNREFUSED 127.0.0.1:8790)',
    } as never);

    const result = await handlers.get('document-sync:get-personal-jwt')!(null);
    expect(result.success).toBe(false);
    expect(result.jwt).toBeUndefined();
    expect(result.error).toContain('unreachable');
    expect(result.error).toContain('ECONNREFUSED');
  });

  it('reports a server rejection as a re-auth prompt, not as a transport problem', async () => {
    vi.mocked(getJwtExp).mockReturnValue(pastExpSeconds);
    vi.mocked(refreshPersonalSessionDetailed).mockResolvedValue({ ok: false, reason: 'auth' } as never);

    const result = await handlers.get('document-sync:get-personal-jwt')!(null);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/sign in again/i);
    expect(result.error).not.toMatch(/unreachable/i);
  });

  it('keeps using a still-valid JWT when only the refresh could not reach the server', async () => {
    vi.mocked(refreshPersonalSessionDetailed).mockResolvedValue({
      ok: false,
      reason: 'network',
      detail: 'ECONNREFUSED',
    } as never);

    // A transport blip must not invalidate a token that has not expired.
    await expect(handlers.get('document-sync:get-personal-jwt')!(null)).resolves.toEqual({
      success: true,
      jwt: 'personal-jwt',
    });
  });
});

describe('document-sync:open performs no client-side key work (NIM-2036)', () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    findTeamForWorkspaceMock.mockResolvedValue({ orgId: 'org-1', teamProjectId: null });
    listPendingOutboxesMock.mockResolvedValue([]);
    registerDocumentSyncHandlers();
  });

  /**
   * Client-managed custody is gone: the server holds the team DEK and refuses
   * content rooms it cannot unlock (NIM-2231), so opening a document must not
   * fetch, unwrap, or probe ANY key material.
   *
   * This is a source-level guard on purpose. The runtime assertion this
   * replaced spied on `OrgKeyService`, and once that module was deleted the
   * spy could never fire — the test passed by construction while guarding
   * nothing. Asserting on the import graph keeps failing if the dependency
   * comes back.
   */
  it('does not import any org-key or custody module', async () => {
    const source = await readFile(
      resolve(__dirname, '../DocumentSyncHandlers.ts'),
      'utf-8',
    );
    const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    expect(imports.filter((spec) => /OrgKey|KeyRotation|TeamCustody/i.test(spec)))
      .toEqual([]);
  });

  it('opens a document twice without re-registering key material', async () => {
    const handler = handlers.get('document-sync:open');
    expect(handler).toBeTruthy();
    const sender = {
      id: 2036,
      isDestroyed: () => false,
      once: vi.fn(),
    };

    for (let i = 0; i < 2; i += 1) {
      await handler!({ sender }, {
        workspacePath: '/workspace/one',
        documentId: 'doc-1',
        documentType: 'markdown',
      });
    }

    expect(registerCollabAssetDocumentMock).toHaveBeenCalledTimes(2);
  });

  it('routes the shared room with the team JWT member id, not the ambient personal member id', async () => {
    const result = await handlers.get('document-sync:open')!(
      { sender: { id: 3027, isDestroyed: () => false, once: vi.fn() } },
      { workspacePath: '/workspace/one', documentId: 'doc-team', documentType: 'markdown' },
    );

    expect(result).toEqual(expect.objectContaining({
      success: true,
      config: expect.objectContaining({
        accountId: 'account-a',
        teamMemberId: 'team-member-1',
      }),
    }));
    expect(result.config).not.toHaveProperty('userId');
  });

  it('resolves the index config without any key probe', async () => {
    const result = await handlers.get('document-sync:resolve-index-config')!(
      null,
      { workspacePath: '/workspace/one' },
    );

    expect(result).toEqual(expect.objectContaining({
      success: true,
      config: expect.objectContaining({ teamMemberId: 'team-member-1' }),
    }));
  });
});

describe('document-sync:resolve-index-config single-flight (RC4)', () => {
  beforeEach(() => {
    handlers.clear();
    findTeamForWorkspaceMock.mockReset();
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

/**
 * The asset route refuses anything over 25 MiB. Queuing such a blob anyway
 * spends the local upload budget on bytes that can only ever 413, so the
 * ceiling is applied before the durable outbox sees them.
 */
describe('document-sync:upload-asset size ceiling', () => {
  const MAX_COLLAB_ASSET_BYTES = 25 * 1024 * 1024;

  beforeEach(() => {
    handlers.clear();
    registerDocumentSyncHandlers();
  });

  it('refuses a payload above the asset route ceiling', async () => {
    const result = await handlers.get('document-sync:upload-asset')!(
      { sender: { id: 1, isDestroyed: () => false, once: vi.fn() } },
      {
        orgId: 'org-a',
        documentId: 'conversation-a',
        fileBytes: new ArrayBuffer(MAX_COLLAB_ASSET_BYTES + 1),
        mimeType: 'video/quicktime',
        fileName: 'capture.mov',
      },
    );

    expect(result).toMatchObject({
      success: false,
      errorCode: 'asset_too_large',
    });
    expect(result.error).toContain('25 MB');
  });
});
