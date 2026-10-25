// @vitest-environment node

import { EventEmitter } from "events";
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
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
    updateActivity: vi.fn(),
    endSession: vi.fn(),
    isSessionActive: vi.fn(() => false),
    // No follow-up adopted the turn's query: the not-executing publish proceeds.
    getSessionState: vi.fn(() => undefined),
  },
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

vi.mock("@nimbalyst/runtime/ai/modelConstants", () => ({
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
import { isTurnControlPending, performTurnInterruption } from '../sessionTurnControl';
import { TurnSetupCancelledError } from '../turnSetupStages';
import { SessionProcessingGuard, tryClaimAndDispatchNextQueuedPrompt } from '../queuedPromptDispatcher';
import { createPGLiteQueuedPromptsStore } from '../../PGLiteQueuedPromptsStore';
import { SQLiteDatabase } from '../../../database/sqlite/SQLiteDatabase';

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
    createToolHandler: vi.fn(() => vi.fn()),
  };

  const handler = new MessageStreamingHandler(service as never);
  const event = { sender: { id: 7, isDestroyed: vi.fn(() => false), send: vi.fn() } } as never;
  if (options.runWithHandler) return options.runWithHandler(handler, event, service);
  if (options.omitWorkspacePath) await handler.handle(event, 'Prompt', undefined, options.session.id as string);
  else await handler.handle(event, 'Prompt', undefined, options.session.id as string, options.session.workspacePath as string);
}

describe("MessageStreamingHandler external ownership", () => {
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
