// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The phone acts on a create response by opening the session id it names. If
 * the ack goes out before the index row for that session is on the wire, the
 * phone opens a session the index has never heard of -- the race fixed in
 * b4f29cbc6 and b63afaeb3. These tests pin the ordering and the failure report.
 */

const mocks = vi.hoisted(() => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  findWindowByWorkspace: vi.fn(() => undefined as unknown),
  stampSessionHost: vi.fn(async () => {}),
  worktreeStore: {
    getAllNames: vi.fn(async () => [] as string[]),
    create: vi.fn(async () => {}),
  },
  createSession: vi.fn(),
  sessionRepoCreate: vi.fn(async () => {}),
}));

vi.mock('../../../utils/logger', () => ({ logger: { main: mocks.logger } }));
vi.mock('../../../utils/store', () => ({ getDefaultAIModel: () => 'claude-code:opus-1m' }));
vi.mock('../../../window/WindowManager', () => ({
  createWindow: vi.fn(),
  findWindowByWorkspace: mocks.findWindowByWorkspace,
  windowStates: new Map(),
}));
vi.mock('../sessionHostAttribution', () => ({
  getLocalHostDeviceId: () => 'host-1',
  isTargetedAtAnotherDevice: () => false,
  stampSessionHost: mocks.stampSessionHost,
}));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false }] },
}));
vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({
  AISessionsRepository: { create: mocks.sessionRepoCreate, updateMetadata: vi.fn(async () => {}) },
}));
vi.mock('../../GitWorktreeService', () => ({
  GitWorktreeService: class {
    getExistingWorktreeDirectories() { return [] as string[]; }
    async getAllBranchNames() { return [] as string[]; }
    generateUniqueWorktreeName() { return 'brave-otter'; }
    async createWorktree() { return { id: 'wt-1', name: 'brave-otter', branch: 'brave-otter', path: '/tmp/wt' }; }
  },
}));
vi.mock('../../WorktreeStore', () => ({ createWorktreeStore: () => mocks.worktreeStore }));
vi.mock('../../../database/initialize', () => ({ getDatabase: () => ({}) }));
vi.mock('../../../file/GitRefWatcher', () => ({ gitRefWatcher: { start: async () => {} } }));

import {
  registerMobileCreateSessionHandler,
  registerMobileCreateWorktreeHandler,
  type MobileCreateRequestContext,
} from '../mobileCreateRequestHandlers';

type Handler = (request: Record<string, unknown>) => Promise<void>;

function requestContext(): MobileCreateRequestContext {
  return {
    sessionManager: { createSession: mocks.createSession } as never,
    claimRequest: () => true,
    releaseRequest: () => {},
  };
}

function fakeProvider(syncSessionsToIndex: unknown) {
  const captured: { session?: Handler; worktree?: Handler } = {};
  const provider = {
    onCreateSessionRequest: (handler: Handler) => { captured.session = handler; },
    onCreateWorktreeRequest: (handler: Handler) => { captured.worktree = handler; },
    sendCreateSessionResponse: vi.fn(async (_response: { success: boolean; error?: string; sessionId?: string }) => {}),
    sendCreateWorktreeResponse: vi.fn(async (_response: { success: boolean; error?: string }) => {}),
    syncSessionsToIndex,
  };
  return { provider, captured };
}

describe('mobile create-session request handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createSession.mockResolvedValue({
      id: 'session-1',
      title: 'From mobile',
      provider: 'claude-code',
      model: 'claude-code:opus-1m',
      mode: 'agent',
      sessionType: 'session',
      workspacePath: '/workspace',
      messages: [],
      updatedAt: 1_000,
      createdAt: 1_000,
    });
    mocks.findWindowByWorkspace.mockReturnValue({
      isDestroyed: () => false,
      webContents: { send: vi.fn(), once: vi.fn() },
    });
  });

  it('sends no response until the index publish for the new session resolves', async () => {
    let releasePublish: (() => void) | undefined;
    const publishing = new Promise<void>((resolve) => { releasePublish = resolve; });
    const syncSessionsToIndex = vi.fn(async () => {
      await publishing;
      return { published: true, publishedSessionIds: ['session-1'] };
    });
    const { provider, captured } = fakeProvider(syncSessionsToIndex);
    registerMobileCreateSessionHandler(provider as never, requestContext());

    const handling = captured.session!({ requestId: 'req-1', projectId: '/workspace' });
    await vi.waitFor(() => expect(syncSessionsToIndex).toHaveBeenCalledTimes(1));
    expect(provider.sendCreateSessionResponse).not.toHaveBeenCalled();

    releasePublish!();
    await handling;
    expect(provider.sendCreateSessionResponse).toHaveBeenCalledWith({
      requestId: 'req-1',
      success: true,
      sessionId: 'session-1',
    });
  });

  /**
   * A queued publish is re-driven on reconnect, so the session really is coming.
   * iOS finishes the request on the FIRST response: answering false here is
   * terminal and the index row arriving later can never complete it.
   */
  it('acks a retryable unpublished row as success so the phone keeps waiting', async () => {
    const { provider, captured } = fakeProvider(async () => ({
      published: false,
      reason: 'index transport not connected; publish queued until reconnect',
      retryable: true,
      publishedSessionIds: [],
    }));
    registerMobileCreateSessionHandler(provider as never, requestContext());

    await captured.session!({ requestId: 'req-2', projectId: '/workspace' });

    const [response] = provider.sendCreateSessionResponse.mock.calls[0];
    expect(response).toEqual({ requestId: 'req-2', success: true, sessionId: 'session-1' });
  });

  it('reports a non-retryable unpublished row as a failure carrying the reason', async () => {
    const { provider, captured } = fakeProvider(async () => ({
      published: false,
      reason: 'no session in the batch is inside index retention',
      retryable: false,
      publishedSessionIds: [],
    }));
    registerMobileCreateSessionHandler(provider as never, requestContext());

    await captured.session!({ requestId: 'req-2b', projectId: '/workspace' });

    const [response] = provider.sendCreateSessionResponse.mock.calls[0];
    expect(response.success).toBe(false);
    expect(response.error).toContain('index retention');
  });

  it('reports a provider that cannot publish to the index rather than acking blind', async () => {
    const { provider, captured } = fakeProvider(undefined);
    registerMobileCreateSessionHandler(provider as never, requestContext());

    await captured.session!({ requestId: 'req-3', projectId: '/workspace' });

    const [response] = provider.sendCreateSessionResponse.mock.calls[0];
    expect(response.success).toBe(false);
  });
});

describe('mobile create-worktree request handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findWindowByWorkspace.mockReturnValue({
      isDestroyed: () => false,
      webContents: { send: vi.fn(), once: vi.fn() },
    });
  });

  it('sends no response until the index publish for the worktree session resolves', async () => {
    let releasePublish: (() => void) | undefined;
    const publishing = new Promise<void>((resolve) => { releasePublish = resolve; });
    const syncSessionsToIndex = vi.fn(async () => {
      await publishing;
      return { published: true, publishedSessionIds: ['wt-session'] };
    });
    const { provider, captured } = fakeProvider(syncSessionsToIndex);
    registerMobileCreateWorktreeHandler(provider as never, requestContext());

    const handling = captured.worktree!({ requestId: 'req-4', projectId: '/workspace' });
    await vi.waitFor(() => expect(syncSessionsToIndex).toHaveBeenCalledTimes(1));
    expect(provider.sendCreateWorktreeResponse).not.toHaveBeenCalled();

    releasePublish!();
    await handling;
    expect(provider.sendCreateWorktreeResponse).toHaveBeenCalledWith({
      requestId: 'req-4',
      success: true,
    });
  });

  it('acks a retryable unpublished worktree row as success', async () => {
    const { provider, captured } = fakeProvider(async () => ({
      published: false,
      reason: 'personal-sync writes withheld',
      retryable: true,
      publishedSessionIds: [],
    }));
    registerMobileCreateWorktreeHandler(provider as never, requestContext());

    await captured.worktree!({ requestId: 'req-5', projectId: '/workspace' });

    const [response] = provider.sendCreateWorktreeResponse.mock.calls[0];
    expect(response).toEqual({ requestId: 'req-5', success: true });
  });

  it('reports a non-retryable unpublished worktree row as a failure carrying the reason', async () => {
    const { provider, captured } = fakeProvider(async () => ({
      published: false,
      reason: 'no session in the batch is inside index retention',
      retryable: false,
      publishedSessionIds: [],
    }));
    registerMobileCreateWorktreeHandler(provider as never, requestContext());

    await captured.worktree!({ requestId: 'req-5b', projectId: '/workspace' });

    const [response] = provider.sendCreateWorktreeResponse.mock.calls[0];
    expect(response.success).toBe(false);
    expect(response.error).toContain('index retention');
  });
});
