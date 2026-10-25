// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { handlers, getProvider, stateManager, storage } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  getProvider: vi.fn(),
  storage: { queue: undefined as any },
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
vi.mock('../../TerminalSessionManager', () => ({ getTerminalSessionManager: () => undefined }));
vi.mock('../../../mcp/tools/backendToolHandler', () => ({ handleBackendTool: () => undefined }));
vi.mock('../../SyncManager', () => ({ getSyncProvider: () => null }));
vi.mock('../../RepositoryManager', () => ({ getQueuedPromptsStore: () => storage.queue }));
vi.mock('../sessionInboxService', () => ({ sessionInbox: { current: () => undefined, end: vi.fn(async () => {}) } }));
vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({
  AISessionsRepository: { get: vi.fn(async () => ({ provider: 'openai-codex', workspacePath: '/workspace' })), updateMetadata: vi.fn() },
}));
vi.mock('../../../tray/TrayManager', () => ({ TrayManager: { getInstance: () => ({ onPromptResolved: vi.fn() }) } }));

import { AIService } from '../AIService';
import { registerTurnControlHandlers } from '../ipc/registerTurnControlHandlers';
import { codexQuestionTurns } from '../codexQuestionTurns';
import { SessionProcessingGuard, tryClaimAndDispatchNextQueuedPrompt } from '../queuedPromptDispatcher';
import { beginSessionTurn } from '../sessionTurnControl';
import { createPGLiteQueuedPromptsStore } from '../../PGLiteQueuedPromptsStore';
import { SQLiteDatabase } from '../../../database/sqlite/SQLiteDatabase';

describe('desktop Stop / lightning with durable queue and question ownership', () => {
  let database: SQLiteDatabase;
  let temporary: string;
  beforeEach(async () => {
    vi.clearAllMocks();
    stateManager.state = { status: 'running', isStreaming: true };
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-stop-lightning-'));
    database = new SQLiteDatabase({ dbDir: temporary, schemaDir: path.resolve(__dirname, '../../../database/sqlite/schemas') });
    await database.initialize();
    database.getRawHandle()!.prepare('INSERT INTO ai_sessions(id, provider, title) VALUES (?, ?, ?)').run('s1', 'openai-codex', 'test');
    storage.queue = createPGLiteQueuedPromptsStore(database as never);
  });
  afterEach(async () => {
    await codexQuestionTurns.end(codexQuestionTurns.current('s1'));
    await database?.close();
    if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
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
      interruptCurrentTurn: (id: string) => service.interruptCurrentTurn(id),
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
      interruptCurrentTurn: (id: string) => service.interruptCurrentTurn(id), driveQueuedPrompts: drive,
      invalidateQueueDrive: (id: string) => service.invalidateQueueDrive(id),
    } as any);
    const result = await handlers.get(action === 'stop' ? 'ai:cancelRequest' : 'ai:interruptCurrentTurn')!({}, 's1');
    expect(result).toMatchObject({ success: true });
    await vi.waitFor(async () => expect((await storage.queue.get('orphan-next'))?.status).toBe('completed'));
    expect(provider.abort).toHaveBeenCalledOnce();
    expect(provider.interruptCurrentTurn).not.toHaveBeenCalled();
    expect(delivered).toEqual([text]);
    expect(drive).toHaveBeenCalledOnce();
    expect(abandon).toHaveBeenCalledOnce();
    expect(stateManager.state.status).toBe('idle');
    expect(await tryClaimAndDispatchNextQueuedPrompt(options)).toBe(false);
  });

});
