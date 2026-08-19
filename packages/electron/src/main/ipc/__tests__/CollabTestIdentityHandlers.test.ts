// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { appMock, handlers, removeHandlerMock, safeHandleMock } = vi.hoisted(() => {
  const handlers = new Map<string, (...args: any[]) => any>();
  return {
    appMock: { isPackaged: false },
    handlers,
    removeHandlerMock: vi.fn((channel: string) => { handlers.delete(channel); }),
    safeHandleMock: vi.fn((channel: string, handler: (...args: any[]) => any) => {
      handlers.set(channel, handler);
    }),
  };
});

vi.mock('electron', () => ({ app: appMock }));
vi.mock('../../utils/ipcRegistry', () => ({
  removeHandler: removeHandlerMock,
  safeHandle: safeHandleMock,
}));
vi.mock('../../utils/logger', () => ({
  logger: { main: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));
vi.mock('../../utils/store', () => ({ getWorkspaceState: vi.fn(() => ({})) }));
vi.mock('../collabDocumentTypeResolver', () => ({
  resolveCollabDocumentType: vi.fn(() => 'mindmap'),
}));
vi.mock('../../protocols/collabAssetProtocol', () => ({
  registerCollabAssetDocument: vi.fn(),
  clearCollabAssetSender: vi.fn(),
}));

import { registerCollabTestIdentityHandlers } from '../CollabTestIdentityHandlers';

const AUTH_CHANNELS = [
  'document-sync:open',
  'document-sync:get-jwt',
  'document-sync:resolve-index-config',
];

const originalEnv = { ...process.env };

function setHarnessEnv(serverUrl = 'ws://127.0.0.1:8797'): void {
  process.env.PLAYWRIGHT = '1';
  process.env.NIMBALYST_E2E_COLLAB_SERVER_URL = serverUrl;
  process.env.NIMBALYST_E2E_COLLAB_ORG_ID = 'e2e-org';
  process.env.NIMBALYST_E2E_COLLAB_USER_ID = 'e2e-user-a';
}

beforeEach(() => {
  handlers.clear();
  vi.clearAllMocks();
  appMock.isPackaged = false;
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('registerCollabTestIdentityHandlers', () => {
  it('never replaces the production auth handlers in a packaged build', () => {
    setHarnessEnv();
    appMock.isPackaged = true;

    registerCollabTestIdentityHandlers();

    expect(safeHandleMock).not.toHaveBeenCalled();
    expect(removeHandlerMock).not.toHaveBeenCalled();
  });

  it('does nothing without the full Playwright harness environment', () => {
    setHarnessEnv();
    delete process.env.NIMBALYST_E2E_COLLAB_USER_ID;
    registerCollabTestIdentityHandlers();
    expect(safeHandleMock).not.toHaveBeenCalled();

    process.env = { ...originalEnv };
    setHarnessEnv();
    delete process.env.PLAYWRIGHT;
    registerCollabTestIdentityHandlers();
    expect(safeHandleMock).not.toHaveBeenCalled();
  });

  it('rejects a collab server that is not loopback', () => {
    setHarnessEnv('wss://sync.nimbalyst.com');
    expect(() => registerCollabTestIdentityHandlers()).toThrow(/loopback/);
    expect(safeHandleMock).not.toHaveBeenCalled();
  });

  it('hands the renderer a pre-authorized URL query instead of rewriting sockets', async () => {
    setHarnessEnv();
    registerCollabTestIdentityHandlers();

    expect(removeHandlerMock.mock.calls.map(([channel]) => channel)).toEqual(AUTH_CHANNELS);
    expect(safeHandleMock.mock.calls.map(([channel]) => channel)).toEqual(AUTH_CHANNELS);

    const expectedQuery = 'test_user_id=e2e-user-a&test_org_id=e2e-org';
    const event = { sender: { id: 7, isDestroyed: () => false, once: vi.fn() } };

    const open = await handlers.get('document-sync:open')!(event, {
      workspacePath: '/tmp/ws',
      documentId: 'doc-1',
    });
    expect(open.config).toMatchObject({
      orgId: 'e2e-org',
      teamMemberId: 'e2e-user-a',
      accountId: 'e2e-user-a',
      documentType: 'mindmap',
      serverUrl: 'ws://127.0.0.1:8797',
      urlExtraQuery: expectedQuery,
    });

    const index = await handlers.get('document-sync:resolve-index-config')!(event, {
      workspacePath: '/tmp/ws',
    });
    expect(index.config).toMatchObject({ orgId: 'e2e-org', urlExtraQuery: expectedQuery });

    expect(await handlers.get('document-sync:get-jwt')!(event, { orgId: 'e2e-org' }))
      .toEqual({ success: true, jwt: expect.any(String) });
    expect(await handlers.get('document-sync:get-jwt')!(event, { orgId: 'other-org' }))
      .toMatchObject({ success: false });
  });
});
