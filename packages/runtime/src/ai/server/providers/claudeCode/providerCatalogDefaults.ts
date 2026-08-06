import {
  CLAUDE_CODE_OLLAMA_DEEPSEEK_V4_FLASH_CLOUD_MODEL,
  CLAUDE_CODE_OLLAMA_DEEPSEEK_V4_FLASH_CLOUD_SDK_ALIAS,
  CLAUDE_CODE_OLLAMA_DEEPSEEK_V4_FLASH_CLOUD_VARIANT,
  CLAUDE_CODE_OLLAMA_DEEPSEEK_V4_PRO_CLOUD_MODEL,
  CLAUDE_CODE_OLLAMA_DEEPSEEK_V4_PRO_CLOUD_SDK_ALIAS,
  CLAUDE_CODE_OLLAMA_DEEPSEEK_V4_PRO_CLOUD_VARIANT,
  CLAUDE_CODE_OLLAMA_GLM_5_1_CLOUD_MODEL,
  CLAUDE_CODE_OLLAMA_GLM_5_1_CLOUD_SDK_ALIAS,
  CLAUDE_CODE_OLLAMA_GLM_5_1_CLOUD_VARIANT,
  CLAUDE_CODE_OLLAMA_GLM_5_2_CLOUD_MODEL,
  CLAUDE_CODE_OLLAMA_GLM_5_2_CLOUD_SDK_ALIAS,
  CLAUDE_CODE_OLLAMA_GLM_5_2_CLOUD_VARIANT,
  CLAUDE_CODE_OLLAMA_GPT_OSS_20B_CLOUD_MODEL,
  CLAUDE_CODE_OLLAMA_GPT_OSS_20B_CLOUD_SDK_ALIAS,
  CLAUDE_CODE_OLLAMA_GPT_OSS_20B_CLOUD_VARIANT,
  CLAUDE_CODE_OLLAMA_KIMI_K2_6_CLOUD_MODEL,
  CLAUDE_CODE_OLLAMA_KIMI_K2_6_CLOUD_SDK_ALIAS,
  CLAUDE_CODE_OLLAMA_KIMI_K2_6_CLOUD_VARIANT,
  CLAUDE_CODE_OLLAMA_KIMI_K2_7_CODE_CLOUD_MODEL,
  CLAUDE_CODE_OLLAMA_KIMI_K2_7_CODE_CLOUD_SDK_ALIAS,
  CLAUDE_CODE_OLLAMA_KIMI_K2_7_CODE_CLOUD_VARIANT,
  CLAUDE_CODE_OLLAMA_MINIMAX_M2_7_CLOUD_MODEL,
  CLAUDE_CODE_OLLAMA_MINIMAX_M2_7_CLOUD_SDK_ALIAS,
  CLAUDE_CODE_OLLAMA_MINIMAX_M2_7_CLOUD_VARIANT,
  CLAUDE_CODE_OLLAMA_MINIMAX_M3_CLOUD_MODEL,
  CLAUDE_CODE_OLLAMA_MINIMAX_M3_CLOUD_SDK_ALIAS,
  CLAUDE_CODE_OLLAMA_MINIMAX_M3_CLOUD_VARIANT,
  CLAUDE_CODE_OLLAMA_NEMOTRON_3_NANO_CLOUD_MODEL,
  CLAUDE_CODE_OLLAMA_NEMOTRON_3_NANO_CLOUD_SDK_ALIAS,
  CLAUDE_CODE_OLLAMA_NEMOTRON_3_NANO_CLOUD_VARIANT,
  CLAUDE_CODE_OLLAMA_NEMOTRON_3_SUPER_CLOUD_MODEL,
  CLAUDE_CODE_OLLAMA_NEMOTRON_3_SUPER_CLOUD_SDK_ALIAS,
  CLAUDE_CODE_OLLAMA_NEMOTRON_3_SUPER_CLOUD_VARIANT,
  CLAUDE_CODE_OLLAMA_QWEN3_5_CLOUD_MODEL,
  CLAUDE_CODE_OLLAMA_QWEN3_5_CLOUD_SDK_ALIAS,
  CLAUDE_CODE_OLLAMA_QWEN3_5_CLOUD_VARIANT,
} from "../../../modelConstants";
import {
  REVIEWED_PROVIDER_CREDENTIAL_REFERENCES,
  type ProviderCatalogEntry,
} from "./providerCatalog";

const OLLAMA_UPSTREAM_ENDPOINT = "https://ollama.com/v1";
const LOCAL_PROXY_ENDPOINT = "http://127.0.0.1:4002";
const DEFAULT_PROXY_CONTEXT_WINDOW_SEED_TOKENS = 128_000;
const DEEPSEEK_PRO_CONTEXT_WINDOW_SEED_TOKENS = 1_000_000;
const CLAUDEX_CONTEXT_WINDOW_SEED_TOKENS = 372_000;
export const LOCAL_PROXY_CREDENTIAL_REF =
  REVIEWED_PROVIDER_CREDENTIAL_REFERENCES[0];
export const CLAUDEX_INGRESS_CREDENTIAL_REF =
  REVIEWED_PROVIDER_CREDENTIAL_REFERENCES[1];
export const DEEPSEEK_API_CREDENTIAL_REF =
  REVIEWED_PROVIDER_CREDENTIAL_REFERENCES[2];
export const OPENROUTER_API_CREDENTIAL_REF =
  REVIEWED_PROVIDER_CREDENTIAL_REFERENCES[3];

export const CLAUDEX_SOL_ENTRY_ID = "claudex-sol";
export const CLAUDEX_TERRA_ENTRY_ID = "claudex-terra";
export const CLAUDEX_LUNA_ENTRY_ID = "claudex-luna";
export const DEEPSEEK_V4_PRO_OFFICIAL_ENTRY_ID = "deepseek-v4-pro-official";
export const DEEPSEEK_V4_FLASH_OFFICIAL_ENTRY_ID = "deepseek-v4-flash-official";
export const DEEPSEEK_V4_PRO_OPENROUTER_ENTRY_ID = "deepseek-v4-pro-openrouter";
export const DEEPSEEK_V4_FLASH_OPENROUTER_ENTRY_ID =
  "deepseek-v4-flash-openrouter";
export const OLLAMA_DEEPSEEK_V4_FLASH_0731_ENTRY_ID =
  "ollama-deepseek-v4-flash-0731";

const FAMILY_ORDER: Readonly<Record<string, number>> = {
  native: 10,
  deepseek: 20,
  qwen: 30,
  kimi: 40,
  glm: 50,
  minimax: 60,
  codex: 70,
  grok: 80,
  gpt: 90,
  nemotron: 100,
};

function createOllamaCatalogEntry(options: {
  id: string;
  persistedId: string;
  providerModelId: string;
  upstreamModel: string;
  modelAlias: string;
  family: string;
  displayName: string;
  /** null keeps an unqualified model's context cap explicitly unknown. */
  contextWindowSeedTokens?: number | null;
}): ProviderCatalogEntry {
  const inferredContextWindowSeedTokens = options.providerModelId.includes(
    "deepseek-v4-pro"
  )
    ? DEEPSEEK_PRO_CONTEXT_WINDOW_SEED_TOKENS
    : DEFAULT_PROXY_CONTEXT_WINDOW_SEED_TOKENS;
  const contextWindowSeedTokens =
    options.contextWindowSeedTokens === null
      ? undefined
      : options.contextWindowSeedTokens ?? inferredContextWindowSeedTokens;
  return {
    id: options.id,
    provider: "ollama",
    providerDisplayName: "Ollama Cloud",
    harness: { id: "claude-agent", order: 10 },
    family: {
      id: options.family,
      order: FAMILY_ORDER[options.family] ?? 1_000,
    },
    displayName: options.displayName,
    model: {
      persistedId: options.persistedId,
      persistedIdNamespace: "claude-code:ollama-",
      providerModelId: options.providerModelId,
      upstreamModel: options.upstreamModel,
      version: options.providerModelId,
      ...(contextWindowSeedTokens === undefined
        ? {}
        : { contextWindowSeedTokens }),
    },
    capabilities: {
      mainSession: true,
      subagent: true,
      consultation: true,
      tools: true,
      vision: false,
    },
    interfaces: [
      {
        id: "claude-agent-proxy",
        kind: "http",
        consumers: [
          "claude-agent-main",
          "claude-agent-subagent",
          "consultation",
        ],
        protocol: "anthropic-messages",
        transportProfile: "anthropic-compatible-proxy",
        authProfile: "credential-reference",
        endpoint: LOCAL_PROXY_ENDPOINT,
        upstreamEndpoint: OLLAMA_UPSTREAM_ENDPOINT,
        credentialRef: LOCAL_PROXY_CREDENTIAL_REF,
        modelAlias: options.modelAlias,
        contextTelemetry: {
          adapterId: "claude-agent-sdk-parent-v1",
          windowPolicy: "runtime-then-model-seed",
        },
      },
    ],
    controls: {},
  };
}

function createReviewedRouteEntry(options: {
  id: string;
  provider: "deepseek" | "openai" | "openrouter";
  persistedId: string;
  persistedIdNamespace:
    | "claude-code:claudex-"
    | "claude-code:deepseek-"
    | "claude-code:openrouter-";
  providerModelId: string;
  modelAlias: string;
  endpoint: string;
  credentialRef: string;
  contextWindowSeedTokens: number;
  controls?: ProviderCatalogEntry["controls"];
  displayName: string;
  providerDisplayName: string;
}): ProviderCatalogEntry {
  return {
    id: options.id,
    provider: options.provider,
    providerDisplayName: options.providerDisplayName,
    harness: { id: "claude-agent", order: 10 },
    family: {
      id: options.provider === "openai" ? "codex" : "deepseek",
      order: options.provider === "openai" ? 70 : 20,
    },
    displayName: options.displayName,
    model: {
      persistedId: options.persistedId,
      persistedIdNamespace: options.persistedIdNamespace,
      providerModelId: options.providerModelId,
      version: options.providerModelId,
      contextWindowSeedTokens: options.contextWindowSeedTokens,
    },
    capabilities: {
      mainSession: true,
      subagent: true,
      consultation: true,
      tools: true,
      vision: false,
    },
    interfaces: [
      {
        id: "claude-agent-anthropic",
        kind: "http",
        consumers: [
          "claude-agent-main",
          "claude-agent-subagent",
          "consultation",
        ],
        protocol: "anthropic-messages",
        transportProfile: "anthropic-compatible-proxy",
        authProfile: "credential-reference",
        endpoint: options.endpoint,
        credentialRef: options.credentialRef,
        modelAlias: options.modelAlias,
        contextTelemetry: {
          adapterId: "claude-agent-sdk-parent-v1",
          windowPolicy: "runtime-then-model-seed",
        },
      },
    ],
    controls: options.controls ?? {},
  };
}

function createEffortControl(
  interfaceId: string
): ProviderCatalogEntry["controls"] {
  return {
    effort: {
      persistenceKey: "effort-level",
      order: 0,
      width: "compact",
      displayLabel: "Effort",
      helpText: "Controls how much reasoning effort this model may use.",
      valueLabels: { '"high"': "High", '"max"': "Max" },
      allowedValues: ["high", "max"],
      defaultValue: "high",
      mappings: [
        {
          interfaceId,
          target: "launch.effort-level",
          values: [
            { storedValue: "high", resolvedValue: "high" },
            { storedValue: "max", resolvedValue: "max" },
          ],
        },
      ],
    },
  };
}

function createDeepSeekOfficialControls(
  interfaceId: string
): ProviderCatalogEntry["controls"] {
  return {
    reasoning: {
      persistenceKey: "reasoning-mode",
      order: 0,
      width: "standard",
      displayLabel: "Thinking effort",
      helpText: "Select the reviewed DeepSeek reasoning profile.",
      valueLabels: {
        '"non-think"': "None",
        '"think-high"': "High",
        '"think-max"': "Max",
      },
      allowedValues: ["non-think", "think-high", "think-max"],
      defaultValue: "think-high",
      mappings: [
        {
          interfaceId,
          target: "request.thinking.type",
          values: [
            { storedValue: "non-think", resolvedValue: "disabled" },
            { storedValue: "think-high", resolvedValue: "enabled" },
            { storedValue: "think-max", resolvedValue: "enabled" },
          ],
        },
        {
          interfaceId,
          target: "request.output-config.effort",
          values: [
            { storedValue: "non-think", operation: "omit" },
            { storedValue: "think-high", resolvedValue: "high" },
            { storedValue: "think-max", resolvedValue: "max" },
          ],
        },
      ],
    },
  };
}

export const BUILT_IN_PROVIDER_CATALOG: readonly ProviderCatalogEntry[] = [
  createOllamaCatalogEntry({
    id: CLAUDE_CODE_OLLAMA_GLM_5_2_CLOUD_VARIANT,
    persistedId: CLAUDE_CODE_OLLAMA_GLM_5_2_CLOUD_MODEL,
    providerModelId: "glm-5.2:cloud",
    upstreamModel: "openai/glm-5.2:cloud",
    modelAlias: CLAUDE_CODE_OLLAMA_GLM_5_2_CLOUD_SDK_ALIAS,
    family: "glm",
    displayName: "GLM 5.2",
  }),
  createOllamaCatalogEntry({
    id: CLAUDE_CODE_OLLAMA_GPT_OSS_20B_CLOUD_VARIANT,
    persistedId: CLAUDE_CODE_OLLAMA_GPT_OSS_20B_CLOUD_MODEL,
    providerModelId: "gpt-oss:20b-cloud",
    upstreamModel: "openai/gpt-oss:20b-cloud",
    modelAlias: CLAUDE_CODE_OLLAMA_GPT_OSS_20B_CLOUD_SDK_ALIAS,
    family: "gpt",
    displayName: "GPT-OSS 20B",
  }),
  createOllamaCatalogEntry({
    id: CLAUDE_CODE_OLLAMA_NEMOTRON_3_NANO_CLOUD_VARIANT,
    persistedId: CLAUDE_CODE_OLLAMA_NEMOTRON_3_NANO_CLOUD_MODEL,
    providerModelId: "nemotron-3-nano:30b-cloud",
    upstreamModel: "openai/nemotron-3-nano:30b-cloud",
    modelAlias: CLAUDE_CODE_OLLAMA_NEMOTRON_3_NANO_CLOUD_SDK_ALIAS,
    family: "nemotron",
    displayName: "Nemotron 3 Nano 30B",
  }),
  {
    id: OLLAMA_DEEPSEEK_V4_FLASH_0731_ENTRY_ID,
    provider: "ollama",
    providerDisplayName: "Ollama Cloud",
    harness: { id: "claude-agent", order: 10 },
    family: { id: "deepseek", order: FAMILY_ORDER.deepseek },
    displayName: "DeepSeek V4 Flash 0731",
    admission: {
      state: "high-runner-candidate",
      reasonCode: "proxy-alias-unqualified",
    },
    model: {
      persistedId: "claude-code:ollama-deepseek-v4-flash-0731",
      persistedIdNamespace: "claude-code:ollama-",
      providerModelId: "deepseek-v4-flash:0731",
      upstreamModel: "openai/deepseek-v4-flash:0731",
      version: "deepseek-v4-flash:0731",
    },
    capabilities: {
      mainSession: false,
      subagent: false,
      consultation: false,
      tools: false,
      vision: false,
    },
    interfaces: [],
    controls: {},
  },
  createOllamaCatalogEntry({
    id: CLAUDE_CODE_OLLAMA_DEEPSEEK_V4_FLASH_CLOUD_VARIANT,
    persistedId: CLAUDE_CODE_OLLAMA_DEEPSEEK_V4_FLASH_CLOUD_MODEL,
    providerModelId: "deepseek-v4-flash:cloud",
    upstreamModel: "openai/deepseek-v4-flash:cloud",
    modelAlias: CLAUDE_CODE_OLLAMA_DEEPSEEK_V4_FLASH_CLOUD_SDK_ALIAS,
    family: "deepseek",
    displayName: "DeepSeek v4 Flash",
  }),
  createOllamaCatalogEntry({
    id: CLAUDE_CODE_OLLAMA_QWEN3_5_CLOUD_VARIANT,
    persistedId: CLAUDE_CODE_OLLAMA_QWEN3_5_CLOUD_MODEL,
    providerModelId: "qwen3.5:cloud",
    upstreamModel: "openai/qwen3.5:cloud",
    modelAlias: CLAUDE_CODE_OLLAMA_QWEN3_5_CLOUD_SDK_ALIAS,
    family: "qwen",
    displayName: "Qwen 3.5",
  }),
  createOllamaCatalogEntry({
    id: CLAUDE_CODE_OLLAMA_NEMOTRON_3_SUPER_CLOUD_VARIANT,
    persistedId: CLAUDE_CODE_OLLAMA_NEMOTRON_3_SUPER_CLOUD_MODEL,
    providerModelId: "nemotron-3-super:cloud",
    upstreamModel: "openai/nemotron-3-super:cloud",
    modelAlias: CLAUDE_CODE_OLLAMA_NEMOTRON_3_SUPER_CLOUD_SDK_ALIAS,
    family: "nemotron",
    displayName: "Nemotron 3 Super",
  }),
  createOllamaCatalogEntry({
    id: CLAUDE_CODE_OLLAMA_GLM_5_1_CLOUD_VARIANT,
    persistedId: CLAUDE_CODE_OLLAMA_GLM_5_1_CLOUD_MODEL,
    providerModelId: "glm-5.1:cloud",
    upstreamModel: "openai/glm-5.1:cloud",
    modelAlias: CLAUDE_CODE_OLLAMA_GLM_5_1_CLOUD_SDK_ALIAS,
    family: "glm",
    displayName: "GLM 5.1",
  }),
  createOllamaCatalogEntry({
    id: CLAUDE_CODE_OLLAMA_MINIMAX_M2_7_CLOUD_VARIANT,
    persistedId: CLAUDE_CODE_OLLAMA_MINIMAX_M2_7_CLOUD_MODEL,
    providerModelId: "minimax-m2.7:cloud",
    upstreamModel: "openai/minimax-m2.7:cloud",
    modelAlias: CLAUDE_CODE_OLLAMA_MINIMAX_M2_7_CLOUD_SDK_ALIAS,
    family: "minimax",
    displayName: "MiniMax M2.7",
  }),
  createOllamaCatalogEntry({
    id: CLAUDE_CODE_OLLAMA_KIMI_K2_6_CLOUD_VARIANT,
    persistedId: CLAUDE_CODE_OLLAMA_KIMI_K2_6_CLOUD_MODEL,
    providerModelId: "kimi-k2.6:cloud",
    upstreamModel: "openai/kimi-k2.6:cloud",
    modelAlias: CLAUDE_CODE_OLLAMA_KIMI_K2_6_CLOUD_SDK_ALIAS,
    family: "kimi",
    displayName: "Kimi 2.6",
  }),
  createOllamaCatalogEntry({
    id: CLAUDE_CODE_OLLAMA_KIMI_K2_7_CODE_CLOUD_VARIANT,
    persistedId: CLAUDE_CODE_OLLAMA_KIMI_K2_7_CODE_CLOUD_MODEL,
    providerModelId: "kimi-k2.7-code:cloud",
    upstreamModel: "openai/kimi-k2.7-code:cloud",
    modelAlias: CLAUDE_CODE_OLLAMA_KIMI_K2_7_CODE_CLOUD_SDK_ALIAS,
    family: "kimi",
    displayName: "Kimi 2.7 Code",
  }),
  createOllamaCatalogEntry({
    id: CLAUDE_CODE_OLLAMA_MINIMAX_M3_CLOUD_VARIANT,
    persistedId: CLAUDE_CODE_OLLAMA_MINIMAX_M3_CLOUD_MODEL,
    providerModelId: "minimax-m3:cloud",
    upstreamModel: "openai/minimax-m3:cloud",
    modelAlias: CLAUDE_CODE_OLLAMA_MINIMAX_M3_CLOUD_SDK_ALIAS,
    family: "minimax",
    displayName: "MiniMax M3",
  }),
  createOllamaCatalogEntry({
    id: CLAUDE_CODE_OLLAMA_DEEPSEEK_V4_PRO_CLOUD_VARIANT,
    persistedId: CLAUDE_CODE_OLLAMA_DEEPSEEK_V4_PRO_CLOUD_MODEL,
    providerModelId: "deepseek-v4-pro:cloud",
    upstreamModel: "openai/deepseek-v4-pro:cloud",
    modelAlias: CLAUDE_CODE_OLLAMA_DEEPSEEK_V4_PRO_CLOUD_SDK_ALIAS,
    family: "deepseek",
    displayName: "DeepSeek v4 Pro",
  }),
  createReviewedRouteEntry({
    id: CLAUDEX_SOL_ENTRY_ID,
    provider: "openai",
    persistedId: "claude-code:claudex-sol",
    persistedIdNamespace: "claude-code:claudex-",
    providerModelId: "gpt-5.6-sol",
    modelAlias: "gpt-5.6-sol",
    endpoint: "http://127.0.0.1:38117",
    credentialRef: CLAUDEX_INGRESS_CREDENTIAL_REF,
    contextWindowSeedTokens: CLAUDEX_CONTEXT_WINDOW_SEED_TOKENS,
    controls: createEffortControl("claude-agent-anthropic"),
    displayName: "Sol",
    providerDisplayName: "Claudex",
  }),
  createReviewedRouteEntry({
    id: CLAUDEX_TERRA_ENTRY_ID,
    provider: "openai",
    persistedId: "claude-code:claudex-terra",
    persistedIdNamespace: "claude-code:claudex-",
    providerModelId: "gpt-5.6-terra",
    modelAlias: "gpt-5.6-terra",
    endpoint: "http://127.0.0.1:38117",
    credentialRef: CLAUDEX_INGRESS_CREDENTIAL_REF,
    contextWindowSeedTokens: CLAUDEX_CONTEXT_WINDOW_SEED_TOKENS,
    controls: createEffortControl("claude-agent-anthropic"),
    displayName: "Terra",
    providerDisplayName: "Claudex",
  }),
  createReviewedRouteEntry({
    id: CLAUDEX_LUNA_ENTRY_ID,
    provider: "openai",
    persistedId: "claude-code:claudex-luna",
    persistedIdNamespace: "claude-code:claudex-",
    providerModelId: "gpt-5.6-luna",
    modelAlias: "gpt-5.6-luna",
    endpoint: "http://127.0.0.1:38117",
    credentialRef: CLAUDEX_INGRESS_CREDENTIAL_REF,
    contextWindowSeedTokens: CLAUDEX_CONTEXT_WINDOW_SEED_TOKENS,
    controls: createEffortControl("claude-agent-anthropic"),
    displayName: "Luna",
    providerDisplayName: "Claudex",
  }),
  createReviewedRouteEntry({
    id: DEEPSEEK_V4_PRO_OFFICIAL_ENTRY_ID,
    provider: "deepseek",
    persistedId: "claude-code:deepseek-v4-pro",
    persistedIdNamespace: "claude-code:deepseek-",
    providerModelId: "deepseek-v4-pro",
    modelAlias: "deepseek-v4-pro[1m]",
    endpoint: "https://api.deepseek.com/anthropic",
    credentialRef: DEEPSEEK_API_CREDENTIAL_REF,
    contextWindowSeedTokens: DEEPSEEK_PRO_CONTEXT_WINDOW_SEED_TOKENS,
    controls: createDeepSeekOfficialControls("claude-agent-anthropic"),
    displayName: "DeepSeek v4 Pro",
    providerDisplayName: "DeepSeek API",
  }),
  createReviewedRouteEntry({
    id: DEEPSEEK_V4_FLASH_OFFICIAL_ENTRY_ID,
    provider: "deepseek",
    persistedId: "claude-code:deepseek-v4-flash",
    persistedIdNamespace: "claude-code:deepseek-",
    providerModelId: "deepseek-v4-flash",
    modelAlias: "deepseek-v4-flash",
    endpoint: "https://api.deepseek.com/anthropic",
    credentialRef: DEEPSEEK_API_CREDENTIAL_REF,
    contextWindowSeedTokens: DEFAULT_PROXY_CONTEXT_WINDOW_SEED_TOKENS,
    controls: createDeepSeekOfficialControls("claude-agent-anthropic"),
    displayName: "DeepSeek v4 Flash",
    providerDisplayName: "DeepSeek API",
  }),
  createReviewedRouteEntry({
    id: DEEPSEEK_V4_PRO_OPENROUTER_ENTRY_ID,
    provider: "openrouter",
    persistedId: "claude-code:openrouter-deepseek-v4-pro",
    persistedIdNamespace: "claude-code:openrouter-",
    providerModelId: "deepseek/deepseek-v4-pro",
    modelAlias: "deepseek/deepseek-v4-pro",
    endpoint: "https://openrouter.ai/api",
    credentialRef: OPENROUTER_API_CREDENTIAL_REF,
    contextWindowSeedTokens: DEEPSEEK_PRO_CONTEXT_WINDOW_SEED_TOKENS,
    // OpenRouter's exact reasoning transport contract is not established by
    // the admitted provider evidence. Do not inherit the first-party mapping.
    controls: {},
    displayName: "DeepSeek v4 Pro",
    providerDisplayName: "OpenRouter",
  }),
  createReviewedRouteEntry({
    id: DEEPSEEK_V4_FLASH_OPENROUTER_ENTRY_ID,
    provider: "openrouter",
    persistedId: "claude-code:openrouter-deepseek-v4-flash",
    persistedIdNamespace: "claude-code:openrouter-",
    providerModelId: "deepseek/deepseek-v4-flash",
    modelAlias: "deepseek/deepseek-v4-flash",
    endpoint: "https://openrouter.ai/api",
    credentialRef: OPENROUTER_API_CREDENTIAL_REF,
    contextWindowSeedTokens: DEFAULT_PROXY_CONTEXT_WINDOW_SEED_TOKENS,
    controls: {},
    displayName: "DeepSeek v4 Flash",
    providerDisplayName: "OpenRouter",
  }),
];
