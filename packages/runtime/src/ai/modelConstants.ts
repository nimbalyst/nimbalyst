/**
 * Shared AI model constants available across hosts.
 */

export interface ModelDefinition {
  id: string;
  displayName: string;
  shortName: string;
  maxTokens: number;
  contextWindow: number;
}

export const CLAUDE_MODELS: ModelDefinition[] = [
  {
    id: 'claude-fable-5',
    displayName: 'Claude Fable 5 (1M)',
    shortName: 'Fable 5',
    maxTokens: 8192,
    // Fable 5 is the tier above Opus — 1M context natively, dateless alias.
    contextWindow: 1000000,
  },
  {
    id: 'claude-opus-4-8',
    displayName: 'Claude Opus 4.8 (1M)',
    shortName: 'Opus 4.8',
    maxTokens: 8192,
    // Opus 4.8 ships with a 1M context window natively (no beta header).
    // The API alias is dateless and pinned to this snapshot — see
    // platform.claude.com/docs/en/about-claude/models/overview.
    contextWindow: 1000000,
  },
  {
    id: 'claude-opus-4-7',
    displayName: 'Claude Opus 4.7 (1M)',
    shortName: 'Opus 4.7',
    maxTokens: 8192,
    // Opus 4.7 uses the 1M context window natively — no beta header required
    // (unlike Opus 4.6 which needed `context-1m-2025-08-07`).
    contextWindow: 1000000,
  },
  {
    id: 'claude-opus-4-6',
    displayName: 'Claude Opus 4.6',
    shortName: 'Opus 4.6',
    maxTokens: 8192,
    contextWindow: 200000,
  },
  {
    id: 'claude-sonnet-5',
    displayName: 'Claude Sonnet 5 (1M)',
    shortName: 'Sonnet 5',
    maxTokens: 8192,
    // Sonnet 5 ships with a 1M context window natively (dateless alias, pinned
    // snapshot). Adaptive thinking only; rejects `temperature` (see
    // ClaudeProvider.supportsTemperature).
    contextWindow: 1000000,
  },
  {
    id: 'claude-sonnet-4-6',
    displayName: 'Claude Sonnet 4.6',
    shortName: 'Sonnet 4.6',
    maxTokens: 8192,
    contextWindow: 200000,
  },
  {
    id: 'claude-opus-4-5-20251101',
    displayName: 'Claude Opus 4.5',
    shortName: 'Opus 4.5',
    maxTokens: 8192,
    contextWindow: 200000,
  },
  {
    id: 'claude-opus-4-1-20250805',
    displayName: 'Claude Opus 4.1',
    shortName: 'Opus 4.1',
    maxTokens: 8192,
    contextWindow: 200000,
  },
  {
    id: 'claude-opus-4-20250514',
    displayName: 'Claude Opus 4',
    shortName: 'Opus 4',
    maxTokens: 8192,
    contextWindow: 200000,
  },
  {
    id: 'claude-sonnet-4-5-20250929',
    displayName: 'Claude Sonnet 4.5',
    shortName: 'Sonnet 4.5',
    maxTokens: 8192,
    contextWindow: 200000,
  },
  {
    id: 'claude-sonnet-4-20250514',
    displayName: 'Claude Sonnet 4',
    shortName: 'Sonnet 4',
    maxTokens: 8192,
    contextWindow: 200000,
  },
  {
    id: 'claude-3-7-sonnet-20250219',
    displayName: 'Claude Sonnet 3.7',
    shortName: 'Sonnet 3.7',
    maxTokens: 8192,
    contextWindow: 200000,
  },
];

export const OPENAI_MODELS: ModelDefinition[] = [
  {
    id: 'gpt-5.5',
    displayName: 'GPT-5.5',
    shortName: '5.5',
    maxTokens: 128000,
    contextWindow: 400000,
  },
  {
    id: 'gpt-5.4',
    displayName: 'GPT-5.4',
    shortName: '5.4',
    maxTokens: 128000,
    contextWindow: 400000,
  },
  {
    id: 'gpt-5.3-chat-latest',
    displayName: 'GPT-5.3 Chat',
    shortName: '5.3 Chat',
    maxTokens: 128000,
    contextWindow: 400000,
  },
  {
    id: 'gpt-5.2',
    displayName: 'GPT-5.2',
    shortName: '5.2',
    maxTokens: 128000,
    contextWindow: 400000,
  },
  {
    id: 'gpt-5.1',
    displayName: 'GPT-5.1',
    shortName: '5.1',
    maxTokens: 128000,
    contextWindow: 400000,
  },
  {
    id: 'gpt-5',
    displayName: 'GPT-5',
    shortName: '5.0',
    maxTokens: 128000,
    contextWindow: 400000,
  },
  {
    id: 'gpt-5-mini',
    displayName: 'GPT-5 Mini',
    shortName: '5 Mini',
    maxTokens: 128000,
    contextWindow: 400000,
  },
  {
    id: 'gpt-5-nano',
    displayName: 'GPT-5 Nano',
    shortName: '5 Nano',
    maxTokens: 128000,
    contextWindow: 400000,
  },
  {
    id: 'gpt-4.1',
    displayName: 'GPT-4.1',
    shortName: '4.1',
    maxTokens: 32768,
    contextWindow: 1047576,
  },
  {
    id: 'gpt-4.1-mini',
    displayName: 'GPT-4.1 Mini',
    shortName: '4.1 Mini',
    maxTokens: 32768,
    contextWindow: 1047576,
  },
  {
    id: 'gpt-4.1-nano',
    displayName: 'GPT-4.1 Nano',
    shortName: '4.1 Nano',
    maxTokens: 32768,
    contextWindow: 1047576,
  },
  {
    id: 'gpt-4o',
    displayName: 'GPT-4o',
    shortName: '4o',
    maxTokens: 16384,
    contextWindow: 128000,
  },
  {
    id: 'gpt-4o-mini',
    displayName: 'GPT-4o Mini',
    shortName: '4o Mini',
    maxTokens: 16384,
    contextWindow: 128000,
  },
];

/**
 * Claude Code variant display metadata — single source of truth.
 *
 * Both the runtime (`ClaudeCodeProvider` — builds the model catalog that the
 * SDK consumes) and the renderer (`modelUtils.ts` — renders the session-chrome
 * label that shows which variant is active) must agree on these values.
 * Duplicating the table in both places caused the renderer indicator to
 * display a stale "Opus 4.6" after the runtime was bumped to 4.7.
 *
 * Two kinds of variants:
 * - Canonical variants (`opus`, `sonnet`, `haiku`) — the SDK resolves these
 *   to the latest underlying model. The version field is for display only.
 * - Pinned variants (`opus-4-6`, ...) — always resolve to a specific
 *   Anthropic model ID via `CLAUDE_CODE_PINNED_SDK_MODELS`. Used to keep
 *   the previous-generation Opus selectable after bumping the canonical
 *   `opus` to the next version.
 */
export type ClaudeCodeVariant = 'fable' | 'opus' | 'sonnet' | 'haiku' | 'opus-4-7' | 'opus-4-6' | 'sonnet-4-6';
export type ClaudeCodeVariantInput = ClaudeCodeVariant | 'opus-4-8' | 'fable-5';

/**
 * Accepted input aliases for Claude Agent model identifiers.
 *
 * `opus-4-8` is intentionally accepted as an alias for the canonical `opus`
 * variant so legacy code paths (meta-agent, Agent tool, imported session IDs)
 * can request the current Opus generation explicitly without requiring a
 * duplicate visible picker entry. `fable-5` is accepted as an alias for
 * `fable` for the same reason.
 */
export const CLAUDE_CODE_ACCEPTED_VARIANT_INPUTS: readonly ClaudeCodeVariantInput[] = [
  'fable',
  'fable-5',
  'opus',
  'opus-4-8',
  'opus-4-7',
  'opus-4-6',
  'sonnet',
  'sonnet-4-6',
  'haiku',
] as const;

const CLAUDE_CODE_VARIANT_INPUT_MAP: Readonly<Record<ClaudeCodeVariantInput, ClaudeCodeVariant>> = {
  fable: 'fable',
  'fable-5': 'fable',
  opus: 'opus',
  'opus-4-8': 'opus',
  'opus-4-7': 'opus-4-7',
  'opus-4-6': 'opus-4-6',
  sonnet: 'sonnet',
  'sonnet-4-6': 'sonnet-4-6',
  haiku: 'haiku',
};

export function normalizeClaudeCodeVariant(variant: string): ClaudeCodeVariant | null {
  return CLAUDE_CODE_VARIANT_INPUT_MAP[variant.toLowerCase() as ClaudeCodeVariantInput] ?? null;
}

export const CLAUDE_CODE_VARIANT_VERSIONS: Record<ClaudeCodeVariant, string> = {
  fable: '5',
  opus: '4.8',
  sonnet: '5',
  haiku: '4.5',
  'opus-4-7': '4.7',
  'opus-4-6': '4.6',
  'sonnet-4-6': '4.6',
};

export const CLAUDE_CODE_MODEL_LABELS: Record<ClaudeCodeVariant, string> = {
  fable: 'Fable',
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
  'opus-4-7': 'Opus',
  'opus-4-6': 'Opus',
  'sonnet-4-6': 'Sonnet',
};

/**
 * For pinned variants, the SDK needs the full Anthropic model ID instead of
 * the short alias — the short aliases always resolve to "latest". An empty
 * string (or missing entry) means "pass the variant name straight through".
 */
export const CLAUDE_CODE_PINNED_SDK_MODELS: Partial<Record<ClaudeCodeVariant, string>> = {
  // The Agent SDK's bundled CLI rejects the bare `fable` alias ("There's an
  // issue with the selected model (fable)…", 2026-06-12) — version skew with
  // the user's interactive CLI, which does accept it. Pin the full model id;
  // the interactive-CLI path (`resolveClaudeCliModelArg`) does not read this
  // map and keeps sending the working `fable` alias to the PTY.
  fable: 'claude-fable-5',
  'opus-4-7': 'claude-opus-4-7',
  'opus-4-6': 'claude-opus-4-6',
  // Pinned so the previous-generation Sonnet stays selectable after the
  // canonical `sonnet` alias rolled forward to Sonnet 5.
  'sonnet-4-6': 'claude-sonnet-4-6',
};

/**
 * Variants that support a 1M-context extended picker row.
 *
 * `fable` belongs here even though the Anthropic API serves Fable 5 at 1M
 * natively: Claude Code gates the 1M window behind the `[1m]` model-value
 * suffix for Fable too (verified against CLI 2.1.175 — plain `fable` sessions
 * auto-compact at ~177k/200k, and the binary carries a distinct `fable[1m]`
 * model value that a live probe accepted). Without this row there was no way
 * to run a 1M Fable session from Nimbalyst at all.
 */
export const CLAUDE_CODE_VARIANTS_WITH_1M: readonly ClaudeCodeVariant[] = [
  'fable',
  'opus',
  'sonnet',
  'opus-4-7',
  'opus-4-6',
  'sonnet-4-6',
];

/**
 * Safe silent fallback for the Claude Agent providers (#631 / NIM-848).
 *
 * Billing safety: 1M context is a PAID add-on, derived purely from a `-1m`
 * model string (which becomes `model[1m]` and triggers the SDK's 1M beta).
 * Whenever a session's model is unexpectedly empty/lost, resolution must fall
 * back to a STANDARD 200k model — never a `-1m` variant — so we never silently
 * bill the user for 1M context they didn't choose. `claude-code:opus` (plain
 * Opus) windows at 200k client-side; no `[1m]` suffix is emitted.
 *
 * This is intentionally distinct from the user-facing default
 * (`DEFAULT_MODELS['claude-code']`, currently `opus-1m`): new installs may
 * still default to the 1M tier as a visible, deliberate choice, but the
 * INVISIBLE fallback must never be a paid model.
 */
export const CLAUDE_CODE_SAFE_FALLBACK_MODEL = 'claude-code:opus' as const;

export const DEFAULT_MODELS = {
  claude: 'claude:claude-opus-4-8',
  openai: 'openai:gpt-5.5',
  ollama: 'ollama:local-model',
  anythingllm: 'anythingllm:local-model',
  openrouter: 'openrouter:local-model',
  featherless: 'featherless:local-model',
  'featherless-official': 'featherless-official:local-model',
  'featherless-sane': 'featherless-sane:local-model',
  'featherless-heretic': 'featherless-heretic:local-model',
  'featherless-keyword': 'featherless-keyword:local-model',
  'claude-code': 'claude-code:opus-1m',
  'claude-code-cli': 'claude-code-cli:opus-1m',
  'openai-codex': 'openai-codex:gpt-5.5',
  'openai-codex-acp': 'openai-codex-acp:gpt-5.5',
  lmstudio: 'lmstudio:local-model',
  opencode: 'opencode:anthropic/claude-sonnet-4-5',
  'copilot-cli': 'copilot-cli:default',
};

/**
 * Curated preset list of models for the OpenCode agent.
 *
 * OpenCode itself uses `<providerID>/<modelID>` (e.g. `anthropic/claude-sonnet-4-5`).
 * In Nimbalyst's model registry we wrap that with the `opencode:` prefix so the
 * provider-router knows which agent to dispatch to. The OpenCode protocol layer
 * strips the prefix before forwarding to the SDK.
 *
 * Keep this list small -- OpenCode supports hundreds of models. These are the
 * defaults users see in the picker before they configure custom providers.
 */
export interface OpenCodePresetModel {
  /** Full id with the `opencode:` registry prefix. */
  id: string;
  /** Human-readable label shown in pickers. */
  name: string;
  /** OpenCode provider id (the segment before the `/`). */
  providerID: string;
  /** OpenCode model id (the segment after the `/`). */
  modelID: string;
}

export const OPENCODE_PRESET_MODELS: OpenCodePresetModel[] = [
  {
    id: 'opencode:anthropic/claude-sonnet-4-5',
    name: 'Claude Sonnet 4.5',
    providerID: 'anthropic',
    modelID: 'claude-sonnet-4-5',
  },
  {
    id: 'opencode:anthropic/claude-opus-4-1',
    name: 'Claude Opus 4.1',
    providerID: 'anthropic',
    modelID: 'claude-opus-4-1',
  },
  {
    id: 'opencode:openai/gpt-5',
    name: 'GPT-5',
    providerID: 'openai',
    modelID: 'gpt-5',
  },
  {
    id: 'opencode:openai/gpt-5-mini',
    name: 'GPT-5 Mini',
    providerID: 'openai',
    modelID: 'gpt-5-mini',
  },
  {
    id: 'opencode:google/gemini-2.5-pro',
    name: 'Gemini 2.5 Pro',
    providerID: 'google',
    modelID: 'gemini-2.5-pro',
  },
  {
    id: 'opencode:zai/glm-5.2',
    name: 'GLM 5.2 (Z.AI)',
    providerID: 'zai',
    modelID: 'glm-5.2',
  },
  {
    id: 'opencode:zai-coding-plan/glm-5.2',
    name: 'GLM 5.2 (Z.AI Coding Plan)',
    providerID: 'zai-coding-plan',
    modelID: 'glm-5.2',
  },
];

/** OpenCode provider id reserved for an LM Studio bridge written into opencode.json. */
export const OPENCODE_LMSTUDIO_PROVIDER_ID = 'lmstudio';
