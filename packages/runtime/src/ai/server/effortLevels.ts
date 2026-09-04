/**
 * Effort level constants for adaptive reasoning (Opus 4.6 and Sonnet 4.6).
 * Matches the Claude Code CLI's /model effort slider and CLAUDE_CODE_EFFORT_LEVEL env var.
 *
 * Levels: low, medium, high (default), xhigh, max, ultra
 *
 * Not every model accepts every level, so the list is a superset and each model
 * has a ceiling — see `resolveEffortCeiling`. Only Codex reaches `ultra`.
 */

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
export type ThinkingMode = 'enabled' | 'disabled';

export const EFFORT_LEVELS: { key: EffortLevel; label: string }[] = [
  { key: 'low', label: 'Low' },
  { key: 'medium', label: 'Medium' },
  { key: 'high', label: 'High' },
  { key: 'xhigh', label: 'xHigh' },
  { key: 'max', label: 'Max' },
  { key: 'ultra', label: 'Ultra' },
];

/** Ascending order, so a level is permitted when its rank <= the model's ceiling. */
const EFFORT_RANK: Record<EffortLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  xhigh: 3,
  max: 4,
  ultra: 5,
};

/**
 * Highest effort each Codex model accepts, read from the codex binary's own
 * model catalog (`supported_reasoning_levels`). Sending a level above a model's
 * ceiling is rejected by codex, so callers clamp rather than pass through.
 */
const CODEX_EFFORT_CEILINGS: Readonly<Record<string, EffortLevel>> = {
  'gpt-6-astra': 'ultra',
  'gpt-5.6-sol': 'ultra',
  'gpt-5.6-terra': 'ultra',
  'gpt-5.6-luna': 'max',
  'gpt-5.5': 'xhigh',
  'gpt-5.4': 'xhigh',
  'gpt-5.4-mini': 'xhigh',
};

/**
 * Unlisted Codex models clamp to xhigh — the behavior every Codex model had
 * before per-model ceilings existed, so an unrecognized id can never start
 * sending a level codex will reject.
 */
const CODEX_DEFAULT_EFFORT_CEILING: EffortLevel = 'xhigh';
/** Claude's effort slider tops out at max; ultra is Codex-only. */
const DEFAULT_EFFORT_CEILING: EffortLevel = 'max';

function stripProviderPrefix(modelId: string): string {
  const separator = modelId.indexOf(':');
  return (separator === -1 ? modelId : modelId.slice(separator + 1)).trim().toLowerCase();
}

/** Highest effort a Codex model accepts. Takes a bare or provider-prefixed id. */
export function resolveCodexEffortCeiling(modelId?: string): EffortLevel {
  if (!modelId) {
    return CODEX_DEFAULT_EFFORT_CEILING;
  }
  return CODEX_EFFORT_CEILINGS[stripProviderPrefix(modelId)] ?? CODEX_DEFAULT_EFFORT_CEILING;
}

/**
 * Highest effort a model accepts, across providers. Codex ids (prefixed or
 * bare) use the catalog ceilings; everything else is Claude, which stops at max.
 */
export function resolveEffortCeiling(modelId?: string): EffortLevel {
  if (!modelId) {
    return DEFAULT_EFFORT_CEILING;
  }
  const raw = stripProviderPrefix(modelId);
  if (modelId.toLowerCase().startsWith('openai-codex') || raw in CODEX_EFFORT_CEILINGS) {
    return resolveCodexEffortCeiling(modelId);
  }
  return DEFAULT_EFFORT_CEILING;
}

/** Clamp a requested effort level down to what the model actually accepts. */
export function clampEffortLevel(level: EffortLevel, modelId?: string): EffortLevel {
  const ceiling = resolveEffortCeiling(modelId);
  return EFFORT_RANK[level] > EFFORT_RANK[ceiling] ? ceiling : level;
}

/** The effort levels to offer for a model, for the composer's effort selector. */
export function getAvailableEffortLevels(modelId?: string): { key: EffortLevel; label: string }[] {
  const ceiling = resolveEffortCeiling(modelId);
  return EFFORT_LEVELS.filter((entry) => EFFORT_RANK[entry.key] <= EFFORT_RANK[ceiling]);
}

export const DEFAULT_EFFORT_LEVEL: EffortLevel = 'high';
// Default to 'enabled' so the app omits the SDK thinking option and preserves
// the SDK's default adaptive thinking (Claude decides depth) on supported
// Opus/Sonnet models. Users can opt into 'disabled' (Extended: Off) per session.
export const DEFAULT_THINKING_MODE: ThinkingMode = 'enabled';

const VALID_EFFORT_LEVELS = new Set<string>(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const VALID_THINKING_MODES = new Set<string>(['enabled', 'disabled']);

/**
 * Validate and return a valid EffortLevel, or the default if invalid.
 */
export function parseEffortLevel(value: unknown): EffortLevel {
  if (typeof value === 'string' && VALID_EFFORT_LEVELS.has(value)) {
    return value as EffortLevel;
  }
  return DEFAULT_EFFORT_LEVEL;
}

/**
 * Resolve the effective effort level for a session.
 *
 * An explicit per-session value wins; otherwise we fall back to the app-wide
 * default that the UI effort selector displays. Without this fallback the
 * selector showed the app default (e.g. "Max") while the session silently ran
 * at the CLI's built-in "high", because the default was never written into
 * session metadata (GitHub #546).
 *
 * Returns undefined only when neither is set, so callers leave the CLI on its
 * own built-in default rather than forcing one.
 */
export function resolveEffortLevel(
  sessionEffortLevel: unknown,
  appDefaultEffortLevel: EffortLevel | undefined
): EffortLevel | undefined {
  if (sessionEffortLevel != null && sessionEffortLevel !== '') {
    return parseEffortLevel(sessionEffortLevel);
  }
  return appDefaultEffortLevel;
}

/**
 * Validate and return a valid ThinkingMode, or the default if invalid.
 */
export function parseThinkingMode(value: unknown): ThinkingMode {
  if (typeof value === 'string' && VALID_THINKING_MODES.has(value)) {
    return value as ThinkingMode;
  }
  return DEFAULT_THINKING_MODE;
}

/**
 * Resolve the effective thinking mode for a session.
 *
 * An explicit per-session value wins; otherwise we fall back to the app-wide
 * default the composer's Extended selector last wrote. Without this the toggle
 * reset to "Extended: On" at the start of every session because nothing
 * persisted the user's choice beyond the session row (GitHub #1034).
 *
 * Unlike effort level this always returns a mode, since 'enabled' is itself
 * the "leave the SDK on its adaptive default" value.
 */
export function resolveThinkingMode(
  sessionThinkingMode: unknown,
  appDefaultThinkingMode: ThinkingMode | undefined
): ThinkingMode {
  if (sessionThinkingMode != null && sessionThinkingMode !== '') {
    return parseThinkingMode(sessionThinkingMode);
  }
  return appDefaultThinkingMode ?? DEFAULT_THINKING_MODE;
}
