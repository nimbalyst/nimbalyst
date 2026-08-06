import {
  isCatalogPersistedModelId,
  resolveProviderCatalogRouteSnapshot,
  type ProviderCatalogCapabilities,
  type ProviderCatalogConsumer,
  type ProviderCatalogControlValue,
  type ProviderCatalogControlContext,
  type ProviderCatalogEntry,
  type ProviderCatalogInterface,
  type ProviderCatalogResolution,
  type ProviderCatalogResolvedControlMapping,
} from "./providerCatalog";

export const PROVIDER_RUNTIME_ROUTE_SCHEMA_VERSION = 1 as const;
export const CLAUDE_AGENT_ANTHROPIC_ENV_BRIDGE =
  "claude-agent-anthropic-env-v1" as const;

export type ProviderRuntimeConsumer =
  | "claude-agent-main"
  | "claude-subagent"
  | "consultation-launcher";

export type ProviderRuntimeRouteErrorCode =
  | "adapter-required"
  | "ambiguous-interface"
  | "credential-unavailable"
  | "identity-mismatch"
  | "immutable-session-route"
  | "invalid-controls"
  | "unsupported-consumer"
  | "unsupported-interface"
  | "unsupported-model"
  | "unsupported-route"
  | "unsupported-transport-profile";

export class ProviderRuntimeRouteError extends Error {
  readonly stage = "pre-mutation" as const;

  constructor(
    readonly code: ProviderRuntimeRouteErrorCode,
    message: string,
    readonly catalogEntryId?: string
  ) {
    super(message);
    this.name = "ProviderRuntimeRouteError";
  }
}

export interface ProviderRuntimeRouteRequest {
  catalogEntryId: string;
  persistedModelId: string;
  consumer: ProviderRuntimeConsumer;
  persistedControls?: Readonly<Record<string, unknown>>;
  controlContext?: ProviderCatalogControlContext;
  credentialReferences: Readonly<Record<string, boolean>>;
}

export interface ProviderRuntimeLaunchPlan {
  schemaVersion: typeof PROVIDER_RUNTIME_ROUTE_SCHEMA_VERSION;
  requested: Readonly<{
    catalogEntryId: string;
    persistedModelId: string;
    consumer: ProviderRuntimeConsumer;
    controlContext: ProviderCatalogControlContext;
    controls: Readonly<Record<string, ProviderCatalogControlValue>>;
  }>;
  harness: Readonly<{ id: string }>;
  family: Readonly<{ id: string }>;
  provider: string;
  model: Readonly<{
    catalogEntryId: string;
    persistedId: string;
    providerModelId: string;
    upstreamModel?: string;
    version: string;
  }>;
  selectedInterface: Readonly<{
    id: string;
    kind: "http";
    protocol: "anthropic-messages";
    transportProfile: "anthropic-compatible-proxy";
    bridge: typeof CLAUDE_AGENT_ANTHROPIC_ENV_BRIDGE;
    authProfile: "credential-reference";
    endpoint: string;
    upstreamEndpoint?: string;
    credentialRef: string;
    credentialReferencePresent: true;
    modelAlias: string;
  }>;
  capabilities: Readonly<ProviderCatalogCapabilities>;
  resolvedControls: readonly Readonly<ProviderCatalogResolvedControlMapping>[];
  confirmationState: "confirmed";
  fallbackUsed: false;
}

export interface ProviderRuntimeRouteReceipt {
  schemaVersion: typeof PROVIDER_RUNTIME_ROUTE_SCHEMA_VERSION;
  requested: ProviderRuntimeLaunchPlan["requested"];
  resolved: Readonly<{
    catalogEntryId: string;
    harness: string;
    family: string;
    provider: string;
    persistedModelId: string;
    providerModelId: string;
    upstreamModel?: string;
    version: string;
  }>;
  selectedInterface: Readonly<{
    id: string;
    protocol: "anthropic-messages";
    transportProfile: "anthropic-compatible-proxy";
    bridge: typeof CLAUDE_AGENT_ANTHROPIC_ENV_BRIDGE;
    authProfile: "credential-reference";
    credentialRef: string;
    credentialReferencePresent: true;
    modelAlias: string;
  }>;
  capabilities: Readonly<ProviderCatalogCapabilities>;
  resolvedControls: readonly Readonly<ProviderCatalogResolvedControlMapping>[];
  confirmationState: "confirmed";
  fallbackUsed: false;
}

export interface ProviderRuntimeSessionSnapshot {
  plan: Readonly<ProviderRuntimeLaunchPlan>;
  receipt: Readonly<ProviderRuntimeRouteReceipt>;
}

export interface ClaudeAgentRuntimeRouteBundle {
  main: Readonly<ProviderRuntimeLaunchPlan>;
  subagent: Readonly<ProviderRuntimeLaunchPlan>;
  consultation: Readonly<ProviderRuntimeLaunchPlan>;
}

const RUNTIME_CONSUMERS = new Set<ProviderRuntimeConsumer>([
  "claude-agent-main",
  "claude-subagent",
  "consultation-launcher",
]);

const CATALOG_CONSUMER_BY_RUNTIME_CONSUMER: Readonly<
  Record<ProviderRuntimeConsumer, ProviderCatalogConsumer>
> = {
  "claude-agent-main": "claude-agent-main",
  "claude-subagent": "claude-agent-subagent",
  "consultation-launcher": "consultation",
};

function cloneJson<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneJson(item)) as T;
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneJson(item)])
    ) as T;
  }
  return value;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeJson(item));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [
          key,
          canonicalizeJson((value as Record<string, unknown>)[key]),
        ])
    );
  }
  return value;
}

/** Compare JSON snapshots independently of database object-key ordering. */
export function providerRuntimeRouteSnapshotEquals(
  left: unknown,
  right: unknown
): boolean {
  return (
    JSON.stringify(canonicalizeJson(left)) ===
    JSON.stringify(canonicalizeJson(right))
  );
}

function routeError(
  code: ProviderRuntimeRouteErrorCode,
  message: string,
  catalogEntryId?: string
): never {
  throw new ProviderRuntimeRouteError(code, message, catalogEntryId);
}

function assertRuntimeConsumer(
  consumer: string
): asserts consumer is ProviderRuntimeConsumer {
  if (!RUNTIME_CONSUMERS.has(consumer as ProviderRuntimeConsumer)) {
    routeError(
      "unsupported-consumer",
      `Unsupported provider runtime consumer: ${consumer}`
    );
  }
}

function findEntry(
  resolution: ProviderCatalogResolution,
  request: ProviderRuntimeRouteRequest
): ProviderCatalogEntry {
  const fatalError = resolution.fatalErrors[0];
  if (fatalError) {
    routeError(
      fatalError.code === "adapter-required"
        ? "adapter-required"
        : "unsupported-route",
      `Provider catalog unavailable: ${fatalError.message}`,
      request.catalogEntryId
    );
  }
  const entryError = resolution.errors.find(
    (candidate) => candidate.id === request.catalogEntryId
  );
  if (entryError) {
    const supportedCode: ProviderRuntimeRouteErrorCode =
      entryError.code === "adapter-required" ||
      entryError.code === "ambiguous-interface" ||
      entryError.code === "unsupported-interface" ||
      entryError.code === "unsupported-transport-profile" ||
      entryError.code === "invalid-controls"
        ? entryError.code
        : "unsupported-route";
    routeError(
      supportedCode,
      `Provider catalog entry ${request.catalogEntryId} is not launchable: ${entryError.message}`,
      request.catalogEntryId
    );
  }
  if (resolution.disabledIds.includes(request.catalogEntryId)) {
    routeError(
      "unsupported-route",
      `Provider catalog entry ${request.catalogEntryId} is disabled.`,
      request.catalogEntryId
    );
  }
  const entry = resolution.entries.find(
    (candidate) => candidate.id === request.catalogEntryId
  );
  if (!entry) {
    routeError(
      "unsupported-route",
      `Unsupported provider catalog route: ${request.catalogEntryId}`,
      request.catalogEntryId
    );
  }
  if (entry.model.persistedId !== request.persistedModelId) {
    routeError(
      "identity-mismatch",
      `Provider route ${request.catalogEntryId} does not own persisted model ${request.persistedModelId}.`,
      request.catalogEntryId
    );
  }
  return entry;
}

function assertSupportedInterface(
  entry: ProviderCatalogEntry,
  catalogInterface: ProviderCatalogInterface
): void {
  if (catalogInterface.kind !== "http") {
    routeError(
      "unsupported-interface",
      `Provider route ${entry.id} requires an unsupported interface.`,
      entry.id
    );
  }
  if (
    catalogInterface.protocol !== "anthropic-messages" ||
    catalogInterface.authProfile !== "credential-reference"
  ) {
    routeError(
      "adapter-required",
      `Provider route ${entry.id} requires a reviewed protocol or authentication adapter.`,
      entry.id
    );
  }
  if (catalogInterface.transportProfile !== "anthropic-compatible-proxy") {
    routeError(
      "unsupported-transport-profile",
      `Provider route ${entry.id} requires an unsupported transport profile.`,
      entry.id
    );
  }
  try {
    const endpoint = new URL(catalogInterface.endpoint);
    if (
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    ) {
      throw new Error("secret-bearing endpoint");
    }
  } catch {
    routeError(
      "unsupported-interface",
      `Provider route ${entry.id} contains an unsafe endpoint.`,
      entry.id
    );
  }
}

export function resolveProviderRuntimeLaunchPlan(
  resolution: ProviderCatalogResolution,
  request: ProviderRuntimeRouteRequest
): Readonly<ProviderRuntimeLaunchPlan> {
  assertRuntimeConsumer(request.consumer);
  const entry = findEntry(resolution, request);
  if (entry.admission?.state === "high-runner-candidate") {
    routeError(
      "adapter-required",
      `Provider route ${entry.id} is a catalog candidate and requires a qualified launch adapter.`,
      entry.id
    );
  }
  const controlContext = request.controlContext ?? "midSession";
  const unavailableControl = Object.entries(entry.controls).find(
    ([, control]) => control.applicability?.[controlContext] === false
  );
  if (unavailableControl) {
    routeError(
      "invalid-controls",
      `Provider route ${entry.id} control ${unavailableControl[0]} is unavailable during ${controlContext}.`,
      entry.id
    );
  }
  const catalogConsumer =
    CATALOG_CONSUMER_BY_RUNTIME_CONSUMER[request.consumer];
  const matchingInterfaces = entry.interfaces.filter((candidate) =>
    candidate.consumers.includes(catalogConsumer)
  );
  if (matchingInterfaces.length === 0) {
    routeError(
      "unsupported-consumer",
      `Provider route ${entry.id} does not support ${request.consumer}.`,
      entry.id
    );
  }
  if (matchingInterfaces.length !== 1) {
    routeError(
      "ambiguous-interface",
      `Provider route ${entry.id} owns more than one interface for ${request.consumer}.`,
      entry.id
    );
  }
  const selectedInterface = matchingInterfaces[0];
  assertSupportedInterface(entry, selectedInterface);
  if (request.credentialReferences[selectedInterface.credentialRef] !== true) {
    routeError(
      "credential-unavailable",
      `Provider route ${entry.id} credential reference is unavailable.`,
      entry.id
    );
  }

  let routeSnapshot;
  try {
    routeSnapshot = resolveProviderCatalogRouteSnapshot(
      resolution,
      entry.id,
      request.persistedControls ?? {}
    );
  } catch (error) {
    routeError(
      "invalid-controls",
      error instanceof Error ? error.message : String(error),
      entry.id
    );
  }
  const resolvedControls = routeSnapshot.mappings.filter(
    (mapping) => mapping.interfaceId === selectedInterface.id
  );
  const requestedControls = Object.fromEntries(
    Object.entries(entry.controls).map(([controlId, control]) => [
      controlId,
      routeSnapshot.controlValues[controlId],
    ])
  );

  return deepFreeze(
    cloneJson({
      schemaVersion: PROVIDER_RUNTIME_ROUTE_SCHEMA_VERSION,
      requested: {
        catalogEntryId: entry.id,
        persistedModelId: request.persistedModelId,
        consumer: request.consumer,
        controlContext,
        controls: requestedControls,
      },
      harness: { id: entry.harness.id },
      family: { id: entry.family.id },
      provider: entry.provider,
      model: {
        catalogEntryId: entry.id,
        persistedId: entry.model.persistedId,
        providerModelId: entry.model.providerModelId,
        ...(entry.model.upstreamModel === undefined
          ? {}
          : { upstreamModel: entry.model.upstreamModel }),
        version: entry.model.version,
      },
      selectedInterface: {
        id: selectedInterface.id,
        kind: selectedInterface.kind,
        protocol: selectedInterface.protocol,
        transportProfile: selectedInterface.transportProfile,
        bridge: CLAUDE_AGENT_ANTHROPIC_ENV_BRIDGE,
        authProfile: selectedInterface.authProfile,
        endpoint: selectedInterface.endpoint,
        ...(selectedInterface.upstreamEndpoint === undefined
          ? {}
          : { upstreamEndpoint: selectedInterface.upstreamEndpoint }),
        credentialRef: selectedInterface.credentialRef,
        credentialReferencePresent: true,
        modelAlias: selectedInterface.modelAlias,
      },
      capabilities: entry.capabilities,
      resolvedControls,
      confirmationState: "confirmed",
      fallbackUsed: false,
    }) as ProviderRuntimeLaunchPlan
  );
}

export function createProviderRuntimeRouteReceipt(
  plan: ProviderRuntimeLaunchPlan
): Readonly<ProviderRuntimeRouteReceipt> {
  return deepFreeze(
    cloneJson({
      schemaVersion: PROVIDER_RUNTIME_ROUTE_SCHEMA_VERSION,
      requested: plan.requested,
      resolved: {
        catalogEntryId: plan.model.catalogEntryId,
        harness: plan.harness.id,
        family: plan.family.id,
        provider: plan.provider,
        persistedModelId: plan.model.persistedId,
        providerModelId: plan.model.providerModelId,
        ...(plan.model.upstreamModel === undefined
          ? {}
          : { upstreamModel: plan.model.upstreamModel }),
        version: plan.model.version,
      },
      selectedInterface: {
        id: plan.selectedInterface.id,
        protocol: plan.selectedInterface.protocol,
        transportProfile: plan.selectedInterface.transportProfile,
        bridge: plan.selectedInterface.bridge,
        authProfile: plan.selectedInterface.authProfile,
        credentialRef: plan.selectedInterface.credentialRef,
        credentialReferencePresent:
          plan.selectedInterface.credentialReferencePresent,
        modelAlias: plan.selectedInterface.modelAlias,
      },
      capabilities: plan.capabilities,
      resolvedControls: plan.resolvedControls,
      confirmationState: plan.confirmationState,
      fallbackUsed: false,
    }) as ProviderRuntimeRouteReceipt
  );
}

export function serializeProviderRuntimeRouteReceipt(
  receipt: ProviderRuntimeRouteReceipt
): string {
  return JSON.stringify(receipt);
}

export function createProviderRuntimeSessionSnapshot(
  plan: ProviderRuntimeLaunchPlan
): Readonly<ProviderRuntimeSessionSnapshot> {
  return deepFreeze({
    plan: deepFreeze(cloneJson(plan)) as Readonly<ProviderRuntimeLaunchPlan>,
    receipt: createProviderRuntimeRouteReceipt(plan),
  });
}

export class ProviderRuntimeSessionSnapshotStore {
  private readonly snapshots = new Map<
    string,
    Readonly<ProviderRuntimeSessionSnapshot>
  >();

  persist(
    sessionId: string,
    plan: ProviderRuntimeLaunchPlan
  ): Readonly<ProviderRuntimeSessionSnapshot> {
    if (!sessionId) {
      routeError(
        "immutable-session-route",
        "A running provider route requires a stable session id.",
        plan.model.catalogEntryId
      );
    }
    const existing = this.snapshots.get(sessionId);
    if (existing) {
      if (!providerRuntimeRouteSnapshotEquals(existing.plan, plan)) {
        routeError(
          "immutable-session-route",
          `Running session ${sessionId} already owns a different provider route.`,
          plan.model.catalogEntryId
        );
      }
      return existing;
    }
    const snapshot = createProviderRuntimeSessionSnapshot(plan);
    this.snapshots.set(sessionId, snapshot);
    return snapshot;
  }

  get(sessionId: string): Readonly<ProviderRuntimeSessionSnapshot> | undefined {
    return this.snapshots.get(sessionId);
  }
}

function resolveEntryIdentityForConfig(
  resolution: ProviderCatalogResolution,
  config: { model?: string; claudeCodeBackend?: string }
): ProviderCatalogEntry | undefined {
  const byModel = config.model
    ? resolution.entries.find(
        (entry) => entry.model.persistedId === config.model
      )
    : undefined;
  const byBackend = config.claudeCodeBackend
    ? resolution.entries.find((entry) => entry.id === config.claudeCodeBackend)
    : undefined;
  if (byModel && byBackend && byModel.id !== byBackend.id) {
    routeError(
      "identity-mismatch",
      `Provider route ${byBackend.id} does not match persisted model ${config.model}.`,
      byBackend.id
    );
  }
  if (config.claudeCodeBackend && !byBackend) {
    routeError(
      "unsupported-route",
      `Unsupported provider runtime route: ${config.claudeCodeBackend}`,
      config.claudeCodeBackend
    );
  }
  if (config.model && isCatalogPersistedModelId(config.model) && !byModel) {
    routeError(
      "unsupported-model",
      `Unsupported catalog-owned provider model: ${config.model}`
    );
  }
  const entry = byModel ?? byBackend;
  if (entry && config.model && config.model !== entry.model.persistedId) {
    routeError(
      "identity-mismatch",
      `Provider route ${entry.id} requires exact persisted model ${entry.model.persistedId}.`,
      entry.id
    );
  }
  return entry;
}

export function resolveClaudeAgentRuntimeRoutes(
  resolution: ProviderCatalogResolution,
  config: {
    model?: string;
    claudeCodeBackend?: string;
    effortLevel?: string;
    thinkingMode?: string;
    catalogControlValues?: Readonly<Record<string, unknown>>;
    catalogControlContext?: ProviderCatalogControlContext;
  },
  credentialReferences: Readonly<Record<string, boolean>>
): Readonly<ClaudeAgentRuntimeRouteBundle> | undefined {
  const entry = resolveEntryIdentityForConfig(resolution, config);
  if (!entry) return undefined;
  const persistedControlKeys = new Set(
    Object.values(entry.controls).map((control) => control.persistenceKey)
  );
  const catalogControlValues = config.catalogControlValues ?? {};
  const persistedControls = {
    ...catalogControlValues,
    ...(config.effortLevel === undefined ||
    !persistedControlKeys.has("effort-level") ||
    Object.prototype.hasOwnProperty.call(catalogControlValues, "effort-level")
      ? {}
      : { "effort-level": config.effortLevel }),
    ...(config.thinkingMode === undefined ||
    !persistedControlKeys.has("thinking-mode") ||
    Object.prototype.hasOwnProperty.call(catalogControlValues, "thinking-mode")
      ? {}
      : { "thinking-mode": config.thinkingMode }),
  };
  const common = {
    catalogEntryId: entry.id,
    persistedModelId: entry.model.persistedId,
    persistedControls,
    controlContext: config.catalogControlContext,
    credentialReferences,
  };
  return deepFreeze({
    main: resolveProviderRuntimeLaunchPlan(resolution, {
      ...common,
      consumer: "claude-agent-main",
    }),
    subagent: resolveProviderRuntimeLaunchPlan(resolution, {
      ...common,
      consumer: "claude-subagent",
    }),
    consultation: resolveProviderRuntimeLaunchPlan(resolution, {
      ...common,
      consumer: "consultation-launcher",
    }),
  });
}

export function resolveMainClaudeAgentLaunchPlan(
  resolution: ProviderCatalogResolution,
  request: Omit<ProviderRuntimeRouteRequest, "consumer">
): Readonly<ProviderRuntimeLaunchPlan> {
  return resolveProviderRuntimeLaunchPlan(resolution, {
    ...request,
    consumer: "claude-agent-main",
  });
}

export function resolveClaudeSubagentLaunchPlan(
  resolution: ProviderCatalogResolution,
  request: Omit<ProviderRuntimeRouteRequest, "consumer">
): Readonly<ProviderRuntimeLaunchPlan> {
  return resolveProviderRuntimeLaunchPlan(resolution, {
    ...request,
    consumer: "claude-subagent",
  });
}

export function resolveConsultationLauncherPlan(
  resolution: ProviderCatalogResolution,
  request: Omit<ProviderRuntimeRouteRequest, "consumer">
): Readonly<ProviderRuntimeLaunchPlan> {
  return resolveProviderRuntimeLaunchPlan(resolution, {
    ...request,
    consumer: "consultation-launcher",
  });
}
