// @vitest-environment node

import { EventEmitter } from "events";
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queue: undefined as any,
  handlers: new Map<string, (...args: any[]) => any>(),
  claim: vi.fn(),
  cancelUsageLimitResume: vi.fn(async () => {}),
  windowStates: new Map<number, { workspacePath: string }>(),
  pushChange: vi.fn(),
  providerFactory: {
    getProvider: vi.fn(),
    createProvider: vi.fn(),
  },
  stateManager: {
    startSession: vi.fn(),
    updateActivity: vi.fn(async () => {}),
    endSession: vi.fn(),
    isSessionActive: vi.fn(() => false),
    // No follow-up adopted the turn's query: the not-executing publish proceeds.
    getSessionState: vi.fn(() => undefined),
  },
}));
vi.mock('../../RepositoryManager', () => ({ getQueuedPromptsStore: () => mocks.queue }));
vi.mock('../../../utils/ipcRegistry', () => ({
  safeHandle: (name: string, handler: (...args: any[]) => any) => mocks.handlers.set(name, handler),
  safeOn: vi.fn(), safeOnce: vi.fn(), removeHandler: vi.fn(), removeAllListeners: vi.fn(), isHandlerRegistered: () => false,
}));

// MessageStreamingHandler pulls in most of the main process. Everything below
// exists only to let it import; nothing here is under test.
vi.mock("electron", async () => ({
  app: (await import("../../../../../test-stubs/privateUserData")).testApp,
  BrowserWindow: {
    fromWebContents: vi.fn(() => null),
    getAllWindows: vi.fn(() => []),
  },
}));

vi.mock("@nimbalyst/runtime/ai/server", () => ({
  ProviderFactory: mocks.providerFactory,
  ModelRegistry: {
    getModelsForProvider: vi.fn(async () => []),
    getDefaultModel: vi.fn(),
  },
  OpenAICodexProvider: {
    normalizeModelSelection: vi.fn((model: string) => model),
  },
  isAgentProvider: vi.fn((provider: string) => provider === "opencode"),
  onAgentMessageBatch: vi.fn(() => vi.fn()),
  buildMetaAgentSystemPrompt: vi.fn(),
  buildDevAgentSystemPrompt: vi.fn(),
}));

vi.mock("@nimbalyst/runtime/ai/server/SessionStateManager", () => ({
  getSessionStateManager: vi.fn(() => mocks.stateManager),
}));

vi.mock("@nimbalyst/runtime/ai/server/utils/errorDetection", () => ({
  isBedrockToolSearchError: vi.fn(() => false),
}));

vi.mock("@nimbalyst/runtime/ai/server/effortLevels", () => ({
  resolveEffortLevel: vi.fn(() => undefined),
  resolveThinkingMode: vi.fn(() => undefined),
}));

vi.mock("@nimbalyst/runtime/storage/repositories/AISessionsRepository", () => ({
  AISessionsRepository: { get: vi.fn() },
}));

vi.mock("@nimbalyst/runtime/ai/modelConstants", async (importOriginal) => ({
  ...await importOriginal<typeof import('@nimbalyst/runtime/ai/modelConstants')>(),
  resolveClaudeCodeParentContextWindow: vi.fn(),
}));

vi.mock("@nimbalyst/runtime/types/MCPServerConfig", () => ({
  buildMcpSessionStatusSnapshot: vi.fn(() => ({})),
}));

vi.mock("../tools", () => ({
  toolRegistry: { getAll: vi.fn(() => []) },
}));

vi.mock("../providerResolution", () => ({
  resolveExtensionAgentRef: vi.fn(() => null),
  // OpenCode discovers its tools over MCP, so it is not a tool-loop provider.
  usesHostSuppliedToolLoop: vi.fn(() => false),
}));

vi.mock("../../../extensions/AgentProviderRegistry", () => ({
  getAgentProviderRegistry: vi.fn(),
}));

vi.mock("../../SoundNotificationService", () => ({
  SoundNotificationService: {
    getInstance: vi.fn(() => ({ playCompletionSound: vi.fn() })),
  },
}));

vi.mock("../../NotificationService", () => ({
  notificationService: { showNotification: vi.fn() },
}));

vi.mock("../../../../shared/notificationTitle", () => ({
  composeNotificationTitle: vi.fn(),
}));

vi.mock("../../../utils/logger", () => ({
  logger: {
    ai: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    main: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  },
}));

vi.mock("../../../window/WindowManager", () => ({
  windowStates: mocks.windowStates,
  findWindowByWorkspace: vi.fn(() => null),
}));

vi.mock("../../SessionFileTracker", () => ({
  sessionFileTracker: { trackUserMessage: vi.fn() },
}));

vi.mock("../../CodexEditWindowRegistry", () => ({
  codexEditWindowRegistry: { clearSession: vi.fn() },
  shouldOpenCodexEditWindow: vi.fn(() => false),
}));

vi.mock("../../ToolCallMatcher", () => ({
  toolCallMatcher: { matchSession: vi.fn(async () => 0) },
  unwrapShellCommand: vi.fn(),
}));

vi.mock("../../FeatureUsageService.ts", () => ({
  FeatureUsageService: {
    getInstance: vi.fn(() => ({ recordUsage: vi.fn() })),
  },
  FEATURES: {
    AI_PROMPT_SUBMITTED: "ai_prompt_submitted",
  },
}));

vi.mock("../../ToolUsageService", () => ({
  ToolUsageService: { getInstance: vi.fn() },
}));

vi.mock("../../../HistoryManager", () => ({
  historyManager: {},
}));

vi.mock("../../../file/WorkspaceEventBus", () => ({
  addGitignoreBypass: vi.fn(),
  drainWorkspaceEvents: vi.fn(() => []),
}));

vi.mock("../../SyncManager", () => ({
  getSyncProvider: vi.fn(() => ({ pushChange: mocks.pushChange })),
  isDesktopTrulyAway: vi.fn(() => false),
}));

vi.mock("../mobilePushRequest", () => ({
  requestMobilePush: vi.fn(),
}));

vi.mock("../supersedeOpenQuestions", () => ({
  supersedeOpenQuestions: vi.fn(async () => ({ superseded: [], skipped: [] })),
}));
vi.mock("../pendingPromptPersistence", () => ({
  setSessionPendingPrompt: vi.fn(),
}));
vi.mock("../sessionInboxService", () => ({
  sessionInbox: {
    current: vi.fn(),
    begin: vi.fn(),
    end: vi.fn(async () => {}),
  },
}));
vi.mock("../../../mcp/httpServer", () => ({
  updateDocumentState: vi.fn(),
  registerWorkspaceWindow: vi.fn(),
}));

vi.mock("../../AgentWorkflowService", () => ({
  getAgentWorkflowService: vi.fn(),
}));

vi.mock("../../../mcp/metaAgentServer", () => ({
  getMetaAgentOpenAITools: vi.fn(),
}));

vi.mock("../../../mcp/devAgentTools", () => ({
  getDevAgentOpenAITools: vi.fn(),
  resolveDevToolScope: vi.fn(),
}));

vi.mock("../../MetaAgentService", () => ({
  MetaAgentService: { getInstance: vi.fn() },
}));

vi.mock("../wikiSkillAvailability", () => ({ isWikiSkillAvailable: () => false }));
vi.mock('../usageLimitAutoResume', () => ({ cancelUsageLimitResume: mocks.cancelUsageLimitResume, maybeScheduleUsageLimitResume: vi.fn() }));

vi.mock("../../../utils/store", () => ({
  getDefaultEffortLevel: vi.fn(() => undefined),
  getDefaultThinkingMode: vi.fn(() => undefined),
  getAppSetting: vi.fn(() => undefined),
  shouldShowCommunityPopup: vi.fn(() => false),
  markCommunityPopupShown: vi.fn(),
  wasCommunityPopupShownThisLaunch: vi.fn(() => false),
  incrementCompletedSessionsWithTools: vi.fn(),
}));

vi.mock("../childSessionTakeover", () => ({
  disableParentNotificationsAfterDirectTakeover: vi.fn(),
}));

vi.mock("../sessionSettlePolicy", () => ({
  shouldSettleUnterminatedTurn: vi.fn(() => false),
}));

vi.mock("../../tutorial/tutorialAnalytics", () => ({
  captureTutorialMilestone: vi.fn(),
}));

vi.mock("../../externalSessions/ExternalSessionService", () => ({
  claimExternalSessionForLocalExecution: mocks.claim,
}));

import { MessageStreamingHandler } from "../MessageStreamingHandler";
import { logger } from "../../../utils/logger";
import { resolveClaudeCodeParentContextWindow } from "@nimbalyst/runtime/ai/modelConstants";
import { resetPushOutcomeWarnings } from "@nimbalyst/runtime/sync/pushOutcome";
import { isTurnControlPending, isTurnAdmissionBlocked, performTurnInterruption } from '../sessionTurnControl';
import { codexQuestionTurns } from '../codexQuestionTurns';
import { TurnSetupCancelledError } from '../turnSetupStages';
import { SessionProcessingGuard, tryClaimAndDispatchNextQueuedPrompt } from '../queuedPromptDispatcher';
import { createPGLiteQueuedPromptsStore } from '../../PGLiteQueuedPromptsStore';
import { SQLiteDatabase } from '../../../database/sqlite/SQLiteDatabase';
import { mergeRestoredPromptIntoDraft } from '../../../../shared/restoredDraft';
import { AIService } from '../AIService';
import { registerTurnControlHandlers } from '../ipc/registerTurnControlHandlers';
import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';

/**
 * OpenCode replaces its whole config on every `initialize`, which is how the
 * session model was lost in #730. This records both the initialize calls and
 * the config in force at the request boundary, which is what the turn runs.
 */
class RecordingProvider extends EventEmitter {
  config: Record<string, unknown> = {};
  initializeConfigs: Array<Record<string, unknown>> = [];
  requestConfigs: Array<Record<string, unknown>> = [];

  constructor(private readonly chunks: Array<Record<string, unknown>> = []) {
    super();
  }

  async initialize(config: Record<string, unknown>) {
    this.initializeConfigs.push(config);
    this.config = config;
  }

  registerToolHandler() {}

  getCapabilities() {
    return { supportsFileTools: true };
  }

  async *sendMessage() {
    this.requestConfigs.push(this.config);
    for (const chunk of this.chunks) yield chunk;
  }
}

function openCodeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "opencode-session",
    provider: "opencode",
    model: "opencode:anthropic/claude-sonnet-4",
    providerConfig: {},
    messages: [{ role: "assistant", content: "Existing turn", timestamp: 1 }],
    workspacePath: "/workspace",
    ...overrides,
  };
}

async function runTurn(options: {
  session: Record<string, unknown>;
  provider: RecordingProvider;
  sessionManager?: Record<string, unknown>;
  omitWorkspacePath?: boolean;
  runWithHandler?: (handler: MessageStreamingHandler, event: any, service: any) => Promise<void>;
}) {
  mocks.providerFactory.createProvider.mockReturnValue(options.provider);

  const service = {
    sessionManager: {
      loadSession: vi.fn(async () => options.session),
      addMessage: vi.fn(),
      ...options.sessionManager,
    },
    analytics: { sendEvent: vi.fn() },
    sendMessageHandler: null,
    processingQueuedPromptIds: new Set(),
    matchDebounceTimers: new Map(),
    sessionsProcessingQueue: new Set(),
    documentContextService: {
      prepareContext: vi.fn(() => ({
        documentContext: {},
        userMessageAdditions: {},
      })),
    },
    hooklessWatcher: {
      ensureForSession: vi.fn(),
      stopForSession: vi.fn(),
      scheduleStop: vi.fn(),
    },
    getSettingsStore: vi.fn(),
    getApiKeyForProvider: vi.fn(() => undefined),
    buildClaudeCodeRuntimeConfig: vi.fn(),
    tryDispatchNextQueuedPrompt: vi.fn(async () => false),
    requestQueueDrive: vi.fn(),
    publishQueueStateToSync: vi.fn(async () => {}),
    createToolHandler: vi.fn(() => vi.fn()),
  };

  const handler = new MessageStreamingHandler(service as never);
  const event = { sender: { id: 7, isDestroyed: vi.fn(() => false), send: vi.fn() } } as never;
  if (options.runWithHandler) return options.runWithHandler(handler, event, service);
  if (options.omitWorkspacePath) await handler.handle(event, 'Prompt', undefined, options.session.id as string);
  else await handler.handle(event, 'Prompt', undefined, options.session.id as string, options.session.workspacePath as string);
}

function expectExistingComposerRestores(error: Error, text: string, attachments: unknown[]) {
  const transcript = fs.readFileSync(path.resolve(__dirname, '../../../../renderer/components/UnifiedAI/SessionTranscript.tsx'), 'utf8').replace(/\r\n/g, '\n');
  const catchStart = transcript.indexOf("      console.error('[SessionTranscript] Failed to send message:', error);");
  const catchEnd = transcript.indexOf('\n    }\n  }, [sessionId', catchStart);
  expect(catchStart).toBeGreaterThan(0);
  expect(catchEnd).toBeGreaterThan(catchStart);
  let draft = 'Typed since submission';
  let restoredAttachments: unknown[] = [];
  const setProcessing = vi.fn();
  const updateTranscript = vi.fn();
  const restore = new Function('error', 'message', 'attachments', 'sessionId', 'messages', 'userMessage', 'makeOptimisticError', 'updateSessionStore', 'setDraftInput', 'setDraftAttachments', 'setIsProcessing', 'mergeRestoredPromptIntoDraft', transcript.slice(catchStart, catchEnd));
  restore(error, text, attachments, 'opencode-session', [], {}, (message: string) => ({ message }), updateTranscript,
    (update: (draft: string) => string) => { draft = update(draft); },
    (update: (attachments: unknown[]) => unknown[]) => { restoredAttachments = update(restoredAttachments); },
    setProcessing, mergeRestoredPromptIntoDraft);
  expect(draft).toBe('Typed since submission\n\n' + text);
  expect(restoredAttachments).toEqual(attachments);
  expect(setProcessing).toHaveBeenCalledWith(false);
  expect(updateTranscript).toHaveBeenCalledWith({ sessionId: 'opencode-session', updates: { messages: [{}, { message: `Error: ${error.message}` }] } });
}

describe("MessageStreamingHandler external ownership", () => {
  it.each(['success', 'interrupt-failure', 'missing-id', 'second-stop', 'interrupt-failure-no-queue', 'missing-id-no-queue'])('pre-stream Stop retires real Codex host/question without killing its child (%s)', async scenario => {
    const interruptFails = scenario.startsWith('interrupt-failure');
    const missingId = scenario.startsWith('missing-id');
    const secondStop = scenario === 'second-stop';
    const noQueue = scenario.endsWith('no-queue');
    const { OpenAICodexProvider: CodexProvider } = await import('@nimbalyst/runtime/ai/server/providers/OpenAICodexProvider');
    const { CodexAppServerProtocol } = await import('@nimbalyst/runtime/ai/server/protocols/CodexAppServerProtocol');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-codex-prestream-'));
    const db = new SQLiteDatabase({ dbDir: dir, schemaDir: path.resolve(__dirname, '../../../database/sqlite/schemas') });
    await db.initialize();
    await db.query("INSERT INTO ai_sessions(id, provider, title) VALUES ('opencode-session', 'openai-codex', 'test')");
    const queue = createPGLiteQueuedPromptsStore(db as never);
    const queuedText = 'Keep the queued successor\n  exactly once.';
    await queue.create({ id: 'prestream-next', sessionId: 'opencode-session', prompt: queuedText });
    let enter!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    let release!: (value: unknown) => void;
    const starting = new Promise(resolve => { release = resolve; });
    let starts = 0;
    let nativeRunning = false;
    const nativeInputs: string[] = [];
    const terminate = vi.fn();
    const protocol = new CodexAppServerProtocol({ terminateProcessTreeOverride: terminate });
    const sends = vi.spyOn(protocol, 'sendMessage');
    const recoveryListener = vi.spyOn(protocol, 'setCancellationRecoveryErrorListener');
    const listeners = new Set<(method: string, params: unknown) => void>();
    const complete = (id: string) => { for (const listener of listeners) listener('turn/completed', { threadId: 'codex-prestream-thread', turn: { id, status: 'completed' } }); };
    const request = vi.fn(async (method: string, params: any) => {
      if (method === 'turn/interrupt') {
        expect(params).toEqual({ threadId: 'codex-prestream-thread', turnId: 'cancelled-turn' });
        if (interruptFails) throw new Error('Owned native interrupt refused');
        nativeRunning = false;
        queueMicrotask(() => complete('cancelled-turn'));
        return {};
      }
      if (method !== 'turn/start') return {};
      nativeInputs.push(params.input.map((item: any) => item.text ?? '').join(''));
      if (++starts === 1) { nativeRunning = true; enter(); return starting; }
      expect(nativeRunning).toBe(false);
      queueMicrotask(() => complete('successor-turn'));
      return { turn: { id: 'successor-turn' } };
    });
    const create = vi.fn(async () => ({ id: 'codex-prestream-thread', platform: 'codex-app-server', raw: {
      threadId: 'codex-prestream-thread', options: {}, activeTurnId: null, cleanupStarted: false,
      child: {}, stderrTail: [], client: {
        onNotification: (listener: (method: string, params: unknown) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
        close: vi.fn(), request,
      },
    } }));
    vi.spyOn(protocol, 'createSession').mockImplementation(create as never);
    vi.spyOn(protocol, 'resumeSession').mockImplementation(create as never);
    const provider = new CodexProvider({}, { protocol, transport: 'app-server', permissionService: { rejectAllPending: vi.fn(), clearSessionCache: vi.fn() } as never });
    vi.spyOn(provider as any, 'getAgentRole').mockResolvedValue('standard');
    vi.spyOn(provider as any, 'getSessionDirective').mockResolvedValue(undefined);
    vi.spyOn(provider as any, 'getConfiguredModel').mockResolvedValue('gpt-6.1-sol');
    vi.spyOn(provider as any, 'requestCodexTurnPermission').mockResolvedValue({ decision: 'allow', permissionMode: 'allow-all' });
    vi.spyOn((provider as any).mcpConfigService, 'getMcpServersConfig').mockResolvedValue({});
    vi.spyOn(provider as any, 'logAgentMessageBestEffort').mockResolvedValue(undefined);
    mocks.providerFactory.getProvider.mockReturnValue(provider);
    mocks.queue = queue;
    try {
      await runTurn({ session: openCodeSession({ provider: 'openai-codex', model: 'openai-codex:gpt-6.1-sol', workspacePath: dir }), provider: provider as unknown as RecordingProvider,
        sessionManager: { updateSessionTokenUsage: vi.fn(), updateProviderSessionData: vi.fn() },
        runWithHandler: async (handler, event, service) => {
          const old = handler.handle(event, 'Old pre-stream input', undefined, 'opencode-session', dir);
          await Promise.race([entered, old.then(() => { throw new Error('Codex host ended before turn/start'); })]);
          const question = codexQuestionTurns.current('opencode-session');
          expect(question?.active).toBe(true);
          const guard = new SessionProcessingGuard();
          service.sessionsProcessingQueue = guard;
          const targetWindow = { isDestroyed: () => false, webContents: { ...event.sender, mainFrame: {} } } as any;
          let successor = false;
          try {
            const stopped = await performTurnInterruption({
              sessionId: 'opencode-session', mode: 'stop', provider, isCurrentProvider: () => true, guard,
              retireInbox: async () => {}, sweep: async () => {}, settle: async () => {},
              drive: async () => {
                if (noQueue) return;
                successor = await tryClaimAndDispatchNextQueuedPrompt({ queueStore: queue, processingSet: guard,
                  sendMessageHandler: handler.handleQueued, continueQueuedPromptChain: async () => {},
                  logError: vi.fn(), logInfo: vi.fn(), onPromptClaimed: vi.fn(), startSession: async () => {},
                  sessionId: 'opencode-session', workspacePath: dir, source: 'prestream-real', targetWindow });
              }, logError: vi.fn(), timeouts: { stageMs: 100 },
            });
            expect(stopped).toMatchObject({ success: true });
            await old;
            expect(question?.active).toBe(false);
            expect(successor).toBe(!noQueue);
            expect(starts).toBe(1);
            expect(nativeRunning).toBe(true);
            expect(terminate).not.toHaveBeenCalled();
            if (secondStop) {
              await vi.waitFor(() => expect(sends).toHaveBeenCalledTimes(2));
              expect((await queue.get('prestream-next'))?.status).toBe('executing');
              const stoppedAgain = await performTurnInterruption({
                sessionId: 'opencode-session', mode: 'stop', provider, isCurrentProvider: () => true, guard,
                retireInbox: async () => {}, sweep: async () => {}, settle: async () => {},
                drive: async () => {}, logError: vi.fn(), timeouts: { stageMs: 100 },
              });
              expect(stoppedAgain).toMatchObject({ success: true });
              await vi.waitFor(async () => expect((await queue.get('prestream-next'))?.status).toBe('failed'));
              expect((await queue.get('prestream-next'))?.prompt).toBe(queuedText);
              expect((await queue.listPending('opencode-session'))).toEqual([]);
              expect(nativeInputs.filter(input => input.includes(queuedText))).toEqual([]);
              expect(starts).toBe(1);
              expect(guard.has('opencode-session')).toBe(false);
              expect(terminate).not.toHaveBeenCalled();
              return;
            }
            event.sender.send.mockClear();
            mocks.stateManager.updateActivity.mockClear();
            release(missingId ? { turn: {} } : { turn: { id: 'cancelled-turn' } });
            if (interruptFails || missingId) {
              // The late failure is visible without another send or a waiting
              // queued host. Native work may still be live: no false Stop claim.
              await vi.waitFor(() => expect(event.sender.send).toHaveBeenCalledWith('ai:error', expect.objectContaining({
                sessionId: 'opencode-session', message: expect.stringContaining('Restart the app'),
              })));
              const errors = event.sender.send.mock.calls.filter(([channel, data]: any[]) => channel === 'ai:error' && data.message.startsWith('Codex could not confirm'));
              expect(errors).toHaveLength(1);
              expect(mocks.stateManager.updateActivity).toHaveBeenCalledWith({ sessionId: 'opencode-session', status: 'error' });
              expect(nativeRunning).toBe(true);
              if (noQueue) {
                expect((await queue.get('prestream-next'))?.status).toBe('pending');
                expect((await queue.get('prestream-next'))?.prompt).toBe(queuedText);
                const sentBeforeForeign = event.sender.send.mock.calls.length;
                provider.emit('session:recovery-error', { sessionId: 'foreign-session', message: 'wrong session' });
                expect(event.sender.send.mock.calls).toHaveLength(sentBeforeForeign);
                expect(sends).toHaveBeenCalledTimes(1);
                expect(starts).toBe(1);
                expect(terminate).not.toHaveBeenCalled();
                return;
              }
            }
            await vi.waitFor(async () => {
              const row = await queue.get('prestream-next');
              expect(row?.status, JSON.stringify(row)).toBe(interruptFails || missingId ? 'failed' : 'completed');
            });
            if (interruptFails || missingId) {
              expect((await queue.get('prestream-next'))?.prompt).toBe(queuedText);
              for (let attempt = 0; attempt < 3; attempt++) {
                const text = 'Keep this composer input';
                const attachments = [{ id: 'kept', type: 'document', filename: 'kept.txt', mimeType: 'text/plain', content: 'kept attachment' }];
                const error = await handler.handle(event, text, { attachments } as any, 'opencode-session', dir).then(() => undefined, error => error);
                expect(error.message).toContain('has not been sent to Codex');
                expectExistingComposerRestores(error, text, attachments);
              }
            }
            expect(starts).toBe(interruptFails || missingId ? 1 : 2);
            expect(nativeInputs.filter(input => input.includes(queuedText))).toHaveLength(interruptFails || missingId ? 0 : 1);
            expect(create).toHaveBeenCalledTimes(1);
            expect(terminate).not.toHaveBeenCalled();
          } finally {
            provider.abort();
            release({ turn: { id: 'cancelled-turn' } });
            await old;
            await vi.waitFor(() => expect(guard.has('opencode-session')).toBe(false));
            const ownedListeners = provider.listeners('session:recovery-error');
            provider.emit('session:recovery-disposed', { sessionId: 'foreign-session' });
            expect(provider.listeners('session:recovery-error')).toEqual(ownedListeners);
            const unrelatedObserver = vi.fn();
            provider.on('session:recovery-error', unrelatedObserver);
            provider.cleanupSession('opencode-session');
            expect(provider.listeners('session:recovery-error')).toEqual([unrelatedObserver]);
            provider.cleanupSession('opencode-session');
            expect(provider.listeners('session:recovery-error')).toEqual([unrelatedObserver]);
            provider.off('session:recovery-error', unrelatedObserver);
            expect(provider.listenerCount('session:recovery-error')).toBe(0);
            expect(provider.listenerCount('session:recovery-disposed')).toBe(0);
          }
        },
      });
    } finally {
      provider.destroy();
      expect(recoveryListener).toHaveBeenLastCalledWith();
      expect(provider.listenerCount('session:recovery-error')).toBe(0);
      expect(provider.listenerCount('session:recovery-disposed')).toBe(0);
      mocks.providerFactory.getProvider.mockReset();
      await db.close();
      fs.rmSync(dir, { recursive: true });
    }
  });

  it.each([false, true])('distinguishes attempted delivery from a first provider response (response: %s)', async responds => {
    class UncertainProvider extends RecordingProvider {
      async *sendMessage() {
        if (responds) yield { type: 'text', content: 'received' };
        throw new TurnSetupCancelledError();
      }
    }
    await runTurn({ session: openCodeSession(), provider: new UncertainProvider(), runWithHandler: async (handler, event) => {
      await expect(handler.handle(event, 'Input', undefined, 'opencode-session', '/workspace')).rejects.toMatchObject({
        deliveryMayHaveStarted: true, providerEntered: responds,
      });
    } });
  });

  it('two real Send Now IPC presses retire the old handler and run one internal queued successor', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-real-double-lightning-'));
    const db = new SQLiteDatabase({ dbDir: dir, schemaDir: path.resolve(__dirname, '../../../database/sqlite/schemas') });
    await db.initialize();
    await db.query("INSERT INTO ai_sessions(id, provider, title) VALUES ('opencode-session', 'opencode', 'test')");
    const queue = createPGLiteQueuedPromptsStore(db as never);
    mocks.queue = queue;
    const text = 'One queued correction\n  exact original text.';
    await queue.create({ id: 'ipc-successor', sessionId: 'opencode-session', prompt: text });
    let release!: () => void;
    let enter!: () => void;
    const parked = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { enter = resolve; });
    let calls = 0;
    class InterruptibleProvider extends RecordingProvider {
      interruptCurrentTurn = vi.fn(async () => { release(); return { method: 'interrupt' as const }; });
      abort = vi.fn(() => release());
      async *sendMessage() {
        for (const chunk of []) yield chunk;
        if (++calls === 1) { enter(); await parked; return; }
        await db.query("INSERT INTO ai_agent_messages(session_id, source, direction, content, created_at) VALUES ('opencode-session', 'test', 'input', $1, $2)", [text, new Date().toISOString()]);
      }
    }
    const provider = new InterruptibleProvider();
    // Concurrent dynamic imports can resolve the actual repository namespace
    // in Vitest; provide its test-only adapter as well as the static mock.
    const actualRepository = await vi.importActual<typeof import('@nimbalyst/runtime/storage/repositories/AISessionsRepository')>('@nimbalyst/runtime/storage/repositories/AISessionsRepository');
    actualRepository.AISessionsRepository.setStore({ get: async () => ({ provider: 'opencode', workspacePath: '/workspace' }) } as any);
    try {
      await runTurn({ session: openCodeSession(), provider, runWithHandler: async (handler, event, service) => {
        const guard = new SessionProcessingGuard();
        service.sessionsProcessingQueue = guard;
        service.forceSessionIdleOnCancel = vi.fn(async () => {});
        Object.setPrototypeOf(service, AIService.prototype);
        mocks.providerFactory.getProvider.mockReturnValue(provider);
        vi.mocked(AISessionsRepository.get).mockResolvedValue({ provider: 'opencode', workspacePath: '/workspace' } as any);
        let sawPostFenceReservation = false;
        service.driveQueuedPrompts = vi.fn(async () => {
          sawPostFenceReservation = !isTurnControlPending('opencode-session');
          await expect(handler.handle(event, 'Competing normal input', undefined, 'opencode-session', '/workspace')).rejects.toThrow('back in the composer');
          const sent = await tryClaimAndDispatchNextQueuedPrompt({
            queueStore: queue, processingSet: guard, sendMessageHandler: handler.handleQueued,
            startSession: async () => {}, continueQueuedPromptChain: async () => {}, onPromptClaimed: vi.fn(), logInfo: vi.fn(), logError: vi.fn(),
            sessionId: 'opencode-session', workspacePath: '/workspace', source: 'real-double-IPC',
            targetWindow: { isDestroyed: () => false, webContents: { ...event.sender, mainFrame: {} } } as any,
          });
          return { kind: sent ? 'dispatched' : 'nothing-pending' };
        });
        service.invalidateQueueDrive = vi.fn();
        registerTurnControlHandlers({
          analytics: service.analytics, sessionsProcessingQueue: guard,
          interruptCurrentTurn: (id: string) => AIService.prototype.interruptCurrentTurn.call(service, id),
        } as any);
        const old = handler.handle(event, 'Old running input', undefined, 'opencode-session', '/workspace');
        await entered;
        const invoke = mocks.handlers.get('ai:interruptCurrentTurn')!;
        const [a, b] = await Promise.all([invoke(event, 'opencode-session'), invoke(event, 'opencode-session')]);
        await old;
        expect(a.success).toBe(true);
        expect(b.success).toBe(true);
        await vi.waitFor(async () => expect((await queue.get('ipc-successor'))?.status).toBe('completed'));
        expect(provider.interruptCurrentTurn).toHaveBeenCalledOnce();
        expect(service.driveQueuedPrompts).toHaveBeenCalledOnce();
        expect(sawPostFenceReservation).toBe(true);
        expect(calls).toBe(2);
        expect((await db.query<{ content: string }>("SELECT content FROM ai_agent_messages WHERE direction='input'")).rows.map(row => row.content)).toEqual([text]);
      } });
    } finally { actualRepository.AISessionsRepository.clearStore(); release(); await db.close(); fs.rmSync(dir, { recursive: true }); }
  });
  it.each(['retireInbox', 'sweep', 'settle'] as const)('rejects and restores input while %s remains visibly quarantined', async stalledStep => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-quarantined-input-'));
    const db = new SQLiteDatabase({ dbDir: dir, schemaDir: path.resolve(__dirname, '../../../database/sqlite/schemas') });
    await db.initialize();
    await db.query("INSERT INTO ai_sessions(id, provider, title) VALUES ('opencode-session', 'opencode', 'test')");
    const queue = createPGLiteQueuedPromptsStore(db as never);
    mocks.queue = queue;
    await queue.create({ id: 'stranded-original', sessionId: 'opencode-session', prompt: 'Original preserved text' });
    let release!: () => void;
    let enter!: () => void;
    const parked = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const provider = new RecordingProvider();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await runTurn({ session: openCodeSession(), provider, runWithHandler: async (handler, event, service) => {
        const control = performTurnInterruption({
          sessionId: 'opencode-session', mode: 'stop', provider: null, isCurrentProvider: () => true, guard: new SessionProcessingGuard(),
          retireInbox: async () => {}, sweep: async () => {}, settle: async () => {},
          [stalledStep]: async () => { enter(); await parked; },
          drive: async () => {}, logError: vi.fn(), timeouts: { stageMs: 20 },
        });
        await entered;
        try {
          await vi.advanceTimersByTimeAsync(20);
          const stopped = await control;
          expect(stopped.success).toBe(false);
          expect(isTurnAdmissionBlocked('opencode-session')).toBe(true);
          const attachments = [{ id: 'attachment', name: 'keep.txt' }];
          const text = 'Fresh input\n  original spacing';
          const error = await handler.handle(event, text, { attachments, inputType: 'user' } as any, 'opencode-session', '/workspace').then(() => undefined, error => error);
          expect(error).toBeInstanceOf(TurnSetupCancelledError);
          expect(error.message).toMatch(/recovering a stuck save/i);
          expect(error.message).toMatch(/text and attachments.*kept/i);
          expect(error.message).toMatch(/restart the app/i);
          // Execute the existing renderer catch body, rather than reproducing
          // its restore algorithm or adding a second product path.
          expectExistingComposerRestores(error, text, attachments);
          // Only finally releases this cleanup barrier, so recovery cannot
          // race any of these fresh composer submissions.
          for (let attempt = 0; attempt < 3; attempt++) {
            expect(isTurnAdmissionBlocked('opencode-session')).toBe(true);
            const rejected = await handler.handle(event, text, { attachments } as any, 'opencode-session', '/workspace').then(() => undefined, error => error);
            expect(rejected.message).toMatch(/recovering a stuck save/);
            expectExistingComposerRestores(rejected, text, attachments);
          }
          const pending = await queue.listPending('opencode-session');
          expect(pending.map(row => row.prompt)).toEqual(['Original preserved text']);
          expect(provider.requestConfigs).toHaveLength(0);
        } finally {
          release();
          await vi.advanceTimersByTimeAsync(0);
          await vi.waitFor(() => expect(isTurnAdmissionBlocked('opencode-session')).toBe(false));
        }
      } });
    } finally { vi.useRealTimers(); release(); await db.close(); fs.rmSync(dir, { recursive: true }); }
  });
  it('preserves direct entry during an ordinary queued chain without a control reservation', async () => {
    const provider = new RecordingProvider();
    await runTurn({ session: openCodeSession(), provider, runWithHandler: async (handler, event, service) => {
      service.sessionsProcessingQueue.add('opencode-session');
      await expect(handler.handle(event, 'Ordinary direct input', undefined, 'opencode-session', '/workspace')).resolves.toEqual({ content: '' });
      expect(provider.requestConfigs).toHaveLength(1);
    } });
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.windowStates.clear();
    mocks.providerFactory.getProvider.mockReturnValue(null);
    mocks.claim.mockResolvedValue(undefined);
  });
  it('keeps cancellation fenced until the real host handler has retired', async () => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    class ParkedProvider extends RecordingProvider {
      async *sendMessage() {
        for (const chunk of []) yield chunk;
        entered();
        await blocked;
      }
    }
    const running = runTurn({ session: openCodeSession(), provider: new ParkedProvider() });
    await started;
    const options = {
      sessionId: 'opencode-session', mode: 'stop' as const,
      provider: { abort: vi.fn(), interruptCurrentTurn: vi.fn(async () => ({ method: 'abort' as const })) },
      isCurrentProvider: () => true, guard: new SessionProcessingGuard(),
      retireInbox: vi.fn(async () => {}), sweep: vi.fn(async () => {}),
      settle: vi.fn(async () => {}), drive: vi.fn(async () => {}), logError: vi.fn(),
    };
    let finished = false;
    const control = performTurnInterruption(options).then(result => { finished = true; return result; });
    await Promise.resolve();
    expect(isTurnControlPending(options.sessionId)).toBe(true);
    expect(finished).toBe(false);
    await expect(runTurn({ session: openCodeSession(), provider: new RecordingProvider() })).rejects.toThrow('back in the composer');
    expect(options.sweep).not.toHaveBeenCalled();
    release();
    await running;
    expect((await control).success).toBe(true);
    expect(options.sweep).toHaveBeenCalledOnce();
    expect(isTurnControlPending(options.sessionId)).toBe(false);
  });
  it('cancels a turn during the last awaited step before provider invocation', async () => {
    let entered!: () => void;
    let release!: () => void;
    const enteredGate = new Promise<void>(resolve => { entered = resolve; });
    const parked = new Promise<void>(resolve => { release = resolve; });
    mocks.cancelUsageLimitResume.mockImplementationOnce(async () => { entered(); await parked; });
    const provider = new RecordingProvider();
    mocks.windowStates.set(7, { workspacePath: '/workspace' });
    const loadSession = vi.fn(async () => openCodeSession());
    const running = runTurn({ session: openCodeSession(), provider, omitWorkspacePath: true, sessionManager: { loadSession } });
    const rejected = expect(running).rejects.toThrow('Stopped before the agent started');
    await enteredGate;
    expect(loadSession).toHaveBeenCalledWith('opencode-session', '/workspace');
    const options = {
      sessionId: 'opencode-session', mode: 'stop' as const,
      provider: { abort: vi.fn(), interruptCurrentTurn: vi.fn(async () => ({ method: 'abort' as const })) },
      isCurrentProvider: () => true, guard: new SessionProcessingGuard(),
      retireInbox: async () => {}, sweep: async () => {}, settle: async () => {}, drive: async () => {}, logError: vi.fn(),
    };
    const control = performTurnInterruption(options);
    release();
    await rejected;
    expect((await control).success).toBe(true);
    expect(provider.requestConfigs).toHaveLength(0);
  });
  it('stops a parked takeover before creating a provider', async () => {
    let entered!: () => void;
    let release!: () => void;
    const enteredGate = new Promise<void>(resolve => { entered = resolve; });
    const parked = new Promise<void>(resolve => { release = resolve; });
    mocks.claim.mockImplementationOnce(async () => { entered(); await parked; });
    const provider = new RecordingProvider();
    const running = runTurn({ session: openCodeSession({ providerConfig: { imported: true } }), provider });
    const rejected = expect(running).rejects.toThrow('Stopped before the agent started');
    await enteredGate;
    const control = performTurnInterruption({
      sessionId: 'opencode-session', mode: 'stop', provider: null,
      isCurrentProvider: () => true, guard: new SessionProcessingGuard(),
      retireInbox: async () => {}, sweep: async () => {}, settle: async () => {}, drive: async () => {}, logError: vi.fn(),
    });
    release();
    await rejected;
    expect((await control).success).toBe(true);
    expect(mocks.providerFactory.createProvider).not.toHaveBeenCalled();
    expect(provider.requestConfigs).toHaveLength(0);
  });
  it("aborts before user raw/provider side effects when the durable claim fails, then permits retry", async () => {
    const provider = new RecordingProvider();
    const addMessage = vi.fn();
    const session = openCodeSession({
      provider: "claude-code",
      providerConfig: { imported: true },
    });
    mocks.claim.mockRejectedValueOnce(new Error("takeover database failure"));
    await expect(
      runTurn({ session, provider, sessionManager: { addMessage } })
    ).rejects.toThrow("takeover database failure");
    expect(addMessage).not.toHaveBeenCalled();
    expect(mocks.providerFactory.createProvider).not.toHaveBeenCalled();
    expect(provider.requestConfigs).toHaveLength(0);
    await runTurn({ session, provider, sessionManager: { addMessage } });
    expect(mocks.claim).toHaveBeenCalledTimes(2);
    expect(addMessage).toHaveBeenCalledOnce();
    expect(provider.requestConfigs).toHaveLength(1);
  });
  it("awaits takeover before writing user raw messages", async () => {
    const provider = new RecordingProvider();
    const addMessage = vi.fn();
    let release!: () => void;
    mocks.claim.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const running = runTurn({
      session: openCodeSession({
        provider: "openai-codex-acp",
        providerConfig: { imported: true },
      }),
      provider,
      sessionManager: { addMessage },
    });
    await vi.waitFor(() => expect(mocks.claim).toHaveBeenCalledOnce());
    expect(addMessage).not.toHaveBeenCalled();
    release();
    await running;
    expect(addMessage).toHaveBeenCalledOnce();
  });
  it.each([['pre-claim', false], ['post-claim', false], ['pre-claim', true], ['post-claim', true]] as const)('retries a timed-out %s drive (normal send race: %s)', async (position, normalRace) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-control-edge-'));
    const db = new SQLiteDatabase({ dbDir: dir, schemaDir: path.resolve(__dirname, '../../../database/sqlite/schemas') });
    await db.initialize();
    await db.query("INSERT INTO ai_sessions(id, provider, title) VALUES ('opencode-session', 'opencode', 'test')");
    const queue = createPGLiteQueuedPromptsStore(db as never);
    const text = 'Preserve this queued input\n  exactly once.';
    await queue.create({ id: 'edge-input', sessionId: 'opencode-session', prompt: text });
    let deliveries = 0;
    class DurableProvider extends RecordingProvider {
      async *sendMessage() {
        for (const chunk of []) yield chunk;
        deliveries++;
        await db.query("INSERT INTO ai_agent_messages(session_id, source, direction, content, created_at) VALUES ('opencode-session', 'test', 'input', $1, $2)", [text, new Date().toISOString()]);
      }
    }
    try {
      await runTurn({ session: openCodeSession(), provider: new DurableProvider(), runWithHandler: async (handler, event, service) => {
        const guard = new SessionProcessingGuard();
        service.sessionsProcessingQueue = guard;
        const targetWindow = { isDestroyed: () => false, webContents: { ...event.sender, mainFrame: {} } } as any;
        const dispatch = () => tryClaimAndDispatchNextQueuedPrompt({
          queueStore: queue, processingSet: guard, sendMessageHandler: handler.handleQueued,
          continueQueuedPromptChain: async () => {}, logError: vi.fn(), logInfo: vi.fn(), onPromptClaimed: vi.fn(),
          startSession: async () => {}, sessionId: 'opencode-session', workspacePath: '/workspace', source: 'edge-test', targetWindow,
        });
        let enter!: () => void;
        let release!: () => void;
        const entered = new Promise<void>(resolve => { enter = resolve; });
        const parked = new Promise<void>(resolve => { release = resolve; });
        let attempts = 0;
        const drive = vi.fn(async () => {
          attempts++;
          if (attempts === 1) {
            const claimed = position === 'post-claim' ? await dispatch() : false;
            enter();
            await parked;
            const sent = position === 'pre-claim' ? await dispatch() : claimed;
            return sent ? { kind: 'dispatched' as const } : { kind: 'deferred' as const, reason: 'session-busy' as const };
          }
          return await dispatch() ? { kind: 'dispatched' as const } : { kind: 'nothing-pending' as const };
        });
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const control = performTurnInterruption({
          sessionId: 'opencode-session', mode: 'stop', provider: null, isCurrentProvider: () => true, guard,
          retireInbox: async () => {}, sweep: async () => {}, settle: async () => {}, drive, logError: vi.fn(), timeouts: { stageMs: 20 },
        });
        try {
        await entered;
        if (normalRace) {
          await expect(handler.handle(event, 'Parallel normal input', { inputType: 'user' } as any, 'opencode-session', '/workspace')).rejects.toThrow('back in the composer');
          await expect(handler.handle(event, 'Forged queued input', { inputType: 'user', queuedPromptId: 'edge-input' } as any, 'opencode-session', '/workspace')).rejects.toThrow('back in the composer');
        }
        await vi.advanceTimersByTimeAsync(20);
        expect((await control).success).toBe(false);
        if (position === 'pre-claim') expect(await queue.get('edge-input')).toMatchObject({ status: 'pending', prompt: text });
        release();
        await vi.waitFor(async () => expect((await queue.get('edge-input'))?.status).toBe('completed'));
        expect(deliveries).toBe(1);
        expect((await db.query<{ n: number }>("SELECT count(*) AS n FROM ai_agent_messages WHERE direction='input'" )).rows[0].n).toBe(1);
        expect(await dispatch()).toBe(false);
        } finally {
          release();
          await vi.advanceTimersByTimeAsync(0);
          await control;
          await vi.waitFor(() => expect(guard.has('opencode-session')).toBe(false));
        }
      } });
    } finally {
      vi.useRealTimers();
      await db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(['end', 'abort-error', 'typed-cancel'] as const)('never requeues persisted provider input after cancellation (%s)', async outcome => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-persisted-control-'));
    const db = new SQLiteDatabase({ dbDir: dir, schemaDir: path.resolve(__dirname, '../../../database/sqlite/schemas') });
    await db.initialize();
    await db.query("INSERT INTO ai_sessions(id, provider, title) VALUES ('opencode-session', 'opencode', 'test')");
    const queue = createPGLiteQueuedPromptsStore(db as never);
    await queue.create({ id: 'persisted-input', sessionId: 'opencode-session', prompt: 'Saved once' });
    let enter!: () => void;
    let release!: () => void;
    const persisted = new Promise<void>(resolve => { enter = resolve; });
    const parked = new Promise<void>(resolve => { release = resolve; });
    let deliveries = 0;
    class DurableProvider extends RecordingProvider {
      async *sendMessage() {
        for (const chunk of []) yield chunk;
        deliveries++;
        await db.query("INSERT INTO ai_agent_messages(session_id, source, direction, content, created_at) VALUES ('opencode-session', 'test', 'input', 'Saved once', $1)", [new Date().toISOString()]);
        enter();
        await parked;
        if (outcome === 'abort-error') throw new Error('Provider aborted after input persistence');
        if (outcome === 'typed-cancel') throw new TurnSetupCancelledError();
      }
    }
    try {
      await runTurn({ session: openCodeSession(), provider: new DurableProvider(), runWithHandler: async (handler, event, service) => {
        const guard = new SessionProcessingGuard();
        service.sessionsProcessingQueue = guard;
        const dispatch = () => tryClaimAndDispatchNextQueuedPrompt({
          queueStore: queue, processingSet: guard, sendMessageHandler: handler.handleQueued,
          continueQueuedPromptChain: async () => {}, logError: vi.fn(), logInfo: vi.fn(), onPromptClaimed: vi.fn(),
          startSession: async () => {}, sessionId: 'opencode-session', workspacePath: '/workspace', source: 'persisted-test',
          targetWindow: { isDestroyed: () => false, webContents: { ...event.sender, mainFrame: {} } } as any,
        });
        try {
        expect(await dispatch()).toBe(true);
        await persisted;
        const control = performTurnInterruption({
          sessionId: 'opencode-session', mode: 'stop', provider: { abort: vi.fn(() => release()), interruptCurrentTurn: vi.fn() },
          isCurrentProvider: () => true, guard, retireInbox: async () => {}, sweep: async () => { await queue.sweepExecutingForSession('opencode-session'); },
          settle: async () => {}, drive: async () => { await dispatch(); }, logError: vi.fn(),
        });
        expect((await control).success).toBe(true);
        expect((await queue.get('persisted-input'))?.status).toBe(outcome === 'end' ? 'completed' : 'failed');
        expect(await dispatch()).toBe(false);
        expect(deliveries).toBe(1);
        expect((await db.query<{ n: number }>("SELECT count(*) AS n FROM ai_agent_messages WHERE direction='input'")).rows[0].n).toBe(1);
        } finally {
          release();
          await vi.waitFor(() => expect(guard.has('opencode-session')).toBe(false));
        }
      } });
    } finally {
      await db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

});
