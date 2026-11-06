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
  queuePrompt: vi.fn(),
  sessionRepoCreate: vi.fn(async () => {}),
  sessionRepoGet: vi.fn(),
  windowStates: new Map<number, { workspacePath?: string }>(),
  allWindows: [{ id: 1, isDestroyed: () => false }] as Array<{ id: number; isDestroyed: () => boolean }>,
}));

vi.mock('../../../utils/logger', () => ({ logger: { main: mocks.logger } }));
vi.mock('../../../utils/store', () => ({ getDefaultAIModel: () => 'claude-code:opus-1m' }));
vi.mock('../../../window/WindowManager', () => ({
  createWindow: vi.fn(),
  findWindowByWorkspace: mocks.findWindowByWorkspace,
  windowStates: mocks.windowStates,
}));
vi.mock('../sessionHostAttribution', () => ({
  getLocalHostDeviceId: () => 'host-1',
  isTargetedAtAnotherDevice: () => false,
  stampSessionHost: mocks.stampSessionHost,
}));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => mocks.allWindows },
}));
vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({
  AISessionsRepository: { get: mocks.sessionRepoGet, create: mocks.sessionRepoCreate, updateMetadata: vi.fn(async () => {}) },
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
vi.mock('../../RepositoryManager', () => ({ getQueuedPromptsStore: () => ({ create: mocks.queuePrompt }) }));
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
  const accepted = new Map<string, { sessionId: string; projectId: string; parentSessionId?: string | null }>();
  const provider = {
    onCreateSessionRequest: (handler: Handler) => { captured.session = handler; },
    onCreateWorktreeRequest: (handler: Handler) => { captured.worktree = handler; },
    sendCreateSessionResponse: vi.fn(async (_response: { success: boolean; error?: string; sessionId?: string }) => {}),
    sendCreateWorktreeResponse: vi.fn(async (_response: { success: boolean; error?: string }) => {}),
    syncSessionsToIndex: typeof syncSessionsToIndex === 'function' ? vi.fn(async (rows: Array<{ id: string; workspaceId: string; parentSessionId?: string | null }>) => {
      const result = await syncSessionsToIndex(rows);
      for (const row of rows) {
        if (result?.publishedSessionIds?.includes(row.id)) accepted.set(row.id, {
          sessionId: row.id, projectId: row.workspaceId, parentSessionId: row.parentSessionId,
        });
      }
      return result;
    }) : syncSessionsToIndex,
    fetchIndex: vi.fn(async () => ({ complete: true, sessions: [...accepted.values()], projects: [], deletedSessionIds: [] as string[] })),
    getPersonalSyncWriteGate: vi.fn(() => ({ state: 'verified', reason: null, detail: null })),
    isIndexReady: () => true,
  };
  return { provider, captured };
}

describe('mobile create-session request handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sessionRepoGet.mockReset().mockImplementation(async () => ({
      id: 'session-1', title: 'Latest title', provider: 'claude-code',
      model: 'claude-code:opus-1m', mode: 'agent', sessionType: 'session',
      workspacePath: '/workspace', messages: [], updatedAt: 1_000, createdAt: 1_000,
    }));
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

  it('creates a worktree child with inherited parent and manager in the initial insert', async () => {
    mocks.sessionRepoGet.mockResolvedValue({ id: 'parent', workspacePath: '/workspace', worktreeId: 'wt', worktreePath: '/workspace/wt' });
    const { provider, captured } = fakeProvider(vi.fn(async () => ({ published: true, publishedSessionIds: ['session-1'] })));
    registerMobileCreateSessionHandler(provider as never, requestContext());
    await captured.session!({ requestId: 'child-in-worktree', projectId: '/workspace', parentSessionId: 'parent' });
    expect(mocks.createSession).toHaveBeenCalledWith('claude-code', undefined, '/workspace', undefined, 'claude-code:opus-1m', 'session', 'agent', 'wt', '/workspace/wt', '/workspace', 'standard', 'parent', undefined, 'parent');
  });

  it('rejects a foreign parent before creating an orphan session', async () => {
    mocks.sessionRepoGet.mockResolvedValue({ id: 'foreign', workspacePath: '/elsewhere' });
    const { provider, captured } = fakeProvider(vi.fn());
    registerMobileCreateSessionHandler(provider as never, requestContext());
    await captured.session!({ requestId: 'bad-parent', projectId: '/workspace', parentSessionId: 'foreign' });
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(provider.sendCreateSessionResponse).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
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

  // projectId is a workspace path. A window whose project merely contains
  // that string, or shares its folder name, is another project.
  it('never creates the session in a different project whose path contains the projectId', async () => {
    mocks.findWindowByWorkspace.mockReturnValue(undefined);
    mocks.windowStates.set(1, { workspacePath: '/workspace-old' });
    const { provider, captured } = fakeProvider(vi.fn(async () => ({ published: true, publishedSessionIds: ['session-1'] })));
    registerMobileCreateSessionHandler(provider as never, requestContext());

    try {
      await captured.session!({ requestId: 'near-miss', projectId: '/workspace' });
    } finally {
      mocks.windowStates.clear();
    }

    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(provider.sendCreateSessionResponse).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'near-miss',
      success: false,
    }));
  });

  it('does not acknowledge a socket send that the server never indexed', async () => {
    const publish = vi.fn(async (_rows: unknown[]) => ({ published: true, publishedSessionIds: ['session-1'] }));
    const { provider, captured } = fakeProvider(publish);
    provider.fetchIndex.mockResolvedValue({ complete: true, sessions: [], projects: [], deletedSessionIds: [] });
    registerMobileCreateSessionHandler(provider as never, requestContext());
    await captured.session!({ requestId: 'rejected-write', projectId: '/workspace', initialPrompt: 'Only once' });
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(4);
    expect(provider.sendCreateSessionResponse).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'rejected-write', success: false, sessionId: 'session-1',
    }));
    expect(mocks.queuePrompt).not.toHaveBeenCalled();
  });

  it('waits for authoritative readback before confirming creation', async () => {
    const { provider, captured } = fakeProvider(vi.fn(async () => ({ published: true, publishedSessionIds: ['session-1'] })));
    let release!: (value: Awaited<ReturnType<typeof provider.fetchIndex>>) => void;
    provider.fetchIndex.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    registerMobileCreateSessionHandler(provider as never, requestContext());
    const handling = captured.session!({ requestId: 'read-after-write', projectId: '/workspace' });
    await vi.waitFor(() => expect(provider.fetchIndex).toHaveBeenCalledTimes(1));
    expect(provider.sendCreateSessionResponse).not.toHaveBeenCalled();
    release({ complete: true, sessions: [{ sessionId: 'session-1', projectId: '/workspace', parentSessionId: null }], projects: [], deletedSessionIds: [] });
    await handling;
    expect(provider.sendCreateSessionResponse).toHaveBeenCalledWith({ requestId: 'read-after-write', success: true, sessionId: 'session-1' });
  });

  it('recovers the same row with fresh metadata after a refused write', async () => {
    const publish = vi.fn(async (_rows: unknown[]) => ({ published: true, publishedSessionIds: ['session-1'] }));
    const { provider, captured } = fakeProvider(publish);
    provider.fetchIndex.mockResolvedValueOnce({ complete: true, sessions: [], projects: [], deletedSessionIds: [] });
    registerMobileCreateSessionHandler(provider as never, requestContext());
    await captured.session!({ requestId: 'recover-row', projectId: '/workspace', initialPrompt: 'Only once' });
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[1][0]).toEqual([expect.objectContaining({ id: 'session-1', title: 'Latest title' })]);
    expect(provider.sendCreateSessionResponse).toHaveBeenCalledWith({ requestId: 'recover-row', success: true, sessionId: 'session-1' });
    expect(mocks.queuePrompt).toHaveBeenCalledTimes(1);
  });

  it('reloads a parented session and its current host without inventing a message count', async () => {
    const current = { id: 'session-1', title: 'Current child', provider: 'claude-code', model: 'claude-code:claudex-gpt-6-1-sol',
      workspacePath: '/workspace', parentSessionId: 'parent', createdBySessionId: 'parent',
      metadata: { hostDeviceId: 'current-host' }, messages: [], updatedAt: 2_000, createdAt: 1_000 };
    mocks.createSession.mockResolvedValue(current);
    mocks.sessionRepoGet.mockImplementation(async id => id === 'parent' ? { id: 'parent', workspacePath: '/workspace' } : current);
    const publish = vi.fn(async (_rows: unknown[]) => ({ published: true, publishedSessionIds: ['session-1'] }))
      .mockResolvedValueOnce({ published: false, reason: 'index state changed during publication', retryable: true, publishedSessionIds: [] } as never);
    const { provider, captured } = fakeProvider(publish);
    registerMobileCreateSessionHandler(provider as never, requestContext());
    await captured.session!({ requestId: 'parented-retry', projectId: '/workspace', parentSessionId: 'parent' });
    expect(publish.mock.calls[1][0]).toEqual([expect.objectContaining({ id: 'session-1', parentSessionId: 'parent', hostDeviceId: 'current-host', messageCountKnown: false })]);
    expect(provider.sendCreateSessionResponse).toHaveBeenCalledWith({ requestId: 'parented-retry', success: true, sessionId: 'session-1' });
  });

  it('answers an unresponsive readback before the phone creation deadline', async () => {
    vi.useFakeTimers();
    const { provider, captured } = fakeProvider(vi.fn(async () => ({ published: true, publishedSessionIds: ['session-1'] })));
    let release!: (value: Awaited<ReturnType<typeof provider.fetchIndex>>) => void;
    provider.fetchIndex.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    registerMobileCreateSessionHandler(provider as never, requestContext());
    const handling = captured.session!({ requestId: 'slow-read', projectId: '/workspace', initialPrompt: 'Only after confirmation' });
    try {
      await vi.waitFor(() => expect(provider.fetchIndex).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(25_000);
      expect(provider.sendCreateSessionResponse).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'slow-read', success: false, sessionId: 'session-1' }));
      expect(mocks.queuePrompt).not.toHaveBeenCalled();
    } finally {
      release({ complete: true, sessions: [{ sessionId: 'session-1', projectId: '/workspace' }], projects: [], deletedSessionIds: [] });
      await handling;
      vi.useRealTimers();
    }
    expect(provider.sendCreateSessionResponse).toHaveBeenCalledTimes(1);
    expect(mocks.queuePrompt).not.toHaveBeenCalled();
  });

  it.each(['tombstone', 'partial', 'wrong-project', 'wrong-parent', 'read-error'])('does not republish on an unsafe confirmation: %s', async scenario => {
    const publish = vi.fn(async (_rows: unknown[]) => ({ published: true, publishedSessionIds: ['session-1'] }));
    const { provider, captured } = fakeProvider(publish);
    const snapshot = { complete: scenario !== 'partial', sessions: [] as Array<{ sessionId: string; projectId: string; parentSessionId?: string | null }>, projects: [], deletedSessionIds: scenario === 'tombstone' ? ['session-1'] : [] };
    if (scenario === 'wrong-project') snapshot.sessions.push({ sessionId: 'session-1', projectId: '/foreign' });
    if (scenario === 'wrong-parent') snapshot.sessions.push({ sessionId: 'session-1', projectId: '/workspace', parentSessionId: 'changed-parent' });
    if (scenario === 'read-error') provider.fetchIndex.mockRejectedValue(new Error('unrelated write rate limit'));
    else provider.fetchIndex.mockResolvedValue(snapshot);
    registerMobileCreateSessionHandler(provider as never, requestContext());
    await captured.session!({ requestId: scenario, projectId: '/workspace' });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(provider.sendCreateSessionResponse).toHaveBeenCalledWith(expect.objectContaining({ success: false, sessionId: 'session-1' }));
  });

  it.each(['gone', 'moved-project', 'moved-parent'])('refuses retry when the canonical row is %s', async scenario => {
    const publish = vi.fn(async () => ({ published: false, reason: 'index state changed during publication', retryable: true, publishedSessionIds: [] }));
    const { provider, captured } = fakeProvider(publish);
    mocks.sessionRepoGet.mockResolvedValue(scenario === 'gone' ? null : {
      id: 'session-1', workspacePath: scenario === 'moved-project' ? '/foreign' : '/workspace', parentSessionId: scenario === 'moved-parent' ? 'new-parent' : null,
    });
    registerMobileCreateSessionHandler(provider as never, requestContext());
    await captured.session!({ requestId: scenario, projectId: '/workspace' });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(provider.sendCreateSessionResponse).toHaveBeenCalledWith(expect.objectContaining({ success: false, sessionId: 'session-1' }));
  });

  it('refuses retry after the index disconnects', async () => {
    let ready = true;
    const publish = vi.fn(async () => { ready = false; return { published: false, reason: 'index state changed during publication', retryable: true, publishedSessionIds: [] }; });
    const { provider, captured } = fakeProvider(publish);
    provider.isIndexReady = () => ready;
    registerMobileCreateSessionHandler(provider as never, requestContext());
    await captured.session!({ requestId: 'disconnected', projectId: '/workspace' });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(provider.sendCreateSessionResponse).toHaveBeenCalledWith(expect.objectContaining({ success: false, sessionId: 'session-1' }));
  });

  it('refuses unverified success from a provider without server readback', async () => {
    const { provider, captured } = fakeProvider(vi.fn(async () => ({ published: true, publishedSessionIds: ['session-1'] })));
    delete (provider as Partial<typeof provider>).fetchIndex;
    registerMobileCreateSessionHandler(provider as never, requestContext());
    await captured.session!({ requestId: 'no-readback', projectId: '/workspace' });
    expect(provider.sendCreateSessionResponse).toHaveBeenCalledWith(expect.objectContaining({ success: false, sessionId: 'session-1' }));
  });

  it('republishes the row when the create-time metadata push overtakes it, instead of failing the phone', async () => {
    // SyncedSessionStore.create fires its own metadata publish for the new
    // session; when it lands during this batch's encryption the batch drops the
    // row as stale. The session exists and the phone must be told so.
    const syncSessionsToIndex = vi.fn()
      .mockResolvedValueOnce({ published: false, reason: 'index state changed during publication', retryable: true, publishedSessionIds: [] })
      .mockResolvedValueOnce({ published: true, publishedSessionIds: ['session-1'] });
    const { provider, captured } = fakeProvider(syncSessionsToIndex);
    registerMobileCreateSessionHandler(provider as never, requestContext());

    await captured.session!({ requestId: 'req-race', projectId: '/workspace', initialPrompt: 'Do work' });

    expect(syncSessionsToIndex).toHaveBeenCalledTimes(2);
    expect(provider.sendCreateSessionResponse).toHaveBeenCalledWith({ requestId: 'req-race', success: true, sessionId: 'session-1' });
    expect(mocks.queuePrompt).toHaveBeenCalledTimes(1);
  });

  it.each(['personal-sync writes withheld', 'index transport not connected; publish queued until reconnect'])('reports unpublished creation without running its prompt: %s', async reason => {
    const { provider, captured } = fakeProvider(async () => ({ published: false, reason, retryable: true, publishedSessionIds: [] }));
    registerMobileCreateSessionHandler(provider as never, requestContext());
    await captured.session!({ requestId: 'req-2', projectId: '/workspace', initialPrompt: 'Do work' });
    expect(provider.sendCreateSessionResponse).toHaveBeenCalledWith(expect.objectContaining({ success: false, sessionId: 'session-1', error: expect.stringContaining(reason) }));
    expect(mocks.queuePrompt).not.toHaveBeenCalled();
  });

  it.each([undefined, { published: true, publishedSessionIds: ['another-session'] }])('does not infer publication from a missing outcome or another row', async outcome => {
    const { provider, captured } = fakeProvider(async () => outcome);
    registerMobileCreateSessionHandler(provider as never, requestContext());
    await captured.session!({ requestId: 'req-invalid', projectId: '/workspace' });
    expect(provider.sendCreateSessionResponse).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
  });

  it.each(['unverified', 'blocked'])('rejects a known %s gate before creating local artifacts', async state => {
    const { provider, captured } = fakeProvider(vi.fn());
    provider.getPersonalSyncWriteGate.mockReturnValue({ state, reason: null, detail: null });
    registerMobileCreateSessionHandler(provider as never, requestContext());
    registerMobileCreateWorktreeHandler(provider as never, requestContext());
    await captured.session!({ requestId: 'preflight-session', projectId: '/workspace' });
    await captured.worktree!({ requestId: 'preflight-worktree', projectId: '/workspace' });
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.worktreeStore.create).not.toHaveBeenCalled();
    expect(provider.syncSessionsToIndex).not.toHaveBeenCalled();
    expect(provider.sendCreateSessionResponse).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
    expect(provider.sendCreateWorktreeResponse).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
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
    const syncSessionsToIndex = vi.fn(async (rows: Array<{ id: string }>) => {
      await publishing;
      return { published: true, publishedSessionIds: [rows[0].id] };
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

  it('reports a retryable unpublished worktree row as failure', async () => {
    const { provider, captured } = fakeProvider(async () => ({
      published: false,
      reason: 'personal-sync writes withheld',
      retryable: true,
      publishedSessionIds: [],
    }));
    registerMobileCreateWorktreeHandler(provider as never, requestContext());

    await captured.worktree!({ requestId: 'req-5', projectId: '/workspace' });

    const [response] = provider.sendCreateWorktreeResponse.mock.calls[0];
    expect(response).toMatchObject({ requestId: 'req-5', success: false, error: expect.stringContaining('withheld') });
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
