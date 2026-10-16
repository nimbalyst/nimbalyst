// @vitest-environment node

import { EventEmitter } from "events";
import { getSessionStateManager } from "@nimbalyst/runtime/ai/server/SessionStateManager";
import { BrowserWindow } from "electron";
import { findWindowByWorkspace } from "../../../window/WindowManager";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
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
  windowStates: new Map(),
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

async function useRealSessionStateManager() {
  const { SessionStateManager } = await vi.importActual<
    typeof import("@nimbalyst/runtime/ai/server/SessionStateManager")
  >("@nimbalyst/runtime/ai/server/SessionStateManager");
  const stateManager = new SessionStateManager();
  vi.mocked(getSessionStateManager).mockReturnValue(stateManager);
  return stateManager;
}

async function runTurn(options: {
  session: Record<string, unknown>;
  provider: RecordingProvider;
  sessionManager?: Record<string, unknown>;
  sender?: { id: number; isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> };
  service?: Record<string, unknown>;
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
    ...options.service,
  };

  await new MessageStreamingHandler(service as never).handle(
    {
      sender: options.sender ?? { id: 7, isDestroyed: vi.fn(() => false), send: vi.fn() },
    } as never,
    "Prompt",
    undefined,
    options.session.id as string,
    options.session.workspacePath as string
  );
}

afterEach(() => {
  vi.mocked(getSessionStateManager).mockReturnValue(mocks.stateManager as never);
  vi.mocked(findWindowByWorkspace).mockReturnValue(null);
  vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(null);
});

describe("MessageStreamingHandler external ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.providerFactory.getProvider.mockReturnValue(null);
    mocks.claim.mockResolvedValue(undefined);
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
});

describe("MessageStreamingHandler window replacement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.providerFactory.getProvider.mockReturnValue(null);
    mocks.claim.mockResolvedValue(undefined);
  });

  it.each([
    ["complete", "live"],
    ["error", "live"],
    ["complete", "missing"],
    ["error", "missing"],
    ["complete", "destroyed"],
    ["error", "destroyed"],
  ] as const)("settles %s with a %s replacement window", async (outcome, windowState) => {
    const stateManager = await useRealSessionStateManager();
    let destroyed = false;
    const sender = { id: 7, isDestroyed: () => destroyed, send: vi.fn() };
    const replacement = windowState === "missing" ? null : {
      id: 22,
      isDestroyed: () => windowState === "destroyed",
      webContents: { isDestroyed: () => false, send: vi.fn() },
    };
    vi.mocked(findWindowByWorkspace).mockReturnValue(replacement as never);
    vi.mocked(BrowserWindow.fromWebContents).mockImplementation(() => {
      if (destroyed) throw new TypeError("Object has been destroyed");
      return null;
    });
    class ClosingProvider extends RecordingProvider {
      async *sendMessage() {
        yield { type: "text", content: "Response" };
        expect(stateManager.getRunningSessionIds()).toContain("opencode-session");
        destroyed = true;
        if (outcome === "error") throw new Error("provider failed");
        yield { type: "complete" };
      }
    }
    const dispatch = vi.fn(async () => false);
    const turn = runTurn({
      session: openCodeSession(), provider: new ClosingProvider(), sender,
      service: { tryDispatchNextQueuedPrompt: dispatch },
    });
    if (outcome === "error") await expect(turn).rejects.toThrow("provider failed");
    else await turn;
    expect(dispatch).toHaveBeenCalledWith(
      "opencode-session", "/workspace", windowState === "live" ? replacement : null,
      outcome === "error" ? "error-handler queue" : "completion-handler queue",
    );
    expect(stateManager.getRunningSessionIds()).toEqual([]);
    expect(stateManager.isSessionActive("opencode-session")).toBe(false);
  });

  it.each(["complete", "error"] as const)("preserves a running queued continuation when the old turn emits %s", async (outcome) => {
    const stateManager = await useRealSessionStateManager();
    const processingQueue = new Set<string>();
    class ContinuingProvider extends RecordingProvider {
      async *sendMessage() {
        yield { type: "text", content: "Response" };
        processingQueue.add("opencode-session");
        // The next turn now owns this session's state.
        await stateManager.startSession({ sessionId: "opencode-session", workspacePath: "/workspace" });
        await stateManager.updateActivity({ sessionId: "opencode-session", status: "running", isStreaming: true });
        if (outcome === "error") throw new Error("old turn failed");
        yield { type: "complete" };
      }
    }
    const dispatch = vi.fn();
    const turn = runTurn({
      session: openCodeSession(), provider: new ContinuingProvider(),
      service: { sessionsProcessingQueue: processingQueue, tryDispatchNextQueuedPrompt: dispatch },
    });
    if (outcome === "error") await expect(turn).rejects.toThrow("old turn failed");
    else await turn;
    expect(dispatch).not.toHaveBeenCalled();
    expect(stateManager.getRunningSessionIds()).toEqual(["opencode-session"]);
    expect(stateManager.getSessionState("opencode-session")?.status).toBe("running");
  });

  it.each(["queue", "teammates", "resume"] as const)("keeps %s work active after a provider error", async (continuation) => {
    const stateManager = await useRealSessionStateManager();
    class BackgroundProvider extends RecordingProvider {
      hasActiveTeammates() { return continuation === "teammates"; }
      willResumeAfterCompletion() { return continuation === "resume"; }
      async *sendMessage() {
        yield { type: "text", content: "Response" };
        throw new Error("lead failed");
      }
    }
    const dispatch = vi.fn(async () => {
      await stateManager.startSession({ sessionId: "opencode-session", workspacePath: "/workspace" });
      await stateManager.updateActivity({ sessionId: "opencode-session", status: "running", isStreaming: true });
      return true;
    });
    await expect(runTurn({
      session: openCodeSession({ provider: continuation === "queue" ? "opencode" : "claude-code" }),
      provider: new BackgroundProvider(),
      service: { tryDispatchNextQueuedPrompt: dispatch },
    })).rejects.toThrow("lead failed");
    expect(dispatch).toHaveBeenCalledTimes(continuation === "queue" ? 1 : 0);
    expect(stateManager.getRunningSessionIds()).toEqual(["opencode-session"]);
    expect(stateManager.getSessionState("opencode-session")?.status).toBe("running");
  });
});
