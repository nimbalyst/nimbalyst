/**
 * Provider-neutral context-meter truth contract (NIM-577 / BS-CTX-01).
 *
 * Provider adapters may emit observations, but only this reducer may turn an
 * observation into displayable context state. Cumulative usage is deliberately
 * absent from every input type in this module.
 */

export const CONTEXT_METER_SCHEMA_VERSION = 1 as const;
export const MAX_CONTEXT_WINDOW_SEED_TOKENS = 2_000_000;

export type ContextTelemetryAdapterId =
  | "claude-agent-sdk-parent-v1"
  | "codex-sdk-token-count-v1"
  | "codex-app-server-thread-usage-v1";

export type ContextWindowPolicy =
  | "runtime-required"
  | "runtime-then-model-seed";

export type ContextConfidence = "exact" | "estimated" | "stale" | "unavailable";

export type ContextNumeratorSource = "runtime-observation";

export type ContextDenominatorSource =
  | "runtime-observation"
  | "prior-runtime-observation"
  | "immutable-model-seed"
  | "none";

export type ContextInvalidationReason =
  | "compacted"
  | "thread-reset"
  | "model-changed"
  | "route-changed"
  | "interface-changed"
  | "restart-mismatch";

export type ContextUnavailableReason =
  | "no-observation"
  | "adapter-unavailable"
  | "runtime-window-required"
  | "seed-conflict"
  | "malformed-observation"
  | "identity-invalidated"
  | "legacy-unverifiable"
  | "turn-missing-observation"
  | ContextInvalidationReason;

export interface ContextMeterIdentityV1 {
  nimbalystSessionId: string;
  providerId: string;
  persistedModelId: string;
  providerModelId?: string;
  catalogEntryId?: string;
  interfaceId?: string;
  upstreamThreadId: string;
  producerRole: "lead";
}

export interface ContextMeterOrderV1 {
  processInstanceId: string;
  lifecycleGeneration: number;
  sequence: number;
  turnId?: string;
  observedAtMs: number;
}

export interface ContextObservationV1 {
  schemaVersion: typeof CONTEXT_METER_SCHEMA_VERSION;
  fillTokens: number;
  runtimeWindowTokens?: number;
  adapterId: ContextTelemetryAdapterId;
  windowPolicy: ContextWindowPolicy;
  contextWindowSeedTokens?: number;
  numeratorSemantics: "current-lead-context";
  identity: ContextMeterIdentityV1;
  order: ContextMeterOrderV1;
}

export interface ContextMeterProvenanceV1 {
  identity: ContextMeterIdentityV1;
  order: ContextMeterOrderV1;
  adapterId: ContextTelemetryAdapterId;
  windowPolicy: ContextWindowPolicy;
  numeratorSource: ContextNumeratorSource;
  denominatorSource: ContextDenominatorSource;
  runtimeWindowTokens?: number;
  contextWindowSeedTokens?: number;
  acceptedAtMs: number;
  lastFreshObservationAtMs?: number;
  invalidationReason?: ContextInvalidationReason;
}

export interface ContextMeterAvailableStateV1 {
  schemaVersion: typeof CONTEXT_METER_SCHEMA_VERSION;
  confidence: "exact" | "estimated" | "stale";
  fillTokens: number;
  effectiveWindowTokens: number;
  provenance: ContextMeterProvenanceV1;
}

export interface ContextMeterUnavailableStateV1 {
  schemaVersion: typeof CONTEXT_METER_SCHEMA_VERSION;
  confidence: "unavailable";
  reason: ContextUnavailableReason;
  provenance?: ContextMeterProvenanceV1;
}

export type ContextMeterStateV1 =
  | ContextMeterAvailableStateV1
  | ContextMeterUnavailableStateV1;

export interface ContextMeterLifecycleV1 {
  identity: ContextMeterIdentityV1;
  order: ContextMeterOrderV1;
}

export type ContextMeterReducerEventV1 =
  | { type: "observation"; observation: ContextObservationV1 }
  | {
      type: "invalidate";
      reason: ContextInvalidationReason;
      lifecycle: ContextMeterLifecycleV1;
    }
  | {
      type: "turn-completed";
      lifecycle: ContextMeterLifecycleV1;
      hadFreshObservation: boolean;
    }
  | {
      type: "turn-cancelled" | "turn-error";
      lifecycle: ContextMeterLifecycleV1;
    };

const ADAPTER_IDS = new Set<ContextTelemetryAdapterId>([
  "claude-agent-sdk-parent-v1",
  "codex-sdk-token-count-v1",
  "codex-app-server-thread-usage-v1",
]);

const WINDOW_POLICIES = new Set<ContextWindowPolicy>([
  "runtime-required",
  "runtime-then-model-seed",
]);

const INVALIDATION_REASONS = new Set<ContextInvalidationReason>([
  "compacted",
  "thread-reset",
  "model-changed",
  "route-changed",
  "interface-changed",
  "restart-mismatch",
]);

const UNAVAILABLE_REASONS = new Set<ContextUnavailableReason>([
  "no-observation",
  "adapter-unavailable",
  "runtime-window-required",
  "seed-conflict",
  "malformed-observation",
  "identity-invalidated",
  "legacy-unverifiable",
  "turn-missing-observation",
  ...INVALIDATION_REASONS,
]);

const DENOMINATOR_SOURCES = new Set<ContextDenominatorSource>([
  "runtime-observation",
  "prior-runtime-observation",
  "immutable-model-seed",
  "none",
]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isSafePositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

export function isValidContextWindowSeedTokens(
  value: unknown
): value is number {
  return (
    isSafePositiveInteger(value) &&
    (value as number) <= MAX_CONTEXT_WINDOW_SEED_TOKENS
  );
}

export function isContextTelemetryAdapterId(
  value: unknown
): value is ContextTelemetryAdapterId {
  return ADAPTER_IDS.has(value as ContextTelemetryAdapterId);
}

export function isContextWindowPolicy(
  value: unknown
): value is ContextWindowPolicy {
  return WINDOW_POLICIES.has(value as ContextWindowPolicy);
}

function optionalIdentityFieldEquals(
  left: string | undefined,
  right: string | undefined
): boolean {
  return left === right;
}

export function contextMeterIdentityEquals(
  left: ContextMeterIdentityV1,
  right: ContextMeterIdentityV1
): boolean {
  return (
    left.nimbalystSessionId === right.nimbalystSessionId &&
    left.providerId === right.providerId &&
    left.persistedModelId === right.persistedModelId &&
    optionalIdentityFieldEquals(left.providerModelId, right.providerModelId) &&
    optionalIdentityFieldEquals(left.catalogEntryId, right.catalogEntryId) &&
    optionalIdentityFieldEquals(left.interfaceId, right.interfaceId) &&
    left.upstreamThreadId === right.upstreamThreadId &&
    left.producerRole === right.producerRole
  );
}

function isValidIdentity(value: unknown): value is ContextMeterIdentityV1 {
  if (!value || typeof value !== "object") return false;
  const identity = value as ContextMeterIdentityV1;
  return (
    isNonEmptyString(identity.nimbalystSessionId) &&
    isNonEmptyString(identity.providerId) &&
    isNonEmptyString(identity.persistedModelId) &&
    (identity.providerModelId === undefined ||
      isNonEmptyString(identity.providerModelId)) &&
    (identity.catalogEntryId === undefined ||
      isNonEmptyString(identity.catalogEntryId)) &&
    (identity.interfaceId === undefined ||
      isNonEmptyString(identity.interfaceId)) &&
    isNonEmptyString(identity.upstreamThreadId) &&
    identity.producerRole === "lead"
  );
}

function isValidOrder(value: unknown): value is ContextMeterOrderV1 {
  if (!value || typeof value !== "object") return false;
  const order = value as ContextMeterOrderV1;
  return (
    isNonEmptyString(order.processInstanceId) &&
    isSafeNonNegativeInteger(order.lifecycleGeneration) &&
    isSafePositiveInteger(order.sequence) &&
    (order.turnId === undefined || isNonEmptyString(order.turnId)) &&
    isSafeNonNegativeInteger(order.observedAtMs)
  );
}

function isValidProvenance(value: unknown): value is ContextMeterProvenanceV1 {
  if (!value || typeof value !== "object") return false;
  const provenance = value as ContextMeterProvenanceV1;
  return (
    isValidIdentity(provenance.identity) &&
    isValidOrder(provenance.order) &&
    isContextTelemetryAdapterId(provenance.adapterId) &&
    isContextWindowPolicy(provenance.windowPolicy) &&
    provenance.numeratorSource === "runtime-observation" &&
    DENOMINATOR_SOURCES.has(provenance.denominatorSource) &&
    (provenance.runtimeWindowTokens === undefined ||
      isSafePositiveInteger(provenance.runtimeWindowTokens)) &&
    (provenance.contextWindowSeedTokens === undefined ||
      isValidContextWindowSeedTokens(provenance.contextWindowSeedTokens)) &&
    isSafeNonNegativeInteger(provenance.acceptedAtMs) &&
    (provenance.lastFreshObservationAtMs === undefined ||
      isSafeNonNegativeInteger(provenance.lastFreshObservationAtMs)) &&
    (provenance.invalidationReason === undefined ||
      INVALIDATION_REASONS.has(provenance.invalidationReason))
  );
}

export function isContextMeterStateV1(
  value: unknown
): value is ContextMeterStateV1 {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<ContextMeterStateV1>;
  if (state.schemaVersion !== CONTEXT_METER_SCHEMA_VERSION) return false;
  if (state.confidence === "unavailable") {
    const unavailable = state as ContextMeterUnavailableStateV1;
    return (
      UNAVAILABLE_REASONS.has(unavailable.reason) &&
      (unavailable.provenance === undefined ||
        isValidProvenance(unavailable.provenance))
    );
  }
  if (
    state.confidence !== "exact" &&
    state.confidence !== "estimated" &&
    state.confidence !== "stale"
  ) {
    return false;
  }
  const available = state as ContextMeterAvailableStateV1;
  if (
    isSafeNonNegativeInteger(available.fillTokens) &&
    isSafePositiveInteger(available.effectiveWindowTokens) &&
    available.fillTokens <= available.effectiveWindowTokens &&
    isValidProvenance(available.provenance) &&
    available.provenance.denominatorSource !== "none"
  ) {
    if (available.confidence === "estimated") {
      return (
        available.provenance.denominatorSource === "immutable-model-seed" &&
        available.provenance.contextWindowSeedTokens ===
          available.effectiveWindowTokens
      );
    }
    if (available.provenance.denominatorSource === "immutable-model-seed") {
      return (
        available.confidence === "stale" &&
        available.provenance.contextWindowSeedTokens ===
          available.effectiveWindowTokens
      );
    }
    return (
      available.provenance.runtimeWindowTokens ===
      available.effectiveWindowTokens
    );
  }
  return false;
}

function orderIsNewer(
  current: ContextMeterProvenanceV1 | undefined,
  next: ContextMeterOrderV1,
  allowProcessRestart = false
): boolean {
  if (!current) return true;
  const prior = current.order;
  if (next.lifecycleGeneration !== prior.lifecycleGeneration) return false;
  if (next.processInstanceId !== prior.processInstanceId) {
    return allowProcessRestart;
  }
  return next.sequence > prior.sequence;
}

function matchingCurrentProvenance(
  state: ContextMeterStateV1,
  identity: ContextMeterIdentityV1,
  order: ContextMeterOrderV1
): ContextMeterProvenanceV1 | undefined {
  const provenance = state.provenance;
  if (!provenance) return undefined;
  if (!contextMeterIdentityEquals(provenance.identity, identity))
    return undefined;
  if (provenance.order.lifecycleGeneration !== order.lifecycleGeneration)
    return undefined;
  if (provenance.order.processInstanceId !== order.processInstanceId)
    return undefined;
  return provenance;
}

function unavailableFromObservation(
  observation: ContextObservationV1,
  reason: ContextUnavailableReason
): ContextMeterUnavailableStateV1 {
  return {
    schemaVersion: CONTEXT_METER_SCHEMA_VERSION,
    confidence: "unavailable",
    reason,
    provenance: {
      identity: observation.identity,
      order: observation.order,
      adapterId: observation.adapterId,
      windowPolicy: observation.windowPolicy,
      numeratorSource: "runtime-observation",
      denominatorSource: "none",
      ...(observation.runtimeWindowTokens === undefined
        ? {}
        : { runtimeWindowTokens: observation.runtimeWindowTokens }),
      ...(observation.contextWindowSeedTokens === undefined
        ? {}
        : { contextWindowSeedTokens: observation.contextWindowSeedTokens }),
      acceptedAtMs: observation.order.observedAtMs,
      lastFreshObservationAtMs: observation.order.observedAtMs,
    },
  };
}

export function createUnavailableContextMeterStateV1(
  reason: ContextUnavailableReason = "no-observation",
  provenance?: ContextMeterProvenanceV1
): ContextMeterUnavailableStateV1 {
  return {
    schemaVersion: CONTEXT_METER_SCHEMA_VERSION,
    confidence: "unavailable",
    reason,
    ...(provenance ? { provenance } : {}),
  };
}

/**
 * Hydrated legacy pairs are never promoted. A versioned, identity-matched
 * numeric state is restored as stale; everything else fails closed.
 */
export function hydrateContextMeterStateV1(
  persisted: unknown,
  expectedIdentity: ContextMeterIdentityV1,
  lifecycleGeneration: number
): ContextMeterStateV1 {
  if (
    !isContextMeterStateV1(persisted) ||
    !persisted.provenance ||
    !contextMeterIdentityEquals(
      persisted.provenance.identity,
      expectedIdentity
    ) ||
    persisted.provenance.order.lifecycleGeneration !== lifecycleGeneration
  ) {
    return createUnavailableContextMeterStateV1(
      persisted ? "restart-mismatch" : "legacy-unverifiable"
    );
  }
  if (persisted.confidence === "unavailable") return persisted;
  return { ...persisted, confidence: "stale" };
}

/**
 * The sole state transition function for context-meter truth.
 * Rejected observations return the existing state byte-for-byte: no partial
 * numerator/window merge can overwrite a newer accepted snapshot.
 */
export function reduceContextMeterStateV1(
  current: ContextMeterStateV1,
  event: ContextMeterReducerEventV1
): ContextMeterStateV1 {
  if (event.type === "observation") {
    const observation = event.observation;
    if (
      observation.schemaVersion !== CONTEXT_METER_SCHEMA_VERSION ||
      observation.numeratorSemantics !== "current-lead-context" ||
      !isContextTelemetryAdapterId(observation.adapterId) ||
      !isContextWindowPolicy(observation.windowPolicy) ||
      !isValidIdentity(observation.identity) ||
      !isValidOrder(observation.order) ||
      !isSafeNonNegativeInteger(observation.fillTokens) ||
      (observation.runtimeWindowTokens !== undefined &&
        !isSafePositiveInteger(observation.runtimeWindowTokens)) ||
      (observation.contextWindowSeedTokens !== undefined &&
        !isValidContextWindowSeedTokens(observation.contextWindowSeedTokens))
    ) {
      return current;
    }

    const currentProvenance = current.provenance;
    if (currentProvenance) {
      if (
        !contextMeterIdentityEquals(
          currentProvenance.identity,
          observation.identity
        )
      ) {
        return current;
      }
      // A persisted numeric state is hydrated as stale after a host restart.
      // Only that explicitly-stale state may establish a new producer process;
      // a fresh state never accepts cross-process reordering.
      if (
        !orderIsNewer(
          currentProvenance,
          observation.order,
          current.confidence === "stale" || current.confidence === "unavailable"
        )
      )
        return current;
    }

    if (
      observation.runtimeWindowTokens !== undefined &&
      observation.fillTokens > observation.runtimeWindowTokens
    ) {
      return current;
    }

    const priorMatching = matchingCurrentProvenance(
      current,
      observation.identity,
      observation.order
    );
    const priorRuntimeWindow = priorMatching?.runtimeWindowTokens;
    const runtimeWindowTokens =
      observation.runtimeWindowTokens ?? priorRuntimeWindow;

    let effectiveWindowTokens: number | undefined;
    let denominatorSource: ContextDenominatorSource = "none";
    let confidence: "exact" | "estimated" | undefined;

    if (runtimeWindowTokens !== undefined) {
      effectiveWindowTokens = runtimeWindowTokens;
      denominatorSource =
        observation.runtimeWindowTokens === undefined
          ? "prior-runtime-observation"
          : "runtime-observation";
      confidence = "exact";
    } else if (
      observation.windowPolicy === "runtime-then-model-seed" &&
      observation.contextWindowSeedTokens !== undefined
    ) {
      if (observation.fillTokens > observation.contextWindowSeedTokens) {
        return unavailableFromObservation(observation, "seed-conflict");
      }
      effectiveWindowTokens = observation.contextWindowSeedTokens;
      denominatorSource = "immutable-model-seed";
      confidence = "estimated";
    }

    if (effectiveWindowTokens === undefined || confidence === undefined) {
      return unavailableFromObservation(observation, "runtime-window-required");
    }

    return {
      schemaVersion: CONTEXT_METER_SCHEMA_VERSION,
      confidence,
      fillTokens: observation.fillTokens,
      effectiveWindowTokens,
      provenance: {
        identity: observation.identity,
        order: observation.order,
        adapterId: observation.adapterId,
        windowPolicy: observation.windowPolicy,
        numeratorSource: "runtime-observation",
        denominatorSource,
        ...(runtimeWindowTokens === undefined ? {} : { runtimeWindowTokens }),
        ...(observation.contextWindowSeedTokens === undefined
          ? {}
          : { contextWindowSeedTokens: observation.contextWindowSeedTokens }),
        acceptedAtMs: observation.order.observedAtMs,
        lastFreshObservationAtMs: observation.order.observedAtMs,
      },
    };
  }

  const { identity, order } = event.lifecycle;
  if (!isValidIdentity(identity) || !isValidOrder(order)) return current;
  const provenance = current.provenance;

  if (event.type === "invalidate") {
    if (provenance) {
      const priorGeneration = provenance.order.lifecycleGeneration;
      if (order.lifecycleGeneration <= priorGeneration) return current;
    }
    return {
      schemaVersion: CONTEXT_METER_SCHEMA_VERSION,
      confidence: "unavailable",
      reason: event.reason,
      provenance: {
        identity,
        order,
        adapterId: provenance?.adapterId ?? "claude-agent-sdk-parent-v1",
        windowPolicy: provenance?.windowPolicy ?? "runtime-required",
        numeratorSource: "runtime-observation",
        denominatorSource: "none",
        acceptedAtMs: order.observedAtMs,
        invalidationReason: event.reason,
      },
    };
  }

  if (
    !provenance ||
    !contextMeterIdentityEquals(provenance.identity, identity) ||
    !orderIsNewer(provenance, order)
  ) {
    return current;
  }

  if (current.confidence === "unavailable") return current;
  if (event.type === "turn-completed" && event.hadFreshObservation) {
    return current;
  }
  return {
    ...current,
    confidence: "stale",
    // Terminal host lifecycle does not mint provider observation sequence
    // numbers. Preserve the last accepted provider order so its next genuine
    // observation remains strictly newer.
    provenance: current.provenance,
  };
}
