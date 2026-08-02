import type { EffortLevel, ThinkingMode } from "../../utils/modelUtils";

export interface LatestModelChangeHooks<T> {
  apply: (value: T) => Promise<void>;
  commit: (value: T) => void;
  rollback: (value: T, error: unknown) => Promise<void> | void;
}

export interface SessionModelChange {
  modelId: string;
  previousModel: string;
  previousControls: {
    effortLevel: unknown;
    thinkingMode: unknown;
  };
  catalogControls: Readonly<{
    effortLevel: EffortLevel | null;
    thinkingMode: ThinkingMode | null;
  }> | null;
}

interface MutationResult {
  success?: boolean;
  error?: string;
}

const ROLLBACK_RECONCILIATION_ATTEMPTS = 3;
const MODEL_CHANGE_RECONCILIATION_KEY = "modelChangeReconciliation";

export interface DurableSessionModelChangeReconciliation {
  status: "pending";
  targetModel: string;
  targetControls: {
    effortLevel: unknown;
    thinkingMode: unknown;
  };
  previousModel: string;
  previousControls: {
    effortLevel: unknown;
    thinkingMode: unknown;
  };
}

function createDurableReconciliationMarker(
  change: SessionModelChange
): DurableSessionModelChangeReconciliation {
  const controls = change.catalogControls ?? change.previousControls;
  return {
    status: "pending",
    targetModel: change.modelId,
    targetControls: controls,
    previousModel: change.previousModel,
    previousControls: change.previousControls,
  };
}

export function parseSessionModelChangeReconciliation(
  value: unknown
): DurableSessionModelChangeReconciliation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.status !== "pending" ||
    typeof candidate.targetModel !== "string" ||
    typeof candidate.previousModel !== "string" ||
    !candidate.targetControls ||
    typeof candidate.targetControls !== "object" ||
    Array.isArray(candidate.targetControls) ||
    !candidate.previousControls ||
    typeof candidate.previousControls !== "object" ||
    Array.isArray(candidate.previousControls)
  ) {
    return null;
  }
  return candidate as unknown as DurableSessionModelChangeReconciliation;
}

export class SessionModelChangeReconciliationError extends Error {
  constructor() {
    super("Model change rollback could not converge after bounded retries.");
    this.name = "SessionModelChangeReconciliationError";
  }
}

export interface SessionModelChangeDependencies {
  sessionId: string;
  usesClaudeCli: boolean;
  invoke: (
    channel: string,
    sessionId: string,
    updates: Record<string, unknown>
  ) => Promise<MutationResult | undefined>;
  setClaudeCliModel: (sessionId: string, modelId: string) => Promise<void>;
  readSessionMetadata: () => Record<string, unknown> | null;
  writeSessionMetadata: (metadata: Record<string, unknown>) => void;
  setCurrentModel: (modelId: string) => void;
  setAgentModeSettings: (settings: {
    defaultModel: string;
    defaultEffortLevel?: EffortLevel;
    defaultThinkingMode?: ThinkingMode;
  }) => void;
  reportError: (message: string, error: unknown) => void;
}

function ensureMutationSucceeded(
  result: MutationResult | undefined,
  fallback: string
): void {
  if (result?.success === false) {
    throw new Error(result.error || fallback);
  }
}

/**
 * Production transaction hooks shared by SessionTranscript and its regression
 * tests. Every request writes the complete control snapshot before the model,
 * so the next serialized request repairs any partial side effect left by an
 * older failed request even when the next model has no catalog controls.
 */
export function createSessionModelChangeHooks(
  dependencies: SessionModelChangeDependencies
): LatestModelChangeHooks<SessionModelChange> {
  const {
    sessionId,
    usesClaudeCli,
    invoke,
    setClaudeCliModel,
    readSessionMetadata,
    writeSessionMetadata,
    setCurrentModel,
    setAgentModeSettings,
    reportError,
  } = dependencies;

  return {
    apply: async (next) => {
      const controls = next.catalogControls ?? next.previousControls;
      ensureMutationSucceeded(
        await invoke("sessions:update-metadata", sessionId, {
          metadata: {
            ...controls,
            [MODEL_CHANGE_RECONCILIATION_KEY]:
              createDurableReconciliationMarker(next),
          },
        }),
        "Failed to persist model controls."
      );
      if (usesClaudeCli) {
        await setClaudeCliModel(sessionId, next.modelId);
      }
      ensureMutationSucceeded(
        await invoke("sessions:update-metadata", sessionId, {
          model: next.modelId,
          metadata: {
            ...controls,
            [MODEL_CHANGE_RECONCILIATION_KEY]: null,
          },
        }),
        "Failed to commit model and reconciliation state."
      );
    },
    commit: (next) => {
      const controls = next.catalogControls ?? next.previousControls;
      const currentMetadata = readSessionMetadata();
      if (currentMetadata) {
        writeSessionMetadata({
          ...currentMetadata,
          ...controls,
          [MODEL_CHANGE_RECONCILIATION_KEY]: null,
        });
      }
      setCurrentModel(next.modelId);
      setAgentModeSettings({
        defaultModel: next.modelId,
        ...(next.catalogControls?.effortLevel
          ? { defaultEffortLevel: next.catalogControls.effortLevel }
          : {}),
        ...(next.catalogControls?.thinkingMode
          ? { defaultThinkingMode: next.catalogControls.thinkingMode }
          : {}),
      });
    },
    rollback: async (failed, error) => {
      reportError("Failed to update model", error);
      let cliConverged = !usesClaudeCli;
      let metadataConverged = false;
      let lastCliError: unknown;
      let lastMetadataError: unknown;

      for (
        let attempt = 0;
        attempt < ROLLBACK_RECONCILIATION_ATTEMPTS &&
        (!cliConverged || !metadataConverged);
        attempt += 1
      ) {
        if (!cliConverged) {
          try {
            await setClaudeCliModel(sessionId, failed.previousModel);
            cliConverged = true;
          } catch (rollbackError) {
            lastCliError = rollbackError;
          }
        }
        if (!metadataConverged) {
          try {
            ensureMutationSucceeded(
              await invoke("sessions:update-metadata", sessionId, {
                model: failed.previousModel,
                metadata: {
                  ...failed.previousControls,
                  [MODEL_CHANGE_RECONCILIATION_KEY]: null,
                },
              }),
              "Failed to roll back model metadata."
            );
            metadataConverged = true;
          } catch (rollbackError) {
            lastMetadataError = rollbackError;
          }
        }
      }

      if (!cliConverged || !metadataConverged) {
        const currentMetadata = readSessionMetadata();
        if (currentMetadata) {
          writeSessionMetadata({
            ...currentMetadata,
            [MODEL_CHANGE_RECONCILIATION_KEY]:
              createDurableReconciliationMarker(failed),
          });
        }
        if (!cliConverged) {
          reportError(
            "CLI model rollback still requires reconciliation",
            lastCliError
          );
        }
        if (!metadataConverged) {
          reportError(
            "Model metadata rollback still requires reconciliation",
            lastMetadataError
          );
        }
        throw new SessionModelChangeReconciliationError();
      }

      const currentMetadata = readSessionMetadata();
      if (currentMetadata) {
        writeSessionMetadata({
          ...currentMetadata,
          ...failed.previousControls,
          [MODEL_CHANGE_RECONCILIATION_KEY]: null,
        });
      }
      setCurrentModel(failed.previousModel);
      setAgentModeSettings({
        defaultModel: failed.previousModel,
        ...(typeof failed.previousControls.effortLevel === "string"
          ? {
              defaultEffortLevel: failed.previousControls
                .effortLevel as EffortLevel,
            }
          : {}),
        ...(typeof failed.previousControls.thinkingMode === "string"
          ? {
              defaultThinkingMode: failed.previousControls
                .thinkingMode as ThinkingMode,
            }
          : {}),
      });
    },
  };
}

/**
 * Serializes the complete external mutation transaction. A newer request is
 * always applied after every side effect from an older request has settled, so
 * an older completion can never become the last writer or trigger a replay of
 * an already-committed newer value.
 */
export class LatestModelChangeCoordinator<T> {
  private generation = 0;
  private transactionTail: Promise<void> = Promise.resolve();

  run(value: T, hooks: LatestModelChangeHooks<T>): Promise<void> {
    const requestGeneration = ++this.generation;
    const transaction = this.transactionTail.then(async () => {
      let succeeded = false;
      let error: unknown;
      try {
        await hooks.apply(value);
        succeeded = true;
      } catch (caught) {
        error = caught;
      }

      // A newer queued transaction will run after this one and becomes the
      // final writer. Suppressing stale commit/rollback also prevents a partial
      // older failure from restoring state over the queued request.
      if (requestGeneration !== this.generation) return;
      if (succeeded) {
        hooks.commit(value);
      } else {
        await hooks.rollback(value, error);
      }
    });
    this.transactionTail = transaction.then(
      () => undefined,
      () => undefined
    );
    return transaction;
  }
}

interface SessionModelChangeCoordinatorEntry {
  coordinator: LatestModelChangeCoordinator<SessionModelChange>;
  activeRequests: number;
  reconciliationError: SessionModelChangeReconciliationError | null;
}

const sessionModelChangeCoordinators = new Map<
  string,
  SessionModelChangeCoordinatorEntry
>();
const sessionModelChangeRecoveries = new Map<
  string,
  { signature: string; promise: Promise<void> }
>();

export type SessionModelChangeTransactionState =
  | { status: "idle" }
  | { status: "running" }
  | {
      status: "reconciliation-required";
      error: SessionModelChangeReconciliationError;
    };

export function getSessionModelChangeTransactionState(
  sessionId: string
): SessionModelChangeTransactionState {
  const entry = sessionModelChangeCoordinators.get(sessionId);
  if (!entry) return { status: "idle" };
  if (entry.activeRequests > 0) return { status: "running" };
  if (entry.reconciliationError) {
    return {
      status: "reconciliation-required",
      error: entry.reconciliationError,
    };
  }
  return { status: "idle" };
}

/**
 * Shares one transaction tail across every mounted view of a session. Entries
 * are request-scoped, so unmounting a view cannot abandon an in-flight tail,
 * and an idle healthy session does not remain retained indefinitely.
 */
export async function runSessionModelChangeTransaction(
  sessionId: string,
  value: SessionModelChange,
  hooks: LatestModelChangeHooks<SessionModelChange>
): Promise<void> {
  let entry = sessionModelChangeCoordinators.get(sessionId);
  if (!entry) {
    entry = {
      coordinator: new LatestModelChangeCoordinator<SessionModelChange>(),
      activeRequests: 0,
      reconciliationError: null,
    };
    sessionModelChangeCoordinators.set(sessionId, entry);
  }

  entry.activeRequests += 1;
  try {
    await entry.coordinator.run(value, hooks);
    entry.reconciliationError = null;
  } catch (error) {
    if (error instanceof SessionModelChangeReconciliationError) {
      entry.reconciliationError = error;
    }
    throw error;
  } finally {
    entry.activeRequests -= 1;
    if (
      entry.activeRequests === 0 &&
      !entry.reconciliationError &&
      sessionModelChangeCoordinators.get(sessionId) === entry
    ) {
      sessionModelChangeCoordinators.delete(sessionId);
    }
  }
}

/**
 * Reconciles a durable interrupted transaction back to its prior committed
 * snapshot. Multiple mounted views share the same recovery promise, while a
 * later manual retry receives a fresh bounded attempt after failure.
 */
export function recoverSessionModelChangeTransaction(
  sessionId: string,
  marker: DurableSessionModelChangeReconciliation,
  hooks: LatestModelChangeHooks<SessionModelChange>
): Promise<void> {
  const signature = JSON.stringify(marker);
  const existing = sessionModelChangeRecoveries.get(sessionId);
  if (existing?.signature === signature) return existing.promise;

  const value: SessionModelChange = {
    modelId: marker.previousModel,
    previousModel: marker.previousModel,
    previousControls: marker.previousControls,
    catalogControls: {
      effortLevel:
        typeof marker.previousControls.effortLevel === "string"
          ? (marker.previousControls.effortLevel as EffortLevel)
          : null,
      thinkingMode:
        typeof marker.previousControls.thinkingMode === "string"
          ? (marker.previousControls.thinkingMode as ThinkingMode)
          : null,
    },
  };
  const recovery = runSessionModelChangeTransaction(sessionId, value, hooks);
  const tracked = recovery.finally(() => {
    if (sessionModelChangeRecoveries.get(sessionId)?.promise === tracked) {
      sessionModelChangeRecoveries.delete(sessionId);
    }
  });
  sessionModelChangeRecoveries.set(sessionId, { signature, promise: tracked });
  return tracked;
}
