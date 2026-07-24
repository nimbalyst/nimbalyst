import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { OpenCodeFileConfig, OpenCodeFileProvider } from '@nimbalyst/runtime/ai/server';
import { logger } from '../utils/logger';

const CONFIG_REL_PATH = ['.config', 'opencode', 'opencode.json'];
const CONFIG_SCHEMA_URL = 'https://opencode.ai/config.json';
const LMSTUDIO_PROVIDER_KEY = 'lmstudio';
const LMSTUDIO_NPM_PACKAGE = '@ai-sdk/openai-compatible';

/**
 * Resolve the opencode.json path in priority order matching the
 * opencode-ai Go binary's own search behaviour:
 *
 *   1. $XDG_CONFIG_HOME/opencode/opencode.json (any platform)
 *   2. Windows: %APPDATA%/opencode/opencode.json
 *      macOS / Linux: ~/.config/opencode/opencode.json (XDG default)
 *   3. Fallback: ~/.config/opencode/opencode.json for cross-platform
 *      compatibility on Windows machines where the user manually
 *      created the XDG path.
 *
 * Returns the candidate list. The caller probes for existence and picks
 * the first hit. If none exist the first candidate is the
 * platform-native default for write operations.
 *
 * Before #284 the path was hardcoded to item 3 across all platforms,
 * so on Windows the merge between opencode.json and the model picker
 * silently failed: opencode-ai itself writes to
 * %APPDATA%\opencode\opencode.json by default. AnisminC reported
 * configured providers (Qwen3-Coder, Devstral, Kimi, DeepSeek, GLM,
 * Mistral, GPT-OSS, Ollama) never appearing in the picker.
 */
export interface ConfigPathEnv {
  platform: NodeJS.Platform;
  xdgConfigHome?: string;
  appData?: string;
  homedir: string;
}

export function resolveOpenCodeConfigCandidates(env: ConfigPathEnv): string[] {
  const candidates: string[] = [];
  if (env.xdgConfigHome && env.xdgConfigHome.length > 0) {
    candidates.push(path.join(env.xdgConfigHome, 'opencode', 'opencode.json'));
  }
  if (env.platform === 'win32') {
    if (env.appData && env.appData.length > 0) {
      candidates.push(path.join(env.appData, 'opencode', 'opencode.json'));
    }
  }
  // XDG-style default. Always considered as a fallback so a user who
  // manually authored the file at the cross-platform path still works.
  candidates.push(path.join(env.homedir, ...CONFIG_REL_PATH));
  return Array.from(new Set(candidates));
}

export function pickFirstExisting(candidates: string[], existsFn: (p: string) => boolean): string {
  for (const p of candidates) {
    try {
      if (existsFn(p)) return p;
    } catch {
      // ignore permission errors and continue probing
    }
  }
  // None of the candidates exist on disk. Return the platform-native
  // first entry so writes go to the canonical location.
  return candidates[0];
}

export interface LMStudioBridgeOptions {
  /** LM Studio server base URL as configured in Nimbalyst (e.g. http://127.0.0.1:1234). */
  baseUrl: string;
  /** Model ids discovered from LM Studio's /v1/models response. */
  modelIds: string[];
  /** Optional human-readable display name for the provider entry. */
  displayName?: string;
}

/**
 * Service that owns the user-level `~/.config/opencode/opencode.json` file.
 *
 * Reads return the parsed config (or null if the file is missing). Writes
 * deep-merge a partial patch into the existing file so we never clobber
 * fields the user authored manually -- OpenCode's schema is broader than
 * what we surface in the panel.
 */
export class OpenCodeConfigService {
  private readonly configPath: string;
  private readonly probedCandidates: string[];

  constructor() {
    this.probedCandidates = resolveOpenCodeConfigCandidates({
      platform: process.platform,
      xdgConfigHome: process.env.XDG_CONFIG_HOME,
      appData: process.env.APPDATA,
      homedir: os.homedir(),
    });
    this.configPath = pickFirstExisting(this.probedCandidates, (p) => fsSync.existsSync(p));
    if (this.probedCandidates.length > 1) {
      logger.ai.info(
        `[OpenCode] config path resolved to ${this.configPath} (probed: ${this.probedCandidates.join(', ')})`
      );
    }
  }

  getConfigPath(): string {
    return this.configPath;
  }

  /**
   * The full list of candidate paths the service considered, in priority
   * order. Used by the settings panel to surface "we looked here but
   * found nothing" diagnostics to the user. See #284.
   */
  getProbedPaths(): string[] {
    return [...this.probedCandidates];
  }

  async readConfig(): Promise<OpenCodeFileConfig | null> {
    try {
      const raw = await fs.readFile(this.configPath, 'utf8');
      const parsed = JSON.parse(raw);
      return (parsed && typeof parsed === 'object') ? parsed as OpenCodeFileConfig : null;
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return null;
      logger.ai.error('[OpenCode] Failed to read config:', error);
      throw error;
    }
  }

  /**
   * Deep-merge a patch into the existing opencode.json. Object values are
   * merged recursively; arrays and primitives are replaced. Removing a key
   * requires passing `null` -- patches with `undefined` are ignored so callers
   * can spread partial updates without erasing untouched fields.
   */
  async mergeConfig(patch: Partial<OpenCodeFileConfig>): Promise<OpenCodeFileConfig> {
    const current = (await this.readConfig()) ?? {};
    const merged = deepMerge(current, patch) as OpenCodeFileConfig;
    if (!merged.$schema) {
      merged.$schema = CONFIG_SCHEMA_URL;
    }
    await this.writeConfigRaw(merged);
    return merged;
  }

  /** Replace the file's contents wholesale. Caller is responsible for the full document. */
  async writeConfig(config: OpenCodeFileConfig): Promise<void> {
    await this.writeConfigRaw(config);
  }

  /**
   * Add or update an OpenCode provider block that bridges to a local LM Studio server.
   * Existing entries under `provider.lmstudio` are preserved -- new model ids are
   * appended, and the baseURL is updated to match the user's current LM Studio config.
   */
  async upsertLMStudioBridge(options: LMStudioBridgeOptions): Promise<OpenCodeFileConfig> {
    const baseURL = normalizeOpenAICompatibleBaseUrl(options.baseUrl);
    const current = (await this.readConfig()) ?? {};
    const provider = { ...(current.provider ?? {}) };
    const existing: OpenCodeFileProvider = provider[LMSTUDIO_PROVIDER_KEY] ?? {};
    const existingModels = existing.models ?? {};

    const models: Record<string, { name?: string }> = { ...existingModels };
    for (const modelId of options.modelIds) {
      if (!modelId) continue;
      if (!models[modelId]) {
        models[modelId] = { name: modelId };
      }
    }

    provider[LMSTUDIO_PROVIDER_KEY] = {
      ...existing,
      name: options.displayName ?? existing.name ?? 'LM Studio (local)',
      npm: existing.npm ?? LMSTUDIO_NPM_PACKAGE,
      options: { ...(existing.options ?? {}), baseURL },
      models,
    };

    return this.mergeConfig({ provider });
  }

  /** Remove the `provider.lmstudio` block entirely. */
  async removeLMStudioBridge(): Promise<OpenCodeFileConfig | null> {
    const current = await this.readConfig();
    if (!current?.provider?.[LMSTUDIO_PROVIDER_KEY]) return current;
    const { [LMSTUDIO_PROVIDER_KEY]: _omit, ...rest } = current.provider;
    const next: OpenCodeFileConfig = { ...current, provider: rest };
    await this.writeConfigRaw(next);
    return next;
  }

  private async writeConfigRaw(config: OpenCodeFileConfig): Promise<void> {
    const dir = path.dirname(this.configPath);
    await fs.mkdir(dir, { recursive: true });
    const serialized = JSON.stringify(config, null, 2) + '\n';
    await fs.writeFile(this.configPath, serialized, 'utf8');
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMerge(target: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) {
      delete out[key];
      continue;
    }
    const existing = out[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      out[key] = deepMerge(existing, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * LM Studio's OpenAI-compatible endpoint lives at `/v1`. Nimbalyst stores the
 * server root (e.g. `http://127.0.0.1:1234`), so we append `/v1` if it's missing.
 */
function normalizeOpenAICompatibleBaseUrl(input: string): string {
  const trimmed = input.replace(/\/+$/, '');
  if (/\/v\d+$/.test(trimmed)) return trimmed;
  return `${trimmed}/v1`;
}
