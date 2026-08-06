import { beforeEach, describe, expect, it, vi } from "vitest";

const ipcMocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  readProviderCatalog: vi.fn(),
  loadSession: vi.fn(),
  databaseQuery: vi.fn(),
  terminal: {
    isActive: vi.fn(),
    write: vi.fn(),
  },
  queueStore: {
    create: vi.fn(),
    get: vi.fn(),
    deletePending: vi.fn(),
    replacePending: vi.fn(),
    listPending: vi.fn(),
    claim: vi.fn(),
    sweepExecutingForSession: vi.fn(),
  },
}));

vi.mock("@nimbalyst/runtime/storage/repositories/AISessionsRepository", () => ({
  AISessionsRepository: { get: ipcMocks.loadSession },
}));

vi.mock("../../RepositoryManager", () => ({
  getQueuedPromptsStore: () => ipcMocks.queueStore,
}));

vi.mock("../../../database/PGLiteDatabaseWorker", () => ({
  database: { query: ipcMocks.databaseQuery },
}));

vi.mock("../../TerminalSessionManager", () => ({
  getTerminalSessionManager: () => ({
    isTerminalActive: ipcMocks.terminal.isActive,
    writeToTerminal: ipcMocks.terminal.write,
  }),
}));

vi.mock("../../../utils/ipcRegistry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../utils/ipcRegistry")>()),
  safeHandle: vi.fn(
    (channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcMocks.handlers.set(channel, handler);
    }
  ),
}));

vi.mock(
  "@nimbalyst/runtime/ai/server/providers/claudeCode/providerCatalogLoader",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@nimbalyst/runtime/ai/server/providers/claudeCode/providerCatalogLoader")
    >()),
    readProviderCatalog: ipcMocks.readProviderCatalog,
  })
);

import { ModelRegistry, ProviderFactory } from "@nimbalyst/runtime/ai/server";
import { resolveProviderCatalog } from "@nimbalyst/runtime/ai/server/providers/claudeCode/providerCatalog";
import { BUILT_IN_PROVIDER_CATALOG } from "@nimbalyst/runtime/ai/server/providers/claudeCode/providerCatalogDefaults";
import { AIService } from "../AIService";

beforeEach(() => {
  ipcMocks.handlers.clear();
  vi.restoreAllMocks();
  ipcMocks.loadSession.mockReset();
  ipcMocks.queueStore.create.mockReset();
  ipcMocks.queueStore.get.mockReset();
  ipcMocks.queueStore.deletePending.mockReset();
  ipcMocks.queueStore.replacePending.mockReset();
  ipcMocks.queueStore.listPending.mockReset();
  ipcMocks.queueStore.claim.mockReset();
  ipcMocks.queueStore.sweepExecutingForSession.mockReset();
  ipcMocks.databaseQuery.mockReset();
  ipcMocks.terminal.isActive.mockReset();
  ipcMocks.terminal.write.mockReset();
});

describe("AIService ai:getModels catalog projection", () => {
  it("captures the production handler and closes every catalog row for a fatal overlay", async () => {
    ipcMocks.readProviderCatalog.mockReturnValue({
      resolution: resolveProviderCatalog(BUILT_IN_PROVIDER_CATALOG, {
        schemaVersion: 999,
        entries: [],
      }),
      migration: { performed: false, sourcePreserved: false },
    });
    vi.spyOn(ModelRegistry, "getAllModels").mockResolvedValue([]);
    const service = Object.create(AIService.prototype) as any;
    service.streamingHandler = { handle: vi.fn() };
    service.getNormalizedProviderSettings = vi.fn(() => ({
      "claude-code": { enabled: true },
      "claude-code-cli": { enabled: false },
    }));
    service.getSettingsStore = vi.fn(() => ({
      get: vi.fn((_key: string, fallback: unknown) => fallback),
    }));

    service.setupIpcHandlers();
    const handler = ipcMocks.handlers.get("ai:getModels");
    expect(handler).toBeTypeOf("function");

    const result = (await handler!()) as {
      success: boolean;
      grouped: Record<
        string,
        Array<{
          catalog?: {
            availability: {
              selectable: boolean;
              code: string;
              reason?: string;
            };
          };
        }>
      >;
    };
    const catalogRows = Object.values(result.grouped)
      .flat()
      .filter((model) => model.catalog);

    expect(result.success).toBe(true);
    expect(ipcMocks.readProviderCatalog).toHaveBeenCalledWith(
      BUILT_IN_PROVIDER_CATALOG
    );
    expect(catalogRows).toHaveLength(BUILT_IN_PROVIDER_CATALOG.length);
    expect(catalogRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          catalog: expect.objectContaining({
            availability: {
              selectable: false,
              code: "invalid",
              reason:
                "The provider catalog source is invalid and cannot be used.",
            },
          }),
        }),
      ])
    );
    expect(
      catalogRows.every(
        (model) => model.catalog?.availability.selectable === false
      )
    ).toBe(true);
  });

  it("keeps local, meta-agent, direct-send, and delete rails inert until the durable marker clears", async () => {
    const pending = {
      status: "pending",
      targetModel: "model-b",
      targetControls: {},
      previousModel: "model-a",
      previousControls: {},
    };
    let metadata: Record<string, unknown> = {
      modelChangeReconciliation: pending,
    };
    ipcMocks.loadSession.mockImplementation(async () => ({ metadata }));
    ipcMocks.queueStore.get.mockResolvedValue({
      id: "q1",
      sessionId: "session-a",
      prompt: "pending",
    });
    ipcMocks.queueStore.create.mockResolvedValue({
      id: "q-created",
      prompt: "ready",
      createdAt: 1,
    });
    ipcMocks.queueStore.deletePending.mockResolvedValue(false);
    const service = Object.create(AIService.prototype) as any;
    service.streamingHandler = { handle: vi.fn() };
    service.sendMessageHandler = vi.fn();
    service.queueProcessingLeases = new Map();
    service.directSendInFlight = new Set();
    service.setupIpcHandlers();

    const createHandler = ipcMocks.handlers.get("ai:createQueuedPrompt");
    const deleteHandler = ipcMocks.handlers.get("ai:deleteQueuedPrompt");
    const sendHandler = ipcMocks.handlers.get("ai:sendMessage");
    expect(createHandler).toBeTypeOf("function");
    expect(deleteHandler).toBeTypeOf("function");
    expect(sendHandler).toBeTypeOf("function");

    await expect(
      createHandler!({ sender: {} }, "session-a", "local prompt")
    ).rejects.toThrow("Session model recovery is pending");
    await expect(
      service.queuePromptForSession("session-a", "meta prompt")
    ).rejects.toThrow("Session model recovery is pending");
    await expect(
      service.sendMessageDirect("session-a", "D:\\repo", "direct prompt")
    ).rejects.toThrow("Session model recovery is pending");
    await expect(
      sendHandler!(
        {},
        "stale renderer prompt",
        undefined,
        "session-a",
        "D:\\repo"
      )
    ).rejects.toThrow("Session model recovery is pending");
    await expect(
      service.tryDispatchNextQueuedPrompt("session-a", "D:\\repo", null, "test")
    ).resolves.toBe(false);
    await expect(deleteHandler!({}, "session-a", "q1")).resolves.toEqual({
      success: false,
      error: "Queued prompt deletion was not admitted",
    });
    expect(ipcMocks.queueStore.create).not.toHaveBeenCalled();
    expect(ipcMocks.queueStore.deletePending).toHaveBeenCalledWith(
      "q1",
      "session-a"
    );
    expect(service.streamingHandler.handle).not.toHaveBeenCalled();

    metadata = { modelChangeReconciliation: null };
    await expect(
      service.queuePromptForSession("session-a", "meta prompt")
    ).resolves.toEqual({ id: "q-created", prompt: "ready", createdAt: 1 });
    expect(ipcMocks.queueStore.create).toHaveBeenCalledTimes(1);
  });

  it("does not register renderer claim or settlement authority", async () => {
    const service = Object.create(AIService.prototype) as any;
    service.streamingHandler = { handle: vi.fn() };
    service.setupIpcHandlers();
    expect(ipcMocks.handlers.has("ai:claimQueuedPrompt")).toBe(false);
    expect(ipcMocks.handlers.has("ai:completeQueuedPrompt")).toBe(false);
    expect(ipcMocks.handlers.has("ai:failQueuedPrompt")).toBe(false);
    expect(ipcMocks.handlers.has("ai:createQueuedPrompt")).toBe(true);
    expect(ipcMocks.handlers.has("ai:replaceQueuedPrompt")).toBe(true);
    expect(ipcMocks.handlers.has("ai:deleteQueuedPrompt")).toBe(true);
  });

  it("returns authoritative replace/delete CAS outcomes without optimistic success", async () => {
    const service = Object.create(AIService.prototype) as any;
    service.streamingHandler = { handle: vi.fn() };
    service.setupIpcHandlers();
    const replace = ipcMocks.handlers.get("ai:replaceQueuedPrompt")!;
    const remove = ipcMocks.handlers.get("ai:deleteQueuedPrompt")!;

    ipcMocks.queueStore.replacePending.mockResolvedValueOnce(null);
    await expect(
      replace({}, "session-a", "q1", "combined", [{ id: "a" }], {
        filePath: "a.ts",
      })
    ).resolves.toEqual({
      success: false,
      error: "Queued prompt replacement was not admitted",
    });
    expect(ipcMocks.queueStore.replacePending).toHaveBeenCalledWith({
      id: "q1",
      sessionId: "session-a",
      prompt: "combined",
      attachments: [{ id: "a" }],
      documentContext: { filePath: "a.ts" },
    });

    ipcMocks.queueStore.replacePending.mockResolvedValueOnce({
      id: "q1",
      prompt: "combined",
      createdAt: 7,
      attachments: [{ id: "a" }],
      documentContext: { filePath: "a.ts" },
    });
    await expect(
      replace({}, "session-a", "q1", "combined", [{ id: "a" }], {
        filePath: "a.ts",
      })
    ).resolves.toMatchObject({
      success: true,
      row: { id: "q1", timestamp: 7 },
    });

    ipcMocks.queueStore.deletePending
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    await expect(remove({}, "session-a", "q1")).resolves.toMatchObject({
      success: false,
    });
    await expect(remove({}, "session-a", "q1")).resolves.toEqual({
      success: true,
    });
    expect(ipcMocks.queueStore.deletePending).toHaveBeenLastCalledWith(
      "q1",
      "session-a"
    );
  });

  it("gates public SDK and CLI cancellation before every effect, then preserves recovered cancellation", async () => {
    const service = Object.create(AIService.prototype) as any;
    const analytics = vi.fn();
    const providerAbort = vi.fn();
    service.streamingHandler = { handle: vi.fn() };
    service.analytics = { sendEvent: analytics };
    service.queueProcessingLeases = new Map([
      ["blocked-sdk", Symbol("blocked-sdk")],
      ["blocked-cli", Symbol("blocked-cli")],
      ["recovered-sdk", Symbol("recovered-sdk")],
      ["recovered-cli", Symbol("recovered-cli")],
    ]);
    ipcMocks.queueStore.sweepExecutingForSession.mockResolvedValue({
      completed: 0,
      failed: 0,
      rolledBack: 0,
    });
    ipcMocks.terminal.isActive.mockReturnValue(true);
    const providerLookup = vi
      .spyOn(ProviderFactory, "getProvider")
      .mockImplementation((_provider, sessionId) =>
        sessionId === "recovered-sdk"
          ? ({ providerType: "claude-code", abort: providerAbort } as any)
          : null
      );

    service.setupIpcHandlers();
    const cancel = ipcMocks.handlers.get("ai:cancelRequest");
    expect(cancel).toBeTypeOf("function");

    const blockedStates: unknown[] = [
      null,
      { metadata: "{not-json" },
      { metadata: [] },
      { metadata: { modelChangeReconciliation: "malformed" } },
      { metadata: { modelChangeReconciliation: { status: "pending" } } },
    ];
    for (const state of blockedStates) {
      ipcMocks.loadSession.mockResolvedValueOnce(state);
      await expect(cancel!({}, "blocked-sdk", 3)).resolves.toEqual({
        success: false,
        error: "Session model recovery is pending",
      });
      ipcMocks.loadSession.mockResolvedValueOnce(state);
      await expect(cancel!({}, "blocked-cli", 4)).resolves.toEqual({
        success: false,
        error: "Session model recovery is pending",
      });
    }
    ipcMocks.loadSession.mockRejectedValueOnce(new Error("metadata down"));
    await expect(cancel!({}, "blocked-sdk")).resolves.toEqual({
      success: false,
      error: "Session model recovery is pending",
    });
    ipcMocks.loadSession.mockRejectedValueOnce(new Error("metadata down"));
    await expect(cancel!({}, "blocked-cli")).resolves.toEqual({
      success: false,
      error: "Session model recovery is pending",
    });

    expect(providerLookup).not.toHaveBeenCalled();
    expect(providerAbort).not.toHaveBeenCalled();
    expect(ipcMocks.terminal.isActive).not.toHaveBeenCalled();
    expect(ipcMocks.terminal.write).not.toHaveBeenCalled();
    expect(ipcMocks.queueStore.sweepExecutingForSession).not.toHaveBeenCalled();
    expect(analytics).not.toHaveBeenCalled();
    expect(service.queueProcessingLeases.size).toBe(4);

    const recoveredSdk = {
      provider: "claude-code",
      metadata: { modelChangeReconciliation: null },
    };
    ipcMocks.loadSession
      .mockResolvedValueOnce(recoveredSdk)
      .mockResolvedValueOnce(recoveredSdk);
    await expect(cancel!({}, "recovered-sdk", 7)).resolves.toEqual({
      success: true,
    });
    expect(providerLookup).toHaveBeenCalledOnce();
    expect(providerAbort).toHaveBeenCalledOnce();
    expect(ipcMocks.queueStore.sweepExecutingForSession).toHaveBeenCalledWith(
      "recovered-sdk"
    );
    expect(service.queueProcessingLeases.has("recovered-sdk")).toBe(false);

    const recoveredCli = {
      provider: "claude-code-cli",
      metadata: { modelChangeReconciliation: null },
    };
    ipcMocks.loadSession
      .mockResolvedValueOnce(recoveredCli)
      .mockResolvedValueOnce(recoveredCli);
    await expect(cancel!({}, "recovered-cli", 9)).resolves.toEqual({
      success: true,
    });
    expect(ipcMocks.terminal.isActive).toHaveBeenCalledOnce();
    expect(ipcMocks.terminal.write).toHaveBeenCalledWith(
      "recovered-cli",
      "\x03"
    );
    expect(
      ipcMocks.queueStore.sweepExecutingForSession
    ).toHaveBeenLastCalledWith("recovered-cli");
    expect(service.queueProcessingLeases.has("recovered-cli")).toBe(false);
    expect(analytics).toHaveBeenCalledTimes(4);
  });

  it("gates manual interrupts for every fail-closed metadata state and enters the provider exactly once after recovery", async () => {
    const service = Object.create(AIService.prototype) as any;
    service.queueProcessingLeases = new Map();
    ipcMocks.queueStore.sweepExecutingForSession.mockResolvedValue({
      completed: 0,
      failed: 0,
      rolledBack: 0,
    });
    const interruptCurrentTurn = vi.fn(async () => ({
      method: "provider-interrupt",
    }));
    vi.spyOn(ProviderFactory, "getProvider").mockReturnValue({
      interruptCurrentTurn,
    } as any);

    const blockedStates: unknown[] = [
      null,
      { metadata: "{not-json" },
      { metadata: [] },
      { metadata: { modelChangeReconciliation: "malformed" } },
      { metadata: { modelChangeReconciliation: { status: "pending" } } },
    ];
    for (const state of blockedStates) {
      ipcMocks.loadSession.mockResolvedValueOnce(state);
      await expect(
        service.interruptCurrentTurnForSession("session-a")
      ).resolves.toEqual({
        success: false,
        error: "Session model recovery is pending",
        nativeEntered: false,
      });
    }
    ipcMocks.loadSession.mockRejectedValueOnce(
      new Error("metadata unavailable")
    );
    await expect(
      service.interruptCurrentTurnForSession("session-a")
    ).resolves.toEqual({
      success: false,
      error: "Session model recovery is pending",
      nativeEntered: false,
    });
    expect(ipcMocks.databaseQuery).not.toHaveBeenCalled();
    expect(interruptCurrentTurn).not.toHaveBeenCalled();

    ipcMocks.loadSession.mockResolvedValueOnce({
      metadata: { modelChangeReconciliation: null },
    });
    ipcMocks.databaseQuery.mockResolvedValue({
      rows: [
        {
          provider: "openai-codex",
          status: "running",
          last_activity: 10,
          updated_at: 20,
        },
      ],
    });
    await expect(
      service.interruptCurrentTurnForSession("session-a")
    ).resolves.toEqual({
      success: true,
      method: "provider-interrupt",
      nativeEntered: true,
      forcedIdle: false,
    });
    expect(interruptCurrentTurn).toHaveBeenCalledTimes(1);
  });
});
