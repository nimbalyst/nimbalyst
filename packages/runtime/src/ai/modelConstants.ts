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
    id: 'claude-opus-5',
    displayName: 'Claude Opus 5 (1M)',
    shortName: 'Opus 5',
    maxTokens: 8192,
    // Opus 5 ships with a 1M context window natively (no beta header), at the
    // same $5/$25 pricing tier as Opus 4.8. The API alias is dateless — see
    // anthropic.com/news/claude-opus-5.
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
export type ClaudeCodeVariant = 'fable' | 'opus' | 'sonnet' | 'haiku' | 'opus-4-8' | 'opus-4-7' | 'opus-4-6' | 'sonnet-4-6';
export type ClaudeCodeVariantInput = ClaudeCodeVariant | 'opus-5' | 'sonnet-5' | 'fable-5';

/**
 * Accepted input aliases for Claude Agent model identifiers.
 *
 * `opus-5` is intentionally accepted as an alias for the canonical `opus`
 * variant so legacy code paths (meta-agent, Agent tool, imported session IDs)
 * can request the current Opus generation explicitly without requiring a
 * duplicate visible picker entry. `sonnet-5` and `fable-5` are accepted as
 * aliases for `sonnet` and `fable` for the same reason.
 * `opus-4-8` is now a pinned previous-generation
 * variant (its own row), not an alias — it resolves to that specific model.
 */
export const CLAUDE_CODE_ACCEPTED_VARIANT_INPUTS: readonly ClaudeCodeVariantInput[] = [
  'fable',
  'fable-5',
  'opus',
  'opus-5',
  'opus-4-8',
  'opus-4-7',
  'opus-4-6',
  'sonnet',
  'sonnet-5',
  'sonnet-4-6',
  'haiku',
] as const;

const CLAUDE_CODE_VARIANT_INPUT_MAP: Readonly<Record<ClaudeCodeVariantInput, ClaudeCodeVariant>> = {
  fable: 'fable',
  'fable-5': 'fable',
  opus: 'opus',
  'opus-5': 'opus',
  'opus-4-8': 'opus-4-8',
  'opus-4-7': 'opus-4-7',
  'opus-4-6': 'opus-4-6',
  sonnet: 'sonnet',
  'sonnet-5': 'sonnet',
  'sonnet-4-6': 'sonnet-4-6',
  haiku: 'haiku',
};

export function normalizeClaudeCodeVariant(variant: string): ClaudeCodeVariant | null {
  return CLAUDE_CODE_VARIANT_INPUT_MAP[variant.toLowerCase() as ClaudeCodeVariantInput] ?? null;
}

export const CLAUDE_CODE_VARIANT_VERSIONS: Record<ClaudeCodeVariant, string> = {
  fable: '5',
  opus: '5',
  sonnet: '5',
  haiku: '4.5',
  'opus-4-8': '4.8',
  'opus-4-7': '4.7',
  'opus-4-6': '4.6',
  'sonnet-4-6': '4.6',
};

export const CLAUDE_CODE_MODEL_LABELS: Record<ClaudeCodeVariant, string> = {
  fable: 'Fable',
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
  'opus-4-8': 'Opus',
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
  'opus-4-8': 'claude-opus-4-8',
  'opus-4-7': 'claude-opus-4-7',
  'opus-4-6': 'claude-opus-4-6',
  // Pinned so the previous-generation Sonnet stays selectable after the
  // canonical `sonnet` alias rolled forward to Sonnet 5.
  'sonnet-4-6': 'claude-sonnet-4-6',
};

/**
 * Variants whose PLAIN (non-`[1m]`) row is seeded at a 1M context window.
 *
 * Verified against CLI 2.1.204/2.1.220 (GitHub #825 / NIM-1660 / NIM-2170): on
 * the Agent-SDK path — the provider most users are on — plain `opus`/`fable`/
 * `sonnet` sessions report `modelUsage[...].contextWindow === 1_000_000`, so
 * seeding 200k here would show a meter that fills past 100% on the first long
 * turn. This is a SEED, not a guarantee; two things make the real window vary:
 *
 *   - 1M is PLAN-GATED (code.claude.com/docs/en/model-config → "Extended
 *     context"): Max/Team/Enterprise auto-upgrade Opus to 1M with no
 *     configuration, Pro needs usage credits, API/pay-as-you-go has full access,
 *     and `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` turns 1M off entirely. Sonnet 5 on
 *     the Anthropic API always runs 1M — it has no 200K variant at all.
 *   - Setting `ANTHROPIC_BASE_URL` (our CLI observation proxy does) makes Claude
 *     Code treat the connection as an LLM gateway it can't verify, so it SKIPS
 *     the plan-based auto-upgrade and runs at 200k unless `[1m]` is explicit.
 *
 * Both paths correct the seed at runtime: the SDK path from the reported window
 * (`resolveClaudeCodeParentContextWindow`), the CLI path from the outbound
 * `anthropic-beta: context-1m-2025-08-07` header the proxy observes
 * (`contextWindowForCliModel`). Users who need to force 1M pick the `-1m` row
 * (see `CLAUDE_CODE_VARIANTS_WITH_1M`).
 *
 * The pinned legacy variants (`opus-4-7`/`opus-4-6`/`sonnet-4-6`) are included
 * because the model catalog lists all three at a 1M window.
 */
export const CLAUDE_CODE_NATIVE_1M_VARIANTS: readonly ClaudeCodeVariant[] = [
  'fable',
  'opus',
  'sonnet',
  'opus-4-8',
  'opus-4-7',
  'opus-4-6',
  'sonnet-4-6',
];

/**
 * Variants that get a SEPARATE 1M-context (`-1m`) picker row, which sends the
 * CLI/SDK's explicit `model[1m]` form (GitHub #989, PR #990 by @Derazien).
 *
 * The row exists because the plain row is NOT always 1M: a Pro account has to
 * opt in (1M costs usage credits there), and any session behind an
 * `ANTHROPIC_BASE_URL` gateway — including Nimbalyst's own CLI observation proxy
 * — loses the plan-based auto-upgrade unless `[1m]` is explicit. Measured on one
 * Max account minutes apart (CLI 2.1.220): direct, bare `opus` reports a 1M
 * window; through the loopback proxy the same `opus` reports 200k and the
 * outbound request omits `context-1m-2025-08-07` — with `opus[1m]` the flag is
 * present and 1M applies either way.
 *
 * Deliberately limited to `opus` and `fable`:
 *   - `sonnet` is excluded — Sonnet 5 has no 200K variant on the Anthropic API
 *     and no `[1m]` suffix to select, so the row would be a dead option.
 *   - `haiku` has no 1M window.
 *   - the pinned legacy variants are excluded because `resolveClaudeCliModelArg`
 *     collapses every `opus*` variant to the bare `opus` alias, so an
 *     `opus-4-7-1m` row would run Opus 5 at 1M while claiming to be Opus 4.7.
 */
export const CLAUDE_CODE_VARIANTS_WITH_1M: readonly ClaudeCodeVariant[] = ['opus', 'fable'];

/**
 * The base (non-`-1m`) context window for a Claude Agent variant, used to seed
 * the context-fill meter before any real signal arrives and as the fallback when
 * the SDK doesn't report a per-model window. Haiku is 200k; see
 * `CLAUDE_CODE_NATIVE_1M_VARIANTS` for why the rest are seeded at 1M and how the
 * seed gets corrected at runtime on each path.
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
 * plain `claude-code:opus` (no `[1m]` suffix). This guards a BILLING risk: an
 * explicit `[1m]` is metered against usage credits on a Pro plan, so an
 * INVISIBLE fallback must never opt a user into extended context. Max/Team/
 * Enterprise accounts get 1M on the plain alias anyway (plan auto-upgrade), so
 * plain is both the safe and the simplest valid choice.
 */
export const CLAUDE_CODE_SAFE_FALLBACK_MODEL = 'claude-code:opus' as const;

export const DEFAULT_MODELS = {
  claude: 'claude:claude-opus-5',
  openai: 'openai:gpt-5.6-sol',
  // Plain `opus` (not `opus-1m`): a plan-gated auto-upgrade gives Max/Team/
  // Enterprise 1M on the plain alias, while an explicit `[1m]` would spend usage
  // credits on Pro. The default must not opt anyone into that — see
  // CLAUDE_CODE_SAFE_FALLBACK_MODEL.
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
