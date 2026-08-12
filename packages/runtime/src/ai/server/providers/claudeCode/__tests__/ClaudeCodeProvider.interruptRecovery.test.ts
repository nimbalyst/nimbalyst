import { describe, expect, it, vi } from "vitest";

vi.mock("../../../../../../../electron/src/main/HistoryManager", () => ({
  historyManager: {},
}));

import { ClaudeCodeProvider } from "../../ClaudeCodeProvider";
import {
  BackgroundAgentRecoveryCoordinator,
  encodeClaudeWorkspaceDir,
  getBackgroundAgentRecoveryLedger,
  type RecoverySessionSnapshot,
} from "../backgroundTaskRecovery";

const SESSION_ID = "interrupt-recovery-session";
const PROVIDER_SESSION_ID = "interrupt-provider-session";
const WORKSPACE_PATH = "D:\\fixtures\\interrupt-recovery";
const TASK_ID = "task-agent-interrupt";
const AGENT_ID = "toolu_agent_interrupt";

type MutableSession = RecoverySessionSnapshot & {
  metadata: Record<string, unknown>;
};

type ProviderInternals = {
  backgroundAgentRecovery: BackgroundAgentRecoveryCoordinator;
  recoverySessionId?: string;
  beginRecoveryTurn: () => string;
  activeTasks: Map<
    string,
    {
      taskId: string;
      description: string;
      taskType?: string;
      status: "running" | "completed" | "failed" | "stopped";
      startedAt: number;
      toolUseId?: string;
      toolCount: number;
      tokenCount: number;
      durationMs: number;
      isBackgrounded?: boolean;
    }
  >;
  leadQuery: { interrupt: ReturnType<typeof vi.fn> } | null;
  interruptResolve: (() => void) | null;
  abortController: AbortController | null;
  emitTaskUpdate: (sessionId: string | undefined) => Promise<void>;
  handleSystemTask: (
    subtype: string,
    chunk: Record<string, unknown>,
    sessionId: string | undefined,
    workspacePath: string,
    recoveryTurnId: string,
    launch?: { runInBackground?: boolean; name?: string }
  ) => Promise<void>;
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function createHarness(sessionId = SESSION_ID) {
  let clock = 1_000;
  let blockNextMerge = false;
  let mergeStarted = false;
  let releaseMerge: (() => void) | undefined;
  const sessions = new Map<string, MutableSession>([
    [
      sessionId,
      {
        id: sessionId,
        provider: "claude-code",
        providerSessionId: PROVIDER_SESSION_ID,
        workspacePath: WORKSPACE_PATH,
        metadata: {},
      },
    ],
  ]);

  const coordinator = (instanceId: string) =>
    new BackgroundAgentRecoveryCoordinator({
      instanceId,
      now: () => ++clock,
      getSession: async (id) => {
        const session = sessions.get(id);
        return session ? clone(session) : null;
      },
      mergeSessionMetadata: async (id, patch) => {
        if (blockNextMerge) {
          blockNextMerge = false;
          mergeStarted = true;
          await new Promise<void>((resolve) => {
            releaseMerge = resolve;
          });
        }
        const session = sessions.get(id);
        if (session) {
          session.metadata = { ...session.metadata, ...clone(patch) };
        }
      },
      inspectTranscript: async (input) => ({
        ok: true,
        transcript: {
          relativePath: `${encodeClaudeWorkspaceDir(
            WORKSPACE_PATH
          )}/${PROVIDER_SESSION_ID}/subagents/agent-${input.agentId}.jsonl`,
          parentRelativePath: `${encodeClaudeWorkspaceDir(
            WORKSPACE_PATH
          )}/${PROVIDER_SESSION_ID}.jsonl`,
          sizeBytes: 128,
          mtimeMs: 256,
          fingerprint: "128:256:last-entry",
        },
      }),
    });

  return {
    sessions,
    coordinator,
    blockNextWrite() {
      blockNextMerge = true;
    },
    hasBlockedWrite() {
      return mergeStarted;
    },
    releaseBlockedWrite() {
      releaseMerge?.();
    },
  };
}

async function recordRunningAgent(
  coordinator: BackgroundAgentRecoveryCoordinator,
  sessionId = SESSION_ID
): Promise<void> {
  await coordinator.observeTaskEvent({
    sessionId,
    workspacePath: WORKSPACE_PATH,
    providerSessionId: PROVIDER_SESSION_ID,
    turnId: "provider-owner:turn-1",
    launch: { runInBackground: true, name: "interrupt-fixture" },
    event: {
      subtype: "task_started",
      task_id: TASK_ID,
      tool_use_id: AGENT_ID,
      task_type: "local_agent",
      description: "Keep working until explicitly stopped",
    },
  });
}

function wireProvider(
  coordinator: BackgroundAgentRecoveryCoordinator,
  sessionId = SESSION_ID,
  sessions?: Map<string, MutableSession>
): { provider: ClaudeCodeProvider; internals: ProviderInternals } {
  const provider = new ClaudeCodeProvider();
  const internals = provider as unknown as ProviderInternals;
  internals.backgroundAgentRecovery = coordinator;
  internals.recoverySessionId = sessionId;
  provider.setProviderSessionData(sessionId, {
    providerSessionId: PROVIDER_SESSION_ID,
  });
  internals.emitTaskUpdate = vi.fn(async () => {
    const session = sessions?.get(sessionId);
    if (session) {
      session.metadata = {
        ...session.metadata,
        currentTasks: clone(Array.from(internals.activeTasks.values())),
      };
    }
  });
  internals.activeTasks.set(TASK_ID, {
    taskId: TASK_ID,
    description: "Keep working until explicitly stopped",
    taskType: "local_agent",
    status: "running",
    startedAt: 1_000,
    toolUseId: AGENT_ID,
    toolCount: 0,
    tokenCount: 0,
    durationMs: 0,
    isBackgrounded: true,
  });
  return { provider, internals };
}

describe("ClaudeCodeProvider explicit-interrupt recovery boundary", () => {
  it("awaits durable cancellation before a graceful interrupt and prevents later recovery", async () => {
    const harness = createHarness();
    const owner = harness.coordinator("provider-owner");
    await recordRunningAgent(owner);
    const { provider, internals } = wireProvider(
      owner,
      SESSION_ID,
      harness.sessions
    );
    const interrupt = vi.fn(async () => undefined);
    const resolveInterrupt = vi.fn();
    const stoppedTurn = internals.beginRecoveryTurn();
    internals.leadQuery = { interrupt };
    internals.interruptResolve = resolveInterrupt;
    harness.blockNextWrite();

    const resultPromise = provider.interruptCurrentTurn();
    let lateTaskEvent: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(harness.hasBlockedWrite()).toBe(true));
      expect(resolveInterrupt).not.toHaveBeenCalled();
      expect(internals.interruptResolve).toBe(resolveInterrupt);
      expect(interrupt).not.toHaveBeenCalled();
      lateTaskEvent = internals.handleSystemTask(
        "task_started",
        {
          task_id: "late-task-after-stop",
          tool_use_id: "late-agent-after-stop",
          task_type: "local_agent",
          description: "Must not become recoverable after explicit stop",
        },
        SESSION_ID,
        WORKSPACE_PATH,
        stoppedTurn,
        { runInBackground: true }
      );
    } finally {
      harness.releaseBlockedWrite();
    }

    await lateTaskEvent;
    await expect(resultPromise).resolves.toEqual({ method: "interrupt" });
    expect(resolveInterrupt).toHaveBeenCalledOnce();
    expect(internals.interruptResolve).toBeNull();
    expect(interrupt).toHaveBeenCalledOnce();
    expect(internals.activeTasks.get(TASK_ID)?.status).toBe("stopped");

    const session = harness.sessions.get(SESSION_ID)!;
    const record = Object.values(
      getBackgroundAgentRecoveryLedger(session.metadata).tasks
    )[0];
    expect(record).toMatchObject({
      taskId: TASK_ID,
      recoveryState: "cancelled",
      lastReason: "user-cancelled",
    });
    expect(session.metadata.currentTasks).toEqual([
      expect.objectContaining({
        taskId: TASK_ID,
        status: "stopped",
        recoveryDisposition: "user-cancelled",
      }),
    ]);

    const laterProcess = await harness
      .coordinator("provider-resume")
      .claimResumeDispatches({
        sessionId: SESSION_ID,
        workspacePath: WORKSPACE_PATH,
        providerSessionId: PROVIDER_SESSION_ID,
        turnId: "provider-resume:turn-1",
        isResume: true,
      });
    expect(laterProcess.dispatches).toEqual([]);
    provider.destroy();
  });

  it("awaits the same durable boundary before the no-lead abort fallback", async () => {
    const harness = createHarness("no-lead-session");
    const owner = harness.coordinator("no-lead-owner");
    await recordRunningAgent(owner, "no-lead-session");
    const { provider, internals } = wireProvider(
      owner,
      "no-lead-session",
      harness.sessions
    );
    const abortController = new AbortController();
    internals.abortController = abortController;
    harness.blockNextWrite();

    const resultPromise = provider.interruptCurrentTurn();
    try {
      await vi.waitFor(() => expect(harness.hasBlockedWrite()).toBe(true));
      expect(abortController.signal.aborted).toBe(false);
    } finally {
      harness.releaseBlockedWrite();
    }

    await expect(resultPromise).resolves.toEqual({ method: "abort" });
    expect(abortController.signal.aborted).toBe(true);
    const session = harness.sessions.get("no-lead-session")!;
    expect(
      Object.values(getBackgroundAgentRecoveryLedger(session.metadata).tasks)[0]
    ).toMatchObject({
      recoveryState: "cancelled",
      lastReason: "user-cancelled",
    });
    expect(session.metadata.currentTasks).toEqual([
      expect.objectContaining({
        status: "stopped",
        recoveryDisposition: "user-cancelled",
      }),
    ]);
    provider.destroy();
  });

  it("keeps stopped turn A gated after turn B begins while accepting B task events", async () => {
    const harness = createHarness("turn-safe-session");
    const owner = harness.coordinator("turn-safe-owner");
    await recordRunningAgent(owner, "turn-safe-session");
    const { provider, internals } = wireProvider(
      owner,
      "turn-safe-session",
      harness.sessions
    );
    const turnA = internals.beginRecoveryTurn();
    internals.leadQuery = { interrupt: vi.fn(async () => undefined) };

    await expect(provider.interruptCurrentTurn()).resolves.toEqual({
      method: "interrupt",
    });

    const turnB = internals.beginRecoveryTurn();
    await internals.handleSystemTask(
      "task_started",
      {
        task_id: "late-task-from-turn-a",
        tool_use_id: "late-agent-from-turn-a",
        task_type: "local_agent",
        description: "Late stopped-turn event",
      },
      "turn-safe-session",
      WORKSPACE_PATH,
      turnA,
      { runInBackground: true }
    );
    await internals.handleSystemTask(
      "task_started",
      {
        task_id: "legitimate-task-from-turn-b",
        tool_use_id: "legitimate-agent-from-turn-b",
        task_type: "local_agent",
        description: "Legitimate next-turn event",
      },
      "turn-safe-session",
      WORKSPACE_PATH,
      turnB,
      { runInBackground: true }
    );

    expect(internals.activeTasks.has("late-task-from-turn-a")).toBe(false);
    expect(
      internals.activeTasks.get("legitimate-task-from-turn-b")
    ).toMatchObject({
      status: "running",
      sourceTurnId: turnB,
    });
    const records = Object.values(
      getBackgroundAgentRecoveryLedger(
        harness.sessions.get("turn-safe-session")!.metadata
      ).tasks
    );
    expect(
      records.some((record) => record.taskId === "late-task-from-turn-a")
    ).toBe(false);
    expect(
      records.find((record) => record.taskId === "legitimate-task-from-turn-b")
    ).toMatchObject({
      recoveryState: "pending",
      sourceTurnId: turnB,
    });
    provider.destroy();
  });

  it("still releases the graceful runtime and gates late chunks when durable suppression fails", async () => {
    const harness = createHarness("graceful-failure-session");
    const owner = harness.coordinator("graceful-failure-owner");
    await recordRunningAgent(owner, "graceful-failure-session");
    const { provider, internals } = wireProvider(
      owner,
      "graceful-failure-session",
      harness.sessions
    );
    const stoppedTurn = internals.beginRecoveryTurn();
    const interrupt = vi.fn(async () => undefined);
    const resolveInterrupt = vi.fn();
    internals.leadQuery = { interrupt };
    internals.interruptResolve = resolveInterrupt;
    vi.spyOn(owner, "suppressRunning").mockRejectedValueOnce(
      new Error("durable suppression failed")
    );

    await expect(provider.interruptCurrentTurn()).rejects.toThrow(
      "durable suppression failed"
    );

    expect(resolveInterrupt).toHaveBeenCalledOnce();
    expect(interrupt).toHaveBeenCalledOnce();
    await internals.handleSystemTask(
      "task_started",
      {
        task_id: "late-task-after-graceful-failure",
        tool_use_id: "late-agent-after-graceful-failure",
        task_type: "local_agent",
        description: "Must remain gated in memory",
      },
      "graceful-failure-session",
      WORKSPACE_PATH,
      stoppedTurn,
      { runInBackground: true }
    );
    expect(internals.activeTasks.has("late-task-after-graceful-failure")).toBe(
      false
    );
    expect(
      Object.values(
        getBackgroundAgentRecoveryLedger(
          harness.sessions.get("graceful-failure-session")!.metadata
        ).tasks
      )[0]
    ).toMatchObject({
      recoveryState: "pending",
    });
    provider.destroy();
  });

  it("still aborts the no-lead runtime and gates late chunks when durable suppression fails", async () => {
    const harness = createHarness("abort-failure-session");
    const owner = harness.coordinator("abort-failure-owner");
    await recordRunningAgent(owner, "abort-failure-session");
    const { provider, internals } = wireProvider(
      owner,
      "abort-failure-session",
      harness.sessions
    );
    const stoppedTurn = internals.beginRecoveryTurn();
    const abortController = new AbortController();
    internals.abortController = abortController;
    vi.spyOn(owner, "suppressRunning").mockRejectedValueOnce(
      new Error("durable suppression failed")
    );

    await expect(provider.interruptCurrentTurn()).rejects.toThrow(
      "durable suppression failed"
    );

    expect(abortController.signal.aborted).toBe(true);
    await internals.handleSystemTask(
      "task_started",
      {
        task_id: "late-task-after-abort-failure",
        tool_use_id: "late-agent-after-abort-failure",
        task_type: "local_agent",
        description: "Must remain gated in memory",
      },
      "abort-failure-session",
      WORKSPACE_PATH,
      stoppedTurn,
      { runInBackground: true }
    );
    expect(internals.activeTasks.has("late-task-after-abort-failure")).toBe(
      false
    );
    expect(
      Object.values(
        getBackgroundAgentRecoveryLedger(
          harness.sessions.get("abort-failure-session")!.metadata
        ).tasks
      )[0]
    ).toMatchObject({
      recoveryState: "pending",
    });
    provider.destroy();
  });

  it("retains eventual durable cancellation for direct synchronous abort callers", async () => {
    const harness = createHarness("direct-abort-session");
    const owner = harness.coordinator("direct-abort-owner");
    await recordRunningAgent(owner, "direct-abort-session");
    const { provider, internals } = wireProvider(
      owner,
      "direct-abort-session",
      harness.sessions
    );
    const abortController = new AbortController();
    internals.abortController = abortController;

    provider.abort();

    expect(abortController.signal.aborted).toBe(true);
    await vi.waitFor(() => {
      const session = harness.sessions.get("direct-abort-session")!;
      expect(
        Object.values(
          getBackgroundAgentRecoveryLedger(session.metadata).tasks
        )[0]
      ).toMatchObject({
        recoveryState: "cancelled",
        lastReason: "user-cancelled",
      });
      expect(session.metadata.currentTasks).toEqual([
        expect.objectContaining({
          status: "stopped",
          recoveryDisposition: "user-cancelled",
        }),
      ]);
    });
    provider.destroy();
  });

  it("preserves recovery across destroy and teammate-message interruption", async () => {
    const recycleHarness = createHarness("recycle-session");
    const recycleOwner = recycleHarness.coordinator("recycle-owner");
    await recordRunningAgent(recycleOwner, "recycle-session");
    const recycleProvider = wireProvider(
      recycleOwner,
      "recycle-session",
      recycleHarness.sessions
    ).provider;
    const recycleSuppress = vi.spyOn(recycleOwner, "suppressRunning");

    recycleProvider.destroy();

    expect(recycleSuppress).not.toHaveBeenCalled();
    const recycled = await recycleHarness
      .coordinator("recycle-resume")
      .claimResumeDispatches({
        sessionId: "recycle-session",
        workspacePath: WORKSPACE_PATH,
        providerSessionId: PROVIDER_SESSION_ID,
        turnId: "recycle-resume:turn-1",
        isResume: true,
      });
    expect(recycled.dispatches).toHaveLength(1);

    const messageHarness = createHarness("message-session");
    const messageOwner = messageHarness.coordinator("message-owner");
    await recordRunningAgent(messageOwner, "message-session");
    const { provider: messageProvider, internals: messageInternals } =
      wireProvider(messageOwner, "message-session", messageHarness.sessions);
    const messageSuppress = vi.spyOn(messageOwner, "suppressRunning");
    const interrupt = vi.fn(async () => undefined);
    messageInternals.leadQuery = { interrupt };

    await messageProvider.interruptWithMessage("Teammate result is ready");

    expect(interrupt).toHaveBeenCalledOnce();
    expect(messageSuppress).not.toHaveBeenCalled();
    const afterMessage = await messageHarness
      .coordinator("message-resume")
      .claimResumeDispatches({
        sessionId: "message-session",
        workspacePath: WORKSPACE_PATH,
        providerSessionId: PROVIDER_SESSION_ID,
        turnId: "message-resume:turn-1",
        isResume: true,
      });
    expect(afterMessage.dispatches).toHaveLength(1);
    messageProvider.destroy();
  });
});
