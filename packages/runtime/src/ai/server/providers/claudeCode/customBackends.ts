/**
 * Per-session "custom backend" registry for the Claude Code provider.
 *
 * Lets a SINGLE Claude Code session run on a non-Anthropic brain (DeepSeek,
 * Kimi, Qwen, GLM, ...) by pointing the native binary at that provider's
 * Anthropic-Messages-compatible endpoint -- WITHOUT a global brain-swap and
 * WITHOUT touching any other session. The selection is strictly per-session: a
 * session with no backend uses the default Anthropic wiring, untouched.
 *
 * Wiring rules (see workspace memory reference_anthropic_messages_compatible_providers):
 *   - ANTHROPIC_BASE_URL OMITS the trailing /v1 -- Claude Code appends /v1/messages.
 *   - Auth uses ANTHROPIC_AUTH_TOKEN (the gateway bearer var), NOT
 *     ANTHROPIC_API_KEY (the native binary treats the mere presence of
 *     ANTHROPIC_API_KEY as a first-party auth signal that shadows the gateway).
 *   - The selected Claude variant (opus/sonnet/haiku) is redirected to the
 *     upstream model via ANTHROPIC_DEFAULT_*_MODEL, so the SDK's variant
 *     resolution still works and the user's model pick stays meaningful.
 *   - *_SUPPORTED_CAPABILITIES makes /effort and thinking work on the upstream.
 */

import {
  DEEPSEEK_CLAUDE_BACKEND_ID,
  isDeepSeekClaudeBackend,
} from '../../deepSeekClaudeAgent';

export interface ClaudeCodeBackend {
  /** Stable id selected per session (stored as ProviderConfig.customBackend). */
  id: string;
  /** Display label for the per-session backend selector. */
  name: string;
  /** Anthropic-compatible base URL. OMIT trailing /v1 -- Claude Code appends it. */
  baseUrl: string;
  /** Env var holding the bearer token (resolved in-process; never persisted). */
  authTokenEnv: string;
  /** Upstream model id the Claude variants map to (e.g. 'deepseek-reasoner'). */
  upstreamModel: string;
  /** Optional per-role routing used when a provider exposes primary and fast models. */
  upstreamModels?: {
    opus: string;
    sonnet: string;
    haiku: string;
    subagent: string;
  };
  /** Capability declaration so /effort + thinking are honored upstream. */
  capabilities?: string;
  /** Additional env needed by this backend. Values must not contain secrets. */
  extraEnv?: Record<string, string>;
}

/**
 * Catalog of non-Anthropic brains runnable on the Claude Code harness.
 * Every entry targets a verified Anthropic-Messages endpoint. Keys are
 * env-var-gated, so an entry whose token is absent simply won't authenticate --
 * it never falls back to a different token or affects default Anthropic sessions.
 */
export const CLAUDE_CODE_BACKENDS: readonly ClaudeCodeBackend[] = [
  {
    id: 'glm-5.2',
    name: 'GLM 5.2 (Z.AI API balance)',
    baseUrl: 'https://api.z.ai/api/anthropic',
    authTokenEnv: 'ZAI_API_KEY',
    upstreamModel: 'glm-5.2[1m]',
    capabilities: 'effort,max_effort,thinking',
    extraEnv: {
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      API_TIMEOUT_MS: '3000000',
    },
  },
  {
    id: 'glm-5.2-coding-plan',
    name: 'GLM 5.2 (Z.AI Coding Plan)',
    baseUrl: 'https://api.z.ai/api/anthropic',
    authTokenEnv: 'ZAI_CODING_PLAN_API_KEY',
    upstreamModel: 'glm-5.2[1m]',
    capabilities: 'effort,max_effort,thinking',
    extraEnv: {
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      API_TIMEOUT_MS: '3000000',
    },
  },
  {
    id: DEEPSEEK_CLAUDE_BACKEND_ID,
    name: 'DeepSeek V4',
    baseUrl: 'https://api.deepseek.com/anthropic',
    authTokenEnv: 'DEEPSEEK_API_KEY',
    upstreamModel: 'deepseek-v4-pro[1m]',
    upstreamModels: {
      opus: 'deepseek-v4-pro[1m]',
      sonnet: 'deepseek-v4-pro[1m]',
      haiku: 'deepseek-v4-flash',
      subagent: 'deepseek-v4-flash',
    },
    capabilities: 'effort,max_effort,thinking',
  },
  {
    id: 'kimi-k2.6',
    name: 'Kimi K2.6 (Moonshot direct)',
    baseUrl: 'https://api.moonshot.ai/anthropic',
    authTokenEnv: 'MOONSHOT_STUDIO_API_KEY',
    upstreamModel: 'kimi-k2.6',
    capabilities: 'effort,thinking',
  },
  {
    id: 'qwen3-max-thinking',
    name: 'Qwen3 Max thinking (via OpenRouter)',
    baseUrl: 'https://openrouter.ai/api',
    authTokenEnv: 'OPENROUTER_API_KEY',
    upstreamModel: 'qwen/qwen3-max-thinking',
    capabilities: 'effort,thinking',
  },
  {
    id: 'qwen3.7-plus',
    name: 'Qwen 3.7 Plus (via OpenRouter)',
    baseUrl: 'https://openrouter.ai/api',
    authTokenEnv: 'OPENROUTER_API_KEY',
    upstreamModel: 'qwen/qwen3.7-plus',
    capabilities: 'effort,thinking',
  },
  {
    id: 'kimi-k2.7-code',
    name: 'Kimi K2.7 Code (Moonshot direct)',
    baseUrl: 'https://api.moonshot.ai/anthropic',
    authTokenEnv: 'MOONSHOT_STUDIO_API_KEY',
    upstreamModel: 'kimi-k2.7-code',
    // k2.7-code is thinking-MANDATORY on Moonshot: the endpoint 400s
    // ("only type=enabled is allowed for this model") unless thinking is on.
    // Declaring thinking keeps /effort+thinking honored; pick effort>0 for this one.
    capabilities: 'effort,thinking',
  },
  {
    id: 'kimi-k2.5',
    name: 'Kimi K2.5 (Moonshot direct)',
    baseUrl: 'https://api.moonshot.ai/anthropic',
    authTokenEnv: 'MOONSHOT_STUDIO_API_KEY',
    upstreamModel: 'kimi-k2.5',
    capabilities: 'effort,thinking',
  },
  // --- Kimi via OpenRouter (models not available on Moonshot's /anthropic surface) ---
  {
    id: 'kimi-k2',
    name: 'Kimi K2 (via OpenRouter)',
    baseUrl: 'https://openrouter.ai/api',
    authTokenEnv: 'OPENROUTER_API_KEY',
    upstreamModel: 'moonshotai/kimi-k2',
    capabilities: 'effort',
  },
  {
    id: 'kimi-k2-thinking',
    name: 'Kimi K2 Thinking (via OpenRouter)',
    baseUrl: 'https://openrouter.ai/api',
    authTokenEnv: 'OPENROUTER_API_KEY',
    upstreamModel: 'moonshotai/kimi-k2-thinking',
    capabilities: 'effort,thinking',
  },
  {
    id: 'kimi-latest',
    name: 'Kimi Latest (via OpenRouter)',
    baseUrl: 'https://openrouter.ai/api',
    authTokenEnv: 'OPENROUTER_API_KEY',
    upstreamModel: 'moonshotai/kimi-latest',
    capabilities: 'effort',
  },
  // --- Google Gemini via OpenRouter (no direct Anthropic-compatible Google endpoint) ---
  {
    id: 'gemini-3.5-flash',
    name: 'Gemini 3.5 Flash (via OpenRouter)',
    baseUrl: 'https://openrouter.ai/api',
    authTokenEnv: 'OPENROUTER_API_KEY',
    upstreamModel: 'google/gemini-3.5-flash',
    capabilities: 'effort',
  },
  // --- OpenAI GPT-5.4 family via OpenRouter (native OpenAI API is not Anthropic-compatible) ---
  {
    id: 'a54-nano',
    name: 'GPT-5.4 Nano / a54-nano (via OpenRouter)',
    baseUrl: 'https://openrouter.ai/api',
    authTokenEnv: 'OPENROUTER_API_KEY',
    upstreamModel: 'openai/gpt-5.4-nano',
    capabilities: 'effort',
  },
  {
    id: 'a54-mini',
    name: 'GPT-5.4 Mini / a54-mini (via OpenRouter)',
    baseUrl: 'https://openrouter.ai/api',
    authTokenEnv: 'OPENROUTER_API_KEY',
    upstreamModel: 'openai/gpt-5.4-mini',
    capabilities: 'effort',
  },
  {
    id: 'a54',
    name: 'GPT-5.4 / a54 (via OpenRouter)',
    baseUrl: 'https://openrouter.ai/api',
    authTokenEnv: 'OPENROUTER_API_KEY',
    upstreamModel: 'openai/gpt-5.4',
    capabilities: 'effort',
  },
] as const;

/** Resolve a per-session backend id to its definition (undefined = default Anthropic). */
export function resolveClaudeCodeBackend(backendId: string | undefined | null): ClaudeCodeBackend | undefined {
  if (!backendId) return undefined;
  if (isDeepSeekClaudeBackend(backendId)) {
    return CLAUDE_CODE_BACKENDS.find((backend) => backend.id === DEEPSEEK_CLAUDE_BACKEND_ID);
  }
  return CLAUDE_CODE_BACKENDS.find((b) => b.id === backendId);
}

/**
 * Overlay the per-session gateway env for a custom backend onto `env` (mutates
 * in place). Only ever called when a backend is selected, so default Anthropic
 * sessions are never affected.
 *
 * DELIBERATE, SCOPED EXCEPTION to the repo "no API keys from process.env" rule:
 * that rule guards against a stray ANTHROPIC_API_KEY being auto-used and billing
 * the user's Anthropic account by surprise. This path is the inverse and safe --
 * it DELETES ANTHROPIC_API_KEY and reads only the user's deliberately-set
 * non-Anthropic gateway tokens (DEEPSEEK_API_KEY / OPENROUTER_API_KEY /
 * ZAI_API_KEY / ZAI_CODING_PLAN_API_KEY), sending them solely to those
 * gateways. The token is read at spawn time and is NEVER persisted to session
 * state, logged, or committed -- session metadata stores only the backend id
 * (e.g. 'deepseek-reasoner').
 */
export function applyClaudeCodeBackendEnv(env: Record<string, any>, backend: ClaudeCodeBackend): void {
  const token = process.env[backend.authTokenEnv];
  console.log(`[CC-BACKEND] applying backend=${backend.id} baseUrl=${backend.baseUrl} model=${backend.upstreamModel} tokenEnv=${backend.authTokenEnv} tokenPresent=${!!token} (DIAGNOSTIC)`);
  // ANTHROPIC_API_KEY presence signals first-party auth and shadows the gateway
  // token -- it must be ABSENT for a gateway route.
  delete env.ANTHROPIC_API_KEY;
  // Do not inherit any ambient Anthropic-compatible token. Each custom backend
  // must use exactly its configured token env; missing token means auth failure,
  // not fallback to another route or balance.
  delete env.ANTHROPIC_AUTH_TOKEN;
  env.ANTHROPIC_BASE_URL = backend.baseUrl;
  if (token) {
    env.ANTHROPIC_AUTH_TOKEN = token;
  }
  // Redirect every Claude variant to the upstream model so opus/sonnet/haiku
  // resolution maps onto the third-party model.
  env.ANTHROPIC_DEFAULT_OPUS_MODEL = backend.upstreamModels?.opus ?? backend.upstreamModel;
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = backend.upstreamModels?.sonnet ?? backend.upstreamModel;
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = backend.upstreamModels?.haiku ?? backend.upstreamModel;
  env.CLAUDE_CODE_SUBAGENT_MODEL = backend.upstreamModels?.subagent ?? backend.upstreamModel;
  if (backend.capabilities) {
    env.ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES = backend.capabilities;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES = backend.capabilities;
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES = backend.capabilities;
  }
  if (backend.extraEnv) {
    Object.assign(env, backend.extraEnv);
  }
}
