/**
 * Model catalog and CLI binary discovery for the `antigravity-gemini-agent`
 * provider, backed by the Antigravity CLI (`agy`).
 *
 * Discovery runs `agy models`, which prints tab-separated `<modelId>\t<label>`
 * lines for the signed-in account. Effort-suffixed variants (e.g.
 * `gemini-4-neon-high`, `gemini-4-neon-xhigh`, `gemini-4-neon-medium`,
 * `gemini-4-neon-low`) are grouped into a single base model entry
 * (`gemini-4-neon`, "Gemini 4 Neon") while recording which effort tiers the
 * model supports — the user selects reasoning depth in Nimbalyst's effort
 * control rather than picking from four duplicate rows per model.
 *
 * Antigravity also fronts third-party models (Anthropic, OpenAI). This is the
 * Gemini provider, so only `gemini-*` entries are surfaced here.
 */

import { execFile } from 'child_process';
import { existsSync } from 'fs';
import os from 'os';
import path from 'path';
import type { EffortLevel } from '../../effortLevels';
import { scrubProviderApiKeys } from '../../providerApiKeyScrub';

const AGY_EFFORT_SUFFIXES = ['low', 'medium', 'high', 'xhigh'] as const;
export type AgyEffortLevel = (typeof AGY_EFFORT_SUFFIXES)[number];

const AGY_EFFORT_SUFFIX_RE = /^(.+)-(low|medium|high|xhigh)$/i;
const DISPLAY_EFFORT_SUFFIX_RE = /\s*\((?:Low|Medium|High|XHigh|Extra)\)\s*$/i;

export interface AgyModelEntry {
  /** Base model id without effort suffix (e.g. `gemini-4-neon`). */
  key: string;
  /** Human-readable model name without the trailing effort tag. */
  displayName: string;
  /** Effort tiers advertised by `agy` for this model (empty if fixed/unconfigurable). */
  supportedEfforts: AgyEffortLevel[];
}

/** Fallback default model when `agy` has not been queried yet or cannot be reached. */
export const DEFAULT_GEMINI_MODEL_KEY = 'gemini-4-neon';

const DEFAULT_FALLBACK_ENTRY: AgyModelEntry = Object.freeze({
  key: DEFAULT_GEMINI_MODEL_KEY,
  displayName: 'Gemini 4 Neon',
  supportedEfforts: ['low', 'medium', 'high', 'xhigh'] as AgyEffortLevel[],
});

const discoveredEffortsByModel = new Map<string, AgyEffortLevel[]>();

/**
 * Strip the `antigravity-gemini-agent:` namespace off a stored model id.
 * Callers may pass either the namespaced form or a bare key.
 */
export function bareGeminiModelKey(raw: string | undefined | null): string {
  if (!raw) return DEFAULT_GEMINI_MODEL_KEY;
  const trimmed = raw.trim();
  if (!trimmed) return DEFAULT_GEMINI_MODEL_KEY;
  return trimmed.includes(':') ? trimmed.split(':').slice(1).join(':') : trimmed;
}

/**
 * Split an effort-suffixed Antigravity model id (e.g. `gemini-4-neon-high`)
 * into its base model id and effort level. Models without a trailing effort
 * suffix return `{ baseModel, effort: undefined }`.
 */
export function splitGeminiModelEffort(modelKey: string): {
  baseModel: string;
  effort?: AgyEffortLevel;
} {
  const match = AGY_EFFORT_SUFFIX_RE.exec(modelKey.trim());
  if (!match) {
    return { baseModel: modelKey.trim() };
  }
  return {
    baseModel: match[1],
    effort: match[2].toLowerCase() as AgyEffortLevel,
  };
}

/**
 * Group raw ACP or `agy models` entries into unique Gemini base models,
 * preserving the vendor's ordering and collecting each model's offered effort
 * tiers. Non-Gemini vendor models (Claude, GPT) are excluded.
 */
export function groupAgyModels(
  rawModels: ReadonlyArray<{ modelId: string; name?: string }>,
): AgyModelEntry[] {
  const byBase = new Map<string, AgyModelEntry>();

  for (const item of rawModels) {
    const rawId = item.modelId?.trim();
    if (!rawId || !rawId.toLowerCase().startsWith('gemini-')) continue;

    const { baseModel, effort } = splitGeminiModelEffort(rawId);
    const rawName = (item.name ?? '').trim();
    const cleanName = rawName
      ? (effort ? rawName.replace(DISPLAY_EFFORT_SUFFIX_RE, '').trim() : rawName)
      : baseModel;

    let entry = byBase.get(baseModel);
    if (!entry) {
      entry = {
        key: baseModel,
        displayName: cleanName || baseModel,
        supportedEfforts: [],
      };
      byBase.set(baseModel, entry);
    }

    if (effort && !entry.supportedEfforts.includes(effort)) {
      entry.supportedEfforts.push(effort);
    }
  }

  return Array.from(byBase.values());
}

/**
 * Parse stdout from `agy models`:
 *
 * ```
 * gemini-4-neon-high\tGemini 4 Neon (High)
 * gemini-4-neon-xhigh\tGemini 4 Neon (XHigh)
 * gemini-pro-orchestrator-neon\tOrchestrator (Neon)
 * ```
 */
export function parseAgyModelsOutput(output: string): AgyModelEntry[] {
  const rawModels: Array<{ modelId: string; name: string }> = [];

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^fetching\b/i.test(line)) continue;

    const tabIdx = line.indexOf('\t');
    if (tabIdx > 0) {
      const modelId = line.slice(0, tabIdx).trim();
      const name = line.slice(tabIdx + 1).trim();
      if (modelId && !/\s/.test(modelId)) {
        rawModels.push({ modelId, name });
      }
      continue;
    }

    // Fallback: two or more spaces separating id and label.
    const spaced = /^(\S+)\s{2,}(.+)$/.exec(line);
    if (spaced) {
      rawModels.push({ modelId: spaced[1], name: spaced[2].trim() });
    }
  }

  return groupAgyModels(rawModels);
}

/**
 * Record discovered model effort tiers in memory so effort clamping can reflect
 * what the live `agy` CLI reported.
 */
export function recordDiscoveredAgyModels(entries: ReadonlyArray<AgyModelEntry>): void {
  for (const entry of entries) {
    discoveredEffortsByModel.set(entry.key.toLowerCase(), [...entry.supportedEfforts]);
  }
}

/**
 * Return the highest discovered effort tier for a Gemini model, if known.
 */
export function getDiscoveredGeminiEffortCeiling(modelKey: string): EffortLevel | undefined {
  const { baseModel } = splitGeminiModelEffort(bareGeminiModelKey(modelKey));
  const efforts = discoveredEffortsByModel.get(baseModel.toLowerCase());
  if (!efforts || efforts.length === 0) return undefined;
  const rank: Record<AgyEffortLevel, number> = { low: 0, medium: 1, high: 2, xhigh: 3 };
  return [...efforts].sort((a, b) => rank[b] - rank[a])[0];
}

/**
 * Resolve the `agy` CLI binary across standard install locations and PATH.
 * Returns null when no executable is found.
 */
export function resolveAgyBinaryPath(options?: {
  enhancedPath?: string | null;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  fileExists?: (candidate: string) => boolean;
}): string | null {
  const platform = options?.platform ?? process.platform;
  const env = options?.env ?? process.env;
  const home = options?.homeDir ?? os.homedir();
  const check = options?.fileExists ?? existsSync;
  const exeName = platform === 'win32' ? 'agy.exe' : 'agy';

  const candidates: string[] = [];

  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    candidates.push(
      path.join(localAppData, 'agy', 'bin', exeName),
      path.join(home, '.agy', 'bin', exeName),
      path.join(home, '.local', 'bin', exeName),
    );
  } else {
    candidates.push(
      path.join(home, '.agy', 'bin', exeName),
      path.join(home, '.local', 'bin', exeName),
      '/opt/homebrew/bin/agy',
      '/usr/local/bin/agy',
    );
  }

  const searchPath = options?.enhancedPath || env.PATH || '';
  const delimiter = platform === 'win32' ? ';' : ':';
  for (const entry of searchPath.split(delimiter)) {
    const trimmed = entry.trim().replace(/^"(.*)"$/, '$1');
    if (trimmed) {
      candidates.push(path.join(trimmed, exeName));
    }
  }

  for (const candidate of candidates) {
    try {
      if (check(candidate)) return candidate;
    } catch {
      // Unreadable path -- keep searching.
    }
  }

  return null;
}

/**
 * Discover Gemini models from the `agy models` CLI command, falling back to the
 * default entry if `agy` is missing, signed out, or times out.
 */
export async function discoverAgyModels(options?: {
  command?: string | null;
  env?: Record<string, string>;
  timeoutMs?: number;
}): Promise<AgyModelEntry[]> {
  const command = options?.command || resolveAgyBinaryPath({ enhancedPath: options?.env?.PATH }) || (process.platform === 'win32' ? 'agy.exe' : 'agy');
  const env = scrubProviderApiKeys({ ...process.env, ...(options?.env ?? {}) });

  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        command,
        ['models'],
        {
          timeout: options?.timeoutMs ?? 10_000,
          encoding: 'utf8',
          windowsHide: true,
          env,
        },
        (error, out) => {
          if (error) reject(error);
          else resolve(out ?? '');
        },
      );
    });
    const models = parseAgyModelsOutput(stdout);
    if (models.length > 0) {
      recordDiscoveredAgyModels(models);
      return models;
    }
  } catch {
    // CLI missing, signed out, or unreachable -- fall back to default entry.
  }

  return [DEFAULT_FALLBACK_ENTRY];
}
