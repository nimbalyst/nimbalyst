import * as fs from 'fs';
import type { EffortLevel, ThinkingMode } from './effortLevels';

export const DEEPSEEK_CLAUDE_AGENT_MODEL_ID = 'claude-code:deepseek';
export const DEEPSEEK_CLAUDE_AGENT_MODEL_VARIANT = 'deepseek';
export const DEEPSEEK_CLAUDE_BACKEND_ID = 'deepseek-v4';

// Local-fork-only (this backend is a personal dev route, not upstream Nimbalyst
// product code -- see the V13-fork-deltas note in the 2026-07-30 efficiency
// audit). Yogev's standing rule: provider keys live in .env, never duplicated
// into a settings JSON file. This reads exactly one named key from that one
// file and returns it -- it never touches process.env and is never persisted
// anywhere, so it cannot trigger the implicit-env-inheritance failure class
// bootstrap.ts strips ANTHROPIC_API_KEY/OPENAI_API_KEY to guard against.
const DEV_ENV_FILE = String.raw`D:\!! CLAUDE\.env`;

export function readDeepSeekApiKeyFromEnvFile(): string | undefined {
  try {
    const contents = fs.readFileSync(DEV_ENV_FILE, 'utf-8');
    const lines = contents.split('\n');
    for (const rawLine of lines) {
      const line = rawLine.replace(/\r$/, '');
      const trimmed = line.trim();
      if (trimmed.startsWith('DEEPSEEK_API_KEY=')) {
        const value = trimmed.slice('DEEPSEEK_API_KEY='.length).trim();
        return value.replace(/^['"]/, '').replace(/['"]$/, '');
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export const DEEPSEEK_EFFORT_LEVELS = [
  { key: 'high', label: 'High' },
  { key: 'max', label: 'Max' },
] as const satisfies readonly { key: EffortLevel; label: string }[];

const DEEPSEEK_LEGACY_BACKEND_IDS = new Set(['deepseek-chat', 'deepseek-reasoner']);

export function isDeepSeekClaudeAgentModel(model: string | undefined | null): boolean {
  const normalized = model?.toLowerCase();
  return normalized === DEEPSEEK_CLAUDE_AGENT_MODEL_ID || normalized === DEEPSEEK_CLAUDE_AGENT_MODEL_VARIANT;
}

export function isDeepSeekClaudeBackend(backendId: string | undefined | null): boolean {
  return backendId === DEEPSEEK_CLAUDE_BACKEND_ID || (backendId != null && DEEPSEEK_LEGACY_BACKEND_IDS.has(backendId));
}

export function normalizeDeepSeekEffort(value: unknown): 'high' | 'max' {
  return value === 'max' || value === 'xhigh' ? 'max' : 'high';
}

export function normalizeDeepSeekThinkingMode(value: unknown): ThinkingMode {
  return value === 'disabled' ? 'disabled' : 'enabled';
}

export function applyDeepSeekClaudeAgentProfile<T extends {
  model?: string;
  customBackend?: string;
  effortLevel?: EffortLevel | string;
  thinkingMode?: ThinkingMode;
}>(config: T): T & { customBackend?: string; effortLevel?: EffortLevel | string; thinkingMode?: ThinkingMode } {
  if (!isDeepSeekClaudeAgentModel(config.model) && !isDeepSeekClaudeBackend(config.customBackend)) return config;
  return {
    ...config,
    customBackend: DEEPSEEK_CLAUDE_BACKEND_ID,
    effortLevel: normalizeDeepSeekEffort(config.effortLevel),
    thinkingMode: normalizeDeepSeekThinkingMode(config.thinkingMode),
  };
}
