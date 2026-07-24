/**
 * Effort level constants for adaptive reasoning (Opus 4.6 and Sonnet 4.6).
 * Matches the Claude Code CLI's /model effort slider and CLAUDE_CODE_EFFORT_LEVEL env var.
 *
 * Levels: low, medium, high (default), xhigh, max
 */

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ThinkingMode = 'enabled' | 'disabled';

export const EFFORT_LEVELS: { key: EffortLevel; label: string }[] = [
  { key: 'low', label: 'Low' },
  { key: 'medium', label: 'Medium' },
  { key: 'high', label: 'High' },
  { key: 'xhigh', label: 'xHigh' },
  { key: 'max', label: 'Max' },
];

export const DEFAULT_EFFORT_LEVEL: EffortLevel = 'high';
// "enabled" is the persisted compatibility value for adaptive thinking. The
// provider translates it to `thinking: { type: 'adaptive' }`; it must not be
// presented as manual "extended thinking", which is a different API mode.
export const DEFAULT_THINKING_MODE: ThinkingMode = 'enabled';

const VALID_EFFORT_LEVELS = new Set<string>(['low', 'medium', 'high', 'xhigh', 'max']);
const VALID_THINKING_MODES = new Set<string>(['enabled', 'disabled']);

const CLAUDE_EFFORT_LEVELS = {
  current: EFFORT_LEVELS,
  legacyAdaptive: EFFORT_LEVELS.filter(level => level.key !== 'xhigh'),
} as const;

function normalizedModelId(modelId: string | undefined | null): string {
  return (modelId ?? '').toLowerCase().replace(/-1m$/, '').replace(/\[1m\]$/, '');
}

/**
 * Return only the effort values the selected model accepts.
 *
 * Claude Sonnet 5, Fable 5, Opus 4.8, and Opus 4.7 support the complete
 * low/medium/high/xhigh/max ladder. Opus 4.6 and Sonnet 4.6 support the same
 * ladder except xhigh. Haiku has no adaptive-effort control in this surface.
 * Other providers keep their existing transport-owned ladder.
 */
export function supportedEffortLevelsForModel(
  modelId: string | undefined | null
): { key: EffortLevel; label: string }[] {
  const id = normalizedModelId(modelId);
  if (id.startsWith('claude-code-cli:') || id.startsWith('openai-codex-acp:')) return [];
  if (id.startsWith('claude-code:')) {
    if (id.includes('haiku')) return [];
    if (id.includes('opus-4-6') || id.includes('sonnet-4-6')) {
      return [...CLAUDE_EFFORT_LEVELS.legacyAdaptive];
    }
  }
  return [...CLAUDE_EFFORT_LEVELS.current];
}

/**
 * Whether the selected model supports an explicit adaptive-thinking toggle.
 *
 * Fable is intentionally excluded: it is always adaptive and cannot be
 * disabled. Claude CLI and non-Claude transports do not forward this setting.
 */
export function supportsThinkingModeForModel(
  modelId: string | undefined | null
): boolean {
  const id = normalizedModelId(modelId);
  if (!id.startsWith('claude-code:')) return false;
  const variant = id.slice('claude-code:'.length);
  return variant.startsWith('opus') || variant.startsWith('sonnet');
}

/**
 * Normalize a stored/global effort to a value the selected model accepts.
 * Unsupported intermediate levels step down rather than silently upgrading
 * capability or cost (for example xhigh -> high on Sonnet 4.6).
 */
export function normalizeEffortForModel(
  modelId: string | undefined | null,
  effort: EffortLevel
): EffortLevel {
  const supported = supportedEffortLevelsForModel(modelId);
  if (supported.length === 0 || supported.some(level => level.key === effort)) return effort;

  const requestedIndex = EFFORT_LEVELS.findIndex(level => level.key === effort);
  for (let index = requestedIndex - 1; index >= 0; index -= 1) {
    const candidate = EFFORT_LEVELS[index].key;
    if (supported.some(level => level.key === candidate)) return candidate;
  }
  return supported[0].key;
}

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
  appDefaultEffortLevel: EffortLevel | undefined,
  modelId?: string | null,
): EffortLevel | undefined {
  let resolved: EffortLevel | undefined;
  if (sessionEffortLevel != null && sessionEffortLevel !== '') {
    resolved = parseEffortLevel(sessionEffortLevel);
  } else {
    resolved = appDefaultEffortLevel;
  }
  if (resolved === undefined) return undefined;
  const supported = supportedEffortLevelsForModel(modelId);
  if (supported.length === 0) return undefined;
  return normalizeEffortForModel(modelId, resolved);
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
