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
export const LOCAL_PROXY_CREDENTIAL_REF =
  REVIEWED_PROVIDER_CREDENTIAL_REFERENCES[0];

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
}): ProviderCatalogEntry {
  return {
    id: options.id,
    provider: "ollama",
    harness: { id: "claude-agent", order: 10 },
    family: {
      id: options.family,
      order: FAMILY_ORDER[options.family] ?? 1_000,
    },
    displayName: options.providerModelId,
    model: {
      persistedId: options.persistedId,
      persistedIdNamespace: "claude-code:ollama-",
      providerModelId: options.providerModelId,
      upstreamModel: options.upstreamModel,
      version: options.providerModelId,
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
      },
    ],
    controls: {},
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
  }),
  createOllamaCatalogEntry({
    id: CLAUDE_CODE_OLLAMA_GPT_OSS_20B_CLOUD_VARIANT,
    persistedId: CLAUDE_CODE_OLLAMA_GPT_OSS_20B_CLOUD_MODEL,
    providerModelId: "gpt-oss:20b-cloud",
    upstreamModel: "openai/gpt-oss:20b-cloud",
    modelAlias: CLAUDE_CODE_OLLAMA_GPT_OSS_20B_CLOUD_SDK_ALIAS,
    family: "gpt",
  }),
  createOllamaCatalogEntry({
    id: CLAUDE_CODE_OLLAMA_NEMOTRON_3_NANO_CLOUD_VARIANT,
    persistedId: CLAUDE_CODE_OLLAMA_NEMOTRON_3_NANO_CLOUD_MODEL,
    providerModelId: "nemotron-3-nano:30b-cloud",
    upstreamModel: "openai/nemotron-3-nano:30b-cloud",
    modelAlias: CLAUDE_CODE_OLLAMA_NEMOTRON_3_NANO_CLOUD_SDK_ALIAS,
    family: "nemotron",
  }),
  createOllamaCatalogEntry({
    id: CLAUDE_CODE_OLLAMA_DEEPSEEK_V4_FLASH_CLOUD_VARIANT,
    persistedId: CLAUDE_CODE_OLLAMA_DEEPSEEK_V4_FLASH_CLOUD_MODEL,
    providerModelId: "deepseek-v4-flash:cloud",
    upstreamModel: "openai/deepseek-v4-flash:cloud",
    modelAlias: CLAUDE_CODE_OLLAMA_DEEPSEEK_V4_FLASH_CLOUD_SDK_ALIAS,
    family: "deepseek",
  }),
  createOllamaCatalogEntry({
    id: CLAUDE_CODE_OLLAMA_QWEN3_5_CLOUD_VARIANT,
    persistedId: CLAUDE_CODE_OLLAMA_QWEN3_5_CLOUD_MODEL,
    providerModelId: "qwen3.5:cloud",
    upstreamModel: "openai/qwen3.5:cloud",
    modelAlias: CLAUDE_CODE_OLLAMA_QWEN3_5_CLOUD_SDK_ALIAS,
    family: "qwen",
  }),
  createOllamaCatalogEntry({
    id: CLAUDE_CODE_OLLAMA_NEMOTRON_3_SUPER_CLOUD_VARIANT,
    persistedId: CLAUDE_CODE_OLLAMA_NEMOTRON_3_SUPER_CLOUD_MODEL,
    providerModelId: "nemotron-3-super:cloud",
    upstreamModel: "openai/nemotron-3-super:cloud",
    modelAlias: CLAUDE_CODE_OLLAMA_NEMOTRON_3_SUPER_CLOUD_SDK_ALIAS,
    family: "nemotron",
  }),
  createOllamaCatalogEntry({
    id: CLAUDE_CODE_OLLAMA_GLM_5_1_CLOUD_VARIANT,
    persistedId: CLAUDE_CODE_OLLAMA_GLM_5_1_CLOUD_MODEL,
    providerModelId: "glm-5.1:cloud",
    upstreamModel: "openai/glm-5.1:cloud",
    modelAlias: CLAUDE_CODE_OLLAMA_GLM_5_1_CLOUD_SDK_ALIAS,
    family: "glm",
  }),
  createOllamaCatalogEntry({
    id: CLAUDE_CODE_OLLAMA_MINIMAX_M2_7_CLOUD_VARIANT,
    persistedId: CLAUDE_CODE_OLLAMA_MINIMAX_M2_7_CLOUD_MODEL,
    providerModelId: "minimax-m2.7:cloud",
    upstreamModel: "openai/minimax-m2.7:cloud",
    modelAlias: CLAUDE_CODE_OLLAMA_MINIMAX_M2_7_CLOUD_SDK_ALIAS,
    family: "minimax",
  }),
  createOllamaCatalogEntry({
    id: CLAUDE_CODE_OLLAMA_KIMI_K2_6_CLOUD_VARIANT,
    persistedId: CLAUDE_CODE_OLLAMA_KIMI_K2_6_CLOUD_MODEL,
    providerModelId: "kimi-k2.6:cloud",
    upstreamModel: "openai/kimi-k2.6:cloud",
    modelAlias: CLAUDE_CODE_OLLAMA_KIMI_K2_6_CLOUD_SDK_ALIAS,
    family: "kimi",
  }),
  createOllamaCatalogEntry({
    id: CLAUDE_CODE_OLLAMA_KIMI_K2_7_CODE_CLOUD_VARIANT,
    persistedId: CLAUDE_CODE_OLLAMA_KIMI_K2_7_CODE_CLOUD_MODEL,
    providerModelId: "kimi-k2.7-code:cloud",
    upstreamModel: "openai/kimi-k2.7-code:cloud",
    modelAlias: CLAUDE_CODE_OLLAMA_KIMI_K2_7_CODE_CLOUD_SDK_ALIAS,
    family: "kimi",
  }),
  createOllamaCatalogEntry({
    id: CLAUDE_CODE_OLLAMA_MINIMAX_M3_CLOUD_VARIANT,
    persistedId: CLAUDE_CODE_OLLAMA_MINIMAX_M3_CLOUD_MODEL,
    providerModelId: "minimax-m3:cloud",
    upstreamModel: "openai/minimax-m3:cloud",
    modelAlias: CLAUDE_CODE_OLLAMA_MINIMAX_M3_CLOUD_SDK_ALIAS,
    family: "minimax",
  }),
  createOllamaCatalogEntry({
    id: CLAUDE_CODE_OLLAMA_DEEPSEEK_V4_PRO_CLOUD_VARIANT,
    persistedId: CLAUDE_CODE_OLLAMA_DEEPSEEK_V4_PRO_CLOUD_MODEL,
    providerModelId: "deepseek-v4-pro:cloud",
    upstreamModel: "openai/deepseek-v4-pro:cloud",
    modelAlias: CLAUDE_CODE_OLLAMA_DEEPSEEK_V4_PRO_CLOUD_SDK_ALIAS,
    family: "deepseek",
  }),
];
