// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const mocks = vi.hoisted(() => {
  const provider = {
    resolveAskUserQuestion: vi.fn(() => true),
    rejectAskUserQuestion: vi.fn(),
    resolveExitPlanModeConfirmation: vi.fn(),
    resolveToolPermission: vi.fn(),
  };

  return {
    provider,
    deliverCodex: vi.fn(async () => ({ success: true, delivery: 'queued' })),
    getProvider: vi.fn(),
    getSession: vi.fn(),
    createMessage: vi.fn(),
    ipcListenerCount: vi.fn((_channel: string) => 0),
    ipcEmit: vi.fn(),
    onPromptResolved: vi.fn(),
    getDatabase: vi.fn(() => null),
    createWorktreeStore: vi.fn(),
    queue: undefined as any,
  };
});

vi.mock('../PromptAnswerReservation', () => ({ reservePromptAnswer: () => true }));

vi.mock('../codexQuestionDelivery', () => ({ deliverCodexQuestionAnswer: mocks.deliverCodex }));

vi.mock('electron', async () => ({
  app: (await import('../../../../../test-stubs/privateUserData')).testApp,
  ipcMain: {
    listenerCount: mocks.ipcListenerCount,
    emit: mocks.ipcEmit,
  },
  BrowserWindow: {
    getAllWindows: () => [],
  },
}));

vi.mock('@nimbalyst/runtime/ai/server', () => ({
  ProviderFactory: {
    getProvider: mocks.getProvider,
  },
  isAskUserQuestionProvider: (candidate: unknown) =>
    !!candidate &&
    typeof (candidate as { resolveAskUserQuestion?: unknown }).resolveAskUserQuestion === 'function',
  isExitPlanModeProvider: (candidate: unknown) =>
    !!candidate &&
    typeof (candidate as { resolveExitPlanModeConfirmation?: unknown }).resolveExitPlanModeConfirmation === 'function',
  isToolPermissionProvider: (candidate: unknown) =>
    !!candidate &&
    typeof (candidate as { resolveToolPermission?: unknown }).resolveToolPermission === 'function',
}));

vi.mock('@nimbalyst/runtime', () => ({
  AISessionsRepository: {
    get: mocks.getSession,
  },
  AgentMessagesRepository: {
    create: mocks.createMessage,
  },
}));

vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({ AISessionsRepository: { get: mocks.getSession } }));
vi.mock('../../RepositoryManager', () => ({ getQueuedPromptsStore: () => mocks.queue }));
vi.mock('../../TerminalSessionManager', () => ({ getTerminalSessionManager: vi.fn() }));

vi.mock('../../../utils/logger', () => ({
  logger: {
    main: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    ai: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  },
}));

vi.mock('../../../tray/TrayManager', () => ({
  TrayManager: {
    getInstance: () => ({
      onPromptResolved: mocks.onPromptResolved,
    }),
  },
}));

vi.mock('../../../mcp/tools/interactiveToolHandlers', () => ({
  getRequestUserInputResponseChannel: (sessionId: string, promptId: string) =>
    `request-user-input-response:${sessionId || 'unknown'}:${promptId}`,
  getRequestUserInputFallbackResponseChannel: (sessionId: string) =>
    `request-user-input-response:${sessionId || 'unknown'}:__fallback__`,
  getToolPermissionResponseChannel: (sessionId: string, requestId: string) =>
    `tool-permission-response:${sessionId || 'unknown'}:${requestId}`,
}));

vi.mock('../../gitEnv', () => ({
  getGitSubprocessEnv: vi.fn(() => ({})),
}));

vi.mock('../../../window/WindowManager', () => ({
  findWindowByWorkspace: vi.fn(),
}));

vi.mock('../../../database/initialize', () => ({
  getDatabase: mocks.getDatabase,
}));

vi.mock('../../WorktreeStore', () => ({
  createWorktreeStore: mocks.createWorktreeStore,
}));

import { initMobileSessionControlHandler, resolveExactVoicePromptResponse, resolveGitCommitWorkspacePath, resolveVoicePromptResponse } from '../MobileSessionControlHandler';
import { cancelSessionTurn } from '../ipc/registerTurnControlHandlers';
import { beginSessionTurn, isTurnAdmissionBlocked } from '../sessionTurnControl';
import { createPGLiteQueuedPromptsStore } from '../../PGLiteQueuedPromptsStore';
import { SQLiteDatabase } from '../../../database/sqlite/SQLiteDatabase';
import { publishQueuedPromptsToSync } from '../queuedPromptSyncPublisher';

describe('phone Stop retirement', () => {
  it('retains Stop for missing provider metadata until a new authorization, without leaking lookup ownership', async () => {
    const sessionId = 'phone-missing-provider';
    const { captureQueueAuthorization, isQueueStopped } = await import('../stoppedQueueHold');
    mocks.getSession.mockResolvedValue({ id: sessionId });
    mocks.getProvider.mockReset();
    let receive!: (message: any) => void;
    const sharedCancel = vi.fn();
    const dispose = initMobileSessionControlHandler({ onSessionControlMessage: (fn: any) => { receive = fn; return () => {}; } } as never,
      () => null, { cancelSessionTurn: sharedCancel, rollbackExecutingPrompts: vi.fn(async () => 0), triggerQueuedPromptProcessing: vi.fn() });
    try {
      receive({ type: 'cancel', sessionId });
      await vi.waitFor(() => expect(mocks.getSession).toHaveBeenCalledWith(sessionId));
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(isQueueStopped(sessionId)).toBe(true);
      expect(mocks.getProvider).not.toHaveBeenCalled();
      expect(sharedCancel).not.toHaveBeenCalled();
      captureQueueAuthorization(sessionId)();
      expect(isQueueStopped(sessionId)).toBe(false);
    } finally { dispose(); captureQueueAuthorization(sessionId)(); mocks.getSession.mockReset(); }
  });
  it.each([false, true])('retains Stop on unknown provider lookup failure and retires its lookup guard (previous hold: %s)', async previouslyStopped => {
    const sessionId = `phone-lookup-failure-${previouslyStopped}`;
    const { captureQueueAuthorization, holdQueueAfterStop, isQueueStopped } = await import('../stoppedQueueHold');
    const oldAuthorization = captureQueueAuthorization(sessionId);
    if (previouslyStopped) holdQueueAfterStop(sessionId);
    mocks.getSession.mockRejectedValue(new Error('repository temporarily unavailable'));
    const abort = vi.fn();
    mocks.getProvider.mockReturnValue({ abort });
    let receive!: (message: any) => void;
    const sharedCancel = vi.fn();
    const rollback = vi.fn(async () => 0);
    const dispose = initMobileSessionControlHandler({ onSessionControlMessage: (fn: any) => { receive = fn; return () => {}; } } as never,
      () => null, { cancelSessionTurn: sharedCancel, rollbackExecutingPrompts: rollback, triggerQueuedPromptProcessing: vi.fn() });
    try {
      receive({ type: 'cancel', sessionId });
      await vi.waitFor(() => expect(mocks.getSession).toHaveBeenCalledWith(sessionId));
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(isQueueStopped(sessionId)).toBe(true);
      oldAuthorization();
      expect(isQueueStopped(sessionId)).toBe(true);
      expect(mocks.getProvider).not.toHaveBeenCalled();
      expect(abort).not.toHaveBeenCalled();
      expect(rollback).not.toHaveBeenCalled();
      expect(sharedCancel).not.toHaveBeenCalled();
      captureQueueAuthorization(sessionId)();
      expect(isQueueStopped(sessionId)).toBe(false);
    } finally { dispose(); captureQueueAuthorization(sessionId)(); mocks.getSession.mockReset(); mocks.getProvider.mockReset(); }
  });
  it.each([false, true])('routes non-Codex phone Stop through the shared controller (previous hold: %s)', async previouslyStopped => {
    const sessionId = `phone-noncodex-${previouslyStopped}`;
    const { captureQueueAuthorization, holdQueueAfterStop, isQueueStopped } = await import('../stoppedQueueHold');
    if (previouslyStopped) holdQueueAfterStop(sessionId);
    mocks.getSession.mockResolvedValue({ id: sessionId, provider: 'claude-code' });
    const abort = vi.fn();
    mocks.getProvider.mockReturnValue({ abort });
    let receive!: (message: any) => void;
    const sharedCancel = vi.fn(async (_id: string, request?: { restorePreviousHold(): void }) => {
      request?.restorePreviousHold();
      return { success: true };
    });
    const dispose = initMobileSessionControlHandler({ onSessionControlMessage: (fn: any) => { receive = fn; return () => {}; } } as never,
      () => null, { cancelSessionTurn: sharedCancel, rollbackExecutingPrompts: vi.fn(async () => 0), triggerQueuedPromptProcessing: vi.fn() });
    try {
      receive({ type: 'cancel', sessionId });
      await vi.waitFor(() => expect(sharedCancel).toHaveBeenCalledExactlyOnceWith(sessionId, expect.objectContaining({ finishLookup: expect.any(Function) })));
      expect(isQueueStopped(sessionId)).toBe(previouslyStopped);
      expect(abort).not.toHaveBeenCalled();
    } finally { dispose(); captureQueueAuthorization(sessionId)(); mocks.getSession.mockReset(); mocks.getProvider.mockReset(); }
  });
  it('retires a non-Codex phone turn through abort, queue sweep, idle, and drive', async () => {
    const sessionId = 'phone-noncodex-controller';
    mocks.getSession.mockResolvedValue({ id: sessionId, provider: 'claude-code', workspacePath: '/ws' });
    const abort = vi.fn();
    mocks.getProvider.mockReturnValue({ abort });
    const sweep = vi.fn(async () => 0);
    mocks.queue = { sweepExecutingForSession: sweep };
    const idle = vi.fn(async () => {});
    const drive = vi.fn(async () => ({ kind: 'nothing-pending' as const }));
    const ctx = {
      analytics: { sendEvent: vi.fn() }, sessionsProcessingQueue: new Set<string>(),
      publishQueueStateToSync: vi.fn(async () => {}), forceSessionIdleOnCancel: idle,
      invalidateQueueDrive: vi.fn(), driveQueuedPrompts: drive,
    };
    let receive!: (message: any) => void;
    const sharedCancel = vi.fn((id: string, request?: any) => cancelSessionTurn(ctx as never, id, undefined, request));
    const dispose = initMobileSessionControlHandler({ onSessionControlMessage: (fn: any) => { receive = fn; return () => {}; } } as never,
      () => null, { cancelSessionTurn: sharedCancel, rollbackExecutingPrompts: vi.fn(async () => 0), triggerQueuedPromptProcessing: vi.fn() });
    try {
      receive({ type: 'cancel', sessionId });
      await vi.waitFor(() => expect(drive).toHaveBeenCalledExactlyOnceWith(sessionId, '/ws', 'renderer-trigger'));
      expect(sharedCancel).toHaveBeenCalledOnce();
      expect(abort).toHaveBeenCalledOnce();
      expect(sweep).toHaveBeenCalledOnce();
      expect(ctx.publishQueueStateToSync).toHaveBeenCalledExactlyOnceWith(sessionId);
      expect(idle).toHaveBeenCalledExactlyOnceWith(sessionId);
    } finally { dispose(); mocks.queue = undefined; mocks.getSession.mockReset(); mocks.getProvider.mockReset(); }
  });
  it('rolls back CLI executing rows before shared phone Stop sends Ctrl-C', async () => {
    const sessionId = 'phone-cli';
    const { getTerminalSessionManager } = await import('../../TerminalSessionManager');
    vi.mocked(getTerminalSessionManager).mockReturnValue({ isTerminalActive: () => true } as never);
    mocks.getSession.mockResolvedValue({ id: sessionId, provider: 'claude-code-cli' });
    const order: string[] = [];
    const rollback = vi.fn(async () => { order.push('rollback'); return 1; });
    const sharedCancel = vi.fn(async () => { order.push('cancel'); return { success: true }; });
    let receive!: (message: any) => void;
    const dispose = initMobileSessionControlHandler({ onSessionControlMessage: (fn: any) => { receive = fn; return () => {}; } } as never,
      () => null, { cancelSessionTurn: sharedCancel, rollbackExecutingPrompts: rollback, triggerQueuedPromptProcessing: vi.fn() });
    try {
      receive({ type: 'cancel', sessionId });
      await vi.waitFor(() => expect(sharedCancel).toHaveBeenCalledOnce());
      expect(order).toEqual(['rollback', 'cancel']);
      expect(rollback).toHaveBeenCalledExactlyOnceWith(sessionId);
    } finally {
      const { captureQueueAuthorization } = await import('../stoppedQueueHold');
      captureQueueAuthorization(sessionId)();
      dispose();
      mocks.getSession.mockReset();
      vi.mocked(getTerminalSessionManager).mockReset();
    }
  });
  it('writes Ctrl-C exactly once after one CLI rollback through the real shared controller', async () => {
    const sessionId = 'phone-cli-real-controller';
    const { getTerminalSessionManager } = await import('../../TerminalSessionManager');
    const order: string[] = [];
    const writeToTerminal = vi.fn((_id: string, _text: string) => { order.push('ctrl-c'); });
    vi.mocked(getTerminalSessionManager).mockReturnValue({
      isTerminalActive: vi.fn(() => true), writeToTerminal,
    } as never);
    mocks.getSession.mockResolvedValue({ id: sessionId, provider: 'claude-code-cli' });
    const rollback = vi.fn(async () => { order.push('rollback'); return 1; });
    const sharedCancel = vi.fn((id: string, request?: any) => cancelSessionTurn({
      analytics: { sendEvent: vi.fn() },
    } as never, id, undefined, request));
    let receive!: (message: any) => void;
    const dispose = initMobileSessionControlHandler({ onSessionControlMessage: (fn: any) => { receive = fn; return () => {}; } } as never,
      () => null, { cancelSessionTurn: sharedCancel, rollbackExecutingPrompts: rollback, triggerQueuedPromptProcessing: vi.fn() });
    try {
      receive({ type: 'cancel', sessionId });
      await vi.waitFor(() => expect(writeToTerminal).toHaveBeenCalledOnce());
      expect(rollback).toHaveBeenCalledExactlyOnceWith(sessionId);
      expect(sharedCancel).toHaveBeenCalledOnce();
      expect(writeToTerminal).toHaveBeenCalledExactlyOnceWith(sessionId, '\x03');
      expect(order).toEqual(['rollback', 'ctrl-c']);
    } finally {
      const { captureQueueAuthorization } = await import('../stoppedQueueHold');
      captureQueueAuthorization(sessionId)();
      dispose();
      mocks.getSession.mockReset();
      vi.mocked(getTerminalSessionManager).mockReset();
    }
  });
  it('retires a resolved native turn before admitting phone corrections and publishing idle', async () => {
    const { CodexAppServerProtocol } = await import('@nimbalyst/runtime/ai/server/protocols/CodexAppServerProtocol');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-phone-poststart-'));
    const db = new SQLiteDatabase({ dbDir: dir, schemaDir: path.resolve(__dirname, '../../../database/sqlite/schemas') });
    await db.initialize();
    const sessionId = 'phone-poststart';
    await db.query("INSERT INTO ai_sessions(id, provider, title) VALUES ($1, 'openai-codex', 'test')", [sessionId]);
    const queue = createPGLiteQueuedPromptsStore(db as never);
    mocks.queue = queue;
    await queue.create({ id: 'original-native', sessionId, prompt: 'Original already submitted' });
    await queue.claim('original-native');
    for (const [direction, content] of [['input', 'Original already submitted'], ['output', 'Task acknowledged; still working']]) {
      await db.query("INSERT INTO ai_agent_messages(session_id, source, direction, content, created_at) SELECT session_id, 'codex-app-server', $2, $3, claimed_at FROM queued_prompts WHERE id = $1",
        ['original-native', direction, content]);
    }
    await queue.create({ id: 'correction-one', sessionId, prompt: 'First correction' });
    const listeners = new Set<(method: string, params: any) => void>();
    const starts: string[] = [];
    const interrupted = vi.fn();
    const native = { id: 'phone-root', platform: 'codex-app-server', raw: {
      threadId: 'phone-root', options: {}, activeTurnId: null, cleanupStarted: false, child: {}, stderrTail: [],
      client: { onNotification: (fn: any) => { listeners.add(fn); return () => listeners.delete(fn); }, close: vi.fn(),
        request: vi.fn(async (method: string, params: any) => {
          if (method === 'turn/interrupt') { interrupted(params); return {}; }
          if (method !== 'turn/start') return {};
          starts.push(params.input[0].text);
          const id = starts.length === 1 ? 'old-native-turn' : `correction-${starts.length}`;
          if (starts.length > 1) queueMicrotask(() => terminal(id));
          return { turn: { id } };
        }),
      },
    } };
    const terminal = (id: string, threadId = 'phone-root') => {
      for (const fn of listeners) fn('turn/completed', { threadId, turn: { id, status: 'interrupted' } });
    };
    const protocol = new CodexAppServerProtocol({ terminateProcessTreeOverride: vi.fn() });
    const abort = new AbortController();
    const host = beginSessionTurn(sessionId);
    let releaseHost!: () => void;
    const cleanup = new Promise<void>(resolve => { releaseHost = resolve; });
    const old = (async () => {
      try { for await (const _event of protocol.sendMessage(native as never, { content: 'Original already submitted', abortSignal: abort.signal })) { /* drain */ } }
      finally { await cleanup; host.finish(); }
    })();
    const provider = { abort: vi.fn(() => abort.abort()), interruptCurrentTurn: vi.fn() };
    mocks.getSession.mockResolvedValue({ id: sessionId, provider: 'openai-codex', workspacePath: dir });
    mocks.getProvider.mockReturnValue(provider);
    const syncPush = vi.fn(async () => ({ published: true }));
    let status = 'running';
    const idle = vi.fn(async () => { status = 'idle'; });
    const guard = new Set([sessionId]);
    const publish = () => publishQueuedPromptsToSync({ listPending: id => queue.listPending(id),
      getSyncProvider: () => ({ pushChange: syncPush }) as never, logWarn: vi.fn() }, sessionId);
    const drive = vi.fn(async () => {
      const { isQueueStopped } = await import('../stoppedQueueHold');
      if (isQueueStopped(sessionId)) return { kind: 'deferred' as const, reason: 'session-busy' as const };
      for (;;) {
        const pending = (await queue.listPending(sessionId))[0];
        const claim = pending ? await queue.claim(pending.id) : null;
        if (!claim) return { kind: 'nothing-pending' as const };
        for await (const _event of protocol.sendMessage(native as never, { content: claim.prompt })) { /* drain */ }
        await queue.complete(claim.id);
      }
    });
    let stop!: Promise<any>;
    let receive!: (message: any) => void;
    const rollback = vi.fn();
    const dispose = initMobileSessionControlHandler({ onSessionControlMessage: (fn: any) => { receive = fn; return () => {}; } } as never,
      () => null, { cancelSessionTurn: (id, receipt) => (stop = cancelSessionTurn({ analytics: { sendEvent: vi.fn() }, sessionsProcessingQueue: guard,
        publishQueueStateToSync: publish, forceSessionIdleOnCancel: idle, invalidateQueueDrive: vi.fn(), driveQueuedPrompts: drive } as never, id, undefined, receipt)),
      rollbackExecutingPrompts: rollback, triggerQueuedPromptProcessing: vi.fn() });
    try {
      await vi.waitFor(() => expect(native.raw.activeTurnId).toBe('old-native-turn'));
      receive({ type: 'cancel', sessionId });
      await vi.waitFor(() => expect(provider.abort).toHaveBeenCalledOnce());
      expect(isTurnAdmissionBlocked(sessionId)).toBe(true);
      expect(status).toBe('running');
      expect(idle).not.toHaveBeenCalled();
      expect(rollback).not.toHaveBeenCalled();
      expect(interrupted).toHaveBeenCalledWith({ threadId: 'phone-root', turnId: 'old-native-turn' });
      await queue.create({ id: 'correction-two', sessionId, prompt: 'Second correction' });
      releaseHost();
      await old;
      expect((await stop).error).toContain('still queued');
      expect(status).toBe('idle');
      expect(guard.has(sessionId)).toBe(false);
      expect((await queue.get('original-native'))?.status).toBe('completed');
      expect((await queue.listPending(sessionId)).map(row => row.id)).toEqual(['correction-one', 'correction-two']);
      expect(syncPush).toHaveBeenLastCalledWith(sessionId, { type: 'metadata_updated', metadata: { queuedPrompts: expect.arrayContaining([
        expect.objectContaining({ id: 'correction-one' }), expect.objectContaining({ id: 'correction-two' }),
      ]) } });
      const { captureQueueAuthorization, isQueueStopped } = await import('../stoppedQueueHold');
      expect(isQueueStopped(sessionId)).toBe(true);
      captureQueueAuthorization(sessionId)();
      const delivered = drive();
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(starts).toEqual(['Original already submitted']);
      terminal('old-native-turn', 'foreign-thread');
      terminal('stale-turn');
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(starts).toHaveLength(1);
      terminal('old-native-turn');
      await delivered;
      await publish();
      expect(starts).toEqual(['Original already submitted', 'First correction', 'Second correction']);
      expect(await queue.listPending(sessionId)).toEqual([]);
      expect(syncPush).toHaveBeenLastCalledWith(sessionId, { type: 'metadata_updated', metadata: { queuedPrompts: [] } });
    } finally {
      dispose(); releaseHost(); abort.abort(); terminal('old-native-turn');
      await old; mocks.queue = undefined;
      await db.close(); fs.rmSync(dir, { recursive: true });
    }
  });
  it('delegates Stop to the shared turn controller instead of sweeping and aborting independently', async () => {
    let receive!: (message: any) => void;
    let finish!: (result: any) => void;
    const pending = new Promise<any>(resolve => { finish = resolve; });
    const cancelSessionTurn = vi.fn(() => pending);
    const rollbackExecutingPrompts = vi.fn();
    const abort = vi.fn();
    mocks.getSession.mockResolvedValue({ id: 'phone-stop', provider: 'openai-codex' });
    mocks.getProvider.mockReturnValue({ abort });
    initMobileSessionControlHandler({ onSessionControlMessage: (callback: any) => { receive = callback; return () => {}; } } as any,
      () => null, { cancelSessionTurn, rollbackExecutingPrompts, triggerQueuedPromptProcessing: vi.fn() });
    receive({ type: 'cancel', sessionId: 'phone-stop' });
    try {
      await vi.waitFor(() => expect(cancelSessionTurn).toHaveBeenCalledExactlyOnceWith('phone-stop', expect.objectContaining({ finishLookup: expect.any(Function) })));
      expect(rollbackExecutingPrompts).not.toHaveBeenCalled();
      expect(abort).not.toHaveBeenCalled();
    } finally { finish({ success: true }); }
  });
});

describe('MobileSessionControlHandler', () => {
  it('does not claim acceptance when neither persistence nor a provider or waiter accepts it', async () => {
    mocks.getSession.mockResolvedValue({ provider: 'claude-code' });
    mocks.getProvider.mockReturnValue(null);
    mocks.createMessage.mockRejectedValue(new Error('disk unavailable'));
    const result = await resolveExactVoicePromptResponse('session-1', { promptType: 'ask_user_question', promptId: 'missing', response: { answers: { Scope: 'A' } } });
    expect(result.success).toBe(false);
    expect(mocks.onPromptResolved).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.provider.resolveAskUserQuestion.mockReturnValue(true);
    mocks.ipcListenerCount.mockReturnValue(0);
    mocks.getSession.mockResolvedValue({ provider: 'openai-codex' });
    mocks.createMessage.mockResolvedValue(undefined);
    mocks.getProvider.mockImplementation((providerType: string, sessionId: string) =>
      providerType === 'openai-codex' && sessionId === 'session-1' ? mocks.provider : null,
    );
  });

  it('routes Codex answers through turn-owned delivery instead of provider or IPC listener guesses', async () => {
    resolveVoicePromptResponse('session-1', {
      promptType: 'ask_user_question', promptId: 'nimtc|exec-q|100|1',
      response: { answers: { Scope: 'Everything' }, cancelled: false },
    });
    await vi.waitFor(() => expect(mocks.deliverCodex).toHaveBeenCalledWith('session-1', 'nimtc|exec-q|100|1', {
      answers: { Scope: 'Everything' }, cancelled: false, respondedBy: 'mobile',
    }));
    expect(mocks.provider.resolveAskUserQuestion).not.toHaveBeenCalled();
    expect(mocks.ipcEmit).not.toHaveBeenCalled();
    expect(mocks.onPromptResolved).toHaveBeenCalledWith('session-1');
  });

  it('uses a native worktree path for mobile commit execution', () => {
    expect(resolveGitCommitWorkspacePath({
      workspacePath: 'D:/project',
      worktreeId: 'wt-1',
      worktreePath: 'D:/project_worktrees/task',
    })).toBe('D:/project_worktrees/task');
  });

  it('fails closed when a native worktree session has no worktree path', () => {
    expect(resolveGitCommitWorkspacePath({
      workspacePath: 'D:/project',
      worktreeId: 'wt-1',
    })).toBeNull();
  });

  it('fails closed when a worktree path lacks a native worktree identity', () => {
    expect(resolveGitCommitWorkspacePath({
      workspacePath: 'D:/project',
      worktreePath: 'D:/project_worktrees/task',
    })).toBeNull();
  });

  it('uses the session provider and always persists the mobile response', async () => {
    mocks.getSession.mockResolvedValue({ provider: 'claude-code' });
    mocks.getProvider.mockReturnValue(mocks.provider);
    resolveVoicePromptResponse('session-1', {
      promptType: 'ask_user_question',
      promptId: 'call_question_123',
      response: {
        answers: { Scope: 'Everything' },
        cancelled: false,
      },
    });

    await vi.waitFor(() => {
      expect(mocks.createMessage).toHaveBeenCalledTimes(1);
    });

    expect(mocks.getProvider).toHaveBeenCalledWith('claude-code', 'session-1');
    expect(mocks.provider.resolveAskUserQuestion).toHaveBeenCalledWith(
      'call_question_123',
      { Scope: 'Everything' },
      'session-1',
      'mobile',
    );
    expect(mocks.createMessage).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      source: 'claude-code',
      direction: 'output',
      content: expect.any(String),
    }));
    expect(JSON.parse(mocks.createMessage.mock.calls[0][0].content)).toMatchObject({
      type: 'ask_user_question_response',
      questionId: 'call_question_123',
      answers: { Scope: 'Everything' },
      cancelled: false,
      respondedBy: 'mobile',
    });
    expect(mocks.onPromptResolved).toHaveBeenCalledWith('session-1');
  });

  it('wakes the MCP waiter even when the provider consumes the response', async () => {
    mocks.getSession.mockResolvedValue({ provider: 'claude-code' });
    mocks.getProvider.mockReturnValue(mocks.provider);
    mocks.ipcListenerCount.mockImplementation((channel: string) =>
      channel === 'ask-user-question-response:session-1:call_question_123' ? 1 : 0,
    );

    resolveVoicePromptResponse('session-1', {
      promptType: 'ask_user_question',
      promptId: 'call_question_123',
      response: {
        answers: { Scope: 'Everything' },
        cancelled: false,
      },
    });

    await vi.waitFor(() => {
      expect(mocks.ipcEmit).toHaveBeenCalledWith(
        'ask-user-question-response:session-1:call_question_123',
        {},
        expect.objectContaining({
          answers: { Scope: 'Everything' },
          respondedBy: 'mobile',
          sessionId: 'session-1',
        }),
      );
    });
    expect(mocks.createMessage).toHaveBeenCalledTimes(1);
  });

  it('persists the response when no in-process provider is available', async () => {
    mocks.getSession.mockResolvedValue({ provider: 'claude-code' });
    mocks.getProvider.mockReturnValue(mocks.provider);
    mocks.getProvider.mockReturnValue(null);

    resolveVoicePromptResponse('session-1', {
      promptType: 'ask_user_question',
      promptId: 'call_question_123',
      response: {
        answers: { Scope: 'Everything' },
        cancelled: false,
      },
    });

    await vi.waitFor(() => {
      expect(mocks.createMessage).toHaveBeenCalledTimes(1);
    });

    expect(mocks.provider.resolveAskUserQuestion).not.toHaveBeenCalled();
    expect(JSON.parse(mocks.createMessage.mock.calls[0][0].content)).toMatchObject({
      questionId: 'call_question_123',
      answers: { Scope: 'Everything' },
      respondedBy: 'mobile',
    });
  });

  it('routes exit_plan_mode through the real provider capability', async () => {
    // ClaudeCodeProvider is currently the only production provider that
    // advertises ExitPlanMode confirmation support.
    mocks.getSession.mockResolvedValue({ provider: 'claude-code' });
    mocks.getProvider.mockImplementation((providerType: string, sessionId: string) =>
      providerType === 'claude-code' && sessionId === 'session-1' ? mocks.provider : null,
    );
    resolveVoicePromptResponse('session-1', {
      promptType: 'exit_plan_mode',
      promptId: 'call_plan_123',
      response: {
        approved: true,
        feedback: 'lgtm',
        startNewSession: true,
      },
    });

    await vi.waitFor(() => {
      expect(mocks.provider.resolveExitPlanModeConfirmation).toHaveBeenCalledTimes(1);
    });

    expect(mocks.getProvider).toHaveBeenCalledWith('claude-code', 'session-1');
    expect(mocks.provider.resolveExitPlanModeConfirmation).toHaveBeenCalledWith(
      'call_plan_123',
      { approved: true, clearContext: true, feedback: 'lgtm' },
      'session-1',
      'mobile',
    );
    expect(mocks.onPromptResolved).toHaveBeenCalledWith('session-1');
  });

  it('persists before waking provider and IPC consumers', async () => {
    mocks.getSession.mockResolvedValue({ provider: 'claude-code' });
    mocks.getProvider.mockReturnValue(mocks.provider);
    mocks.ipcListenerCount.mockImplementation((channel: string) =>
      channel === 'ask-user-question-response:session-1:call_ordered' ? 1 : 0,
    );

    resolveVoicePromptResponse('session-1', {
      promptType: 'ask_user_question',
      promptId: 'call_ordered',
      response: {
        answers: { Scope: 'Everything' },
        cancelled: false,
      },
    });

    await vi.waitFor(() => {
      expect(mocks.ipcEmit).toHaveBeenCalledTimes(1);
    });

    expect(mocks.createMessage.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.provider.resolveAskUserQuestion.mock.invocationCallOrder[0]);
    expect(mocks.createMessage.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.ipcEmit.mock.invocationCallOrder[0]);
  });

  it('continues notification cleanup when an IPC listener throws', async () => {
    mocks.getSession.mockResolvedValue({ provider: 'claude-code' });
    mocks.getProvider.mockReturnValue(mocks.provider);
    mocks.ipcListenerCount.mockReturnValue(1);
    mocks.ipcEmit.mockImplementationOnce(() => {
      throw new Error('stale listener');
    });

    resolveVoicePromptResponse('session-1', {
      promptType: 'ask_user_question',
      promptId: 'call_throwing_listener',
      response: {
        answers: { Scope: 'Everything' },
        cancelled: false,
      },
    });

    await vi.waitFor(() => {
      expect(mocks.onPromptResolved).toHaveBeenCalledWith('session-1');
    });
    expect(mocks.createMessage).toHaveBeenCalledTimes(1);
    expect(mocks.provider.resolveAskUserQuestion).toHaveBeenCalledTimes(1);
  });

  it('resolves tool_permission against the session provider (not hardcoded claude-code)', async () => {
    resolveVoicePromptResponse('session-1', {
      promptType: 'tool_permission',
      promptId: 'call_perm_123',
      response: {
        decision: 'allow',
        scope: 'once',
      },
    });

    await vi.waitFor(() => {
      expect(mocks.provider.resolveToolPermission).toHaveBeenCalledTimes(1);
    });

    expect(mocks.getProvider).toHaveBeenCalledWith('openai-codex', 'session-1');
    expect(mocks.getProvider).not.toHaveBeenCalledWith('claude-code', 'session-1');
    expect(mocks.provider.resolveToolPermission).toHaveBeenCalledWith(
      'call_perm_123',
      { decision: 'allow', scope: 'once' },
      'session-1',
      'mobile',
    );
    expect(mocks.onPromptResolved).toHaveBeenCalledWith('session-1');
  });

  it('resolves tool_permission against an opencode provider (provider-agnostic guard)', async () => {
    mocks.getSession.mockResolvedValue({ provider: 'opencode' });
    mocks.getProvider.mockImplementation((providerType: string, sessionId: string) =>
      providerType === 'opencode' && sessionId === 'session-1' ? mocks.provider : null,
    );

    resolveVoicePromptResponse('session-1', {
      promptType: 'tool_permission',
      promptId: 'call_perm_oc',
      response: {
        decision: 'allow',
        scope: 'session',
      },
    });

    await vi.waitFor(() => {
      expect(mocks.provider.resolveToolPermission).toHaveBeenCalledTimes(1);
    });

    expect(mocks.getProvider).toHaveBeenCalledWith('opencode', 'session-1');
    expect(mocks.getProvider).not.toHaveBeenCalledWith('claude-code', 'session-1');
    expect(mocks.provider.resolveToolPermission).toHaveBeenCalledWith(
      'call_perm_oc',
      { decision: 'allow', scope: 'session' },
      'session-1',
      'mobile',
    );
  });

  it('recovers ask_user_question on an opencode session via MCP + DB fallback (no in-process resolver)', async () => {
    // OpenCodeProvider extends BaseAgentProvider but does NOT implement
    // resolveAskUserQuestion — so this prompt must still be delivered by the
    // provider-agnostic MCP waiter + durable DB row, keyed to the real provider.
    const opencodeProvider = { resolveToolPermission: vi.fn() };
    mocks.getSession.mockResolvedValue({ provider: 'opencode' });
    mocks.getProvider.mockImplementation((providerType: string, sessionId: string) =>
      providerType === 'opencode' && sessionId === 'session-1' ? opencodeProvider : null,
    );
    mocks.ipcListenerCount.mockImplementation((channel: string) =>
      channel === 'ask-user-question-response:session-1:call_question_oc' ? 1 : 0,
    );

    resolveVoicePromptResponse('session-1', {
      promptType: 'ask_user_question',
      promptId: 'call_question_oc',
      response: {
        answers: { Scope: 'Everything' },
        cancelled: false,
      },
    });

    await vi.waitFor(() => {
      expect(mocks.createMessage).toHaveBeenCalledTimes(1);
    });

    // No in-process AskUserQuestion resolver on opencode, so the shared mock's
    // resolver is never touched.
    expect(mocks.provider.resolveAskUserQuestion).not.toHaveBeenCalled();
    // MCP waiter woken independently...
    expect(mocks.ipcEmit).toHaveBeenCalledWith(
      'ask-user-question-response:session-1:call_question_oc',
      {},
      expect.objectContaining({ answers: { Scope: 'Everything' }, respondedBy: 'mobile' }),
    );
    // ...and the durable row is persisted under the real provider.
    expect(mocks.createMessage).toHaveBeenCalledWith(expect.objectContaining({
      source: 'opencode',
    }));
  });

  it('preserves mobile attribution when cancelling a provider question', async () => {
    mocks.getSession.mockResolvedValue({ provider: 'claude-code' });
    mocks.getProvider.mockReturnValue(mocks.provider);
    resolveVoicePromptResponse('session-1', {
      promptType: 'ask_user_question',
      promptId: 'call_question_123',
      response: {
        answers: { ignored: 'value' },
        cancelled: true,
      },
    });

    await vi.waitFor(() => {
      expect(mocks.createMessage).toHaveBeenCalledTimes(1);
    });

    expect(mocks.provider.rejectAskUserQuestion).toHaveBeenCalledWith(
      'call_question_123',
      expect.any(Error),
      'mobile',
    );
    expect(JSON.parse(mocks.createMessage.mock.calls[0][0].content)).toMatchObject({
      type: 'ask_user_question_response',
      answers: {},
      cancelled: true,
      respondedBy: 'mobile',
    });
  });
});
