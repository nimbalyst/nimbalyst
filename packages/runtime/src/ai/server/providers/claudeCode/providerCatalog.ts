/**
 * Provider-neutral, versioned catalog contract shared by agent and
 * consultation consumers. This module is deliberately transport-free: it
 * validates and snapshots reviewed route descriptions but never launches one.
 */

export const PROVIDER_CATALOG_SCHEMA_VERSION = 2 as const;

export type ProviderCatalogConsumer =
  | "claude-agent-main"
  | "claude-agent-subagent"
  | "consultation";

export type ProviderCatalogControlValue = string | number | boolean;

export type ProviderCatalogControlTarget =
  | "launch.context-window"
  | "launch.effort-level"
  | "launch.thinking-mode"
  | "interface.model-profile"
  | "interface.reasoning-mode";

export interface ProviderCatalogControlMappingValue {
  storedValue: ProviderCatalogControlValue;
  resolvedValue: ProviderCatalogControlValue;
}

export interface ProviderCatalogControlMapping {
  interfaceId: string;
  target: ProviderCatalogControlTarget;
  values: readonly ProviderCatalogControlMappingValue[];
}

export interface ProviderCatalogControl {
  persistenceKey: string;
  allowedValues: readonly ProviderCatalogControlValue[];
  defaultValue: ProviderCatalogControlValue;
  mappings: readonly ProviderCatalogControlMapping[];
}

export interface ProviderCatalogCapabilities {
  mainSession: boolean;
  subagent: boolean;
  consultation: boolean;
  tools: boolean;
  vision: boolean;
}

export interface ProviderCatalogModel {
  persistedId: string;
  persistedIdNamespace:
    | "claude-code:claudex-"
    | "claude-code:deepseek-"
    | "claude-code:grok-"
    | "claude-code:ollama-"
    | "claude-code:openrouter-";
  providerModelId: string;
  upstreamModel?: string;
  version: string;
}

export interface ProviderCatalogOrderedIdentity {
  id: string;
  order: number;
}

export interface ProviderCatalogInterface {
  id: string;
  kind: "http";
  consumers: readonly ProviderCatalogConsumer[];
  protocol: "anthropic-messages";
  transportProfile: "anthropic-compatible-proxy";
  authProfile: "credential-reference";
  endpoint: string;
  upstreamEndpoint?: string;
  credentialRef: string;
  modelAlias: string;
}

export interface ProviderCatalogEntry {
  id: string;
  provider: string;
  harness: ProviderCatalogOrderedIdentity;
  family: ProviderCatalogOrderedIdentity;
  displayName: string;
  model: ProviderCatalogModel;
  capabilities: ProviderCatalogCapabilities;
  interfaces: readonly ProviderCatalogInterface[];
  controls: Readonly<Record<string, ProviderCatalogControl>>;
}

export interface ProviderCatalogEntryPatch {
  provider?: string;
  harness?: Partial<ProviderCatalogOrderedIdentity>;
  family?: Partial<ProviderCatalogOrderedIdentity>;
  displayName?: string;
  model?: Partial<ProviderCatalogModel>;
  capabilities?: Partial<ProviderCatalogCapabilities>;
  interfaces?: readonly ProviderCatalogInterface[];
  controls?: Readonly<Record<string, ProviderCatalogControl>>;
}

export interface ProviderCatalogOverlayEntry {
  id: string;
  disabled?: boolean;
  patch?: ProviderCatalogEntryPatch;
}

export type ProviderCatalogErrorCode =
  | "adapter-required"
  | "ambiguous-interface"
  | "arbitrary-command"
  | "duplicate-id"
  | "invalid-controls"
  | "invalid-entry"
  | "invalid-overlay"
  | "invalid-schema-version"
  | "malformed-capabilities"
  | "malformed-json"
  | "raw-credential"
  | "unsupported-interface"
  | "unsupported-transport-profile"
  | "unsafe-endpoint"
  | "write-failed";

export type ProviderCatalogErrorScope = "entry" | "source";

export interface ProviderCatalogError {
  scope: ProviderCatalogErrorScope;
  id?: string;
  index?: number;
  code: ProviderCatalogErrorCode;
  message: string;
}

export interface ProviderCatalogMigrationRecord {
  source: "ollama-backends.json";
  sourceSchemaVersion: 1;
  errors?: readonly ProviderCatalogError[];
}

export interface ProviderCatalogOverlay {
  schemaVersion: typeof PROVIDER_CATALOG_SCHEMA_VERSION;
  entries: readonly ProviderCatalogOverlayEntry[];
  migration?: ProviderCatalogMigrationRecord;
}

export interface ProviderCatalogResolution {
  schemaVersion: typeof PROVIDER_CATALOG_SCHEMA_VERSION;
  entries: readonly ProviderCatalogEntry[];
  disabledIds: readonly string[];
  errors: readonly ProviderCatalogError[];
  fatalErrors: readonly ProviderCatalogError[];
}

export interface ProviderCatalogResolvedControlMapping {
  controlId: string;
  persistenceKey: string;
  interfaceId: string;
  target: ProviderCatalogControlTarget;
  value: ProviderCatalogControlValue;
}

export interface ProviderCatalogRouteSnapshot {
  entry: Readonly<ProviderCatalogEntry>;
  controlValues: Readonly<Record<string, ProviderCatalogControlValue>>;
  mappings: readonly ProviderCatalogResolvedControlMapping[];
}

export interface NormalizedProviderCatalog {
  schemaVersion: typeof PROVIDER_CATALOG_SCHEMA_VERSION;
  entries: readonly ProviderCatalogEntry[];
}

const ENTRY_KEYS = new Set([
  "id",
  "provider",
  "harness",
  "family",
  "displayName",
  "model",
  "capabilities",
  "interfaces",
  "controls",
]);
const PATCH_KEYS = new Set([...ENTRY_KEYS].filter((key) => key !== "id"));
const ORDERED_IDENTITY_KEYS = new Set(["id", "order"]);
const MODEL_KEYS = new Set([
  "persistedId",
  "persistedIdNamespace",
  "providerModelId",
  "upstreamModel",
  "version",
]);
const CAPABILITY_KEYS = new Set([
  "mainSession",
  "subagent",
  "consultation",
  "tools",
  "vision",
]);
const INTERFACE_KEYS = new Set([
  "id",
  "kind",
  "consumers",
  "protocol",
  "transportProfile",
  "authProfile",
  "endpoint",
  "upstreamEndpoint",
  "credentialRef",
  "modelAlias",
]);
const CONTROL_KEYS = new Set([
  "persistenceKey",
  "allowedValues",
  "defaultValue",
  "mappings",
]);
const CONTROL_MAPPING_KEYS = new Set(["interfaceId", "target", "values"]);
const CONTROL_MAPPING_VALUE_KEYS = new Set(["storedValue", "resolvedValue"]);
const OVERLAY_KEYS = new Set(["schemaVersion", "entries", "migration"]);
const OVERLAY_ENTRY_KEYS = new Set(["id", "disabled", "patch"]);
const MIGRATION_KEYS = new Set(["source", "sourceSchemaVersion", "errors"]);
const MIGRATION_ERROR_KEYS = new Set([
  "scope",
  "id",
  "index",
  "code",
  "message",
]);
const ERROR_CODES = new Set<ProviderCatalogErrorCode>([
  "adapter-required",
  "ambiguous-interface",
  "arbitrary-command",
  "duplicate-id",
  "invalid-controls",
  "invalid-entry",
  "invalid-overlay",
  "invalid-schema-version",
  "malformed-capabilities",
  "malformed-json",
  "raw-credential",
  "unsupported-interface",
  "unsupported-transport-profile",
  "unsafe-endpoint",
  "write-failed",
]);
const CONSUMERS = new Set<ProviderCatalogConsumer>([
  "claude-agent-main",
  "claude-agent-subagent",
  "consultation",
]);
const ID_PATTERN = /^[a-z0-9][a-z0-9._:-]*$/;
const PERSISTENCE_KEY_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const CREDENTIAL_REFERENCE_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/;
const RAW_CREDENTIAL_KEYS = new Set([
  "apikey",
  "api_key",
  "authtoken",
  "auth_token",
  "password",
  "secret",
  "token",
]);
const COMMAND_KEYS = new Set([
  "args",
  "arguments",
  "command",
  "env",
  "environment",
  "executable",
  "shell",
]);
const CONTROL_TARGETS = new Set<ProviderCatalogControlTarget>([
  "launch.context-window",
  "launch.effort-level",
  "launch.thinking-mode",
  "interface.model-profile",
  "interface.reasoning-mode",
]);
const CATALOG_PERSISTED_ID_NAMESPACES = new Set([
  "claude-code:claudex-",
  "claude-code:deepseek-",
  "claude-code:grok-",
  "claude-code:ollama-",
  "claude-code:openrouter-",
]);
export const REVIEWED_PROVIDER_CREDENTIAL_REFERENCES = [
  "nimbalyst.local-proxy",
  "workspace.claudex-ingress",
  "workspace.deepseek-api",
  "workspace.openrouter-api",
] as const;
const REVIEWED_CREDENTIAL_REFERENCES = new Set<string>(
  REVIEWED_PROVIDER_CREDENTIAL_REFERENCES
);
const SECRET_LIKE_CREDENTIAL_REFERENCE_PATTERN =
  /^(?:api|auth|bearer|key|password|pk|secret|sk|token)[._-]/;
const REVIEWED_ANTHROPIC_PROXY_BASE_PATH_PATTERN =
  /^\/(?:(?:anthropic|api|openai)(?:\/v[0-9]+)?|v[0-9]+)?\/?$/;

export function isCatalogPersistedModelId(model: string): boolean {
  return [...CATALOG_PERSISTED_ID_NAMESPACES].some((namespace) =>
    model.startsWith(namespace)
  );
}

function isControlValue(value: unknown): value is ProviderCatalogControlValue {
  return (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>
): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStableId(value: unknown): value is string {
  return isNonEmptyString(value) && ID_PATTERN.test(value);
}

function isOrder(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isOrderedIdentity(
  value: unknown
): value is ProviderCatalogOrderedIdentity {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ORDERED_IDENTITY_KEYS) &&
    isStableId(value.id) &&
    isOrder(value.order)
  );
}

function compareStableStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function cloneJson<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneJson(item)) as T;
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneJson(item)])
    ) as T;
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return value;
}

function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isRecord(base) || !isRecord(patch)) {
    return cloneJson(patch);
  }
  const merged: Record<string, unknown> = cloneJson(base);
  for (const [key, patchValue] of Object.entries(patch)) {
    if (patchValue === undefined) continue;
    merged[key] =
      isRecord(merged[key]) && isRecord(patchValue)
        ? deepMerge(merged[key], patchValue)
        : cloneJson(patchValue);
  }
  return merged;
}

function findProhibitedField(
  value: unknown
): { code: "raw-credential" | "arbitrary-command"; key: string } | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const prohibited = findProhibitedField(item);
      if (prohibited) return prohibited;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  for (const [key, nested] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
    if (RAW_CREDENTIAL_KEYS.has(normalizedKey)) {
      return { code: "raw-credential", key };
    }
    if (COMMAND_KEYS.has(normalizedKey)) {
      return { code: "arbitrary-command", key };
    }
    const prohibited = findProhibitedField(nested);
    if (prohibited) return prohibited;
  }
  return undefined;
}

function makeError(
  code: ProviderCatalogErrorCode,
  message: string,
  id?: string,
  index?: number
): ProviderCatalogError {
  return {
    scope: id !== undefined || index !== undefined ? "entry" : "source",
    ...(id ? { id } : {}),
    ...(index === undefined ? {} : { index }),
    code,
    message,
  };
}

function decodeEndpointPath(pathname: string): string | undefined {
  let decoded = pathname;
  try {
    // Decode repeatedly so a secret-bearing segment cannot evade validation
    // through nested percent encoding. Excessive nesting fails closed.
    for (let pass = 0; pass < 8; pass += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) return decoded;
      decoded = next;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function extractRawEndpointPath(value: string): string | undefined {
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(value);
  if (!scheme) return undefined;
  const queryIndex = value.indexOf("?", scheme[0].length);
  const fragmentIndex = value.indexOf("#", scheme[0].length);
  const rawEnd = Math.min(
    queryIndex === -1 ? value.length : queryIndex,
    fragmentIndex === -1 ? value.length : fragmentIndex
  );
  const authorityAndPath = value.slice(scheme[0].length, rawEnd);
  if (authorityAndPath.includes("\\")) return undefined;
  const pathIndex = authorityAndPath.indexOf("/");
  return pathIndex === -1 ? "/" : authorityAndPath.slice(pathIndex);
}

function validateEndpoint(
  value: unknown,
  id: string,
  label: string,
  requireHttps: boolean
): ProviderCatalogError | undefined {
  if (!isNonEmptyString(value)) {
    return makeError(
      "unsafe-endpoint",
      `${id} has a missing or invalid ${label}.`,
      id
    );
  }
  const rawPath = extractRawEndpointPath(value);
  const decodedRawPath =
    rawPath === undefined ? undefined : decodeEndpointPath(rawPath);
  if (
    decodedRawPath === undefined ||
    decodedRawPath.includes("\\") ||
    !REVIEWED_ANTHROPIC_PROXY_BASE_PATH_PATTERN.test(decodedRawPath)
  ) {
    return makeError(
      "unsafe-endpoint",
      `${id} ${label} must use a reviewed credential-free proxy base path.`,
      id
    );
  }
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      return makeError(
        "unsafe-endpoint",
        `${id} ${label} must not embed credentials.`,
        id
      );
    }
    if (url.search || url.hash) {
      return makeError(
        "unsafe-endpoint",
        `${id} ${label} must not contain a query string or fragment.`,
        id
      );
    }
    const decodedPath = decodeEndpointPath(url.pathname);
    if (
      decodedPath === undefined ||
      !REVIEWED_ANTHROPIC_PROXY_BASE_PATH_PATTERN.test(decodedPath)
    ) {
      return makeError(
        "unsafe-endpoint",
        `${id} ${label} must use a reviewed credential-free proxy base path.`,
        id
      );
    }
    if (url.protocol === "https:") return undefined;
    const isLoopback =
      url.hostname === "127.0.0.1" ||
      url.hostname === "localhost" ||
      url.hostname === "[::1]";
    if (!requireHttps && url.protocol === "http:" && isLoopback)
      return undefined;
  } catch {
    // Returned below without echoing the unsafe value.
  }
  return makeError(
    "unsafe-endpoint",
    `${id} ${label} must use HTTPS${requireHttps ? "" : " or loopback HTTP"}.`,
    id
  );
}

function validateCapabilities(
  value: unknown,
  id: string
): ProviderCatalogError | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, CAPABILITY_KEYS)) {
    return makeError(
      "malformed-capabilities",
      `${id} capabilities must use the supported capability fields.`,
      id
    );
  }
  for (const key of CAPABILITY_KEYS) {
    if (typeof value[key] !== "boolean") {
      return makeError(
        "malformed-capabilities",
        `${id} capability ${key} must be boolean.`,
        id
      );
    }
  }
  return undefined;
}

function validateControls(
  value: unknown,
  id: string,
  interfaceIds: ReadonlySet<string>
): ProviderCatalogError | undefined {
  if (!isRecord(value)) {
    return makeError(
      "invalid-controls",
      `${id} controls must be an object.`,
      id
    );
  }
  const persistenceKeys = new Set<string>();
  const ownedMappingTargets = new Set<string>();
  for (const [controlId, control] of Object.entries(value)) {
    if (
      !isStableId(controlId) ||
      !isRecord(control) ||
      !hasOnlyKeys(control, CONTROL_KEYS)
    ) {
      return makeError(
        "invalid-controls",
        `${id} has a malformed control definition.`,
        id
      );
    }
    const allowedValues = control.allowedValues;
    const defaultValue = control.defaultValue;
    const persistenceKey = control.persistenceKey;
    const mappings = control.mappings;
    if (
      !isNonEmptyString(persistenceKey) ||
      !PERSISTENCE_KEY_PATTERN.test(persistenceKey) ||
      persistenceKeys.has(persistenceKey)
    ) {
      return makeError(
        "invalid-controls",
        `${id} control ${controlId} must declare a unique persistence key.`,
        id
      );
    }
    persistenceKeys.add(persistenceKey);
    if (!Array.isArray(allowedValues) || allowedValues.length === 0) {
      return makeError(
        "invalid-controls",
        `${id} control ${controlId} must declare allowed values.`,
        id
      );
    }
    if (!allowedValues.every(isControlValue) || !isControlValue(defaultValue)) {
      return makeError(
        "invalid-controls",
        `${id} control ${controlId} contains an unsupported value.`,
        id
      );
    }
    if (
      new Set(allowedValues.map((candidate) => JSON.stringify(candidate)))
        .size !== allowedValues.length
    ) {
      return makeError(
        "invalid-controls",
        `${id} control ${controlId} contains duplicate allowed values.`,
        id
      );
    }
    if (
      !allowedValues.some((candidate) => Object.is(candidate, defaultValue))
    ) {
      return makeError(
        "invalid-controls",
        `${id} control ${controlId} default must be one of its allowed values.`,
        id
      );
    }
    if (!Array.isArray(mappings) || mappings.length === 0) {
      return makeError(
        "invalid-controls",
        `${id} control ${controlId} must declare reviewed interface mappings.`,
        id
      );
    }
    for (const mapping of mappings) {
      if (
        !isRecord(mapping) ||
        !hasOnlyKeys(mapping, CONTROL_MAPPING_KEYS) ||
        !isStableId(mapping.interfaceId) ||
        !interfaceIds.has(mapping.interfaceId) ||
        !CONTROL_TARGETS.has(mapping.target as ProviderCatalogControlTarget) ||
        !Array.isArray(mapping.values) ||
        mapping.values.length !== allowedValues.length
      ) {
        return makeError(
          "invalid-controls",
          `${id} control ${controlId} has an invalid interface mapping.`,
          id
        );
      }
      const mappingTarget = `${mapping.interfaceId}:${mapping.target}`;
      if (ownedMappingTargets.has(mappingTarget)) {
        return makeError(
          "invalid-controls",
          `${id} interface target ${mappingTarget} is owned by more than one control mapping.`,
          id
        );
      }
      ownedMappingTargets.add(mappingTarget);
      const seenStoredValues = new Set<string>();
      for (const mappedValue of mapping.values) {
        if (
          !isRecord(mappedValue) ||
          !hasOnlyKeys(mappedValue, CONTROL_MAPPING_VALUE_KEYS) ||
          !isControlValue(mappedValue.storedValue) ||
          !isControlValue(mappedValue.resolvedValue) ||
          !allowedValues.some((candidate) =>
            Object.is(candidate, mappedValue.storedValue)
          )
        ) {
          return makeError(
            "invalid-controls",
            `${id} control ${controlId} contains an invalid mapped value.`,
            id
          );
        }
        seenStoredValues.add(JSON.stringify(mappedValue.storedValue));
      }
      if (seenStoredValues.size !== allowedValues.length) {
        return makeError(
          "invalid-controls",
          `${id} control ${controlId} must map every allowed value exactly once.`,
          id
        );
      }
    }
  }
  return undefined;
}

function validateInterface(
  value: unknown,
  entryId: string
): ProviderCatalogError | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, INTERFACE_KEYS)) {
    return makeError(
      "unsupported-interface",
      `${entryId} contains an unsupported interface shape.`,
      entryId
    );
  }
  if (!isStableId(value.id)) {
    return makeError(
      "unsupported-interface",
      `${entryId} has an invalid interface id.`,
      entryId
    );
  }
  if (value.kind !== "http") {
    return makeError(
      "unsupported-interface",
      `${entryId} interface ${value.id} is unsupported.`,
      entryId
    );
  }
  if (value.transportProfile !== "anthropic-compatible-proxy") {
    return makeError(
      "unsupported-transport-profile",
      `${entryId} interface ${value.id} uses an unsupported transport profile.`,
      entryId
    );
  }
  if (value.protocol !== "anthropic-messages") {
    return makeError(
      "adapter-required",
      `${entryId} protocol requires a reviewed adapter before use.`,
      entryId
    );
  }
  if (value.authProfile !== "credential-reference") {
    return makeError(
      "adapter-required",
      `${entryId} authentication scheme requires a reviewed adapter before use.`,
      entryId
    );
  }
  if (!Array.isArray(value.consumers) || value.consumers.length === 0) {
    return makeError(
      "unsupported-interface",
      `${entryId} interface ${value.id} must name at least one supported consumer.`,
      entryId
    );
  }
  if (
    !value.consumers.every((consumer) =>
      CONSUMERS.has(consumer as ProviderCatalogConsumer)
    ) ||
    new Set(value.consumers).size !== value.consumers.length
  ) {
    return makeError(
      "unsupported-interface",
      `${entryId} interface ${value.id} has unsupported or duplicate consumers.`,
      entryId
    );
  }
  const credentialRef = String(value.credentialRef ?? "");
  if (
    !CREDENTIAL_REFERENCE_PATTERN.test(credentialRef) ||
    !credentialRef.includes(".") ||
    SECRET_LIKE_CREDENTIAL_REFERENCE_PATTERN.test(credentialRef)
  ) {
    return makeError(
      "raw-credential",
      `${entryId} must use a named credential reference, never a credential value.`,
      entryId
    );
  }
  if (!REVIEWED_CREDENTIAL_REFERENCES.has(credentialRef)) {
    return makeError(
      "adapter-required",
      `${entryId} credential reference requires a reviewed resolver before use.`,
      entryId
    );
  }
  if (!isNonEmptyString(value.modelAlias)) {
    return makeError(
      "invalid-entry",
      `${entryId} interface ${value.id} must declare a model alias.`,
      entryId
    );
  }
  const endpointError = validateEndpoint(
    value.endpoint,
    entryId,
    "endpoint",
    false
  );
  if (endpointError) return endpointError;
  if (value.upstreamEndpoint !== undefined) {
    const upstreamError = validateEndpoint(
      value.upstreamEndpoint,
      entryId,
      "upstream endpoint",
      true
    );
    if (upstreamError) return upstreamError;
  }
  return undefined;
}

export function validateProviderCatalogEntry(
  candidate: unknown,
  fallbackId?: string
): ProviderCatalogError | undefined {
  const prohibited = findProhibitedField(candidate);
  const candidateId =
    isRecord(candidate) && isStableId(candidate.id) ? candidate.id : fallbackId;
  if (prohibited) {
    return makeError(
      prohibited.code,
      prohibited.code === "raw-credential"
        ? `${
            candidateId ?? "Catalog entry"
          } contains a raw credential field; use credentialRef.`
        : `${
            candidateId ?? "Catalog entry"
          } contains an arbitrary command field, which is not allowed.`,
      candidateId
    );
  }
  if (!isRecord(candidate) || !hasOnlyKeys(candidate, ENTRY_KEYS)) {
    return makeError(
      "invalid-entry",
      `${candidateId ?? "Catalog entry"} has unsupported or missing fields.`,
      candidateId
    );
  }
  if (!isStableId(candidate.id)) {
    return makeError(
      "invalid-entry",
      "Catalog entry has an invalid stable id.",
      fallbackId
    );
  }
  const id = candidate.id;
  if (
    !isStableId(candidate.provider) ||
    !isOrderedIdentity(candidate.harness) ||
    !isOrderedIdentity(candidate.family) ||
    !isNonEmptyString(candidate.displayName)
  ) {
    return makeError(
      "invalid-entry",
      `${id} must declare valid provider, harness, family, and display name fields.`,
      id
    );
  }
  if (
    !isRecord(candidate.model) ||
    !hasOnlyKeys(candidate.model, MODEL_KEYS) ||
    !isNonEmptyString(candidate.model.persistedId) ||
    !isNonEmptyString(candidate.model.persistedIdNamespace) ||
    !CATALOG_PERSISTED_ID_NAMESPACES.has(
      candidate.model.persistedIdNamespace
    ) ||
    !candidate.model.persistedId.startsWith(
      candidate.model.persistedIdNamespace
    ) ||
    candidate.model.persistedId === candidate.model.persistedIdNamespace ||
    !isNonEmptyString(candidate.model.providerModelId) ||
    !isNonEmptyString(candidate.model.version) ||
    (candidate.model.upstreamModel !== undefined &&
      !isNonEmptyString(candidate.model.upstreamModel))
  ) {
    return makeError(
      "invalid-entry",
      `${id} has a malformed model definition.`,
      id
    );
  }
  const capabilitiesError = validateCapabilities(candidate.capabilities, id);
  if (capabilitiesError) return capabilitiesError;
  if (
    !Array.isArray(candidate.interfaces) ||
    candidate.interfaces.length === 0
  ) {
    return makeError(
      "unsupported-interface",
      `${id} must declare an interface.`,
      id
    );
  }
  const interfaceIds = new Set<string>();
  const consumerOwners = new Map<ProviderCatalogConsumer, string>();
  for (const catalogInterface of candidate.interfaces) {
    const interfaceError = validateInterface(catalogInterface, id);
    if (interfaceError) return interfaceError;
    const interfaceId = (catalogInterface as ProviderCatalogInterface).id;
    if (interfaceIds.has(interfaceId)) {
      return makeError(
        "duplicate-id",
        `${id} has duplicate interface ids.`,
        id
      );
    }
    interfaceIds.add(interfaceId);
    for (const consumer of (catalogInterface as ProviderCatalogInterface)
      .consumers) {
      const existingInterface = consumerOwners.get(consumer);
      if (existingInterface) {
        return makeError(
          "ambiguous-interface",
          `${id} consumer ${consumer} is declared by both ${existingInterface} and ${interfaceId}.`,
          id
        );
      }
      consumerOwners.set(consumer, interfaceId);
    }
  }
  const advertisedConsumers = new Set(
    candidate.interfaces.flatMap(
      (catalogInterface) =>
        (catalogInterface as ProviderCatalogInterface).consumers
    )
  );
  const consumerCapabilities: Array<
    [
      keyof Pick<
        ProviderCatalogCapabilities,
        "mainSession" | "subagent" | "consultation"
      >,
      ProviderCatalogConsumer
    ]
  > = [
    ["mainSession", "claude-agent-main"],
    ["subagent", "claude-agent-subagent"],
    ["consultation", "consultation"],
  ];
  for (const [capability, consumer] of consumerCapabilities) {
    if (
      (candidate.capabilities as ProviderCatalogCapabilities)[capability] !==
      advertisedConsumers.has(consumer)
    ) {
      return makeError(
        "malformed-capabilities",
        `${id} capability ${capability} does not match its reviewed interfaces.`,
        id
      );
    }
  }
  const controlsError = validateControls(candidate.controls, id, interfaceIds);
  if (controlsError) return controlsError;
  return undefined;
}

function normalizeEntry(entry: ProviderCatalogEntry): ProviderCatalogEntry {
  const normalizedControls = Object.fromEntries(
    Object.entries(entry.controls)
      .sort(([left], [right]) => compareStableStrings(left, right))
      .map(([controlId, control]) => [
        controlId,
        {
          persistenceKey: control.persistenceKey,
          allowedValues: [...control.allowedValues],
          defaultValue: control.defaultValue,
          mappings: [...control.mappings]
            .sort(
              (left, right) =>
                compareStableStrings(left.interfaceId, right.interfaceId) ||
                compareStableStrings(left.target, right.target)
            )
            .map((mapping) => ({
              interfaceId: mapping.interfaceId,
              target: mapping.target,
              values: mapping.values.map((value) => ({
                storedValue: value.storedValue,
                resolvedValue: value.resolvedValue,
              })),
            })),
        },
      ])
  );
  return {
    id: entry.id,
    provider: entry.provider,
    harness: { id: entry.harness.id, order: entry.harness.order },
    family: { id: entry.family.id, order: entry.family.order },
    displayName: entry.displayName,
    model: {
      persistedId: entry.model.persistedId,
      persistedIdNamespace: entry.model.persistedIdNamespace,
      providerModelId: entry.model.providerModelId,
      ...(entry.model.upstreamModel === undefined
        ? {}
        : { upstreamModel: entry.model.upstreamModel }),
      version: entry.model.version,
    },
    capabilities: {
      mainSession: entry.capabilities.mainSession,
      subagent: entry.capabilities.subagent,
      consultation: entry.capabilities.consultation,
      tools: entry.capabilities.tools,
      vision: entry.capabilities.vision,
    },
    interfaces: [...entry.interfaces]
      .sort((left, right) => compareStableStrings(left.id, right.id))
      .map((catalogInterface) => ({
        id: catalogInterface.id,
        kind: catalogInterface.kind,
        consumers: [...catalogInterface.consumers].sort(),
        protocol: catalogInterface.protocol,
        transportProfile: catalogInterface.transportProfile,
        authProfile: catalogInterface.authProfile,
        endpoint: catalogInterface.endpoint,
        ...(catalogInterface.upstreamEndpoint === undefined
          ? {}
          : { upstreamEndpoint: catalogInterface.upstreamEndpoint }),
        credentialRef: catalogInterface.credentialRef,
        modelAlias: catalogInterface.modelAlias,
      })),
    controls: normalizedControls,
  };
}

/** Canonical picker/export order: harness, family, model/version, provider leaf. */
export function compareProviderCatalogEntries(
  left: ProviderCatalogEntry,
  right: ProviderCatalogEntry
): number {
  return (
    left.harness.order - right.harness.order ||
    compareStableStrings(left.harness.id, right.harness.id) ||
    left.family.order - right.family.order ||
    compareStableStrings(left.family.id, right.family.id) ||
    compareStableStrings(left.displayName, right.displayName) ||
    compareStableStrings(left.model.version, right.model.version) ||
    compareStableStrings(left.provider, right.provider) ||
    compareStableStrings(left.id, right.id)
  );
}

export function getProviderCatalogLeafLabel(
  entry: ProviderCatalogEntry
): string {
  return `${entry.displayName} (${entry.provider})`;
}

function validateCodeDefaults(
  defaults: readonly ProviderCatalogEntry[]
): Map<string, ProviderCatalogEntry> {
  const byId = new Map<string, ProviderCatalogEntry>();
  const persistedIds = new Set<string>();
  for (const candidate of defaults) {
    const error = validateProviderCatalogEntry(candidate);
    if (error) {
      throw new Error(`Invalid built-in provider catalog: ${error.message}`);
    }
    if (byId.has(candidate.id)) {
      throw new Error(
        `Invalid built-in provider catalog: duplicate id ${candidate.id}`
      );
    }
    if (persistedIds.has(candidate.model.persistedId)) {
      throw new Error(
        `Invalid built-in provider catalog: duplicate persisted model ${candidate.model.persistedId}`
      );
    }
    persistedIds.add(candidate.model.persistedId);
    byId.set(candidate.id, normalizeEntry(cloneJson(candidate)));
  }
  return byId;
}

function parseMigrationRecord(value: unknown): {
  errors: readonly ProviderCatalogError[];
  validationError?: ProviderCatalogError;
} {
  if (value === undefined) return { errors: [] };
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, MIGRATION_KEYS) ||
    value.source !== "ollama-backends.json" ||
    value.sourceSchemaVersion !== 1 ||
    (value.errors !== undefined && !Array.isArray(value.errors))
  ) {
    return {
      errors: [],
      validationError: makeError(
        "invalid-overlay",
        "Provider catalog migration metadata is malformed."
      ),
    };
  }
  if (!Array.isArray(value.errors)) return { errors: [] };
  const invalidRecordedError = value.errors.some(
    (candidate) =>
      !isRecord(candidate) ||
      !hasOnlyKeys(candidate, MIGRATION_ERROR_KEYS) ||
      (candidate.scope !== undefined &&
        candidate.scope !== "entry" &&
        candidate.scope !== "source") ||
      !ERROR_CODES.has(candidate.code as ProviderCatalogErrorCode) ||
      !isNonEmptyString(candidate.message) ||
      (candidate.id !== undefined && !isStableId(candidate.id)) ||
      (candidate.index !== undefined &&
        (typeof candidate.index !== "number" ||
          !Number.isInteger(candidate.index) ||
          candidate.index < 0))
  );
  if (invalidRecordedError) {
    return {
      errors: [],
      validationError: makeError(
        "invalid-overlay",
        "Provider catalog migration errors are malformed."
      ),
    };
  }
  return {
    errors: value.errors.flatMap((candidate): ProviderCatalogError[] => {
      if (
        !isRecord(candidate) ||
        !isNonEmptyString(candidate.code) ||
        !isNonEmptyString(candidate.message)
      ) {
        return [];
      }
      return [
        {
          scope:
            candidate.scope === "source" || candidate.scope === "entry"
              ? candidate.scope
              : candidate.index !== undefined || isStableId(candidate.id)
              ? "entry"
              : "source",
          ...(isStableId(candidate.id) ? { id: candidate.id } : {}),
          ...(typeof candidate.index === "number"
            ? { index: candidate.index }
            : {}),
          code: candidate.code as ProviderCatalogErrorCode,
          message: `${
            candidate.id ?? "Legacy catalog"
          } retained an unresolved ${candidate.code} migration error.`,
        },
      ];
    }),
  };
}

export function resolveProviderCatalog(
  defaults: readonly ProviderCatalogEntry[],
  overlay: unknown,
  externalErrors: readonly ProviderCatalogError[] = []
): ProviderCatalogResolution {
  const byId = validateCodeDefaults(defaults);
  const errors: ProviderCatalogError[] = [...externalErrors.map(cloneJson)];
  const disabledIds = new Set<string>();

  if (overlay !== undefined) {
    if (!isRecord(overlay) || !hasOnlyKeys(overlay, OVERLAY_KEYS)) {
      errors.push(
        makeError(
          "invalid-overlay",
          "Provider catalog overlay must be an object with schemaVersion and entries."
        )
      );
    } else if (overlay.schemaVersion !== PROVIDER_CATALOG_SCHEMA_VERSION) {
      errors.push(
        makeError(
          "invalid-schema-version",
          `Provider catalog overlay must use schema version ${PROVIDER_CATALOG_SCHEMA_VERSION}.`
        )
      );
    } else if (!Array.isArray(overlay.entries)) {
      errors.push(
        makeError(
          "invalid-overlay",
          "Provider catalog overlay entries must be an array."
        )
      );
    } else {
      const migrationRecord = parseMigrationRecord(overlay.migration);
      errors.push(...migrationRecord.errors);
      if (migrationRecord.validationError) {
        errors.push(migrationRecord.validationError);
      }
      const idsByIndex = overlay.entries.map((candidate) =>
        isRecord(candidate) && isStableId(candidate.id)
          ? candidate.id
          : undefined
      );
      const duplicateIds = new Set(
        idsByIndex.filter(
          (id): id is string =>
            id !== undefined &&
            idsByIndex.filter((candidate) => candidate === id).length > 1
        )
      );
      for (const duplicateId of [...duplicateIds].sort()) {
        byId.delete(duplicateId);
        disabledIds.delete(duplicateId);
        errors.push(
          makeError(
            "duplicate-id",
            `${duplicateId} has duplicate overlay entries; remove duplicates before use.`,
            duplicateId
          )
        );
      }

      overlay.entries.forEach((candidate, index) => {
        const id = idsByIndex[index];
        if (id && duplicateIds.has(id)) return;
        const prohibited = findProhibitedField(candidate);
        if (prohibited) {
          if (id) byId.delete(id);
          errors.push(
            makeError(
              prohibited.code,
              prohibited.code === "raw-credential"
                ? `${
                    id ?? "Overlay entry"
                  } contains a raw credential field; use credentialRef.`
                : `${
                    id ?? "Overlay entry"
                  } contains an arbitrary command field, which is not allowed.`,
              id,
              index
            )
          );
          return;
        }
        if (
          !isRecord(candidate) ||
          !hasOnlyKeys(candidate, OVERLAY_ENTRY_KEYS) ||
          !isStableId(candidate.id)
        ) {
          errors.push(
            makeError(
              "invalid-overlay",
              "Provider catalog overlay entry has invalid fields or id.",
              id,
              index
            )
          );
          return;
        }
        if (candidate.disabled === true) {
          if (candidate.patch !== undefined) {
            byId.delete(candidate.id);
            errors.push(
              makeError(
                "invalid-overlay",
                `${candidate.id} cannot be disabled and patched in the same overlay entry.`,
                candidate.id,
                index
              )
            );
            return;
          }
          byId.delete(candidate.id);
          disabledIds.add(candidate.id);
          return;
        }
        if (
          (candidate.disabled !== undefined && candidate.disabled !== false) ||
          !isRecord(candidate.patch) ||
          !hasOnlyKeys(candidate.patch, PATCH_KEYS)
        ) {
          byId.delete(candidate.id);
          errors.push(
            makeError(
              "invalid-overlay",
              `${candidate.id} overlay must contain a supported patch or disabled flag.`,
              candidate.id,
              index
            )
          );
          return;
        }
        const base = byId.get(candidate.id);
        const patchModel = isRecord(candidate.patch.model)
          ? candidate.patch.model
          : undefined;
        const patchHarness = isRecord(candidate.patch.harness)
          ? candidate.patch.harness
          : undefined;
        if (
          base &&
          ((candidate.patch.provider !== undefined &&
            candidate.patch.provider !== base.provider) ||
            (patchHarness?.id !== undefined &&
              patchHarness.id !== base.harness.id) ||
            (patchModel?.persistedIdNamespace !== undefined &&
              patchModel.persistedIdNamespace !==
                base.model.persistedIdNamespace) ||
            (patchModel?.persistedId !== undefined &&
              patchModel.persistedId !== base.model.persistedId))
        ) {
          byId.delete(candidate.id);
          errors.push(
            makeError(
              "invalid-overlay",
              `${candidate.id} cannot change the provider, harness, persisted-id namespace, or exact persisted model owned by its built-in identity.`,
              candidate.id,
              index
            )
          );
          return;
        }
        const merged = base
          ? deepMerge(base, candidate.patch)
          : { id: candidate.id, ...cloneJson(candidate.patch) };
        const entryError = validateProviderCatalogEntry(merged, candidate.id);
        if (entryError) {
          byId.delete(candidate.id);
          errors.push({ ...entryError, index });
          return;
        }
        const mergedEntry = merged as ProviderCatalogEntry;
        const persistedIdConflict = [...byId.values()].find(
          (entry) =>
            entry.id !== candidate.id &&
            entry.model.persistedId === mergedEntry.model.persistedId
        );
        if (persistedIdConflict) {
          byId.delete(candidate.id);
          errors.push(
            makeError(
              "duplicate-id",
              `${candidate.id} duplicates a persisted model identity already owned by ${persistedIdConflict.id}.`,
              candidate.id,
              index
            )
          );
          return;
        }
        disabledIds.delete(candidate.id);
        byId.set(candidate.id, normalizeEntry(mergedEntry));
      });
    }
  }

  // Any id-scoped error is authoritative. In particular, a failed legacy
  // migration must never leave the code default with the same id launchable.
  for (const catalogError of errors) {
    if (catalogError.id) {
      byId.delete(catalogError.id);
      disabledIds.delete(catalogError.id);
    }
  }

  const fatalErrors = errors.filter((error) => error.scope === "source");

  return deepFreeze({
    schemaVersion: PROVIDER_CATALOG_SCHEMA_VERSION,
    entries: [...byId.values()]
      .sort(compareProviderCatalogEntries)
      .map((entry) => deepFreeze(cloneJson(entry))),
    disabledIds: [...disabledIds].sort(),
    errors: errors
      .map((error) => cloneJson(error))
      .sort(
        (left, right) =>
          compareStableStrings(left.id ?? "", right.id ?? "") ||
          compareStableStrings(left.code, right.code) ||
          (left.index ?? -1) - (right.index ?? -1)
      ),
    fatalErrors: fatalErrors
      .map((error) => cloneJson(error))
      .sort(
        (left, right) =>
          compareStableStrings(left.code, right.code) ||
          (left.index ?? -1) - (right.index ?? -1)
      ),
  });
}

export function resolveProviderCatalogSnapshot(
  resolution: ProviderCatalogResolution,
  id: string
): Readonly<ProviderCatalogEntry> {
  const fatalError = resolution.fatalErrors[0];
  if (fatalError) {
    throw new Error(`Provider catalog unavailable: ${fatalError.message}`);
  }
  const error = resolution.errors.find((candidate) => candidate.id === id);
  if (error) {
    throw new Error(`Invalid provider catalog entry ${id}: ${error.message}`);
  }
  if (resolution.disabledIds.includes(id)) {
    throw new Error(
      `Provider catalog entry ${id} is disabled by the user overlay.`
    );
  }
  const entry = resolution.entries.find((candidate) => candidate.id === id);
  if (!entry) {
    throw new Error(`Unsupported provider catalog entry: ${id}`);
  }
  return deepFreeze(cloneJson(entry));
}

export function resolveProviderCatalogRouteSnapshot(
  resolution: ProviderCatalogResolution,
  id: string,
  storedControls: Readonly<Record<string, ProviderCatalogControlValue>> = {}
): Readonly<ProviderCatalogRouteSnapshot> {
  const entry = resolveProviderCatalogSnapshot(resolution, id);
  const controlsByPersistenceKey = new Map(
    Object.entries(entry.controls).map(([controlId, control]) => [
      control.persistenceKey,
      { controlId, control },
    ])
  );
  for (const persistenceKey of Object.keys(storedControls)) {
    if (!controlsByPersistenceKey.has(persistenceKey)) {
      throw new Error(
        `Provider catalog entry ${id} has no control for persisted key ${persistenceKey}.`
      );
    }
  }

  const controlValues: Record<string, ProviderCatalogControlValue> = {};
  const mappings: ProviderCatalogResolvedControlMapping[] = [];
  const resolvedTargets = new Set<string>();
  for (const [controlId, control] of Object.entries(entry.controls)) {
    const storedValue = Object.prototype.hasOwnProperty.call(
      storedControls,
      control.persistenceKey
    )
      ? storedControls[control.persistenceKey]
      : control.defaultValue;
    if (
      !control.allowedValues.some((candidate) =>
        Object.is(candidate, storedValue)
      )
    ) {
      throw new Error(
        `Provider catalog entry ${id} control ${controlId} received an unsupported persisted value.`
      );
    }
    controlValues[controlId] = storedValue;
    for (const mapping of control.mappings) {
      const mappedValue = mapping.values.find((candidate) =>
        Object.is(candidate.storedValue, storedValue)
      );
      if (!mappedValue) {
        throw new Error(
          `Provider catalog entry ${id} control ${controlId} has no reviewed mapping for its value.`
        );
      }
      const resolvedTarget = `${mapping.interfaceId}:${mapping.target}`;
      if (resolvedTargets.has(resolvedTarget)) {
        throw new Error(
          `Provider catalog entry ${id} resolved duplicate ownership for interface target ${resolvedTarget}.`
        );
      }
      resolvedTargets.add(resolvedTarget);
      mappings.push({
        controlId,
        persistenceKey: control.persistenceKey,
        interfaceId: mapping.interfaceId,
        target: mapping.target,
        value: mappedValue.resolvedValue,
      });
    }
  }

  return deepFreeze(cloneJson({ entry, controlValues, mappings }));
}

export function exportNormalizedProviderCatalog(
  resolution: ProviderCatalogResolution
): Readonly<NormalizedProviderCatalog> {
  const fatalError = resolution.fatalErrors[0];
  if (fatalError) {
    throw new Error(`Provider catalog unavailable: ${fatalError.message}`);
  }
  return deepFreeze({
    schemaVersion: PROVIDER_CATALOG_SCHEMA_VERSION,
    entries: resolution.entries.map((entry) => deepFreeze(cloneJson(entry))),
  });
}

export function serializeNormalizedProviderCatalog(
  resolution: ProviderCatalogResolution
): string {
  return `${JSON.stringify(
    exportNormalizedProviderCatalog(resolution),
    null,
    2
  )}\n`;
}
