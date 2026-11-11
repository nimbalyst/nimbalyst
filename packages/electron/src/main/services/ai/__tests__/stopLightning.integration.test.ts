// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { handlers, getProvider, stateManager, storage, terminal } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  getProvider: vi.fn(),
  storage: { queue: undefined as any },
  terminal: { isTerminalActive: vi.fn(() => false), writeToTerminal: vi.fn() },
  stateManager: {
    state: { status: 'running', isStreaming: true },
    getSessionState() { return this.state; },
    interruptSession: vi.fn(async function () { stateManager.state = { status: 'idle', isStreaming: false }; }),
  },
}));
vi.mock('electron', async () => ({
  app: (await import('../../../../../test-stubs/privateUserData')).testApp,
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { on: vi.fn(), handle: vi.fn() },
}));
vi.mock('../../../utils/ipcRegistry', () => ({
  safeHandle: (channel: string, handler: (...args: any[]) => any) => handlers.set(channel, handler),
  safeOn: () => {}, safeOnce: () => {}, removeHandler: () => {}, removeAllListeners: () => {}, isHandlerRegistered: () => false,
}));
vi.mock('@nimbalyst/runtime/ai/server', () => ({
  AIProvider: class {}, GeminiAntigravityProvider: class {}, OpenAICodexProvider: class {},
  ModelRegistry: {}, ProviderFactory: { getProvider }, SessionManager: class {}, isAskUserQuestionProvider: () => false,
}));
vi.mock('@nimbalyst/runtime/ai/server/SessionStateManager', () => ({ getSessionStateManager: () => stateManager }));
vi.mock('../../../utils/logger', () => ({ logger: { main: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } }));
vi.mock('../../../utils/privateSettingsStore', () => ({ default: class {
  get(_key: string, fallback?: unknown) { return fallback; }
  set() {} onDidChange() { return () => {}; } onDidAnyChange() { return () => {}; }
} }));
vi.mock('../../../window/WindowManager', () => ({ getWindowId: () => undefined }));
vi.mock('../../TerminalSessionManager', () => ({ getTerminalSessionManager: () => terminal }));
vi.mock('../../../mcp/tools/backendToolHandler', () => ({ handleBackendTool: () => undefined }));
vi.mock('../../SyncManager', () => ({ getSyncProvider: () => null }));
vi.mock('../../RepositoryManager', () => ({ getQueuedPromptsStore: () => storage.queue }));
vi.mock('../sessionInboxService', () => ({ sessionInbox: { current: () => undefined, end: vi.fn(async () => {}) } }));
vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({
  AISessionsRepository: { get: vi.fn(async () => ({ provider: 'openai-codex', workspacePath: '/workspace' })), updateMetadata: vi.fn() },
}));
vi.mock('../../../tray/TrayManager', () => ({ TrayManager: { getInstance: () => ({ onPromptResolved: vi.fn() }) } }));

import { AIService } from '../AIService';
import { cancelSessionTurn, registerTurnControlHandlers } from '../ipc/registerTurnControlHandlers';
import { codexQuestionTurns } from '../codexQuestionTurns';
import { SessionProcessingGuard, tryClaimAndDispatchNextQueuedPrompt } from '../queuedPromptDispatcher';
import { beginSessionTurn } from '../sessionTurnControl';
import { captureQueueAuthorization, isQueueStopped } from '../stoppedQueueHold';
import { createPGLiteQueuedPromptsStore } from '../../PGLiteQueuedPromptsStore';
import { SQLiteDatabase } from '../../../database/sqlite/SQLiteDatabase';
import { beginCommitProposalCall, isCommitProposalInFlight, registerWaitingCommitProposal } from '@nimbalyst/runtime/ai/server/commitProposalInFlight';
import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { closeProposalForHumanSend } from '../orphanedCommitProposalRecovery';
import { QueueDriveService } from '../QueueDriveService';
import { runQueueDriveAttempt } from '../queueDriveAttempt';

describe('desktop Stop / lightning with durable queue and question ownership', () => {
  let database: SQLiteDatabase;
  let temporary: string;
  beforeEach(async () => {
    vi.clearAllMocks();
    terminal.isTerminalActive.mockReturnValue(false);
    vi.mocked(AISessionsRepository.get).mockResolvedValue({ provider: 'openai-codex', workspacePath: '/workspace' } as any);
    stateManager.state = { status: 'running', isStreaming: true };
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-stop-lightning-'));
    database = new SQLiteDatabase({ dbDir: temporary, schemaDir: path.resolve(__dirname, '../../../database/sqlite/schemas') });
    await database.initialize();
    database.getRawHandle()!.prepare('INSERT INTO ai_sessions(id, provider, title) VALUES (?, ?, ?)').run('s1', 'openai-codex', 'test');
    storage.queue = createPGLiteQueuedPromptsStore(database as never);
  });
  afterEach(async () => {
    captureQueueAuthorization('s1')();
    await codexQuestionTurns.end(codexQuestionTurns.current('s1'));
    await database?.close();
    if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
  });

  it('keeps an explicitly stopped pending queue idle until a human Send Now', async () => {
    const id = 's1';
    const text = 'Retain this queued original exactly once.';
    await storage.queue.create({ id: 'portable-row', sessionId: id, prompt: text });
    const provider = { abort: vi.fn(), interruptCurrentTurn: vi.fn(async () => ({ method: 'interrupt' as const })) };
    getProvider.mockReturnValue(provider);
    const guard = new SessionProcessingGuard();
    const service = Object.assign(Object.create(AIService.prototype), {
      sessionsProcessingQueue: guard, publishQueueStateToSync: vi.fn(async () => {}),
      driveQueuedPrompts: vi.fn(async () => ({ kind: 'nothing-pending' })),
    });
    registerTurnControlHandlers({
      analytics: { sendEvent: vi.fn() }, sessionsProcessingQueue: guard,
      publishQueueStateToSync: service.publishQueueStateToSync,
      forceSessionIdleOnCancel: (key: string) => service.forceSessionIdleOnCancel(key),
      interruptCurrentTurn: (key: string, options?: { userSendNow?: boolean }) => service.interruptCurrentTurn(key, options),
      driveQueuedPrompts: service.driveQueuedPrompts,
      invalidateQueueDrive: (key: string) => service.invalidateQueueDrive(key),
    } as any);
    const delivered: string[] = [];
    const options = {
      queueStore: storage.queue, processingSet: guard,
      sendMessageHandler: vi.fn(async (_event, prompt: string) => { delivered.push(prompt); return { content: 'ok' }; }),
      continueQueuedPromptChain: vi.fn(async () => {}), logError: vi.fn(), logInfo: vi.fn(), onPromptClaimed: vi.fn(),
      startSession: vi.fn(async () => {}), sessionId: id, workspacePath: '/workspace', source: 'automatic-after-stop',
      targetWindow: { isDestroyed: () => false, webContents: { mainFrame: {} } } as any,
    };
    const stopped = await handlers.get('ai:cancelRequest')!({}, id);
    const automatic = await tryClaimAndDispatchNextQueuedPrompt(options);
    const stateAfterStop = (await storage.queue.get('portable-row'))?.status;
    await handlers.get('ai:interruptCurrentTurn')!({}, id);
    await tryClaimAndDispatchNextQueuedPrompt(options);
    await vi.waitFor(async () => expect((await storage.queue.get('portable-row'))?.status).toBe('completed'));
    expect(stopped).toMatchObject({ success: true });
    expect(automatic).toBe(false);
    expect(stateAfterStop).toBe('pending');
    expect(delivered).toEqual([text]);
  });

  it('withdraws a waiting commit proposal when Stop retires its turn', async () => {
    await storage.queue.create({ id: 'after-proposal', sessionId: 's1', prompt: 'Keep this input' });
    const provider = { abort: vi.fn(), interruptCurrentTurn: vi.fn(async () => ({ method: 'interrupt' as const })) };
    getProvider.mockReturnValue(provider);
    const endCommit = beginCommitProposalCall('s1');
    const close = vi.fn(async () => { endCommit(); return true; });
    const unregister = registerWaitingCommitProposal('s1', close);
    const service = Object.assign(Object.create(AIService.prototype), {
      sessionsProcessingQueue: new SessionProcessingGuard(),
      publishQueueStateToSync: vi.fn(async () => {}),
      driveQueuedPrompts: vi.fn(async () => ({ kind: 'nothing-pending' })),
    });
    registerTurnControlHandlers({
      analytics: { sendEvent: vi.fn() }, sessionsProcessingQueue: service.sessionsProcessingQueue,
      publishQueueStateToSync: service.publishQueueStateToSync,
      forceSessionIdleOnCancel: (id: string) => service.forceSessionIdleOnCancel(id),
      driveQueuedPrompts: service.driveQueuedPrompts,
      invalidateQueueDrive: vi.fn(),
    } as any);
    try {
      await handlers.get('ai:cancelRequest')!({}, 's1');
      expect(close).toHaveBeenCalledOnce();
      expect(isCommitProposalInFlight('s1')).toBe(false);
      expect((await storage.queue.get('after-proposal'))?.status).toBe('pending');
    } finally { unregister(); endCommit(); }
  });

  it('settles Stop and sweeps its queue while a proposal close is still pending', async () => {
    getProvider.mockReturnValue({ abort: vi.fn() });
    const endCommit = beginCommitProposalCall('s1');
    let releaseClose!: () => void;
    const closeReady = new Promise<void>(resolve => { releaseClose = resolve; });
    const close = vi.fn(async () => { await closeReady; endCommit(); return true; });
    const unregister = registerWaitingCommitProposal('s1', close);
    const ctx = {
      analytics: { sendEvent: vi.fn() }, sessionsProcessingQueue: new SessionProcessingGuard(),
      publishQueueStateToSync: vi.fn(async () => {}), forceSessionIdleOnCancel: vi.fn(async () => {}),
      driveQueuedPrompts: vi.fn(async () => ({ kind: 'nothing-pending' })), invalidateQueueDrive: vi.fn(),
    };
    const response = cancelSessionTurn(ctx as never, 's1');
    try {
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(ctx.forceSessionIdleOnCancel).toHaveBeenCalledOnce());
      expect(await response).toMatchObject({ success: true, warning: expect.stringMatching(/commit proposal/i) });
      releaseClose();
      await vi.waitFor(() => expect(isCommitProposalInFlight('s1')).toBe(false));
    } finally { releaseClose(); await response; unregister(); endCommit(); }
  });

  it('reports a successful Stop with a warning when proposal close fails', async () => {
    getProvider.mockReturnValue({ abort: vi.fn() });
    const close = vi.fn(async () => { throw new Error('proposal storage unavailable'); });
    const unregister = registerWaitingCommitProposal('s1', close);
    const ctx = {
      analytics: { sendEvent: vi.fn() }, sessionsProcessingQueue: new SessionProcessingGuard(),
      publishQueueStateToSync: vi.fn(async () => {}), forceSessionIdleOnCancel: vi.fn(async () => {}),
      driveQueuedPrompts: vi.fn(async () => ({ kind: 'nothing-pending' })), invalidateQueueDrive: vi.fn(),
    };
    try {
      const response = await cancelSessionTurn(ctx as never, 's1');
      expect(close).toHaveBeenCalledOnce();
      expect(response).toMatchObject({ success: true, warning: expect.stringMatching(/commit proposal/i) });
    } finally { unregister(); }
  });

  it('sweeps and publishes executing rows when proposal close never resolves', async () => {
    await storage.queue.create({ id: 'executing-before-stop', sessionId: 's1', prompt: 'Keep this input' });
    await storage.queue.claim('executing-before-stop');
    getProvider.mockReturnValue({ abort: vi.fn() });
    const unregister = registerWaitingCommitProposal('s1', () => new Promise<boolean>(() => {}));
    const ctx = {
      analytics: { sendEvent: vi.fn() }, sessionsProcessingQueue: new SessionProcessingGuard(),
      publishQueueStateToSync: vi.fn(async () => {}), forceSessionIdleOnCancel: vi.fn(async () => {}),
      driveQueuedPrompts: vi.fn(async () => ({ kind: 'nothing-pending' })), invalidateQueueDrive: vi.fn(),
    };
    try {
      const response = cancelSessionTurn(ctx as never, 's1');
      await vi.waitFor(async () => expect((await storage.queue.get('executing-before-stop'))?.status).toBe('pending'));
      expect(ctx.publishQueueStateToSync).toHaveBeenCalledExactlyOnceWith('s1');
      expect(await response).toMatchObject({ success: true });
    } finally { unregister(); }
  });

  it('preserves a provider abort failure when proposal close also fails', async () => {
    getProvider.mockReturnValue({ abort: vi.fn(() => { throw new Error('abort refused'); }) });
    const unregister = registerWaitingCommitProposal('s1', async () => { throw new Error('close failed'); });
    const ctx = {
      analytics: { sendEvent: vi.fn() }, sessionsProcessingQueue: new SessionProcessingGuard(),
      publishQueueStateToSync: vi.fn(async () => {}), forceSessionIdleOnCancel: vi.fn(async () => {}),
      driveQueuedPrompts: vi.fn(async () => ({ kind: 'nothing-pending' })), invalidateQueueDrive: vi.fn(),
    };
    try {
      expect(await cancelSessionTurn(ctx as never, 's1')).toMatchObject({ success: false, error: 'abort refused' });
    } finally { unregister(); }
  });

  it('reports CLI Stop success promptly when proposal close never resolves', async () => {
    vi.mocked(AISessionsRepository.get).mockResolvedValue({ provider: 'claude-code-cli', workspacePath: '/workspace' } as any);
    terminal.isTerminalActive.mockReturnValue(true);
    const unregister = registerWaitingCommitProposal('s1', () => new Promise<boolean>(() => {}));
    const ctx = { analytics: { sendEvent: vi.fn() } };
    try {
      const result = cancelSessionTurn(ctx as never, 's1');
      await vi.waitFor(() => expect(terminal.writeToTerminal).toHaveBeenCalledWith('s1', '\x03'));
      await expect(result).resolves.toMatchObject({ success: true, warning: expect.stringMatching(/commit proposal/i) });
    } finally { unregister(); }
  });

  it('delivers older and newer queued rows once and in order after an idle proposal marker is reaped', async () => {
    stateManager.state = { status: 'idle', isStreaming: false };
    await storage.queue.create({ id: 'a-older', sessionId: 's1', prompt: 'older input' });
    await storage.queue.create({ id: 'z-newer', sessionId: 's1', prompt: 'newer input' });
    const endCommit = beginCommitProposalCall('s1');
    const delivered: string[] = [];
    const targetWindow = { isDestroyed: () => false, webContents: { mainFrame: {} } } as any;
    const guard = new SessionProcessingGuard();
    const driver = new QueueDriveService({
      attempt: ({ sessionId, workspacePath, reason, signal }) => runQueueDriveAttempt({
        listPendingIds: async id => (await storage.queue.listPending(id)).map((row: any) => row.id),
        isChainActive: () => false, isSessionBusy: () => false, isCommitProposalInFlight,
        resolveWindow: async () => ({ kind: 'window', window: targetWindow, opened: false }),
        failAllPending: async () => 0,
        dispatch: async () => tryClaimAndDispatchNextQueuedPrompt({
          queueStore: storage.queue, processingSet: guard,
          sendMessageHandler: vi.fn(async (_event, prompt: string) => { delivered.push(prompt); return { content: 'ok' }; }),
          continueQueuedPromptChain: vi.fn(async () => {}), logError: vi.fn(), logInfo: vi.fn(), onPromptClaimed: vi.fn(),
          startSession: vi.fn(async () => {}), sessionId, workspacePath, source: reason, targetWindow,
        }),
        logWarn: vi.fn(),
      }, { sessionId, workspacePath, reason, signal }),
      onWindowAvailable: () => () => {}, onSessionIdle: () => () => {},
      logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn(),
    });
    try {
      await closeProposalForHumanSend('s1', async () => 0, vi.fn());
      expect(isCommitProposalInFlight('s1')).toBe(false);
      await driver.drive('s1', '/workspace', 'send-now');
      await vi.waitFor(async () => expect((await storage.queue.get('a-older'))?.status).toBe('completed'));
      await driver.drive('s1', '/workspace', 'send-now');
      await vi.waitFor(async () => expect((await storage.queue.get('z-newer'))?.status).toBe('completed'));
      await driver.drive('s1', '/workspace', 'send-now');
      expect(delivered).toEqual(['older input', 'newer input']);
      expect((await storage.queue.get('a-older'))?.status).toBe('completed');
      expect((await storage.queue.get('z-newer'))?.status).toBe('completed');
    } finally { driver.dispose(); endCommit(); }
  });

  it.each([
    ['stop', 'running'], ['lightning', 'running'],
    ['stop', 'waiting_for_input'], ['lightning', 'waiting_for_input'],
  ] as const)('%s waits for the captured %s turn before exactly one successor', async (action, status) => {
    stateManager.state = { status, isStreaming: status === 'running' };
    const text = 'Keep this original text\n  with spacing exactly once.';
    await storage.queue.create({ id: 'old', sessionId: 's1', prompt: 'previous input' });
    await storage.queue.claim('old');
    await database.query("INSERT INTO ai_agent_messages(session_id, source, direction, content, created_at) VALUES ($1, 'test', 'input', 'previous input', $2)", ['s1', new Date(Date.now() + 1000).toISOString()]);
    await storage.queue.create({ id: 'next', sessionId: 's1', prompt: text });
    const old = codexQuestionTurns.begin('s1');
    const oldHost = beginSessionTurn('s1');
    const abandon = vi.fn();
    codexQuestionTurns.register(old, 'question', { questions: [{ question: 'Continue?' }] }, { answer: vi.fn(), abandon });
    let observeAbort!: () => void;
    const aborted = new Promise<void>(resolve => { observeAbort = resolve; });
    const provider = {
      abort: vi.fn(observeAbort),
      interruptCurrentTurn: vi.fn(async () => { observeAbort(); return { method: 'abort' as const }; }),
    };
    getProvider.mockReturnValue(provider);
    const processingSet = new SessionProcessingGuard();
    processingSet.acquire('s1');
    const service = Object.assign(Object.create(AIService.prototype), {
      sessionsProcessingQueue: processingSet,
      publishQueueStateToSync: vi.fn(async () => {}),
      driveQueuedPrompts: vi.fn(async () => ({ kind: 'nothing-pending' })),
    });
    registerTurnControlHandlers({
      analytics: { sendEvent: vi.fn() }, sessionsProcessingQueue: processingSet,
      publishQueueStateToSync: service.publishQueueStateToSync,
      forceSessionIdleOnCancel: (id: string) => service.forceSessionIdleOnCancel(id),
      interruptCurrentTurn: (id: string, options?: { userSendNow?: boolean }) => service.interruptCurrentTurn(id, options),
      driveQueuedPrompts: service.driveQueuedPrompts,
      invalidateQueueDrive: (id: string) => service.invalidateQueueDrive(id),
    } as any);
    const delivered: string[] = [];
    let successor: ReturnType<typeof codexQuestionTurns.begin> | undefined;
    const sendMessageHandler = vi.fn(async (_event, prompt: string) => {
      successor = codexQuestionTurns.begin('s1');
      delivered.push(prompt);
      // The cancelled generator's late finally must not retire its successor.
      await codexQuestionTurns.end(old);
      expect(successor.active).toBe(true);
      await codexQuestionTurns.end(successor);
      return { content: 'ok' };
    });
    const options = {
      queueStore: storage.queue, processingSet, sendMessageHandler,
      continueQueuedPromptChain: vi.fn(async () => {}), logError: vi.fn(), logInfo: vi.fn(), onPromptClaimed: vi.fn(),
      startSession: vi.fn(async () => {}), sessionId: 's1', workspacePath: '/workspace', source: action,
      targetWindow: { isDestroyed: () => false, webContents: { mainFrame: {} } } as any,
    };
    let controlFinished = false;
    const control = handlers.get(action === 'stop' ? 'ai:cancelRequest' : 'ai:interruptCurrentTurn')!({}, 's1').then((result: any) => { controlFinished = true; return result; });
    await aborted;
    await new Promise<void>(resolve => setImmediate(resolve));
    // An interrupt acknowledgement is not host retirement. Simulate the
    // old provider stream taking time to unwind, including its old finally.
    const finishedBeforeRetirement = controlFinished;
    const admittedBeforeRetirement = await tryClaimAndDispatchNextQueuedPrompt(options);
    await new Promise<void>(resolve => setImmediate(resolve));
    const successorBeforeRetirement = await storage.queue.get('next');
    await codexQuestionTurns.end(old);
    oldHost.finish();
    const result = await control;
    expect(successorBeforeRetirement?.status).toBe('pending');
    expect(successorBeforeRetirement?.prompt).toBe(text);
    expect(finishedBeforeRetirement).toBe(false);
    expect(admittedBeforeRetirement).toBe(false);
    expect(result).toMatchObject({ success: true });
    expect(old.active).toBe(false);
    expect((await storage.queue.get('old'))?.status).toBe('failed');
    expect(abandon).toHaveBeenCalledTimes(1);
    if (action === 'stop') {
      expect(isQueueStopped('s1')).toBe(true);
      expect(await tryClaimAndDispatchNextQueuedPrompt(options)).toBe(false);
      expect((await storage.queue.get('next'))?.status).toBe('pending');
      expect(delivered).toEqual([]);
      await handlers.get('ai:interruptCurrentTurn')!({}, 's1');
      expect(isQueueStopped('s1')).toBe(false);
    }
    const competing = await Promise.all([tryClaimAndDispatchNextQueuedPrompt(options), tryClaimAndDispatchNextQueuedPrompt(options)]);
    expect(competing.filter(Boolean)).toHaveLength(1);
    await vi.waitFor(async () => expect((await storage.queue.get('next'))?.status).toBe('completed'));
    expect(delivered).toEqual([text]);
    expect(sendMessageHandler).toHaveBeenCalledTimes(1);
    expect(options.logError).not.toHaveBeenCalled();
    expect(await tryClaimAndDispatchNextQueuedPrompt(options)).toBe(false);
    expect(abandon).toHaveBeenCalledTimes(1);
    expect(stateManager.state.status).toBe('idle');
  });
  it.each(['stop', 'lightning'] as const)('%s recovers orphaned waiting state and delivers the durable original once', async action => {
    stateManager.state = { status: 'waiting_for_input', isStreaming: false };
    const text = 'Orphan recovery\n  original text stays exact.';
    await storage.queue.create({ id: 'orphan-next', sessionId: 's1', prompt: text });
    const question = codexQuestionTurns.begin('s1');
    const abandon = vi.fn();
    codexQuestionTurns.register(question, 'orphan-question', {}, { abandon, answer: vi.fn() });
    const provider = { abort: vi.fn(), interruptCurrentTurn: vi.fn(async () => ({ method: 'interrupt' as const })) };
    getProvider.mockReturnValue(provider);
    const guard = new SessionProcessingGuard();
    guard.acquire('s1');
    const delivered: string[] = [];
    const options = {
      queueStore: storage.queue, processingSet: guard,
      sendMessageHandler: vi.fn(async (_event, prompt: string) => {
        const nextQuestion = codexQuestionTurns.begin('s1');
        delivered.push(prompt);
        await codexQuestionTurns.end(question);
        expect(nextQuestion.active).toBe(true);
        await codexQuestionTurns.end(nextQuestion);
        return { content: 'ok' };
      }),
      continueQueuedPromptChain: vi.fn(async () => {}), logError: vi.fn(), logInfo: vi.fn(), onPromptClaimed: vi.fn(),
      startSession: vi.fn(async () => {}), sessionId: 's1', workspacePath: '/workspace', source: action,
      targetWindow: { isDestroyed: () => false, webContents: { mainFrame: {} } } as any,
    };
    const drive = vi.fn(async () => {
      const claims = await Promise.all([tryClaimAndDispatchNextQueuedPrompt(options), tryClaimAndDispatchNextQueuedPrompt(options)]);
      return { kind: claims.some(Boolean) ? 'dispatched' : 'nothing-pending' };
    });
    const service = Object.assign(Object.create(AIService.prototype), {
      sessionsProcessingQueue: guard, publishQueueStateToSync: vi.fn(async () => {}), driveQueuedPrompts: drive,
    });
    registerTurnControlHandlers({
      analytics: { sendEvent: vi.fn() }, sessionsProcessingQueue: guard,
      publishQueueStateToSync: service.publishQueueStateToSync,
      forceSessionIdleOnCancel: (id: string) => service.forceSessionIdleOnCancel(id),
      interruptCurrentTurn: (id: string, options?: { userSendNow?: boolean }) => service.interruptCurrentTurn(id, options), driveQueuedPrompts: drive,
      invalidateQueueDrive: (id: string) => service.invalidateQueueDrive(id),
    } as any);
    const result = await handlers.get(action === 'stop' ? 'ai:cancelRequest' : 'ai:interruptCurrentTurn')!({}, 's1');
    expect(result).toMatchObject({ success: true });
    expect(provider.abort).toHaveBeenCalledOnce();
    expect(provider.interruptCurrentTurn).not.toHaveBeenCalled();
    if (action === 'stop') {
      expect(isQueueStopped('s1')).toBe(true);
      expect((await storage.queue.get('orphan-next'))?.status).toBe('pending');
      expect(delivered).toEqual([]);
      await handlers.get('ai:interruptCurrentTurn')!({}, 's1');
      expect(isQueueStopped('s1')).toBe(false);
    }
    await vi.waitFor(async () => expect((await storage.queue.get('orphan-next'))?.status).toBe('completed'));
    expect(delivered).toEqual([text]);
    expect(drive).toHaveBeenCalledTimes(action === 'stop' ? 2 : 1);
    expect(abandon).toHaveBeenCalledOnce();
    expect(stateManager.state.status).toBe('idle');
    expect(await tryClaimAndDispatchNextQueuedPrompt(options)).toBe(false);
  });

  it.each(['user-first', 'meta-first', 'replay', 'newer-stop'] as const)('user Send Now closes a waiting commit proposal and sends queued text once after the old turn retires (%s)', async order => {
    const text = 'Send this queued correction\n  exactly once after retirement.';
    await storage.queue.create({ id: 'commit-next', sessionId: 's1', prompt: text });
    const old = codexQuestionTurns.begin('s1');
    const host = beginSessionTurn('s1');
    const guard = new SessionProcessingGuard();
    guard.acquire('s1');
    const provider = { abort: vi.fn(), interruptCurrentTurn: vi.fn(async () => ({ method: 'interrupt' as const })) };
    getProvider.mockReturnValue(provider);
    const delivered: string[] = [];
    const options = {
      queueStore: storage.queue, processingSet: guard,
      sendMessageHandler: vi.fn(async (_event, prompt: string) => {
        expect(old.active).toBe(false);
        delivered.push(prompt);
        return { content: 'ok' };
      }),
      continueQueuedPromptChain: vi.fn(async () => {}), logError: vi.fn(), logInfo: vi.fn(), onPromptClaimed: vi.fn(),
      startSession: vi.fn(async () => {}), sessionId: 's1', workspacePath: '/workspace', source: 'lightning',
      targetWindow: { isDestroyed: () => false, webContents: { mainFrame: {} } } as any,
    };
    const drive = vi.fn(async () => ({
      kind: await tryClaimAndDispatchNextQueuedPrompt(options) ? 'dispatched' : 'nothing-pending',
    }));
    const service = Object.assign(Object.create(AIService.prototype), {
      sessionsProcessingQueue: guard, publishQueueStateToSync: vi.fn(async () => {}), driveQueuedPrompts: drive,
    });
    registerTurnControlHandlers({
      analytics: { sendEvent: vi.fn() }, sessionsProcessingQueue: guard,
      publishQueueStateToSync: service.publishQueueStateToSync,
      forceSessionIdleOnCancel: (id: string) => service.forceSessionIdleOnCancel(id),
      interruptCurrentTurn: (id: string, interruptOptions?: { userSendNow?: boolean }) => service.interruptCurrentTurn(id, interruptOptions),
      driveQueuedPrompts: drive, invalidateQueueDrive: (id: string) => service.invalidateQueueDrive(id),
    } as any);
    const endCommit = beginCommitProposalCall('s1');
    let withdraw = () => {};
    const close = vi.fn(async () => {
      withdraw();
      // The real tool handler settles its call after closing the proposal.
      setImmediate(endCommit);
      return true;
    });
    withdraw = registerWaitingCommitProposal('s1', close);
    let endReplay = () => {};
    let withdrawReplay = () => {};
    const closeReplay = vi.fn(async () => {
      withdrawReplay();
      setImmediate(endReplay);
      return true;
    });
    const listPending = storage.queue.listPending.bind(storage.queue);
    const interruptEntry = vi.spyOn(service, 'interruptCurrentTurn');
    const pendingSpy = vi.spyOn(storage.queue, 'listPending');
    let replayInstalled = false;
    pendingSpy.mockImplementation(async (...args: unknown[]) => {
      const rows = await listPending(...args);
      // A second waiting proposal arrives at the replay's asynchronous read.
      if (order === 'replay' && !replayInstalled) {
        replayInstalled = true;
        endReplay = beginCommitProposalCall('s1');
        withdrawReplay = registerWaitingCommitProposal('s1', closeReplay);
      }
      return rows;
    });
    try {
      const meta = order === 'meta-first' ? service.interruptCurrentTurn('s1') : undefined;
      expect(close).not.toHaveBeenCalled();
      const result = await handlers.get('ai:interruptCurrentTurn')!({}, 's1');
      if (order === 'newer-stop') {
        const stop = handlers.get('ai:cancelRequest')!({}, 's1');
        try {
          await vi.waitFor(() => expect(provider.abort).toHaveBeenCalledOnce());
          await vi.waitFor(() => expect(interruptEntry).toHaveBeenCalledTimes(2));
          expect(isQueueStopped('s1')).toBe(true);
          expect(delivered).toEqual([]);
        } finally { host.finish(); await stop; }
        await vi.waitFor(() => expect(service.interruptRequests?.size ?? 0).toBe(0));
        expect((await storage.queue.get('commit-next'))?.status).toBe('pending');
        await handlers.get('ai:interruptCurrentTurn')!({}, 's1');
        await vi.waitFor(async () => expect((await storage.queue.get('commit-next'))?.status).toBe('completed'));
        expect(delivered).toEqual([text]);
        expect(options.sendMessageHandler).toHaveBeenCalledOnce();
        return;
      }
      if (meta) await meta;
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
      expect(result).toMatchObject({ success: false, deferred: 'commit-in-flight' });
      if (order === 'replay') await vi.waitFor(() => expect(closeReplay).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(provider.interruptCurrentTurn).toHaveBeenCalledOnce());
      expect(delivered).toEqual([]);
      expect(await storage.queue.get('commit-next')).toMatchObject({ status: 'pending', prompt: text });
      expect(await tryClaimAndDispatchNextQueuedPrompt(options)).toBe(false);

      // A second press while the first retires must share that operation.
      const second = handlers.get('ai:interruptCurrentTurn')!({}, 's1');
      host.finish();
      expect(await second).toMatchObject({ success: true });
      await vi.waitFor(async () => expect((await storage.queue.get('commit-next'))?.status).toBe('completed'));
      expect(close).toHaveBeenCalledOnce();
      expect(provider.interruptCurrentTurn).toHaveBeenCalledOnce();
      expect(delivered).toEqual([text]);
      expect(options.sendMessageHandler).toHaveBeenCalledOnce();
      expect(options.logError).not.toHaveBeenCalled();
      expect(await tryClaimAndDispatchNextQueuedPrompt(options)).toBe(false);
    } finally {
      withdrawReplay();
      endReplay();
      withdraw();
      endCommit();
      host.finish();
      await new Promise<void>(resolve => setImmediate(resolve));
      await new Promise<void>(resolve => setImmediate(resolve));
      await vi.waitFor(() => expect(service.interruptRequests?.size ?? 0).toBe(0));
      pendingSpy.mockRestore();
    }
  });

});
