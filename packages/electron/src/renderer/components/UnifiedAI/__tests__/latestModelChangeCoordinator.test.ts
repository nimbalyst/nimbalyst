import { describe, expect, it, vi } from "vitest";
import {
  createSessionModelChangeHooks,
  getSessionModelChangeTransactionState,
  LatestModelChangeCoordinator,
  parseSessionModelChangeReconciliation,
  recoverSessionModelChangeTransaction,
  runSessionModelChangeTransaction,
  SessionModelChangeReconciliationError,
  type SessionModelChange,
} from "../latestModelChangeCoordinator";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function mutation(
  modelId: string,
  effortLevel: "high" | "max"
): SessionModelChange {
  return {
    modelId,
    previousModel: "initial",
    previousControls: { effortLevel: "low", thinkingMode: "disabled" },
    catalogControls: { effortLevel, thinkingMode: "enabled" },
  };
}

interface ProductionHarnessOptions {
  sessionId?: string;
  deferredModel?: string;
  failStep?: "controls" | "cli" | "model";
  failSecondBApply?: boolean;
  cliRollbackFailures?: number;
  metadataRollbackFailures?: number;
}

function productionHarness(options: ProductionHarnessOptions = {}) {
  const sessionId = options.sessionId ?? "session-1";
  const deferredModelWrite = deferred<{ success: boolean }>();
  const modelApplyCounts = new Map<string, number>();
  const modelApplyOrder: string[] = [];
  const failures = {
    step: options.failStep,
    cliRollbackRemaining: options.cliRollbackFailures ?? 0,
    metadataRollbackRemaining: options.metadataRollbackFailures ?? 0,
  };
  const state = {
    persistedModel: "initial",
    persistedControls: {
      effortLevel: "low" as unknown,
      thinkingMode: "disabled" as unknown,
    },
    cliModel: "initial",
    rendererMetadata: {
      untouched: true,
      effortLevel: "low" as unknown,
      thinkingMode: "disabled" as unknown,
    },
    currentModel: "initial",
    defaults: { defaultModel: "initial" } as Record<string, unknown>,
  };
  const invoke = vi.fn(
    async (
      _channel: string,
      _sessionId: string,
      updates: Record<string, unknown>
    ) => {
      if (updates.metadata && !updates.model) {
        if (failures.step === "controls") {
          return { success: false, error: "control write failed" };
        }
        state.persistedControls = {
          ...(updates.metadata as Record<string, unknown>),
        } as typeof state.persistedControls;
        return { success: true };
      }
      if (typeof updates.model === "string" && updates.metadata) {
        if (
          updates.model === "initial" &&
          failures.metadataRollbackRemaining > 0
        ) {
          failures.metadataRollbackRemaining -= 1;
          return { success: false, error: "metadata rollback failed" };
        }
        const count = (modelApplyCounts.get(updates.model) ?? 0) + 1;
        modelApplyCounts.set(updates.model, count);
        modelApplyOrder.push(updates.model);
        if (failures.step === "model" && updates.model !== "initial") {
          return { success: false, error: "model write failed" };
        }
        if (options.failSecondBApply && updates.model === "B" && count > 1) {
          return { success: false, error: "redundant B replay failed" };
        }
        if (updates.model === options.deferredModel) {
          const result = await deferredModelWrite.promise;
          if (!result.success) return result;
        }
        state.persistedModel = updates.model;
        state.persistedControls = {
          ...(updates.metadata as Record<string, unknown>),
        } as typeof state.persistedControls;
        return { success: true };
      }
      if (typeof updates.model === "string") {
        state.persistedModel = updates.model;
        return { success: true };
      }
      throw new Error("unexpected IPC update");
    }
  );
  const setClaudeCliModel = vi.fn(
    async (_sessionId: string, modelId: string) => {
      if (failures.step === "cli" && modelId !== "initial") {
        throw new Error("CLI switch failed");
      }
      if (modelId === "initial" && failures.cliRollbackRemaining > 0) {
        failures.cliRollbackRemaining -= 1;
        throw new Error("CLI rollback failed");
      }
      state.cliModel = modelId;
    }
  );
  const writeSessionMetadata = vi.fn((metadata: Record<string, unknown>) => {
    state.rendererMetadata = {
      ...metadata,
      untouched: true,
    } as typeof state.rendererMetadata;
  });
  const setCurrentModel = vi.fn((modelId: string) => {
    state.currentModel = modelId;
  });
  const setAgentModeSettings = vi.fn((settings: Record<string, unknown>) => {
    state.defaults = { ...state.defaults, ...settings };
  });
  const reportError = vi.fn();
  const createHooks = () =>
    createSessionModelChangeHooks({
      sessionId,
      usesClaudeCli: true,
      invoke,
      setClaudeCliModel,
      readSessionMetadata: () => state.rendererMetadata,
      writeSessionMetadata,
      setCurrentModel,
      setAgentModeSettings,
      reportError,
    });
  const hooks = createHooks();

  return {
    createHooks,
    deferredModelWrite,
    failures,
    hooks,
    invoke,
    modelApplyCounts,
    modelApplyOrder,
    reportError,
    sessionId,
    setClaudeCliModel,
    state,
  };
}

function expectEveryObservableToBeB(
  harness: ReturnType<typeof productionHarness>
) {
  expect(harness.state).toMatchObject({
    persistedModel: "B",
    persistedControls: {
      effortLevel: "max",
      thinkingMode: "enabled",
      modelChangeReconciliation: null,
    },
    cliModel: "B",
    rendererMetadata: {
      untouched: true,
      effortLevel: "max",
      thinkingMode: "enabled",
    },
    currentModel: "B",
    defaults: {
      defaultModel: "B",
      defaultEffortLevel: "max",
      defaultThinkingMode: "enabled",
    },
  });
  expect(harness.modelApplyCounts.get("B")).toBe(1);
}

describe("LatestModelChangeCoordinator production transaction", () => {
  it("shares one session tail across views after a late A failure", async () => {
    const harness = productionHarness({
      sessionId: "shared-late-failure",
      deferredModel: "A",
      failSecondBApply: true,
    });

    const runA = runSessionModelChangeTransaction(
      harness.sessionId,
      mutation("A", "high"),
      harness.createHooks()
    );
    const runB = runSessionModelChangeTransaction(
      harness.sessionId,
      mutation("B", "max"),
      harness.createHooks()
    );
    await vi.waitFor(() =>
      expect(harness.setClaudeCliModel).toHaveBeenCalledWith(
        harness.sessionId,
        "A"
      )
    );
    expect(harness.modelApplyCounts.get("B")).toBeUndefined();

    harness.deferredModelWrite.reject(new Error("A failed late"));
    await Promise.all([runA, runB]);

    expectEveryObservableToBeB(harness);
    expect(harness.reportError).not.toHaveBeenCalled();
  });

  it("shares one session tail across views after a late A success", async () => {
    const harness = productionHarness({
      sessionId: "shared-late-success",
      deferredModel: "A",
      failSecondBApply: true,
    });

    const runA = runSessionModelChangeTransaction(
      harness.sessionId,
      mutation("A", "high"),
      harness.createHooks()
    );
    const runB = runSessionModelChangeTransaction(
      harness.sessionId,
      mutation("B", "max"),
      harness.createHooks()
    );
    await vi.waitFor(() =>
      expect(harness.setClaudeCliModel).toHaveBeenCalledWith(
        harness.sessionId,
        "A"
      )
    );
    expect(harness.state.currentModel).toBe("initial");

    harness.deferredModelWrite.resolve({ success: true });
    await Promise.all([runA, runB]);

    expectEveryObservableToBeB(harness);
    expect(harness.reportError).not.toHaveBeenCalled();
  });

  it("keeps A/B/C ordered across fresh view hooks and releases the idle owner", async () => {
    const harness = productionHarness({
      sessionId: "shared-lifecycle",
      deferredModel: "A",
    });

    const runs = [
      runSessionModelChangeTransaction(
        harness.sessionId,
        mutation("A", "high"),
        harness.createHooks()
      ),
      runSessionModelChangeTransaction(
        harness.sessionId,
        mutation("B", "max"),
        harness.createHooks()
      ),
      runSessionModelChangeTransaction(
        harness.sessionId,
        mutation("C", "high"),
        harness.createHooks()
      ),
    ];

    harness.deferredModelWrite.resolve({ success: true });
    await Promise.all(runs);

    expect(harness.modelApplyOrder).toEqual(["A", "B", "C"]);
    expect(harness.state.currentModel).toBe("C");
    expect(getSessionModelChangeTransactionState(harness.sessionId)).toEqual({
      status: "idle",
    });

    await runSessionModelChangeTransaction(
      harness.sessionId,
      mutation("D", "max"),
      harness.createHooks()
    );
    expect(harness.state.currentModel).toBe("D");
    expect(getSessionModelChangeTransactionState(harness.sessionId)).toEqual({
      status: "idle",
    });
  });

  it("does not block a different session behind a deferred transaction", async () => {
    const slow = productionHarness({
      sessionId: "independent-slow",
      deferredModel: "A",
    });
    const fast = productionHarness({ sessionId: "independent-fast" });

    const slowRun = runSessionModelChangeTransaction(
      slow.sessionId,
      mutation("A", "high"),
      slow.createHooks()
    );
    await vi.waitFor(() => expect(slow.modelApplyCounts.get("A")).toBe(1));

    await runSessionModelChangeTransaction(
      fast.sessionId,
      mutation("B", "max"),
      fast.createHooks()
    );
    expect(fast.state.currentModel).toBe("B");
    expect(slow.state.currentModel).toBe("initial");

    slow.deferredModelWrite.resolve({ success: true });
    await slowRun;
  });

  it("does not poison the shared tail after a rejected apply rolls back", async () => {
    const harness = productionHarness({
      sessionId: "shared-rejection-recovery",
      failStep: "model",
    });

    await runSessionModelChangeTransaction(
      harness.sessionId,
      mutation("B", "max"),
      harness.createHooks()
    );
    harness.failures.step = undefined;
    await runSessionModelChangeTransaction(
      harness.sessionId,
      mutation("C", "high"),
      harness.createHooks()
    );

    expect(harness.state.currentModel).toBe("C");
    expect(harness.state.persistedModel).toBe("C");
    expect(harness.state.cliModel).toBe("C");
  });

  it.each(["controls", "cli", "model"] as const)(
    "rolls every production observable back when the latest %s step fails",
    async (failStep) => {
      const harness = productionHarness({ failStep });
      const coordinator =
        new LatestModelChangeCoordinator<SessionModelChange>();

      await coordinator.run(mutation("B", "max"), harness.hooks);

      expect(harness.state).toMatchObject({
        persistedModel: "initial",
        persistedControls: {
          effortLevel: "low",
          thinkingMode: "disabled",
        },
        cliModel: "initial",
        rendererMetadata: {
          untouched: true,
          effortLevel: "low",
          thinkingMode: "disabled",
        },
        currentModel: "initial",
        defaults: { defaultModel: "initial" },
      });
      expect(harness.reportError).toHaveBeenCalledWith(
        "Failed to update model",
        expect.any(Error)
      );
    }
  );

  it("retries failed CLI and metadata rollback transports to convergence", async () => {
    const harness = productionHarness({
      sessionId: "bounded-rollback-success",
      failStep: "model",
      cliRollbackFailures: 2,
      metadataRollbackFailures: 2,
    });

    await runSessionModelChangeTransaction(
      harness.sessionId,
      mutation("B", "max"),
      harness.createHooks()
    );

    expect(harness.state).toMatchObject({
      persistedModel: "initial",
      persistedControls: {
        effortLevel: "low",
        thinkingMode: "disabled",
        modelChangeReconciliation: null,
      },
      cliModel: "initial",
      rendererMetadata: {
        effortLevel: "low",
        thinkingMode: "disabled",
      },
      currentModel: "initial",
      defaults: { defaultModel: "initial" },
    });
    expect(getSessionModelChangeTransactionState(harness.sessionId)).toEqual({
      status: "idle",
    });
  });

  it("recovers a durable marker to the complete previous snapshot", async () => {
    const harness = productionHarness({
      sessionId: "bounded-rollback-failure",
      failStep: "model",
      cliRollbackFailures: 4,
      metadataRollbackFailures: 4,
    });

    await expect(
      runSessionModelChangeTransaction(
        harness.sessionId,
        mutation("B", "max"),
        harness.createHooks()
      )
    ).rejects.toBeInstanceOf(SessionModelChangeReconciliationError);

    expect(harness.state).toMatchObject({
      persistedModel: "initial",
      persistedControls: {
        effortLevel: "max",
        thinkingMode: "enabled",
        modelChangeReconciliation: {
          status: "pending",
          targetModel: "B",
          previousModel: "initial",
        },
      },
      cliModel: "B",
      rendererMetadata: {
        effortLevel: "low",
        thinkingMode: "disabled",
        modelChangeReconciliation: {
          status: "pending",
          targetModel: "B",
          previousModel: "initial",
        },
      },
      currentModel: "initial",
      defaults: { defaultModel: "initial" },
    });
    expect(getSessionModelChangeTransactionState(harness.sessionId)).toEqual({
      status: "reconciliation-required",
      error: expect.any(SessionModelChangeReconciliationError),
    });

    harness.failures.step = undefined;
    harness.failures.cliRollbackRemaining = 0;
    harness.failures.metadataRollbackRemaining = 0;
    const durableMarker = parseSessionModelChangeReconciliation(
      (harness.state.persistedControls as Record<string, unknown>)
        .modelChangeReconciliation
    );
    expect(durableMarker).not.toBeNull();
    await recoverSessionModelChangeTransaction(
      harness.sessionId,
      durableMarker!,
      harness.createHooks()
    );

    expect(harness.state).toMatchObject({
      persistedModel: "initial",
      persistedControls: {
        effortLevel: "low",
        thinkingMode: "disabled",
        modelChangeReconciliation: null,
      },
      cliModel: "initial",
      rendererMetadata: {
        effortLevel: "low",
        thinkingMode: "disabled",
        modelChangeReconciliation: null,
      },
      currentModel: "initial",
      defaults: {
        defaultModel: "initial",
        defaultEffortLevel: "low",
        defaultThinkingMode: "disabled",
      },
    });
    expect(getSessionModelChangeTransactionState(harness.sessionId)).toEqual({
      status: "idle",
    });
  });
});
