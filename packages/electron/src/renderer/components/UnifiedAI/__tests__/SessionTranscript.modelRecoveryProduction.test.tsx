import React from "react";
import { Provider } from "jotai";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const productionSeam = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => unknown>(),
  sessionStore: null as any,
  queueStore: null as any,
  browserWindow: null as any,
  ptyWrite: vi.fn(),
  logUserPrompt: vi.fn(async () => undefined),
  analytics: vi.fn(),
  reveal: vi.fn(),
  rendererNotification: vi.fn(),
  sdkSend: vi.fn(async (..._args: unknown[]) => ({ content: "sent" })),
  startSession: vi.fn(async () => undefined),
  endSession: vi.fn(async () => undefined),
  terminalInterrupt: vi.fn(),
  providerAbort: vi.fn(),
  providerInterrupt: vi.fn(async () => ({ nativeEntered: true })),
  providerGetSpy: null as any,
  loggerInfoSpy: null as any,
}));

vi.mock("@nimbalyst/runtime/storage/repositories/AISessionsRepository", () => ({
  AISessionsRepository: {
    get: (sessionId: string) =>
      productionSeam.sessionStore?.get(sessionId) ?? null,
    updateMetadata: (sessionId: string, updates: unknown) =>
      productionSeam.sessionStore?.updateMetadata(sessionId, updates),
  },
}));
vi.mock("../../../../main/services/RepositoryManager", () => ({
  getQueuedPromptsStore: () => productionSeam.queueStore,
}));
vi.mock("../../../../main/utils/ipcRegistry", () => ({
  safeHandle: vi.fn((channel: string, handler: (...args: any[]) => unknown) => {
    productionSeam.handlers.set(channel, handler);
  }),
  safeOn: vi.fn(),
  safeSend: vi.fn(),
}));
vi.mock("../../../../main/services/TerminalSessionManager", () => ({
  getTerminalSessionManager: () => ({
    writeToTerminal: productionSeam.ptyWrite,
    isTerminalActive: vi.fn(() => true),
    getClaudeCliLiveTurnState: vi.fn(async () => "idle"),
    getTerminalInfo: vi.fn(),
    createTerminal: vi.fn(),
    interruptClaudeCliTurn: productionSeam.terminalInterrupt,
    resizeTerminal: vi.fn(),
    destroyTerminal: vi.fn(),
  }),
}));
vi.mock("../../../../main/services/analytics/AnalyticsService", () => ({
  AnalyticsService: {
    getInstance: () => ({ sendEvent: productionSeam.analytics }),
  },
}));
vi.mock("../../../../main/services/ai/claudeCliUserPromptLog", () => ({
  logClaudeCliUserPrompt: productionSeam.logUserPrompt,
}));
vi.mock("../../../../main/services/ai/claudeCliRevealTerminal", () => ({
  broadcastClaudeCliRevealTerminal: productionSeam.reveal,
}));
vi.mock("../../../../main/services/ai/claudeCliLauncherSingleton", () => ({
  ensureClaudeCliSession: vi.fn(),
  isClaudeCliInstalled: vi.fn(async () => true),
  claudeCliSessionSupportsPlugins: vi.fn(() => false),
}));
vi.mock("@nimbalyst/runtime/ai/server/SessionStateManager", () => ({
  getSessionStateManager: () => ({
    startSession: productionSeam.startSession,
    endSession: productionSeam.endSession,
    getSessionState: vi.fn(() => ({ status: "idle" })),
  }),
}));
vi.mock("../../../../main/window/WindowManager", () => ({
  windowStates: new Map(),
  findWindowByWorkspace: () => productionSeam.browserWindow,
  getWindowId: vi.fn(() => 1),
  createWindow: vi.fn(),
}));
vi.mock("electron", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    BrowserWindow: {
      fromWebContents: () => productionSeam.browserWindow,
      getAllWindows: () =>
        productionSeam.browserWindow ? [productionSeam.browserWindow] : [],
    },
    ipcMain: {
      listenerCount: vi.fn(() => 0),
      emit: vi.fn(),
      handle: vi.fn(),
      removeHandler: vi.fn(),
      on: vi.fn(),
    },
    app: {
      isPackaged: false,
      getPath: vi.fn(() => "D:/nimbalyst-brain-swap-v14/.test-electron"),
      getAppPath: vi.fn(() => "D:/nimbalyst-brain-swap-v14"),
    },
  };
});

vi.mock(
  "@nimbalyst/runtime/ui/AgentTranscript/components/AgentTranscriptPanel",
  () => ({
    AgentTranscriptPanel: () => <div data-testid="transcript-panel" />,
  })
);
vi.mock("../ClaudeCliTerminalStrip", () => ({
  ClaudeCliTerminalStrip: () => <div data-testid="real-cli-terminal-strip" />,
}));
vi.mock("../ClaudeCliNotInstalledNotice", () => ({
  ClaudeCliNotInstalledNotice: () => null,
}));
vi.mock("../TranscriptEmbeddedFileCard", () => ({
  TranscriptEmbeddedFileCard: () => null,
}));
vi.mock("../../AIChat/FileGutter", () => ({ FileGutter: () => null }));
vi.mock("../../AIChat/PendingReviewBanner", () => ({
  PendingReviewBanner: () => null,
}));
vi.mock("../../AIChat/WakeupBanner", () => ({ WakeupBanner: () => null }));
vi.mock("../SlashCommandSuggestions", () => ({
  SlashCommandSuggestions: () => null,
}));
vi.mock("../../../tips/InlineTipDisplay", () => ({
  InlineTipDisplay: () => null,
}));
vi.mock("../ContextUsageDisplay", () => ({ ContextUsageDisplay: () => null }));
vi.mock("../ActionPromptsDropdown", () => ({
  ActionPromptsDropdown: () => null,
}));
vi.mock("../../../contexts/DialogContext", () => ({
  useDialog: () => ({ confirm: vi.fn(async () => true) }),
}));
vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({ capture: vi.fn() }),
}));
vi.mock("../../../store/listeners/fileStateListeners", () => ({
  registerSessionWorkspace: vi.fn(),
  loadInitialSessionFileState: vi.fn(async () => undefined),
}));
vi.mock("../../../store/listeners/claudeUsageListeners", () => ({
  recordClaudeActivity: vi.fn(),
}));
vi.mock("../../../store/listeners/codexUsageListeners", () => ({
  recordCodexActivity: vi.fn(),
}));
vi.mock("../../CustomEditors/registry", () => ({
  customEditorRegistry: { findRegistrationForFile: vi.fn(() => null) },
}));
// SessionTranscript normally reaches the broad renderer-store barrel, which
// initializes unrelated listener graphs. Keep the production atoms themselves
// while replacing only the listener-side exports this mounted proof does not use.
vi.mock("../../../store", async () => {
  const [sessions, transcript, sessionFiles, fileMention, sessionMention] =
    await Promise.all([
      import("../../../store/atoms/sessions"),
      import("../../../store/atoms/sessionTranscript"),
      import("../../../store/atoms/sessionFiles"),
      import("../../../store/atoms/fileMention"),
      import("../../../store/atoms/sessionMention"),
    ]);
  return {
    ...sessions,
    ...transcript,
    ...fileMention,
    ...sessionMention,
    sessionPendingReviewFilesAtom: sessionFiles.sessionPendingReviewFilesAtom,
    loadInitialQueuedPrompts: vi.fn(async () => undefined),
    clearSessionError: vi.fn(),
  };
});

import { store } from "@nimbalyst/runtime/store";
import { PGlite } from "@electric-sql/pglite";
import { SessionTranscript } from "../SessionTranscript";
import { AIInput } from "../AIInput";
import {
  createPGLiteQueuedPromptsStore,
  SWEEP_UNANSWERED_ERROR,
} from "../../../../main/services/PGLiteQueuedPromptsStore";
import { createPGLiteSessionStore } from "../../../../main/services/PGLiteSessionStore";
import {
  sessionDraftInputAtom,
  sessionModelReconciliationGateAtom,
  sessionProcessingAtom,
  sessionStoreAtom,
} from "../../../store/atoms/sessions";
import { sessionQueuedPromptsAtom } from "../../../store/atoms/sessionTranscript";
import type { DurableSessionModelChangeReconciliation } from "../latestModelChangeCoordinator";

const marker: DurableSessionModelChangeReconciliation = {
  status: "pending",
  targetModel: "openai-codex:gpt-5.4",
  targetControls: { effortLevel: "high", thinkingMode: "enabled" },
  previousModel: "openai-codex:gpt-5.3-codex",
  previousControls: { effortLevel: "low", thinkingMode: "disabled" },
};

const cliMarker: DurableSessionModelChangeReconciliation = {
  ...marker,
  targetModel: "claude-code-cli:sonnet",
  previousModel: "claude-code-cli:sonnet",
};

const sdkModel = "claude-code:deepseek-v4-pro";
const alternateSdkModel = "claude-code:deepseek-v4-flash";
const alternateProviderModel = "opencode:kimi-k2";
const sdkMarker: DurableSessionModelChangeReconciliation = {
  ...marker,
  targetModel: sdkModel,
  previousModel: sdkModel,
};

const catalogControls = [
  {
    id: "effort",
    persistenceKey: "effort-level",
    displayLabel: "Effort",
    helpText: "Reasoning effort",
    allowedValues: ["high", "max"],
    defaultValue: "high",
    valueLabels: { '"high"': "High", '"max"': "Max" },
  },
  {
    id: "thinking",
    persistenceKey: "thinking-mode",
    displayLabel: "Thinking",
    helpText: "Extended thinking",
    allowedValues: ["enabled", "disabled"],
    defaultValue: "enabled",
    valueLabels: { '"enabled"': "On", '"disabled"': "Off" },
  },
];

function catalogModel(id: string, name: string, provider = "claude-code") {
  return {
    id,
    name,
    provider,
    catalog: {
      entryId: id,
      family: "test-family",
      version: "test-version",
      capabilities: {
        mainSession: true,
        subagent: true,
        consultation: true,
        tools: true,
        vision: false,
      },
      controls: catalogControls,
      availability: { selectable: true, code: "available" },
    },
  };
}

const catalogResponse = {
  success: true,
  grouped: {
    "claude-code": [
      catalogModel(sdkModel, "DeepSeek v4 Pro"),
      catalogModel(alternateSdkModel, "DeepSeek v4 Flash"),
    ],
    opencode: [catalogModel(alternateProviderModel, "Kimi K2", "opencode")],
  },
};

let productionDb: PGlite | null = null;

async function initializeProductionSeam() {
  productionDb = new PGlite();
  await productionDb.exec(`
    CREATE TABLE worktrees (
      id TEXT PRIMARY KEY,
      path TEXT,
      workspace_id TEXT
    );
    CREATE TABLE ai_sessions (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      model TEXT,
      title TEXT,
      session_type TEXT,
      mode TEXT,
      agent_role TEXT,
      created_by_session_id TEXT,
      workspace_id TEXT,
      draft_input TEXT,
      worktree_id TEXT,
      parent_session_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      metadata JSONB,
      document_context JSONB,
      provider_config JSONB,
      provider_session_id TEXT,
      last_read_timestamp TIMESTAMPTZ,
      has_been_named BOOLEAN DEFAULT FALSE,
      is_archived BOOLEAN DEFAULT FALSE,
      is_pinned BOOLEAN DEFAULT FALSE,
      branched_from_session_id TEXT,
      branch_point_message_id INTEGER,
      branched_at TIMESTAMPTZ,
      last_document_state JSONB
    );
    CREATE TABLE queued_prompts (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attachments JSONB,
      document_context JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      claimed_at TIMESTAMPTZ,
      claim_token TEXT,
      dispatch_started_at TIMESTAMPTZ,
      settlement_provenance TEXT,
      completed_at TIMESTAMPTZ,
      error_message TEXT,
      delivery_class TEXT NOT NULL DEFAULT 'ordinary',
      priority_rank INTEGER NOT NULL DEFAULT 0,
      delivery_ready BOOLEAN NOT NULL DEFAULT TRUE,
      producer TEXT,
      idempotency_key TEXT,
      request_digest TEXT,
      control_operation TEXT,
      interrupt_target_generation TEXT,
      interrupt_reservation_owner TEXT,
      interrupt_receipt JSONB,
      client_submission_id TEXT UNIQUE,
      source_session_id TEXT,
      source_room_id TEXT,
      submission_sequence INTEGER,
      payload_utf8_bytes INTEGER,
      payload_unicode_scalars INTEGER,
      payload_sha256 TEXT,
      claim_trigger TEXT,
      claim_triggered_at TIMESTAMPTZ,
      turn_id TEXT,
      provider_input_message_id TEXT,
      provider_output_message_id TEXT,
      stream_event_sequence INTEGER NOT NULL DEFAULT 0,
      terminal_status TEXT,
      terminal_at TIMESTAMPTZ
    );
    CREATE TABLE queued_prompt_source_sequences (
      source_session_id TEXT PRIMARY KEY,
      next_sequence INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX idx_queued_prompts_source_sequence
      ON queued_prompts(source_session_id, submission_sequence);
    CREATE UNIQUE INDEX idx_queued_prompts_interrupt_generation_owner
      ON queued_prompts(session_id, interrupt_target_generation)
      WHERE delivery_class = 'control' AND interrupt_target_generation IS NOT NULL;
    CREATE UNIQUE INDEX idx_queued_prompts_control_idempotency
      ON queued_prompts(session_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;
    CREATE TABLE ai_agent_messages (
      id BIGSERIAL PRIMARY KEY,
      session_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      source TEXT NOT NULL,
      direction TEXT NOT NULL,
      content TEXT NOT NULL
    );
  `);
  productionSeam.sessionStore = createPGLiteSessionStore(productionDb as any);
  productionSeam.queueStore = createPGLiteQueuedPromptsStore(
    productionDb as any
  );
  productionSeam.browserWindow = {
    isDestroyed: () => false,
    webContents: {
      send: productionSeam.rendererNotification,
      mainFrame: {},
    },
  };
  productionSeam.handlers.clear();
  productionSeam.ptyWrite.mockClear();
  productionSeam.logUserPrompt.mockClear();
  productionSeam.analytics.mockClear();
  productionSeam.reveal.mockClear();
  productionSeam.rendererNotification.mockClear();
  productionSeam.sdkSend.mockClear();
  productionSeam.startSession.mockClear();
  productionSeam.endSession.mockClear();
  productionSeam.terminalInterrupt.mockClear();
  productionSeam.providerAbort.mockClear();
  productionSeam.providerInterrupt.mockClear();
  productionSeam.providerGetSpy?.mockRestore();
  productionSeam.loggerInfoSpy?.mockRestore();

  const [
    { AIService },
    { registerTerminalHandlers },
    { ProviderFactory },
    { logger },
  ] = await Promise.all([
    import("../../../../main/services/ai/AIService"),
    import("../../../../main/ipc/TerminalHandlers"),
    import("@nimbalyst/runtime/ai/server"),
    import("../../../../main/utils/logger"),
  ]);
  productionSeam.loggerInfoSpy = vi.spyOn(logger.main, "info");
  productionSeam.providerGetSpy = vi
    .spyOn(ProviderFactory, "getProvider")
    .mockReturnValue({
      abort: productionSeam.providerAbort,
      interruptCurrentTurn: productionSeam.providerInterrupt,
    } as any);
  const aiService = Object.create(AIService.prototype) as any;
  aiService.streamingHandler = { handle: productionSeam.sdkSend };
  aiService.sendMessageHandler = productionSeam.sdkSend;
  aiService.analytics = { sendEvent: productionSeam.analytics };
  aiService.queueProcessingLeases = new Map();
  aiService.directSendInFlight = new Set();
  aiService.sessionManager = { saveDraftInput: vi.fn(async () => true) };
  aiService.hooklessWatcher = { scheduleStop: vi.fn() };
  aiService.setupIpcHandlers();
  registerTerminalHandlers();
  return aiService;
}

async function seedProductionSession(
  sessionId: string,
  provider: string,
  reconciliation: unknown
) {
  await productionDb!.query(
    `INSERT INTO ai_sessions
       (id, provider, model, title, session_type, mode, agent_role, workspace_id, metadata)
     VALUES ($1, $2, $3, $1, 'session', 'agent', 'standard', '/workspace', $4::jsonb)`,
    [
      sessionId,
      provider,
      provider === "claude-code-cli"
        ? "claude-code-cli:sonnet"
        : provider === "claude-code"
        ? sdkModel
        : "openai-codex:gpt-5.3-codex",
      JSON.stringify({ modelChangeReconciliation: reconciliation }),
    ]
  );
}

function seedSession(
  sessionId: string,
  reconciliation: unknown,
  options: {
    processing?: boolean;
    messages?: any[];
    provider?: string;
    queue?: boolean;
  } = {}
) {
  const provider = options.provider ?? "openai-codex";
  store.set(sessionStoreAtom(sessionId), {
    id: sessionId,
    title: sessionId,
    workspacePath: "/workspace",
    provider,
    model:
      provider === "claude-code-cli"
        ? "claude-code-cli:sonnet"
        : provider === "claude-code"
        ? sdkModel
        : "openai-codex:gpt-5.3-codex",
    mode: "agent",
    status: options.processing ? "running" : "idle",
    isArchived: false,
    messages: options.messages ?? [],
    createdAt: 1,
    updatedAt: 1,
    metadata:
      typeof reconciliation === "string"
        ? reconciliation
        : { modelChangeReconciliation: reconciliation },
  } as never);
  store.set(sessionProcessingAtom(sessionId), options.processing ?? false);
  store.set(
    sessionQueuedPromptsAtom(sessionId),
    options.queue === false
      ? []
      : [{ id: `${sessionId}-queued`, prompt: "keep pending", timestamp: 1 }]
  );
  store.set(sessionDraftInputAtom(sessionId), "blocked draft");
  store.set(sessionModelReconciliationGateAtom(sessionId), { status: "idle" });
}

function Transcript({ sessionId }: { sessionId: string }) {
  return (
    <Provider store={store}>
      <SessionTranscript
        sessionId={sessionId}
        workspacePath="/workspace"
        mode="agent"
        collapseTranscript
        hideSidebar
      />
    </Provider>
  );
}

describe("SessionTranscript mounted production model-recovery seam", () => {
  let invoke: ReturnType<typeof vi.fn>;
  let recoveryBlocked: boolean;

  beforeEach(() => {
    recoveryBlocked = true;
    invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
      if (channel === "sessions:update-metadata" && recoveryBlocked) {
        throw new Error("store unavailable");
      }
      if (channel === "ai:createQueuedPrompt") {
        return { id: "created", prompt: args[1], timestamp: 2 };
      }
      return { success: true };
    });

    class TestIntersectionObserver {
      observe() {}
      disconnect() {}
      unobserve() {}
    }
    Object.defineProperty(globalThis, "IntersectionObserver", {
      configurable: true,
      value: TestIntersectionObserver,
    });
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: {
        invoke,
        aiLoadSession: vi.fn(async (sessionId: string) =>
          store.get(sessionStoreAtom(sessionId))
        ),
        aiGetModels: vi.fn(async () => ({ success: true, grouped: {} })),
        readFileContent: vi.fn(async () => ({ success: false })),
        extensionDevTools: {
          getProcessInfo: vi.fn(async () => ({ startTime: 0 })),
        },
        terminal: {
          isClaudeCliInstalled: vi.fn(async () => true),
          setClaudeCliModel: vi.fn(async () => ({ success: true })),
          interruptClaudeCli: vi.fn(async () => ({ success: true })),
          submitClaudeCliPrompt: vi.fn(async (payload: unknown) => {
            const handler = productionSeam.handlers.get(
              "claude-cli:submit-prompt"
            );
            if (!handler)
              throw new Error("Production CLI handler is not registered");
            return handler({}, payload);
          }),
        },
      },
    });
  });

  afterEach(async () => {
    if (productionDb) {
      await productionDb.close();
      productionDb = null;
    }
    productionSeam.sessionStore = null;
    productionSeam.queueStore = null;
    productionSeam.browserWindow = null;
    productionSeam.providerGetSpy?.mockRestore();
    productionSeam.providerGetSpy = null;
    productionSeam.loggerInfoSpy?.mockRestore();
    productionSeam.loggerInfoSpy = null;
  });

  it("makes the actual disabled AIInput cancel control and Escape inert", () => {
    const onCancel = vi.fn();
    render(
      <Provider store={store}>
        <AIInput
          value=""
          onChange={vi.fn()}
          onSend={vi.fn()}
          onCancel={onCancel}
          disabled
          isLoading
          testId="disabled-cancel-input"
        />
      </Provider>
    );

    const input = screen.getByTestId(
      "disabled-cancel-input"
    ) as HTMLTextAreaElement;
    const cancel = screen.getByRole("button", { name: "Cancel request" });
    expect((cancel as HTMLButtonElement).disabled).toBe(true);
    expect(cancel.getAttribute("aria-disabled")).toBe("true");
    expect(cancel.getAttribute("title")).toBe(
      "Unavailable while model recovery completes"
    );
    fireEvent.click(cancel);
    fireEvent.keyDown(input, { key: "Escape", code: "Escape" });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("mounts the actual transcript, owner, AIInput, and queue controls and visibly disables the full mutation surface", async () => {
    seedSession("blocked", marker, { processing: true });
    seedSession("other", null);
    const durableQueueBefore = store.get(sessionQueuedPromptsAtom("blocked"));

    render(
      <>
        <Transcript sessionId="blocked" />
        <Transcript sessionId="other" />
      </>
    );

    await waitFor(() =>
      expect(screen.getByTestId("model-reconciliation-retry")).toBeTruthy()
    );
    const blockedInput = screen.getAllByTestId(
      "agent-mode-chat-input"
    )[0] as HTMLTextAreaElement;
    const otherInput = screen.getAllByTestId(
      "agent-mode-chat-input"
    )[1] as HTMLTextAreaElement;
    expect(blockedInput.disabled).toBe(true);
    expect(otherInput.disabled).toBe(false);

    const queues = document.querySelectorAll(".prompt-queue-list");
    expect(queues[0]?.getAttribute("aria-disabled")).toBe("true");
    expect(queues[1]?.getAttribute("aria-disabled")).toBe("false");
    const blockedButtons = queues[0]?.querySelectorAll("button") ?? [];
    expect(blockedButtons.length).toBeGreaterThanOrEqual(3);
    expect(Array.from(blockedButtons).every((button) => button.disabled)).toBe(
      true
    );
    expect(
      Array.from(blockedButtons).every(
        (button) =>
          button.title === "Unavailable while model recovery completes"
      )
    ).toBe(true);
    expect(screen.queryByTestId("real-cli-terminal-strip")).toBeNull();

    const mutationChannels = new Set([
      "ai:sendMessage",
      "ai:createQueuedPrompt",
      "ai:deleteQueuedPrompt",
      "ai:cancelRequest",
      "sessions:update-metadata",
    ]);
    const mutationCallsBefore = invoke.mock.calls.filter(([channel]) =>
      mutationChannels.has(channel)
    );

    await act(async () => {
      Array.from(blockedButtons).forEach((button) => fireEvent.click(button));
      fireEvent.keyDown(blockedInput, { key: "Enter", code: "Enter" });

      const blockedCancel = document.querySelector(
        'button[aria-label="Cancel request"]'
      ) as HTMLButtonElement;
      expect(blockedCancel.disabled).toBe(true);
      fireEvent.click(blockedCancel);
      fireEvent.keyDown(blockedInput, { key: "Escape", code: "Escape" });
      blockedCancel.disabled = false;
      fireEvent.click(blockedCancel);
      blockedCancel.disabled = true;

      const modelPicker = document.querySelector(
        '[data-testid="model-picker"]'
      ) as HTMLElement;
      expect(modelPicker.tagName).toBe("SPAN");
      fireEvent.click(modelPicker);
      await Promise.resolve();
    });

    expect(
      invoke.mock.calls.filter(([channel]) => mutationChannels.has(channel))
    ).toEqual(mutationCallsBefore);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(store.get(sessionQueuedPromptsAtom("blocked"))).toEqual(
      durableQueueBefore
    );
    expect(queues[0]?.querySelector(".prompt-queue-text")?.textContent).toBe(
      "keep pending"
    );
  });

  it("keeps the real mounted controls closed across a failed recovery and remount, then resumes once after committed recovery", async () => {
    seedSession("persistent", marker, { processing: true });
    const first = render(<Transcript sessionId="persistent" />);

    await waitFor(() =>
      expect(screen.getByTestId("model-reconciliation-retry")).toBeTruthy()
    );
    expect(
      (screen.getByTestId("agent-mode-chat-input") as HTMLTextAreaElement)
        .disabled
    ).toBe(true);
    first.unmount();
    render(<Transcript sessionId="persistent" />);
    await waitFor(() =>
      expect(screen.getByTestId("model-reconciliation-retry")).toBeTruthy()
    );
    expect(
      (screen.getByTestId("agent-mode-chat-input") as HTMLTextAreaElement)
        .disabled
    ).toBe(true);

    recoveryBlocked = false;
    store.set(sessionProcessingAtom("persistent"), false);
    await act(async () => {
      fireEvent.click(screen.getByTestId("model-reconciliation-retry"));
    });

    await waitFor(() => {
      expect(
        (screen.getByTestId("agent-mode-chat-input") as HTMLTextAreaElement)
          .disabled
      ).toBe(false);
    });
    expect(
      (
        store.get(sessionStoreAtom("persistent"))?.metadata as Record<
          string,
          unknown
        >
      ).modelChangeReconciliation
    ).toBeNull();
    await waitFor(() => {
      expect(
        invoke.mock.calls.filter(
          ([channel]) => channel === "ai:triggerQueueProcessing"
        )
      ).toHaveLength(2);
    });
  });

  it("coalesces simultaneous actual transcript owners and opens both only after the durable commit", async () => {
    seedSession("coalesced", marker);
    let release!: () => void;
    const delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === "sessions:update-metadata") await delayed;
      return { success: true };
    });

    render(
      <>
        <Transcript sessionId="coalesced" />
        <Transcript sessionId="coalesced" />
      </>
    );
    expect(
      screen
        .getAllByTestId("agent-mode-chat-input")
        .every((node) => (node as HTMLTextAreaElement).disabled)
    ).toBe(true);
    await waitFor(() => {
      expect(
        invoke.mock.calls.filter(
          ([channel]) => channel === "sessions:update-metadata"
        )
      ).toHaveLength(1);
    });

    await act(async () => {
      release();
      await delayed;
    });
    await waitFor(() => {
      expect(
        screen
          .getAllByTestId("agent-mode-chat-input")
          .every((node) => !(node as HTMLTextAreaElement).disabled)
      ).toBe(true);
    });
    expect(
      invoke.mock.calls.filter(
        ([channel]) => channel === "sessions:update-metadata"
      )
    ).toHaveLength(2);
  });

  it("preserves mounted queue state when an authoritative pending-delete CAS loses", async () => {
    seedSession("queue-cas", null, { provider: "claude-code" });
    invoke.mockImplementation(async (channel: string) => {
      if (channel === "ai:deleteQueuedPrompt") {
        return {
          success: false,
          error: "Queued prompt deletion was not admitted",
        };
      }
      if (channel === "ai:listPendingPrompts") {
        return [
          { id: "queue-cas-queued", prompt: "keep pending", timestamp: 1 },
        ];
      }
      return { success: true };
    });
    render(<Transcript sessionId="queue-cas" />);

    const cancel = await waitFor(() => {
      const button = document.querySelector(
        ".prompt-queue-cancel"
      ) as HTMLButtonElement;
      expect(button).toBeTruthy();
      return button;
    });
    fireEvent.click(cancel);
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "ai:deleteQueuedPrompt",
        "queue-cas",
        "queue-cas-queued"
      );
      expect(invoke).toHaveBeenCalledWith("ai:listPendingPrompts", "queue-cas");
    });
    expect(document.querySelector(".prompt-queue-text")?.textContent).toBe(
      "keep pending"
    );
  });

  it("consumes captured main registrations through the real store, SDK dispatcher, CLI core, and PTY sink", async () => {
    await initializeProductionSeam();
    const sendMessage = productionSeam.sdkSend;

    await Promise.all([
      seedProductionSession("sdk-blocked", "claude-code", sdkMarker),
      seedProductionSession("cli-blocked", "claude-code-cli", cliMarker),
      seedProductionSession("delayed", "openai-codex", marker),
      seedProductionSession("malformed-production", "openai-codex", "bad"),
      seedProductionSession("other-production", "claude-code", null),
    ]);
    await productionDb!.query(
      `INSERT INTO queued_prompts (id, session_id, prompt)
       VALUES ($1, $2, $3)`,
      ["sdk-blocked-queued", "sdk-blocked", "sdk once"]
    );
    await productionSeam.queueStore.create({
      id: "ordinary-failed",
      sessionId: "other-production",
      prompt: "ordinary failure",
    });
    await productionSeam.queueStore.create({
      id: "sweep-failed",
      sessionId: "other-production",
      prompt: "late sweep",
    });
    const ordinaryFailureClaim = await productionSeam.queueStore.claim(
      "ordinary-failed",
      "other-production"
    );
    const sweepFailureClaim = await productionSeam.queueStore.claim(
      "sweep-failed",
      "other-production"
    );
    await productionSeam.queueStore.beginDispatch(
      "ordinary-failed",
      "other-production",
      ordinaryFailureClaim!.claimToken!
    );
    await productionSeam.queueStore.beginDispatch(
      "sweep-failed",
      "other-production",
      sweepFailureClaim!.claimToken!
    );
    await productionSeam.queueStore.failAfterDispatch(
      "ordinary-failed",
      "permanent send failure",
      "other-production",
      ordinaryFailureClaim!.claimToken!
    );
    await productionDb!.query(
      `INSERT INTO ai_agent_messages (session_id, source, direction, content)
       VALUES ($1, 'mounted-proof', 'input', 'late sweep')`,
      ["other-production"]
    );
    await expect(
      productionSeam.queueStore.sweepExecutingForSession("other-production")
    ).resolves.toMatchObject({ completed: 0, failed: 1, rolledBack: 0 });
    await productionSeam.queueStore.create({
      id: "reserved-forge",
      sessionId: "other-production",
      prompt: "forge reserved sweep marker",
    });
    await productionSeam.queueStore.claim("reserved-forge", "other-production");

    const successfulClaims: string[] = [];
    const originalClaim = productionSeam.queueStore.claim.bind(
      productionSeam.queueStore
    );
    const claim = vi
      .spyOn(productionSeam.queueStore, "claim")
      .mockImplementation(async (promptId: unknown, sessionId: unknown) => {
        const claimed = await originalClaim(
          String(promptId),
          String(sessionId)
        );
        if (claimed) successfulClaims.push(claimed.id);
        return claimed;
      });
    const create = vi.spyOn(productionSeam.queueStore, "create");
    const remove = vi.spyOn(productionSeam.queueStore, "deletePending");
    const successfulCompletions: string[] = [];
    const originalCompleteAfterDispatch =
      productionSeam.queueStore.completeAfterDispatch.bind(
        productionSeam.queueStore
      );
    const completeAfterDispatch = vi
      .spyOn(productionSeam.queueStore, "completeAfterDispatch")
      .mockImplementation(
        async (promptId: unknown, sessionId: unknown, claimToken: unknown) => {
          const completed = await originalCompleteAfterDispatch(
            String(promptId),
            String(sessionId),
            String(claimToken)
          );
          if (completed.outcome === "settled")
            successfulCompletions.push(String(promptId));
          return completed;
        }
      );
    const successfulFailures: string[] = [];
    const originalFail = productionSeam.queueStore.failAfterDispatch.bind(
      productionSeam.queueStore
    );
    const fail = vi
      .spyOn(productionSeam.queueStore, "failAfterDispatch")
      .mockImplementation(
        async (
          promptId: unknown,
          errorMessage: unknown,
          sessionId: unknown,
          claimToken: unknown
        ) => {
          const failed = await originalFail(
            String(promptId),
            String(errorMessage),
            String(sessionId),
            String(claimToken)
          );
          if (failed.outcome === "settled")
            successfulFailures.push(String(promptId));
          return failed;
        }
      );
    const pendingBefore = await productionSeam.queueStore.get(
      "sdk-blocked-queued"
    );
    const ordinaryFailedBefore = await productionSeam.queueStore.get(
      "ordinary-failed"
    );
    const sweepFailedBefore = await productionSeam.queueStore.get(
      "sweep-failed"
    );
    const reservedForgeBefore = await productionSeam.queueStore.get(
      "reserved-forge"
    );

    seedSession("sdk-blocked", sdkMarker, {
      processing: true,
      provider: "claude-code",
    });
    seedSession("cli-blocked", cliMarker, {
      processing: true,
      provider: "claude-code-cli",
      messages: [{ id: "prior", role: "assistant", content: "ready" }],
      queue: false,
    });
    seedSession("delayed", marker, { queue: false });
    seedSession("malformed-production", "{not-json", { queue: false });
    seedSession("other-production", null, {
      provider: "claude-code",
      queue: false,
    });

    let allowRecovery = false;
    let releaseDelayed!: () => void;
    const delayedRecovery = new Promise<void>((resolve) => {
      releaseDelayed = resolve;
    });
    const successfulMetadataWrites: Array<{
      sessionId: string;
      updates: Record<string, unknown>;
    }> = [];
    const productionInvoke = vi.fn(
      async (channel: string, ...args: unknown[]) => {
        if (channel === "sessions:update-metadata") {
          const sessionId = String(args[0]);
          if (!allowRecovery && sessionId !== "other-production") {
            if (sessionId === "cli-blocked") {
              throw new Error("session store unavailable");
            }
            if (sessionId === "delayed") {
              await delayedRecovery;
            } else {
              return { success: false, error: "recovery rejected" };
            }
          }
          await productionSeam.sessionStore.updateMetadata(sessionId, args[1]);
          successfulMetadataWrites.push({
            sessionId,
            updates: args[1] as Record<string, unknown>,
          });
          return { success: true };
        }
        const handler = productionSeam.handlers.get(channel);
        if (handler) {
          return handler(
            { sender: productionSeam.browserWindow.webContents },
            ...args
          );
        }
        if (channel === "workspace:get-state") return null;
        if (
          channel === "workspace:update-state" &&
          args[0] === "/workspace" &&
          ((args[1] as any)?.aiPanel?.promptBoxHeight === null ||
            typeof (args[1] as any)?.aiPanel?.promptBoxHeight === "number") &&
          Object.keys(args[1] as object).length === 1 &&
          Object.keys((args[1] as any).aiPanel).length === 1
        ) {
          return { success: true };
        }
        if (
          channel === "settings:set-default-ai-model" &&
          [
            marker.targetModel,
            marker.previousModel,
            cliMarker.targetModel,
            cliMarker.previousModel,
            sdkModel,
            alternateSdkModel,
            alternateProviderModel,
          ].includes(String(args[0]))
        ) {
          return { success: true };
        }
        if (
          channel === "settings:set-default-effort-level" &&
          ["low", "high", "max"].includes(String(args[0]))
        ) {
          return { success: true };
        }
        if (
          channel === "settings:set-default-thinking-mode" &&
          ["enabled", "disabled"].includes(String(args[0]))
        ) {
          return { success: true };
        }
        throw new Error(`Unexpected renderer IPC channel: ${channel}`);
      }
    );
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: {
        invoke: productionInvoke,
        aiLoadSession: (sessionId: string) =>
          store.get(sessionStoreAtom(sessionId)),
        aiGetModels: vi.fn(async () => catalogResponse),
        readFileContent: vi.fn(async () => ({ success: false })),
        extensionDevTools: {
          getProcessInfo: vi.fn(async () => ({ startTime: 0 })),
        },
        terminal: {
          isClaudeCliInstalled: vi.fn(async () => true),
          setClaudeCliModel: vi.fn(async () => ({ success: true })),
          interruptClaudeCli: (sessionId: string) =>
            productionSeam.handlers.get("claude-cli:interrupt")!({}, sessionId),
          submitClaudeCliPrompt: (payload: unknown) =>
            productionSeam.handlers.get("claude-cli:submit-prompt")!(
              {},
              payload
            ),
        },
      },
    });

    const mounted = render(
      <>
        <Transcript sessionId="sdk-blocked" />
        <Transcript sessionId="sdk-blocked" />
        <Transcript sessionId="cli-blocked" />
        <Transcript sessionId="delayed" />
        <Transcript sessionId="delayed" />
        <Transcript sessionId="malformed-production" />
        <Transcript sessionId="other-production" />
      </>
    );
    const transcript = (sessionId: string) =>
      document.querySelector(`[data-session-id="${sessionId}"]`) as HTMLElement;
    const transcripts = (sessionId: string) =>
      Array.from(
        document.querySelectorAll(`[data-session-id="${sessionId}"]`)
      ) as HTMLElement[];

    await waitFor(() => {
      expect(transcripts("sdk-blocked")).toHaveLength(2);
      expect(
        transcripts("sdk-blocked").every((root) =>
          root.querySelector('[data-testid="model-reconciliation-retry"]')
        )
      ).toBe(true);
      expect(
        transcript("cli-blocked").querySelector(
          '[data-testid="model-reconciliation-retry"]'
        )
      ).toBeTruthy();
    });
    const metadataCallsFor = (sessionId: string) =>
      productionInvoke.mock.calls.filter(
        ([channel, targetSessionId]) =>
          channel === "sessions:update-metadata" &&
          targetSessionId === sessionId
      );
    const successfulCommittedMetadataWritesFor = (sessionId: string) =>
      successfulMetadataWrites.filter(({ sessionId: target, updates }) => {
        const metadata = updates.metadata as
          | Record<string, unknown>
          | undefined;
        return (
          target === sessionId &&
          typeof updates.model === "string" &&
          metadata?.modelChangeReconciliation === null
        );
      });
    await waitFor(() => {
      expect(metadataCallsFor("sdk-blocked").length).toBeGreaterThan(0);
      expect(metadataCallsFor("delayed")).toHaveLength(1);
    });
    const sdkMetadataBeforeRecovery = metadataCallsFor("sdk-blocked").length;

    const sdkRoot = transcript("sdk-blocked");
    const sdkInput = sdkRoot.querySelector(
      '[data-testid="agent-mode-chat-input"]'
    ) as HTMLTextAreaElement;
    expect(sdkInput.disabled).toBe(true);
    const queue = sdkRoot.querySelector(".prompt-queue-list")!;
    expect(queue.getAttribute("aria-disabled")).toBe("true");
    const queueButtons = Array.from(queue.querySelectorAll("button"));
    expect(queueButtons).toHaveLength(3);
    expect(queueButtons.every((button) => button.disabled)).toBe(true);
    queueButtons.forEach((button) => fireEvent.click(button));
    fireEvent.keyDown(sdkInput, { key: "Enter", code: "Enter" });

    const cliRoot = transcript("cli-blocked");
    const cliBlockedInput = cliRoot.querySelector(
      '[data-testid="agent-mode-chat-input"]'
    ) as HTMLTextAreaElement;
    const sdkCancel = sdkRoot.querySelector(
      'button[aria-label="Cancel request"]'
    ) as HTMLButtonElement;
    const cliCancel = cliRoot.querySelector(
      'button[aria-label="Cancel request"]'
    ) as HTMLButtonElement;
    for (const [input, cancel] of [
      [sdkInput, sdkCancel],
      [cliBlockedInput, cliCancel],
    ] as const) {
      expect(cancel).toBeTruthy();
      expect(cancel.disabled).toBe(true);
      expect(cancel.getAttribute("aria-disabled")).toBe("true");
      fireEvent.click(cancel);
      fireEvent.keyDown(input, { key: "Escape", code: "Escape" });

      // Force the DOM control open to isolate SessionTranscript's synchronous
      // guard from AIInput's native disabled behavior.
      cancel.disabled = false;
      fireEvent.click(cancel);
      cancel.disabled = true;
    }
    expect(
      productionInvoke.mock.calls.filter(
        ([channel]) => channel === "ai:cancelRequest"
      )
    ).toHaveLength(0);
    expect(productionSeam.terminalInterrupt).not.toHaveBeenCalled();

    const modelPicker = sdkRoot.querySelector(
      '[data-testid="model-picker"]'
    ) as HTMLElement;
    expect(modelPicker.tagName).toBe("SPAN");
    expect(modelPicker.getAttribute("aria-label")).toBe(
      "Current model: DeepSeek v4 Pro"
    );
    expect(modelPicker.getAttribute("title")).toBeTruthy();
    fireEvent.click(modelPicker);
    expect(screen.queryByRole("menu")).toBeNull();

    const modeControl = sdkRoot.querySelector(
      '[data-testid="plan-mode-toggle"]'
    ) as HTMLButtonElement;
    const effortControl = await waitFor(() =>
      expect(
        sdkRoot.querySelector('[data-testid="catalog-control-effort-level"]')
      ).toBeTruthy()
    ).then(
      () =>
        sdkRoot.querySelector(
          '[data-testid="catalog-control-effort-level"]'
        ) as HTMLButtonElement
    );
    const thinkingControl = sdkRoot.querySelector(
      '[data-testid="catalog-control-thinking-mode"]'
    ) as HTMLButtonElement;
    expect(modeControl.getAttribute("aria-disabled")).toBe("true");
    for (const control of [modeControl, effortControl, thinkingControl]) {
      expect(control).toBeTruthy();
      expect(control.disabled).toBe(true);
      expect(control.title).toBeTruthy();
      fireEvent.click(control);
    }
    expect(metadataCallsFor("sdk-blocked")).toHaveLength(
      sdkMetadataBeforeRecovery
    );
    expect(screen.queryByRole("listbox")).toBeNull();
    await expect(
      productionInvoke("unexpected:mutation", "sdk-blocked")
    ).rejects.toThrow("Unexpected renderer IPC channel: unexpected:mutation");

    const providerLookupsBeforeBlockedHandlers =
      productionSeam.providerGetSpy.mock.calls.length;
    const event = { sender: productionSeam.browserWindow.webContents };
    expect(productionSeam.handlers.has("ai:claimQueuedPrompt")).toBe(false);
    expect(productionSeam.handlers.has("ai:completeQueuedPrompt")).toBe(false);
    expect(productionSeam.handlers.has("ai:failQueuedPrompt")).toBe(false);
    await expect(
      productionSeam.handlers.get("ai:createQueuedPrompt")!(
        event,
        "sdk-blocked",
        "blocked create"
      )
    ).rejects.toThrow("Session model recovery is pending");
    await expect(
      productionSeam.handlers.get("ai:triggerQueueProcessing")!(
        event,
        "sdk-blocked",
        "/workspace"
      )
    ).resolves.toEqual({ processed: false });
    await expect(
      productionSeam.handlers.get("ai:deleteQueuedPrompt")!(
        event,
        "sdk-blocked",
        "sdk-blocked-queued"
      )
    ).resolves.toEqual({
      success: false,
      error: "Queued prompt deletion was not admitted",
    });
    await expect(
      productionSeam.handlers.get("ai:interruptCurrentTurn")!(
        event,
        "sdk-blocked"
      )
    ).resolves.toMatchObject({ success: false, nativeEntered: false });
    await expect(
      productionSeam.handlers.get("ai:cancelRequest")!(event, "sdk-blocked")
    ).resolves.toEqual({
      success: false,
      error: "Session model recovery is pending",
    });
    await expect(
      productionSeam.handlers.get("ai:cancelRequest")!(event, "cli-blocked")
    ).resolves.toEqual({
      success: false,
      error: "Session model recovery is pending",
    });
    await expect(
      productionSeam.handlers.get("claude-cli:submit-prompt")!(
        {},
        {
          sessionId: "cli-blocked",
          workspacePath: "/workspace",
          prompt: "blocked pty",
        }
      )
    ).rejects.toThrow("Session model recovery is pending");
    expect(productionSeam.ptyWrite).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(productionSeam.logUserPrompt).not.toHaveBeenCalled();
    expect(productionSeam.analytics).not.toHaveBeenCalled();
    expect(productionSeam.reveal).not.toHaveBeenCalled();
    expect(productionSeam.startSession).not.toHaveBeenCalled();
    expect(productionSeam.endSession).not.toHaveBeenCalled();
    expect(productionSeam.rendererNotification).not.toHaveBeenCalled();
    expect(productionSeam.terminalInterrupt).not.toHaveBeenCalled();
    expect(productionSeam.providerAbort).not.toHaveBeenCalled();
    expect(productionSeam.providerInterrupt).not.toHaveBeenCalled();
    expect(productionSeam.providerGetSpy).toHaveBeenCalledTimes(
      providerLookupsBeforeBlockedHandlers
    );
    expect(create).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith("sdk-blocked-queued", "sdk-blocked");
    expect(completeAfterDispatch).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
    expect(successfulCompletions).toEqual([]);
    expect(successfulFailures).toEqual([]);
    expect(successfulClaims).toEqual([]);
    expect(await productionSeam.queueStore.get("sdk-blocked-queued")).toEqual(
      pendingBefore
    );
    expect(await productionSeam.queueStore.get("ordinary-failed")).toEqual(
      ordinaryFailedBefore
    );
    expect(await productionSeam.queueStore.get("sweep-failed")).toEqual(
      sweepFailedBefore
    );
    expect(await productionSeam.queueStore.get("reserved-forge")).toEqual(
      reservedForgeBefore
    );

    const otherRoot = transcript("other-production");
    const otherMode = otherRoot.querySelector(
      '[data-testid="plan-mode-toggle"]'
    ) as HTMLButtonElement;
    const otherEffort = await waitFor(() =>
      expect(
        otherRoot.querySelector('[data-testid="catalog-control-effort-level"]')
      ).toBeTruthy()
    ).then(
      () =>
        otherRoot.querySelector(
          '[data-testid="catalog-control-effort-level"]'
        ) as HTMLButtonElement
    );
    const otherThinking = otherRoot.querySelector(
      '[data-testid="catalog-control-thinking-mode"]'
    ) as HTMLButtonElement;
    const otherModelPicker = otherRoot.querySelector(
      '[data-testid="model-picker"]'
    ) as HTMLButtonElement;
    for (const control of [
      otherMode,
      otherEffort,
      otherThinking,
      otherModelPicker,
    ]) {
      expect(control).toBeTruthy();
      expect(control.disabled).toBe(false);
    }

    const otherMetadataBefore = metadataCallsFor("other-production").length;
    fireEvent.click(otherMode);
    await waitFor(() => expect(otherMode.textContent).toBe("Plan"));

    fireEvent.click(otherEffort);
    const effortMenu = await screen.findByTestId(
      "catalog-control-effort-level-menu"
    );
    fireEvent.click(
      Array.from(effortMenu.querySelectorAll("button")).find(
        (button) => button.textContent === "Max"
      )!
    );

    fireEvent.click(otherThinking);
    const thinkingMenu = await screen.findByTestId(
      "catalog-control-thinking-mode-menu"
    );
    fireEvent.click(
      Array.from(thinkingMenu.querySelectorAll("button")).find((button) =>
        button.textContent?.startsWith("Off")
      )!
    );

    fireEvent.click(otherModelPicker);
    await screen.findByTestId("model-picker-provider-claude-code");
    await screen.findByTestId("model-picker-provider-opencode");
    fireEvent.click(screen.getByText("DeepSeek v4 Flash").closest("button")!);
    await waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
      expect(
        otherRoot
          .querySelector('[data-testid="model-picker"]')
          ?.getAttribute("aria-label")
      ).toBe("Current model: DeepSeek v4 Flash");
    });

    const refreshedOtherModelPicker = otherRoot.querySelector(
      '[data-testid="model-picker"]'
    ) as HTMLButtonElement;
    fireEvent.click(refreshedOtherModelPicker);
    await screen.findByTestId("model-picker-provider-opencode");
    fireEvent.click(screen.getByText("Kimi K2").closest("button")!);
    await waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
      expect(metadataCallsFor("other-production").length).toBeGreaterThan(
        otherMetadataBefore
      );
    });
    await waitFor(() => {
      expect(productionInvoke).toHaveBeenCalledWith(
        "settings:set-default-ai-model",
        alternateProviderModel
      );
      expect(productionInvoke).toHaveBeenCalledWith(
        "settings:set-default-effort-level",
        "max"
      );
      expect(productionInvoke).toHaveBeenCalledWith(
        "settings:set-default-thinking-mode",
        "disabled"
      );
    });

    const otherInput = otherRoot.querySelector(
      '[data-testid="agent-mode-chat-input"]'
    ) as HTMLTextAreaElement;
    expect(otherInput.disabled).toBe(false);
    fireEvent.change(otherInput, { target: { value: "other works" } });
    fireEvent.keyDown(otherInput, { key: "Enter", code: "Enter" });
    await waitFor(() =>
      expect(
        sendMessage.mock.calls.filter((call) => call[3] === "other-production")
      ).toHaveLength(1)
    );
    sendMessage.mockClear();

    expect(
      transcript("malformed-production").querySelector(
        '[data-testid="agent-mode-chat-input"]'
      )
    ).toHaveProperty("disabled", true);
    expect(
      transcript("delayed").querySelector(
        '[data-testid="agent-mode-chat-input"]'
      )
    ).toHaveProperty("disabled", true);
    expect(metadataCallsFor("sdk-blocked")).toHaveLength(
      sdkMetadataBeforeRecovery
    );
    expect(metadataCallsFor("delayed")).toHaveLength(1);

    allowRecovery = true;
    store.set(sessionProcessingAtom("sdk-blocked"), false);
    store.set(sessionProcessingAtom("cli-blocked"), false);
    releaseDelayed();
    await act(async () => {
      for (const root of transcripts("sdk-blocked")) {
        fireEvent.click(
          root.querySelector('[data-testid="model-reconciliation-retry"]')!
        );
      }
      fireEvent.click(
        transcript("cli-blocked").querySelector(
          '[data-testid="model-reconciliation-retry"]'
        )!
      );
      await delayedRecovery;
    });

    await waitFor(() => {
      expect(metadataCallsFor("sdk-blocked")).toHaveLength(
        sdkMetadataBeforeRecovery + 2
      );
      expect(successfulCommittedMetadataWritesFor("sdk-blocked")).toEqual([
        expect.objectContaining({
          sessionId: "sdk-blocked",
          updates: expect.objectContaining({ model: sdkModel }),
        }),
      ]);
      expect(metadataCallsFor("delayed")).toHaveLength(2);
    });
    await waitFor(() =>
      expect(
        sendMessage.mock.calls.filter((call) => call[3] === "sdk-blocked")
      ).toHaveLength(1)
    );
    await waitFor(async () =>
      expect(
        await productionSeam.queueStore.get("sdk-blocked-queued")
      ).toMatchObject({ status: "completed" })
    );
    expect(
      claim.mock.calls.filter(
        ([promptId, sessionId]) =>
          promptId === "sdk-blocked-queued" && sessionId === "sdk-blocked"
      ).length
    ).toBeGreaterThanOrEqual(2);
    expect(successfulClaims).toEqual(["sdk-blocked-queued"]);
    expect(create).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(fail).not.toHaveBeenCalled();
    expect(successfulFailures).toEqual([]);
    expect(completeAfterDispatch).toHaveBeenCalledTimes(1);
    expect(successfulCompletions).toEqual(["sdk-blocked-queued"]);
    expect(productionSeam.startSession).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(productionSeam.endSession).toHaveBeenCalledTimes(1)
    );
    expect(
      productionSeam.rendererNotification.mock.calls.filter(
        ([channel]) => channel === "ai:promptClaimed"
      )
    ).toHaveLength(1);
    expect(productionSeam.providerAbort).not.toHaveBeenCalled();
    expect(productionSeam.providerInterrupt).not.toHaveBeenCalled();
    expect(productionSeam.terminalInterrupt).not.toHaveBeenCalled();

    const cliInput = transcript("cli-blocked").querySelector(
      '[data-testid="agent-mode-chat-input"]'
    ) as HTMLTextAreaElement;
    await waitFor(() => expect(cliInput.disabled).toBe(false));
    fireEvent.change(cliInput, { target: { value: "pty once" } });
    fireEvent.keyDown(cliInput, { key: "Enter", code: "Enter" });
    await waitFor(() =>
      expect(productionSeam.ptyWrite).toHaveBeenCalledTimes(2)
    );
    expect(productionSeam.logUserPrompt).toHaveBeenCalledTimes(1);
    expect(productionSeam.analytics).toHaveBeenCalledTimes(1);
    expect(productionSeam.reveal).toHaveBeenCalledTimes(1);

    act(() => {
      store.set(sessionProcessingAtom("sdk-blocked"), true);
      store.set(sessionProcessingAtom("cli-blocked"), true);
    });
    const recoveredSdkCancel = await waitFor(() => {
      const button = transcript("sdk-blocked").querySelector(
        'button[aria-label="Cancel request"]'
      ) as HTMLButtonElement;
      expect(button?.disabled).toBe(false);
      return button;
    });
    const recoveredCliCancel = await waitFor(() => {
      const button = transcript("cli-blocked").querySelector(
        'button[aria-label="Cancel request"]'
      ) as HTMLButtonElement;
      expect(button?.disabled).toBe(false);
      return button;
    });
    fireEvent.click(recoveredSdkCancel);
    await waitFor(() =>
      expect(productionSeam.providerAbort).toHaveBeenCalledOnce()
    );
    fireEvent.click(recoveredCliCancel);
    await waitFor(() =>
      expect(productionSeam.terminalInterrupt).toHaveBeenCalledOnce()
    );
    await expect(
      productionSeam.handlers.get("ai:cancelRequest")!(
        { sender: productionSeam.browserWindow.webContents },
        "cli-blocked"
      )
    ).resolves.toEqual({ success: true });
    expect(productionSeam.ptyWrite).toHaveBeenCalledTimes(3);
    expect(productionSeam.analytics).toHaveBeenCalledTimes(5);

    const sdkSendCount = sendMessage.mock.calls.filter(
      (call) => call[3] === "sdk-blocked"
    ).length;
    mounted.unmount();
    render(
      <>
        <Transcript sessionId="sdk-blocked" />
        <Transcript sessionId="sdk-blocked" />
        <Transcript sessionId="cli-blocked" />
      </>
    );
    await waitFor(() =>
      expect(
        productionSeam.queueStore.get("sdk-blocked-queued")
      ).resolves.toMatchObject({ status: "completed" })
    );
    expect(
      sendMessage.mock.calls.filter((call) => call[3] === "sdk-blocked")
    ).toHaveLength(sdkSendCount);
    expect(productionSeam.ptyWrite).toHaveBeenCalledTimes(3);
    expect(productionSeam.logUserPrompt).toHaveBeenCalledTimes(1);
    expect(productionSeam.analytics).toHaveBeenCalledTimes(5);
    expect(productionSeam.reveal).toHaveBeenCalledTimes(1);
    expect(successfulClaims).toEqual(["sdk-blocked-queued"]);
    expect(successfulCompletions).toEqual(["sdk-blocked-queued"]);
    expect(successfulFailures).toEqual([]);
    expect(metadataCallsFor("sdk-blocked")).toHaveLength(
      sdkMetadataBeforeRecovery + 2
    );
    expect(successfulCommittedMetadataWritesFor("sdk-blocked")).toHaveLength(1);
  }, 30_000);

  it("fails closed for malformed loaded metadata in the actual transcript", async () => {
    seedSession("malformed", "{not-json");
    render(<Transcript sessionId="malformed" />);

    await waitFor(() =>
      expect(screen.getByTestId("model-reconciliation-retry")).toBeTruthy()
    );
    expect(
      (screen.getByTestId("agent-mode-chat-input") as HTMLTextAreaElement)
        .disabled
    ).toBe(true);
    expect(
      document
        .querySelector(".prompt-queue-list")
        ?.getAttribute("aria-disabled")
    ).toBe("true");
  });
});
