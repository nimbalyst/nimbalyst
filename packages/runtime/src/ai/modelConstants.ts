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
    id: 'gpt-5.6-sol',
    displayName: 'GPT-5.6 Sol',
    shortName: '5.6 Sol',
    maxTokens: 128000,
    contextWindow: 372000,
  },
  {
    id: 'gpt-5.6-terra',
    displayName: 'GPT-5.6 Terra',
    shortName: '5.6 Terra',
    maxTokens: 128000,
    contextWindow: 372000,
  },
  {
    id: 'gpt-5.6-luna',
    displayName: 'GPT-5.6 Luna',
    shortName: '5.6 Luna',
    maxTokens: 128000,
    contextWindow: 372000,
  },
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
 * Current-generation variants that run a 1M context window natively — the
 * window is the SAME whether or not the `[1m]` suffix is sent, and 1M is GA at
 * a single flat price (no `[1m]` premium tier, no >200k long-context surcharge).
 * Verified against CLI 2.1.204 (GitHub #825 / NIM-1660): plain `opus`/`fable`/
 * `sonnet` sessions report `modelUsage[...].contextWindow === 1_000_000`.
 *
 * Because plain and `[1m]` are identical for these, they get NO separate `-1m`
 * picker row (see `CLAUDE_CODE_VARIANTS_WITH_1M`) and their base context-window
 * is 1M. The earlier "plain models window at 200k client-side" behavior was real
 * on CLI 2.1.175 but is now stale.
 *
 * The pinned legacy variants (`opus-4-7`/`opus-4-6`/`sonnet-4-6`) are included
 * too: the model catalog lists all three at a 1M window, and we don't want a
 * redundant second `-1m` picker row for them either. The SDK-path meter reads
 * the REAL reported window per turn (see `resolveClaudeCodeParentContextWindow`),
 * so even if a legacy variant's live window differed it would self-correct — the
 * 1M value here is only the pre-first-result seed / CLI-proxy fallback.
 */
export const CLAUDE_CODE_NATIVE_1M_VARIANTS: readonly ClaudeCodeVariant[] = [
  'fable',
  'opus',
  'sonnet',
  'opus-4-7',
  'opus-4-6',
  'sonnet-4-6',
];

/**
 * Variants that still get a SEPARATE 1M-context (`-1m`) picker row.
 *
 * Intentionally empty: every Claude Agent variant now runs 1M on its single base
 * row (see `CLAUDE_CODE_NATIVE_1M_VARIANTS`), so a `-1m` row would be a redundant
 * duplicate. Existing sessions pinned to `…-1m` still resolve fine
 * (`resolveClaudeCodeModelVariant` strips the suffix); we just stop offering the
 * row for new selections. The mechanism is retained (not deleted) so a future
 * model that genuinely gates 1M behind a beta suffix can opt back in here.
 */
export const CLAUDE_CODE_VARIANTS_WITH_1M: readonly ClaudeCodeVariant[] = [];

/**
 * The base (non-`-1m`) context window for a Claude Agent variant, used to seed
 * the context-fill meter before the first real `modelUsage` arrives and as the
 * fallback when the SDK doesn't report a per-model window. Current-gen variants
 * are 1M natively; everything else (legacy pinned variants, haiku) is 200k until
 * proven otherwise. The authoritative value at runtime is the CLI-reported
 * window — see `resolveClaudeCodeParentContextWindow`.
 */
export function baseContextWindowForVariant(variant: ClaudeCodeVariant): number {
  return (CLAUDE_CODE_NATIVE_1M_VARIANTS as readonly string[]).includes(variant)
    ? 1_000_000
    : 200_000;
}

/**
 * The model "family" keyword (`opus` | `fable` | `sonnet` | `haiku`) for a
 * Claude Agent picker id such as `claude-code:opus` or `claude-code-cli:opus-1m`.
 * Used to match a session's parent model against the SDK's per-model usage map,
 * whose keys are full Anthropic ids (`claude-opus-4-8`, `claude-haiku-4-5-…`).
 * Returns undefined for ids we can't classify.
 */
export function claudeCodeFamilyKeyword(sessionModelId: string | undefined): string | undefined {
  if (!sessionModelId) return undefined;
  const modelPart = sessionModelId.includes(':')
    ? sessionModelId.slice(sessionModelId.indexOf(':') + 1)
    : sessionModelId;
  const base = modelPart.toLowerCase().replace(/-1m$/, '');
  const variant = normalizeClaudeCodeVariant(base);
  if (!variant) return undefined;
  // Every ClaudeCodeVariant encodes its family as the first `-`-delimited
  // segment (`opus`, `opus-4-7`, `sonnet-4-6`, …).
  return variant.split('-')[0];
}

/**
 * Resolve the PARENT model's real context window from the SDK's per-model usage
 * map (`result.modelUsage`), keyed by full Anthropic model id. The map also
 * carries sub-agent entries (e.g. Haiku at 200k), so we must not blindly take
 * the first entry or trust iteration order. Strategy:
 *   1. Match entries to the session's model family (`claude-code:opus` → keys
 *      containing "opus"), then take the largest window among the matches (a
 *      same-family sub-agent, if any, is never larger than the parent).
 *   2. If nothing matches the family (unknown id, or the SDK labels it
 *      differently), fall back to the largest reported window overall — a
 *      sub-agent's window is never larger than the parent's, so the max is the
 *      parent.
 * Returns undefined when no usable window is present (caller then falls back to
 * the registry seed).
 */
export function resolveClaudeCodeParentContextWindow(
  sessionModelId: string | undefined,
  modelUsage: Record<string, { contextWindow?: number } | undefined> | undefined,
): number | undefined {
  if (!modelUsage) return undefined;
  const entries = Object.entries(modelUsage)
    .map(([key, u]) => [key, u?.contextWindow] as const)
    .filter((e): e is readonly [string, number] => typeof e[1] === 'number' && e[1] > 0);
  if (entries.length === 0) return undefined;
  if (entries.length === 1) return entries[0][1];

  const family = claudeCodeFamilyKeyword(sessionModelId);
  if (family) {
    const matches = entries.filter(([key]) => key.toLowerCase().includes(family));
    if (matches.length > 0) {
      return Math.max(...matches.map(([, win]) => win));
    }
  }
  return Math.max(...entries.map(([, win]) => win));
}

/**
 * Safe silent fallback for the Claude Agent providers (#631 / NIM-848).
 *
 * When a session's model is unexpectedly empty/lost, resolution falls back to
 * plain `claude-code:opus` (no `[1m]` suffix). Historically this guarded a
 * BILLING risk: 1M used to be a paid add-on gated behind `model[1m]`, so the
 * invisible fallback had to avoid the premium tier. That premium is gone for
 * current-gen models — 1M is GA at a single flat price and `[1m]` is a no-op
 * (verified 2.1.204, GitHub #825) — so this fallback no longer changes cost for
 * current-gen. It stays plain (not a `-1m` variant) as defensive correctness for
 * any legacy variant that might still carry a premium, and because plain is the
 * simplest valid choice.
 */
export const CLAUDE_CODE_SAFE_FALLBACK_MODEL = 'claude-code:opus' as const;

export const DEFAULT_MODELS = {
  claude: 'claude:claude-opus-4-8',
  openai: 'openai:gpt-5.6-sol',
  minimax: 'minimax:MiniMax-M3',
  // Plain `opus` (not `opus-1m`): the current CLI runs plain Opus at 1M natively
  // at a flat price, so the `[1m]` suffix is a redundant no-op (GitHub #825).
  'claude-code': 'claude-code:opus',
  'claude-code-cli': 'claude-code-cli:opus',
  'openai-codex': 'openai-codex:gpt-5.6-sol',
  'openai-codex-acp': 'openai-codex-acp:gpt-5.6-sol',
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
