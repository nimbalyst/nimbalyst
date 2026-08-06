/**
 * Per-session non-Anthropic brain profiles for the Claude Code harness.
 *
 * These profiles only configure the environment of the native Claude Code
 * process spawned for one Nimbalyst session. They never mutate process.env or
 * provider settings, and an unknown persisted profile is an error rather than
 * a request to use the default Anthropic route.
 *
 * Backend routes are adapted from the versioned provider-neutral catalog.
 * Code defaults merge with a user overlay by stable id, and the legacy
 * ollama-backends.json whole-file format migrates without becoming the source
 * of truth. Catalog data contains credential references only; this adapter
 * resolves the one existing non-secret local-proxy reference for compatibility.
 */

import { CLAUDE_CODE_OLLAMA_GLM_5_2_CLOUD_VARIANT } from "../../../modelConstants";
import {
  isCatalogPersistedModelId,
  type ProviderCatalogEntry,
  type ProviderCatalogResolution,
} from "./providerCatalog";
import {
  BUILT_IN_PROVIDER_CATALOG,
  LOCAL_PROXY_CREDENTIAL_REF,
} from "./providerCatalogDefaults";
import { loadProviderCatalog } from "./providerCatalogLoader";
import { LOCAL_PROXY_AUTH_TOKEN } from "./providerRouteCredentials";
import {
  ProviderRuntimeRouteError,
  type ProviderRuntimeLaunchPlan,
} from "./runtimeRouteResolver";

export const OLLAMA_GLM_5_2_CLOUD_BACKEND_ID =
  CLAUDE_CODE_OLLAMA_GLM_5_2_CLOUD_VARIANT;

export interface ClaudeCodeBackend {
  id: string;
  persistedModel: string;
  provider: string;
  model: string;
  upstreamModel: string;
  upstreamBaseUrl: string;
  baseUrl: string;
  /** Non-secret local proxy token mirrored by the existing LiteLLM config. */
  authToken: string;
  /**
   * Claude-shaped alias accepted by the existing LiteLLM profile. LiteLLM
   * translates this alias to `model` at the Ollama Cloud OpenAI endpoint.
   */
  claudeModelAlias: string;
}

export const PROVIDER_CATALOG_LOAD = loadProviderCatalog(
  BUILT_IN_PROVIDER_CATALOG
);
export const PROVIDER_CATALOG_RESOLUTION = PROVIDER_CATALOG_LOAD.resolution;

function toClaudeCodeBackend(
  entry: ProviderCatalogEntry
): ClaudeCodeBackend | undefined {
  const catalogInterface = entry.interfaces.find(
    (candidate) =>
      candidate.consumers.includes("claude-agent-main") &&
      candidate.kind === "http" &&
      candidate.protocol === "anthropic-messages" &&
      candidate.transportProfile === "anthropic-compatible-proxy"
  );
  if (
    !catalogInterface ||
    !catalogInterface.upstreamEndpoint ||
    catalogInterface.credentialRef !== LOCAL_PROXY_CREDENTIAL_REF ||
    !entry.model.upstreamModel
  ) {
    return undefined;
  }
  return Object.freeze({
    id: entry.id,
    persistedModel: entry.model.persistedId,
    provider: entry.provider,
    model: entry.model.providerModelId,
    upstreamModel: entry.model.upstreamModel,
    upstreamBaseUrl: catalogInterface.upstreamEndpoint,
    baseUrl: catalogInterface.endpoint,
    authToken: LOCAL_PROXY_AUTH_TOKEN,
    claudeModelAlias: catalogInterface.modelAlias,
  });
}

/** Existing Claude Agent route view derived from the normalized catalog. */
export function projectClaudeCodeBackends(
  resolution: ProviderCatalogResolution
): readonly ClaudeCodeBackend[] {
  if (resolution.fatalErrors.length > 0) return Object.freeze([]);
  const blockedIds = new Set(
    resolution.errors.flatMap((error) => (error.id ? [error.id] : []))
  );
  return Object.freeze(
    resolution.entries.flatMap((entry) => {
      if (
        blockedIds.has(entry.id) ||
        entry.admission?.state === "high-runner-candidate"
      )
        return [];
      const backend = toClaudeCodeBackend(entry);
      return backend ? [backend] : [];
    })
  );
}

export const CLAUDE_CODE_BACKENDS: readonly ClaudeCodeBackend[] =
  projectClaudeCodeBackends(PROVIDER_CATALOG_RESOLUTION);

function fatalCatalogError(
  resolution: ProviderCatalogResolution
): Error | undefined {
  const catalogError = resolution.fatalErrors[0];
  return catalogError
    ? new Error(`Provider catalog unavailable: ${catalogError.message}`)
    : undefined;
}

export function resolveClaudeCodeBackendInCatalog(
  resolution: ProviderCatalogResolution,
  backends: readonly ClaudeCodeBackend[],
  backendId: string | undefined | null
): ClaudeCodeBackend | undefined {
  if (!backendId) return undefined;
  const fatalError = fatalCatalogError(resolution);
  if (fatalError) throw fatalError;
  const catalogError = resolution.errors.find(
    (candidate) => candidate.id === backendId
  );
  if (catalogError) {
    throw new Error(
      `Invalid provider catalog entry ${backendId}: ${catalogError.message}`
    );
  }
  if (resolution.disabledIds.includes(backendId)) {
    throw new Error(
      `Provider catalog entry ${backendId} is disabled by the user overlay.`
    );
  }
  const catalogEntry = resolution.entries.find(
    (candidate) => candidate.id === backendId
  );
  if (!catalogEntry) {
    throw new Error(`Unsupported Claude Code backend profile: ${backendId}`);
  }
  const backend = backends.find((candidate) => candidate.id === backendId);
  if (!backend) {
    throw new Error(
      `Provider catalog entry ${backendId} is valid but adapter required for Claude Agent launch.`
    );
  }
  return backend;
}

/**
 * Resolve a persisted backend id.
 *
 * Missing means a normal Anthropic Claude Code session. A present-but-unknown
 * id fails closed so stale or mistyped Ollama sessions cannot silently run on
 * Anthropic.
 */
export function resolveClaudeCodeBackend(
  backendId: string | undefined | null
): ClaudeCodeBackend | undefined {
  return resolveClaudeCodeBackendInCatalog(
    PROVIDER_CATALOG_RESOLUTION,
    CLAUDE_CODE_BACKENDS,
    backendId
  );
}

/**
 * Resolve from the canonical persisted model identity. Any lookalike Ollama
 * identity is rejected rather than treated as an ordinary Anthropic model.
 */
export function resolveClaudeCodeBackendFromModel(
  model: string | undefined | null
): ClaudeCodeBackend | undefined {
  return resolveClaudeCodeBackendFromModelInCatalog(
    PROVIDER_CATALOG_RESOLUTION,
    CLAUDE_CODE_BACKENDS,
    model
  );
}

export function resolveClaudeCodeBackendFromModelInCatalog(
  resolution: ProviderCatalogResolution,
  backends: readonly ClaudeCodeBackend[],
  model: string | undefined | null
): ClaudeCodeBackend | undefined {
  if (!model) return undefined;
  const catalogEntry = resolution.entries.find(
    (candidate) => candidate.model.persistedId === model
  );
  if (catalogEntry) {
    const fatalError = fatalCatalogError(resolution);
    if (fatalError) throw fatalError;
    const backend = backends.find(
      (candidate) => candidate.id === catalogEntry.id
    );
    if (!backend) {
      // Valid general catalog identities are consumed by the shared runtime
      // resolver. Only the legacy Ollama projection needs a ClaudeCodeBackend.
      return undefined;
    }
    return resolveClaudeCodeBackendInCatalog(
      resolution,
      backends,
      catalogEntry.id
    );
  }
  const builtIn = BUILT_IN_PROVIDER_CATALOG.find(
    (candidate) => candidate.model.persistedId === model
  );
  if (builtIn) {
    const currentEntry = resolution.entries.find(
      (candidate) => candidate.id === builtIn.id
    );
    if (!currentEntry) {
      return resolveClaudeCodeBackendInCatalog(
        resolution,
        backends,
        builtIn.id
      );
    }
    if (currentEntry.model.persistedId !== model) {
      throw new Error(
        `Persisted Claude Code model identity is no longer owned by its built-in catalog entry: ${model}`
      );
    }
    return resolveClaudeCodeBackendInCatalog(resolution, backends, builtIn.id);
  }
  if (isCatalogPersistedModelId(model)) {
    const fatalError = fatalCatalogError(resolution);
    if (fatalError) throw fatalError;
    throw new Error(
      `Unsupported catalog-owned Claude Code model identity: ${model}`
    );
  }
  return undefined;
}

export function resolveClaudeCodeBackendForConfig(config: {
  model?: string;
  claudeCodeBackend?: string;
}): ClaudeCodeBackend | undefined {
  const modelBackend = resolveClaudeCodeBackendFromModel(config.model);
  const configuredBackend = resolveClaudeCodeBackend(config.claudeCodeBackend);
  if (
    modelBackend &&
    configuredBackend &&
    modelBackend.id !== configuredBackend.id
  ) {
    throw new Error(
      `Claude Code backend ${configuredBackend.id} does not match persisted model ${config.model}`
    );
  }
  if (configuredBackend && config.model !== configuredBackend.persistedModel) {
    throw new Error(
      `Claude Code backend ${configuredBackend.id} requires exact persisted model ${configuredBackend.persistedModel}`
    );
  }
  return modelBackend ?? configuredBackend;
}

/**
 * Route selectors and provider-specific credentials read by the pinned
 * @anthropic-ai/claude-agent-sdk 0.3.220 native CLI. These are deleted only
 * from the per-spawn environment; process.env is never mutated.
 */
export const CLAUDE_CODE_AMBIENT_ROUTE_ENV_KEYS = [
  // Primary route, authentication, and generic provider credentials.
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "OPENAI_API_KEY",

  // Alternate sockets, gateways, relays, and generic HTTP proxying.
  "ANTHROPIC_UNIX_SOCKET",
  "CLAUDE_CODE_API_BASE_URL",
  "AGENT_PROXY_URL",
  "AGENT_PROXY_AUTH_TOKEN",
  "CCR_AGENT_PROXY_ENABLED",
  "CCR_AGENT_PROXY_INCLUDE_HOSTS",
  "CCR_AGENT_PROXY_RELAY_MODE",
  "CLAUDE_CODE_PROXY_RESOLVES_HOSTS",
  "CLAUDE_CODE_SIMULATE_PROXY_USAGE",
  "CLAUDE_CODE_AGENT_PROXY_GIT_CONFIG",
  "CLAUDE_CODE_AGENT_PROXY_GH_SHIM",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",

  // Provider selectors and provider-specific credentials.
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_GATEWAY",
  "ANTHROPIC_FOUNDRY_RESOURCE",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "ANTHROPIC_AWS_API_KEY",
  "ANTHROPIC_AWS_WORKSPACE_ID",
  "ANTHROPIC_GOOGLE_CLOUD_PROJECT",
  "ANTHROPIC_GOOGLE_CLOUD_LOCATION",
  "ANTHROPIC_GOOGLE_CLOUD_WORKSPACE_ID",
  "ANTHROPIC_BEDROCK_SERVICE_TIER",
  "ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION",
  "CLOUD_ML_REGION",
  "_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_AWS_BASE_URL",
  "ANTHROPIC_GOOGLE_CLOUD_BASE_URL",
  "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
  "CLAUDE_CODE_ARTIFACTS_API_BASE_URL",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_CONFIG_FILE",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
  "AWS_EC2_METADATA_SERVICE_ENDPOINT",
  "AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_QUOTA_PROJECT",

  // OAuth, host-managed authentication, descriptor/file auth, and identity
  // controls recognized by the pinned SDK/CLI.
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_OAUTH_CLIENT_ID",
  "CLAUDE_CODE_OAUTH_SCOPES",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
  "CLAUDE_CODE_HOST_CREDS_FILE",
  "CLAUDE_CODE_HOST_AUTH_ENV_VAR",
  "CLAUDE_CODE_HFI_BEARER_TOKEN",
  "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
  "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
  "CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH",
  "CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH",
  "CLAUDE_CODE_ENABLE_PROXY_AUTH_HELPER",
  "CLAUDE_CODE_CUSTOM_OAUTH_URL",
  "CLAUDE_CODE_DESIGN_OAUTH_CLIENT_ID",
  "CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR",
  "CLAUDE_BRIDGE_OAUTH_TOKEN",
  "CLAUDE_BG_SOCKET_TOKENS_PATH",
  "ANTHROPIC_CONFIG_DIR",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_IDENTITY_TOKEN",
  "ANTHROPIC_IDENTITY_TOKEN_FILE",
  "ANTHROPIC_PROFILE",
  "ANTHROPIC_SCOPE",
  "ANTHROPIC_ORGANIZATION_ID",
  "ANTHROPIC_SERVICE_ACCOUNT_ID",
  "ANTHROPIC_WORKSPACE_ID",

  // Manager, classifier, fallback, and native-child model selectors. The
  // accepted route re-adds the required selectors with one exact alias.
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_CUSTOM_MODEL_OPTION",
  "CLAUDE_CODE_BG_CLASSIFIER_MODEL",
  "CLAUDE_CODE_AUTO_MODE_MODEL",
  "CLAUDE_CONTEXT_COLLAPSE_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "FALLBACK_FOR_ALL_PRIMARY_MODELS",
  "CLAUDE_CODE_NO_MODEL_FALLBACK",

  // Generic provider-catalog reasoning controls must never inherit from the
  // parent harness. Accepted routes re-add an explicitly resolved value.
  "CLAUDE_CODE_EFFORT_LEVEL",
] as const;

const CANONICAL_AMBIENT_ROUTE_ENV_KEYS = new Set<string>(
  CLAUDE_CODE_AMBIENT_ROUTE_ENV_KEYS.map((key) => key.toUpperCase())
);

/**
 * Return a copy with the named keys removed using Windows environment-key
 * semantics. JavaScript object keys remain case-sensitive on Windows even
 * though the child process environment does not, so exact-property deletion
 * is insufficient for inherited mixed-case selectors.
 */
export function omitEnvironmentKeysCaseInsensitive(
  source: Readonly<Record<string, string | undefined>>,
  deniedKeys: readonly string[]
): Record<string, string | undefined> {
  const denied = new Set(deniedKeys.map((key) => key.toUpperCase()));
  return Object.fromEntries(
    Object.entries(source).filter(([key]) => !denied.has(key.toUpperCase()))
  );
}

/** Remove every ambient route selector using case-insensitive key matching. */
export function scrubAmbientProviderRouteEnv(
  env: Record<string, string | undefined>
): void {
  for (const key of Object.keys(env)) {
    if (CANONICAL_AMBIENT_ROUTE_ENV_KEYS.has(key.toUpperCase())) {
      delete env[key];
    }
  }
}

/**
 * Overlay one backend profile onto a per-spawn environment.
 *
 * The LiteLLM proxy owns translation from Anthropic Messages to Ollama Cloud's
 * OpenAI-compatible API. All Claude roles, including native Task/Agent children,
 * use the same proxy alias and therefore the same exact Ollama model.
 */
export function applyClaudeCodeBackendEnv(
  env: Record<string, string | undefined>,
  backend: ClaudeCodeBackend
): void {
  // ANTHROPIC_API_KEY signals first-party API-key auth to the native binary and
  // can shadow gateway routing. It must be absent, even when configured in
  // Nimbalyst settings.
  scrubAmbientProviderRouteEnv(env);

  env.ANTHROPIC_BASE_URL = backend.baseUrl;
  env.ANTHROPIC_AUTH_TOKEN = backend.authToken;
  env.ANTHROPIC_DEFAULT_OPUS_MODEL = backend.claudeModelAlias;
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = backend.claudeModelAlias;
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = backend.claudeModelAlias;
  env.ANTHROPIC_DEFAULT_FABLE_MODEL = backend.claudeModelAlias;
  env.ANTHROPIC_SMALL_FAST_MODEL = backend.claudeModelAlias;
  env.ANTHROPIC_MODEL = backend.claudeModelAlias;
  env.ANTHROPIC_CUSTOM_MODEL_OPTION = backend.claudeModelAlias;
  env.CLAUDE_CODE_BG_CLASSIFIER_MODEL = backend.claudeModelAlias;
  env.CLAUDE_CODE_AUTO_MODE_MODEL = backend.claudeModelAlias;
  env.CLAUDE_CONTEXT_COLLAPSE_MODEL = backend.claudeModelAlias;
  env.CLAUDE_CODE_SUBAGENT_MODEL = backend.claudeModelAlias;
  env.CLAUDE_CODE_NO_MODEL_FALLBACK = "1";
  env.NO_PROXY = "127.0.0.1,localhost";
}

/** Apply one already-confirmed immutable route at the final spawn boundary. */
export function applyProviderRuntimeLaunchPlanEnv(
  env: Record<string, string | undefined>,
  plan: ProviderRuntimeLaunchPlan,
  credential: string
): void {
  if (!credential) {
    throw new ProviderRuntimeRouteError(
      "credential-unavailable",
      `Provider route ${plan.model.catalogEntryId} credential is unavailable before launch.`
    );
  }
  scrubAmbientProviderRouteEnv(env);

  const modelAlias = plan.selectedInterface.modelAlias;
  env.ANTHROPIC_BASE_URL = plan.selectedInterface.endpoint;
  env.ANTHROPIC_AUTH_TOKEN = credential;
  env.ANTHROPIC_DEFAULT_OPUS_MODEL = modelAlias;
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = modelAlias;
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = modelAlias;
  env.ANTHROPIC_DEFAULT_FABLE_MODEL = modelAlias;
  env.ANTHROPIC_SMALL_FAST_MODEL = modelAlias;
  env.ANTHROPIC_MODEL = modelAlias;
  env.ANTHROPIC_CUSTOM_MODEL_OPTION = modelAlias;
  env.CLAUDE_CODE_BG_CLASSIFIER_MODEL = modelAlias;
  env.CLAUDE_CODE_AUTO_MODE_MODEL = modelAlias;
  env.CLAUDE_CONTEXT_COLLAPSE_MODEL = modelAlias;
  env.CLAUDE_CODE_SUBAGENT_MODEL = modelAlias;
  env.CLAUDE_CODE_NO_MODEL_FALLBACK = "1";

  for (const mapping of plan.resolvedControls) {
    if (mapping.target === "launch.effort-level") {
      if (mapping.operation !== "set" || typeof mapping.value !== "string") {
        throw new ProviderRuntimeRouteError(
          "invalid-controls",
          `Provider route ${plan.model.catalogEntryId} has an invalid launch effort mapping.`,
          plan.model.catalogEntryId
        );
      }
      env.CLAUDE_CODE_EFFORT_LEVEL = String(mapping.value);
    }
  }

  const endpoint = new URL(plan.selectedInterface.endpoint);
  if (
    endpoint.hostname === "127.0.0.1" ||
    endpoint.hostname === "localhost" ||
    endpoint.hostname === "[::1]"
  ) {
    env.NO_PROXY = "127.0.0.1,localhost";
  }
}
