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
export type ClaudeCodeVariant = 'opus' | 'sonnet' | 'haiku' | 'opus-4-7' | 'opus-4-6';
export type ClaudeCodeVariantInput = ClaudeCodeVariant | 'opus-4-8';

/**
 * Accepted input aliases for Claude Agent model identifiers.
 *
 * `opus-4-8` is intentionally accepted as an alias for the canonical `opus`
 * variant so legacy code paths (meta-agent, Agent tool, imported session IDs)
 * can request the current Opus generation explicitly without requiring a
 * duplicate visible picker entry.
 */
export const CLAUDE_CODE_ACCEPTED_VARIANT_INPUTS: readonly ClaudeCodeVariantInput[] = [
  'opus',
  'opus-4-8',
  'opus-4-7',
  'opus-4-6',
  'sonnet',
  'haiku',
] as const;

const CLAUDE_CODE_VARIANT_INPUT_MAP: Readonly<Record<ClaudeCodeVariantInput, ClaudeCodeVariant>> = {
  opus: 'opus',
  'opus-4-8': 'opus',
  'opus-4-7': 'opus-4-7',
  'opus-4-6': 'opus-4-6',
  sonnet: 'sonnet',
  haiku: 'haiku',
};

export function normalizeClaudeCodeVariant(variant: string): ClaudeCodeVariant | null {
  return CLAUDE_CODE_VARIANT_INPUT_MAP[variant.toLowerCase() as ClaudeCodeVariantInput] ?? null;
}

export const CLAUDE_CODE_VARIANT_VERSIONS: Record<ClaudeCodeVariant, string> = {
  opus: '4.8',
  sonnet: '4.6',
  haiku: '4.5',
  'opus-4-7': '4.7',
  'opus-4-6': '4.6',
};

export const CLAUDE_CODE_MODEL_LABELS: Record<ClaudeCodeVariant, string> = {
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
  'opus-4-7': 'Opus',
  'opus-4-6': 'Opus',
};

/**
 * For pinned variants, the SDK needs the full Anthropic model ID instead of
 * the short alias — the short aliases always resolve to "latest". An empty
 * string (or missing entry) means "pass the variant name straight through".
 */
export const CLAUDE_CODE_PINNED_SDK_MODELS: Partial<Record<ClaudeCodeVariant, string>> = {
  'opus-4-7': 'claude-opus-4-7',
  'opus-4-6': 'claude-opus-4-6',
};

/** Variants that support a 1M-context extended picker row. */
export const CLAUDE_CODE_VARIANTS_WITH_1M: readonly ClaudeCodeVariant[] = [
  'opus',
  'sonnet',
  'opus-4-7',
  'opus-4-6',
];

export const DEFAULT_MODELS = {
  claude: 'claude:claude-opus-4-8',
  openai: 'openai:gpt-5.5',
  'claude-code': 'claude-code:opus-1m',
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
];

/** OpenCode provider id reserved for an LM Studio bridge written into opencode.json. */
export const OPENCODE_LMSTUDIO_PROVIDER_ID = 'lmstudio';
