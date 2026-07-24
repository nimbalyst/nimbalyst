import type { EffortLevel, ThinkingMode } from './effortLevels';

export const DEEPSEEK_CLAUDE_AGENT_MODEL_ID = 'claude-code:deepseek';
export const DEEPSEEK_CLAUDE_AGENT_MODEL_VARIANT = 'deepseek';
export const DEEPSEEK_CLAUDE_BACKEND_ID = 'deepseek-v4';

export const DEEPSEEK_EFFORT_LEVELS = [
  { key: 'high', label: 'High' },
  { key: 'max', label: 'Max' },
] as const satisfies readonly { key: EffortLevel; label: string }[];

const DEEPSEEK_LEGACY_BACKEND_IDS = new Set([
  'deepseek-chat',
  'deepseek-reasoner',
]);

export function isDeepSeekClaudeAgentModel(model: string | undefined | null): boolean {
  if (!model) return false;
  const normalized = model.toLowerCase();
  return normalized === DEEPSEEK_CLAUDE_AGENT_MODEL_ID
    || normalized === DEEPSEEK_CLAUDE_AGENT_MODEL_VARIANT;
}

export function isDeepSeekClaudeBackend(backendId: string | undefined | null): boolean {
  if (!backendId) return false;
  return backendId === DEEPSEEK_CLAUDE_BACKEND_ID || DEEPSEEK_LEGACY_BACKEND_IDS.has(backendId);
}

/**
 * DeepSeek's Anthropic-compatible API exposes two effort degrees of freedom.
 * Legacy Claude effort values normalize to the nearest supported value.
 */
export function normalizeDeepSeekEffort(value: unknown): 'high' | 'max' {
  return value === 'max' || value === 'xhigh' ? 'max' : 'high';
}

export function normalizeDeepSeekThinkingMode(value: unknown): ThinkingMode {
  return value === 'disabled' ? 'disabled' : 'enabled';
}

/**
 * Derive the complete DeepSeek launch profile from the synthetic model row.
 * The stored model remains recognizable to the picker while the provider gets
 * an atomic backend, effort, and reasoning configuration.
 */
export function applyDeepSeekClaudeAgentProfile<T extends {
  model?: string;
  customBackend?: string;
  effortLevel?: EffortLevel | string;
  thinkingMode?: ThinkingMode;
}>(config: T): T {
  if (!isDeepSeekClaudeAgentModel(config.model) && !isDeepSeekClaudeBackend(config.customBackend)) {
    return config;
  }

  return {
    ...config,
    customBackend: DEEPSEEK_CLAUDE_BACKEND_ID,
    effortLevel: normalizeDeepSeekEffort(config.effortLevel),
    thinkingMode: normalizeDeepSeekThinkingMode(config.thinkingMode),
  } as T;
}
