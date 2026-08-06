import { describe, expect, it } from "vitest";
import type { ContextObservationV1 } from "@nimbalyst/runtime/ai/server/types";
import {
  applyContextObservationToTokenUsage,
  contextMeterTransitionReason,
  expectedContextMeterIdentityForSession,
  invalidateContextMeterTokenUsage,
  settleContextMeterTurn,
  transitionContextMeterTokenUsage,
} from "../MessageStreamingHandler";
import { hydrateContextMeterStateV1 } from "@nimbalyst/runtime/ai/server";

function observation(
  sequence: number,
  overrides: Partial<ContextObservationV1> = {}
): ContextObservationV1 {
  return {
    schemaVersion: 1,
    fillTokens: 32_000,
    runtimeWindowTokens: 200_000,
    adapterId: "codex-app-server-thread-usage-v1",
    windowPolicy: "runtime-required",
    numeratorSemantics: "current-lead-context",
    identity: {
      nimbalystSessionId: "session-1",
      providerId: "openai-codex",
      persistedModelId: "openai-codex:gpt-5.4",
      upstreamThreadId: "thread-1",
      producerRole: "lead",
    },
    order: {
      processInstanceId: "process-1",
      lifecycleGeneration: 0,
      sequence,
      turnId: "turn-1",
      observedAtMs: 1_000 + sequence,
    },
    ...overrides,
  };
}

const cumulative = {
  inputTokens: 90_000,
  outputTokens: 10_000,
  totalTokens: 100_000,
};

describe("MessageStreamingHandler context-meter seam", () => {
  it("projects only an accepted paired observation while preserving cumulative usage", () => {
    const next = applyContextObservationToTokenUsage(
      cumulative,
      observation(1)
    );
    expect(next).toMatchObject({
      ...cumulative,
      currentContext: { tokens: 32_000, contextWindow: 200_000 },
      contextMeterState: {
        confidence: "exact",
        fillTokens: 32_000,
        effectiveWindowTokens: 200_000,
      },
    });
  });

  it("never derives current context from cumulative token counters", () => {
    const next = settleContextMeterTurn(cumulative, false);
    expect(next.inputTokens).toBe(90_000);
    expect(next.currentContext).toBeUndefined();
    expect(next.contextMeterState).toMatchObject({
      confidence: "unavailable",
      reason: "turn-missing-observation",
    });
  });

  it("rejects an unpaired newer fill without partially overwriting exact state", () => {
    const exact = applyContextObservationToTokenUsage(
      cumulative,
      observation(1)
    );
    const malformed = applyContextObservationToTokenUsage(
      exact,
      observation(2, { fillTokens: 250_000 })
    );
    expect(malformed.contextMeterState).toBe(exact.contextMeterState);
    expect(malformed.currentContext).toEqual(exact.currentContext);
  });

  it("marks a missing terminal observation stale", () => {
    const exact = applyContextObservationToTokenUsage(
      cumulative,
      observation(1)
    );
    expect(
      settleContextMeterTurn(exact, false).contextMeterState?.confidence
    ).toBe("stale");
  });

  it.each(["cancelled", "error"] as const)(
    "marks a %s turn stale",
    (outcome) => {
      const exact = applyContextObservationToTokenUsage(
        cumulative,
        observation(1)
      );
      expect(
        settleContextMeterTurn(exact, true, outcome).contextMeterState
          ?.confidence
      ).toBe("stale");
    }
  );

  it("clears on compaction and accepts only a newer-generation observation", () => {
    const exact = applyContextObservationToTokenUsage(
      cumulative,
      observation(1)
    );
    const compacted = invalidateContextMeterTokenUsage(exact, "compacted");
    expect(compacted.contextMeterState).toMatchObject({
      confidence: "unavailable",
      reason: "compacted",
    });
    expect(compacted.currentContext).toBeUndefined();

    const late = applyContextObservationToTokenUsage(compacted, observation(3));
    expect(late.contextMeterState).toBe(compacted.contextMeterState);

    const fresh = applyContextObservationToTokenUsage(
      compacted,
      observation(2, {
        order: {
          ...observation(2).order,
          lifecycleGeneration: 1,
        },
      })
    );
    expect(fresh.contextMeterState?.confidence).toBe("exact");
  });

  it.each([
    [
      "thread reset",
      {
        identity: { ...observation(1).identity, upstreamThreadId: "thread-2" },
      },
    ],
    [
      "model change",
      {
        identity: {
          ...observation(1).identity,
          persistedModelId: "openai-codex:gpt-6",
          providerModelId: "gpt-6",
        },
      },
    ],
  ] as const)(
    "rejects a stray %s observation without overwriting accepted truth",
    (_label, overrides) => {
      const exact = applyContextObservationToTokenUsage(
        cumulative,
        observation(1)
      );
      const next = applyContextObservationToTokenUsage(
        exact,
        observation(1, overrides)
      );
      expect(next.contextMeterState).toBe(exact.contextMeterState);
      expect(next.currentContext).toEqual(exact.currentContext);
    }
  );

  it("accepts a new identity only after an explicit authoritative transition", () => {
    const exact = applyContextObservationToTokenUsage(
      cumulative,
      observation(1)
    );
    const nextIdentity = {
      ...observation(1).identity,
      upstreamThreadId: "thread-2",
    };
    const transitioned = transitionContextMeterTokenUsage(
      exact,
      nextIdentity,
      "thread-reset"
    );
    expect(transitioned.contextMeterState).toMatchObject({
      confidence: "unavailable",
      reason: "thread-reset",
      provenance: { identity: nextIdentity, order: { lifecycleGeneration: 1 } },
    });

    const accepted = applyContextObservationToTokenUsage(
      transitioned,
      observation(1, {
        identity: nextIdentity,
        order: {
          ...observation(1).order,
          lifecycleGeneration: 1,
          sequence: 2,
        },
      })
    );
    expect(accepted.contextMeterState).toMatchObject({
      confidence: "exact",
      provenance: { identity: nextIdentity },
    });
  });

  it.each([
    "claude-agent-sdk-parent-v1",
    "codex-sdk-token-count-v1",
    "codex-app-server-thread-usage-v1",
  ] as const)(
    "rebases a fresh %s process onto a persisted compacted lifecycle",
    (adapterId) => {
      const exact = applyContextObservationToTokenUsage(
        cumulative,
        observation(1, { adapterId })
      );
      const compacted = invalidateContextMeterTokenUsage(exact, "compacted");
      const recovered = applyContextObservationToTokenUsage(
        compacted,
        observation(1, {
          adapterId,
          order: {
            ...observation(1).order,
            processInstanceId: "process-after-restart",
            lifecycleGeneration: 0,
          },
        })
      );
      expect(recovered.contextMeterState).toMatchObject({
        confidence: "exact",
        provenance: {
          adapterId,
          order: {
            processInstanceId: "process-after-restart",
            lifecycleGeneration: 1,
          },
        },
      });
    }
  );

  it("hydrates from the durable live route instead of persisted meter identity", () => {
    const routeIdentity = {
      ...observation(1).identity,
      providerModelId: "gpt-5.4",
      catalogEntryId: "codex-gpt-5.4",
      interfaceId: "codex-app-server",
    };
    const exact = applyContextObservationToTokenUsage(
      cumulative,
      observation(1, { identity: routeIdentity })
    );
    const persisted = exact.contextMeterState!;
    const liveSession = {
      id: "session-1",
      provider: "openai-codex",
      model: "openai-codex:gpt-5.4",
      providerSessionId: "thread-1",
      metadata: {
        providerRuntimeRouteSnapshotV1: {
          schemaVersion: 1,
          main: {
            plan: {
              provider: "openai-codex",
              model: {
                persistedId: "openai-codex:gpt-5.4",
                providerModelId: "gpt-5.4",
                catalogEntryId: "codex-gpt-5.4",
              },
              selectedInterface: { id: "codex-app-server" },
            },
          },
        },
      },
    };
    const expected = expectedContextMeterIdentityForSession(liveSession);
    expect(expected).toEqual(routeIdentity);
    expect(hydrateContextMeterStateV1(persisted, expected, 0).confidence).toBe(
      "stale"
    );

    const oldRoute = expectedContextMeterIdentityForSession({
      ...liveSession,
      metadata: {
        providerRuntimeRouteSnapshotV1: {
          ...liveSession.metadata.providerRuntimeRouteSnapshotV1,
          main: {
            plan: {
              ...liveSession.metadata.providerRuntimeRouteSnapshotV1.main.plan,
              model: {
                persistedId: "openai-codex:gpt-5.4",
                providerModelId: "gpt-5.4-old",
                catalogEntryId: "codex-old-route",
              },
            },
          },
        },
      },
    });
    expect(hydrateContextMeterStateV1(persisted, oldRoute, 0)).toMatchObject({
      confidence: "unavailable",
      reason: "restart-mismatch",
    });

    const clearedThread = expectedContextMeterIdentityForSession({
      ...liveSession,
      providerSessionId: undefined,
    });
    expect(clearedThread.upstreamThreadId).toBe("session-1");
    expect(contextMeterTransitionReason(expected, clearedThread)).toBe(
      "thread-reset"
    );
    const transitioned = transitionContextMeterTokenUsage(
      exact,
      clearedThread,
      "thread-reset"
    );
    const acceptedNewThread = applyContextObservationToTokenUsage(
      transitioned,
      observation(2, {
        identity: clearedThread,
        order: {
          ...observation(2).order,
          processInstanceId: "new-process",
          lifecycleGeneration: 0,
        },
      })
    );
    expect(acceptedNewThread.contextMeterState).toMatchObject({
      confidence: "exact",
      provenance: {
        identity: { upstreamThreadId: "session-1" },
        order: { lifecycleGeneration: 1 },
      },
    });

    expect(
      hydrateContextMeterStateV1(
        persisted,
        { ...expected, catalogEntryId: "old-route" },
        0
      )
    ).toMatchObject({ confidence: "unavailable", reason: "restart-mismatch" });
    expect(
      hydrateContextMeterStateV1(
        { ...persisted, fillTokens: Number.NaN },
        expected,
        0
      )
    ).toMatchObject({ confidence: "unavailable", reason: "restart-mismatch" });
    expect(
      hydrateContextMeterStateV1(
        { schemaVersion: 1, confidence: "exact", provenance: {} },
        expected,
        0
      )
    ).toMatchObject({ confidence: "unavailable", reason: "restart-mismatch" });
  });

  it("hydrates a matching active Codex route when no durable Claude snapshot applies", () => {
    const identity = {
      ...observation(1).identity,
      providerModelId: "gpt-5.4",
    };
    const persisted = applyContextObservationToTokenUsage(
      cumulative,
      observation(1, { identity })
    ).contextMeterState!;
    const expected = expectedContextMeterIdentityForSession({
      id: "session-1",
      provider: "openai-codex",
      model: "openai-codex:gpt-5.4",
      providerSessionId: "thread-1",
    });

    expect(expected).toEqual(identity);
    expect(hydrateContextMeterStateV1(persisted, expected, 0)).toMatchObject({
      confidence: "stale",
      provenance: { identity },
    });
  });
});
