import { describe, expect, it } from "vitest";
import {
  CONTEXT_METER_SCHEMA_VERSION,
  createUnavailableContextMeterStateV1,
  hydrateContextMeterStateV1,
  reduceContextMeterStateV1,
  type ContextMeterIdentityV1,
  type ContextMeterOrderV1,
  type ContextMeterStateV1,
  type ContextObservationV1,
} from "../contextMeter";

const identity: ContextMeterIdentityV1 = {
  nimbalystSessionId: "nim-session-1",
  providerId: "claude-code",
  persistedModelId: "claude-code:claudex-sol",
  providerModelId: "gpt-5.6-sol",
  catalogEntryId: "claudex-sol",
  interfaceId: "claude-agent-anthropic",
  upstreamThreadId: "upstream-thread-1",
  producerRole: "lead",
};

function order(
  sequence: number,
  lifecycleGeneration = 0,
  processInstanceId = "process-1"
): ContextMeterOrderV1 {
  return {
    processInstanceId,
    lifecycleGeneration,
    sequence,
    turnId: `turn-${sequence}`,
    observedAtMs: 1_000 + sequence,
  };
}

function observation(
  overrides: Partial<ContextObservationV1> = {}
): ContextObservationV1 {
  return {
    schemaVersion: CONTEXT_METER_SCHEMA_VERSION,
    fillTokens: 40_000,
    adapterId: "claude-agent-sdk-parent-v1",
    windowPolicy: "runtime-then-model-seed",
    contextWindowSeedTokens: 372_000,
    numeratorSemantics: "current-lead-context",
    identity,
    order: order(1),
    ...overrides,
  };
}

function accept(
  current: ContextMeterStateV1,
  next: ContextObservationV1
): ContextMeterStateV1 {
  return reduceContextMeterStateV1(current, {
    type: "observation",
    observation: next,
  });
}

describe("ContextMeterStateV1 reducer", () => {
  it("classifies a paired runtime observation as exact", () => {
    const state = accept(
      createUnavailableContextMeterStateV1(),
      observation({ runtimeWindowTokens: 400_000 })
    );

    expect(state).toMatchObject({
      confidence: "exact",
      fillTokens: 40_000,
      effectiveWindowTokens: 400_000,
      provenance: {
        denominatorSource: "runtime-observation",
        numeratorSource: "runtime-observation",
      },
    });
  });

  it("classifies a current numerator with an immutable admitted seed as estimated", () => {
    const state = accept(createUnavailableContextMeterStateV1(), observation());

    expect(state).toMatchObject({
      confidence: "estimated",
      fillTokens: 40_000,
      effectiveWindowTokens: 372_000,
      provenance: { denominatorSource: "immutable-model-seed" },
    });
  });

  it("requires a runtime denominator for runtime-required adapters", () => {
    const state = accept(
      createUnavailableContextMeterStateV1(),
      observation({
        adapterId: "codex-app-server-thread-usage-v1",
        windowPolicy: "runtime-required",
        contextWindowSeedTokens: undefined,
      })
    );

    expect(state).toMatchObject({
      confidence: "unavailable",
      reason: "runtime-window-required",
    });
  });

  it("reuses a prior matching runtime denominator inside one identity and generation", () => {
    const exact = accept(
      createUnavailableContextMeterStateV1(),
      observation({ runtimeWindowTokens: 400_000 })
    );
    const next = accept(
      exact,
      observation({
        fillTokens: 55_000,
        runtimeWindowTokens: undefined,
        order: order(2),
      })
    );

    expect(next).toMatchObject({
      confidence: "exact",
      fillTokens: 55_000,
      effectiveWindowTokens: 400_000,
      provenance: { denominatorSource: "prior-runtime-observation" },
    });
  });

  it("fails closed on seed conflict without clamping", () => {
    const state = accept(
      createUnavailableContextMeterStateV1(),
      observation({ fillTokens: 372_001 })
    );
    expect(state).toMatchObject({
      confidence: "unavailable",
      reason: "seed-conflict",
    });
    expect(state).not.toHaveProperty("fillTokens");
  });

  it.each([
    ["NaN fill", { fillTokens: Number.NaN }],
    ["infinite fill", { fillTokens: Number.POSITIVE_INFINITY }],
    ["fractional fill", { fillTokens: 1.5 }],
    ["negative fill", { fillTokens: -1 }],
    ["zero runtime window", { runtimeWindowTokens: 0 }],
    [
      "unsafe runtime window",
      { runtimeWindowTokens: Number.MAX_SAFE_INTEGER + 1 },
    ],
    [
      "fill over runtime window",
      { fillTokens: 200_001, runtimeWindowTokens: 200_000 },
    ],
    ["unknown adapter", { adapterId: "unknown-adapter" as never }],
    ["unknown policy", { windowPolicy: "unknown-policy" as never }],
  ])("rejects malformed observation: %s", (_label, overrides) => {
    const current = accept(
      createUnavailableContextMeterStateV1(),
      observation({ runtimeWindowTokens: 400_000 })
    );
    const next = accept(
      current,
      observation({ ...overrides, order: order(2) })
    );
    expect(next).toBe(current);
  });

  it("rejects child/subagent producer relays", () => {
    const current = accept(
      createUnavailableContextMeterStateV1(),
      observation({ runtimeWindowTokens: 400_000 })
    );
    const next = accept(
      current,
      observation({
        identity: { ...identity, producerRole: "child" as never },
        order: order(2),
      })
    );
    expect(next).toBe(current);
  });

  it.each([
    ["session", { nimbalystSessionId: "other-session" }],
    ["provider", { providerId: "openai-codex" }],
    ["persisted model", { persistedModelId: "claude-code:claudex-terra" }],
    ["provider model", { providerModelId: "gpt-5.6-terra" }],
    ["catalog route", { catalogEntryId: "claudex-terra" }],
    ["interface", { interfaceId: "other-interface" }],
    ["thread", { upstreamThreadId: "other-thread" }],
  ])(
    "rejects a stray %s mismatch without overwriting valid state",
    (_label, patch) => {
      const current = accept(
        createUnavailableContextMeterStateV1(),
        observation({ runtimeWindowTokens: 400_000 })
      );
      const next = accept(
        current,
        observation({
          identity: { ...identity, ...patch },
          runtimeWindowTokens: 400_000,
          order: order(2),
        })
      );
      expect(next).toBe(current);
    }
  );

  it("rejects duplicate, decreasing, old-generation, and foreign-process order", () => {
    const current = accept(
      createUnavailableContextMeterStateV1(),
      observation({ runtimeWindowTokens: 400_000, order: order(3) })
    );

    for (const nextOrder of [
      order(3),
      order(2),
      order(4, 1),
      order(4, 0, "process-2"),
    ]) {
      expect(
        accept(
          current,
          observation({ runtimeWindowTokens: 400_000, order: nextOrder })
        )
      ).toBe(current);
    }
  });

  it("clears on compaction with a higher generation and rejects late prior-generation data", () => {
    const current = accept(
      createUnavailableContextMeterStateV1(),
      observation({ runtimeWindowTokens: 400_000, order: order(3) })
    );
    const compactIdentity = { ...identity };
    const cleared = reduceContextMeterStateV1(current, {
      type: "invalidate",
      reason: "compacted",
      lifecycle: { identity: compactIdentity, order: order(1, 1) },
    });
    expect(cleared).toMatchObject({
      confidence: "unavailable",
      reason: "compacted",
    });

    const late = accept(
      cleared,
      observation({ runtimeWindowTokens: 400_000, order: order(4, 0) })
    );
    expect(late).toBe(cleared);

    const fresh = accept(
      cleared,
      observation({ runtimeWindowTokens: 400_000, order: order(2, 1) })
    );
    expect(fresh.confidence).toBe("exact");
  });

  it.each([
    "thread-reset",
    "model-changed",
    "route-changed",
    "interface-changed",
  ] as const)("clears authoritatively for %s", (reason) => {
    const current = accept(
      createUnavailableContextMeterStateV1(),
      observation({ runtimeWindowTokens: 400_000 })
    );
    const nextIdentity = {
      ...identity,
      ...(reason === "thread-reset" ? { upstreamThreadId: "thread-2" } : {}),
      ...(reason === "model-changed"
        ? { persistedModelId: "claude-code:claudex-terra" }
        : {}),
      ...(reason === "route-changed"
        ? { catalogEntryId: "claudex-terra" }
        : {}),
      ...(reason === "interface-changed" ? { interfaceId: "interface-2" } : {}),
    };
    const cleared = reduceContextMeterStateV1(current, {
      type: "invalidate",
      reason,
      lifecycle: { identity: nextIdentity, order: order(1, 1) },
    });
    expect(cleared).toMatchObject({ confidence: "unavailable", reason });
  });

  it("hydrates matching numeric state as stale and mismatches as unavailable", () => {
    const current = accept(
      createUnavailableContextMeterStateV1(),
      observation({ runtimeWindowTokens: 400_000 })
    );
    expect(hydrateContextMeterStateV1(current, identity, 0).confidence).toBe(
      "stale"
    );
    expect(
      hydrateContextMeterStateV1(
        current,
        { ...identity, upstreamThreadId: "other" },
        0
      )
    ).toMatchObject({ confidence: "unavailable", reason: "restart-mismatch" });
    expect(hydrateContextMeterStateV1(undefined, identity, 0)).toMatchObject({
      confidence: "unavailable",
      reason: "legacy-unverifiable",
    });
  });

  it("lets a hydrated stale state accept the first exact observation from a new process", () => {
    const prior = accept(
      createUnavailableContextMeterStateV1(),
      observation({ runtimeWindowTokens: 400_000 })
    );
    const stale = hydrateContextMeterStateV1(prior, identity, 0);
    const fresh = accept(
      stale,
      observation({
        fillTokens: 41_000,
        runtimeWindowTokens: 400_000,
        order: order(1, 0, "process-after-restart"),
      })
    );

    expect(fresh).toMatchObject({
      confidence: "exact",
      fillTokens: 41_000,
      provenance: { order: { processInstanceId: "process-after-restart" } },
    });
  });

  it("downgrades on missing completion, cancellation, and error but preserves a fresh completion", () => {
    const current = accept(
      createUnavailableContextMeterStateV1(),
      observation({ runtimeWindowTokens: 400_000 })
    );
    const freshCompletion = reduceContextMeterStateV1(current, {
      type: "turn-completed",
      lifecycle: { identity, order: order(2) },
      hadFreshObservation: true,
    });
    expect(freshCompletion).toBe(current);

    for (const event of [
      {
        type: "turn-completed" as const,
        lifecycle: { identity, order: order(2) },
        hadFreshObservation: false,
      },
      {
        type: "turn-cancelled" as const,
        lifecycle: { identity, order: order(2) },
      },
      { type: "turn-error" as const, lifecycle: { identity, order: order(2) } },
    ]) {
      expect(reduceContextMeterStateV1(current, event)).toMatchObject({
        confidence: "stale",
      });
    }
  });
});
