/**
 * Settings Key Registry
 *
 * Central registry of all flat-key settings managed by the SettingsService.
 * Every setting that the renderer can read or write goes through this registry.
 *
 * The two invariants this registry enforces:
 *   1. Per-key reads/writes never affect other keys (no spread, no blob merge).
 *   2. Adding a new setting is one line in this file: declare key + Zod schema.
 *      Type inference + the SettingsService picks it up automatically.
 *
 * Storage backing for each key is described by `storage`:
 *   - `store`: the electron-store instance name (e.g. 'ai-settings', 'app-settings')
 *   - `path`: the dot-notation path inside that store
 *
 * This indirection lets us keep existing on-disk shapes intact during the
 * migration -- a key like `ai.provider.claude` maps to `providerSettings.claude`
 * in `ai-settings.json`, so existing main-process code that reads
 * `aiStore.get('providerSettings.claude')` keeps working unchanged.
 */

import { z } from 'zod';

// ---------- Reusable schemas ----------

const ProviderTestStatusSchema = z.enum(['idle', 'testing', 'success', 'error']).optional();
const InstallStatusSchema = z.enum(['not-installed', 'installing', 'installed', 'error']).optional();

export const ProviderConfigSchema = z.object({
  enabled: z.boolean(),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  models: z.array(z.string()).optional(),
  testStatus: ProviderTestStatusSchema,
  testMessage: z.string().optional(),
  installed: z.boolean().optional(),
  version: z.string().optional(),
  updateAvailable: z.boolean().optional(),
  installStatus: InstallStatusSchema,
  authMethod: z.string().optional(),
}).passthrough();

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

// ---------- The key registry ----------

/**
 * Where a key lives on disk.
 *
 * `store` is the electron-store instance name. SettingsService keeps a Map of
 * Store instances keyed by name.
 *
 * `path` is the dot-notation path inside that store. electron-store supports
 * dot-notation natively for both get and set.
 */
export interface SettingStorage {
  store: 'ai-settings' | 'app-settings';
  path: string;
}

interface SettingDescriptor<S extends z.ZodTypeAny> {
  schema: S;
  storage: SettingStorage;
  /** Optional default. Used by getAll when the key is absent on disk. */
  defaultValue?: z.infer<S>;
}

function setting<S extends z.ZodTypeAny>(
  schema: S,
  storage: SettingStorage,
  defaultValue?: z.infer<S>,
): SettingDescriptor<S> {
  return { schema, storage, defaultValue };
}

/**
 * The full settings registry. Add new settings here.
 *
 * Naming convention: `<domain>.<subdomain>.<id>` (lowercase, dot-separated).
 * Domains we have so far:
 *   - ai.provider.<id>  -- per-provider config (enabled, models, baseUrl, ...)
 *   - ai.apiKey.<name>  -- per-provider API key (string, may be empty)
 *   - ai.defaultProvider, ai.showToolCalls, ai.chatShowToolCalls,
 *     ai.collapseIntermediateProgress, ai.aiDebugLogging, ai.showPromptAdditions,
 *     ai.customClaudeCodePath, ai.autoCommitEnabled,
 *     ai.trackerAutomation, ai.diffPeekSize
 */
export const SETTINGS_REGISTRY = {
  // ---- AI providers (per-key) ----
  'ai.provider.claude': setting(
    ProviderConfigSchema,
    { store: 'ai-settings', path: 'providerSettings.claude' },
    { enabled: false, testStatus: 'idle' },
  ),
  'ai.provider.claude-code': setting(
    ProviderConfigSchema,
    { store: 'ai-settings', path: 'providerSettings.claude-code' },
    { enabled: true, testStatus: 'idle', installStatus: 'not-installed' },
  ),
  'ai.provider.openai': setting(
    ProviderConfigSchema,
    { store: 'ai-settings', path: 'providerSettings.openai' },
    { enabled: false, testStatus: 'idle' },
  ),
  'ai.provider.openai-codex': setting(
    ProviderConfigSchema,
    { store: 'ai-settings', path: 'providerSettings.openai-codex' },
    { enabled: false, testStatus: 'idle', installStatus: 'not-installed' },
  ),
  'ai.provider.openai-codex-acp': setting(
    ProviderConfigSchema,
    { store: 'ai-settings', path: 'providerSettings.openai-codex-acp' },
    { enabled: false, testStatus: 'idle', installStatus: 'not-installed' },
  ),
  'ai.provider.opencode': setting(
    ProviderConfigSchema,
    { store: 'ai-settings', path: 'providerSettings.opencode' },
    { enabled: false, testStatus: 'idle', installStatus: 'not-installed' },
  ),
  'ai.provider.copilot-cli': setting(
    ProviderConfigSchema,
    { store: 'ai-settings', path: 'providerSettings.copilot-cli' },
    { enabled: false, testStatus: 'idle', installStatus: 'not-installed' },
  ),
  'ai.provider.lmstudio': setting(
    ProviderConfigSchema,
    { store: 'ai-settings', path: 'providerSettings.lmstudio' },
    { enabled: false, baseUrl: 'http://127.0.0.1:8234', testStatus: 'idle' },
  ),

  // ---- API keys (per-key) ----
  'ai.apiKey.anthropic': setting(
    z.string(),
    { store: 'ai-settings', path: 'apiKeys.anthropic' },
    '',
  ),
  'ai.apiKey.claude-code': setting(
    z.string(),
    { store: 'ai-settings', path: 'apiKeys.claude-code' },
    '',
  ),
  'ai.apiKey.openai': setting(
    z.string(),
    { store: 'ai-settings', path: 'apiKeys.openai' },
    '',
  ),
  'ai.apiKey.openai-codex': setting(
    z.string(),
    { store: 'ai-settings', path: 'apiKeys.openai-codex' },
    '',
  ),
  // OpenCode's API key is optional (only used by Nimbalyst's connection test);
  // the panel still lets the user enter one, so it needs a registry entry or the
  // per-key flush would be rejected as an unknown key. See OpenCodePanel.tsx.
  'ai.apiKey.opencode': setting(
    z.string(),
    { store: 'ai-settings', path: 'apiKeys.opencode' },
    '',
  ),
  'ai.apiKey.lmstudio_url': setting(
    z.string(),
    { store: 'ai-settings', path: 'apiKeys.lmstudio_url' },
    'http://127.0.0.1:8234',
  ),

  // ---- Other AI-domain settings ----
  'ai.defaultProvider': setting(
    z.string(),
    { store: 'ai-settings', path: 'defaultProvider' },
    'claude-code',
  ),
  'ai.showToolCalls': setting(
    z.boolean(),
    { store: 'ai-settings', path: 'showToolCalls' },
    false,
  ),
  'ai.chatShowToolCalls': setting(
    z.boolean(),
    { store: 'ai-settings', path: 'chatShowToolCalls' },
    true,
  ),
  'ai.collapseIntermediateProgress': setting(
    z.boolean(),
    { store: 'ai-settings', path: 'collapseIntermediateProgress' },
    false,
  ),
  'ai.aiDebugLogging': setting(
    z.boolean(),
    { store: 'ai-settings', path: 'aiDebugLogging' },
    false,
  ),
  'ai.showPromptAdditions': setting(
    z.boolean(),
    { store: 'ai-settings', path: 'showPromptAdditions' },
    false,
  ),
  'ai.customClaudeCodePath': setting(
    z.string(),
    { store: 'ai-settings', path: 'customClaudeCodePath' },
    '',
  ),
  'ai.autoCommitEnabled': setting(
    z.boolean(),
    { store: 'ai-settings', path: 'autoCommitEnabled' },
    false,
  ),
  'ai.trackerAutomation': setting(
    z.object({
      enabled: z.boolean(),
      autoCloseOnCommit: z.boolean(),
    }).passthrough(),
    { store: 'ai-settings', path: 'trackerAutomation' },
    { enabled: false, autoCloseOnCommit: true },
  ),
  'ai.diffPeekSize': setting(
    z.object({ width: z.number(), height: z.number() }).nullable(),
    { store: 'ai-settings', path: 'diffPeekSize' },
    null,
  ),
  'ai.showUsageIndicator': setting(
    z.boolean(),
    { store: 'ai-settings', path: 'showUsageIndicator' },
    true,
  ),
  'ai.showCodexUsageIndicator': setting(
    z.boolean(),
    { store: 'ai-settings', path: 'showCodexUsageIndicator' },
    true,
  ),
  'ai.showGeminiUsageIndicator': setting(
    z.boolean(),
    { store: 'ai-settings', path: 'showGeminiUsageIndicator' },
    true,
  ),
} as const;

export type SettingKey = keyof typeof SETTINGS_REGISTRY;
export type SettingValue<K extends SettingKey> = z.infer<typeof SETTINGS_REGISTRY[K]['schema']>;

export const SETTING_KEYS = Object.keys(SETTINGS_REGISTRY) as SettingKey[];

export function isSettingKey(key: string): key is SettingKey {
  return key in SETTINGS_REGISTRY;
}

export function getDescriptor<K extends SettingKey>(key: K): SettingDescriptor<typeof SETTINGS_REGISTRY[K]['schema']> {
  const d = SETTINGS_REGISTRY[key];
  if (!d) throw new Error(`Unknown setting key: ${key}`);
  return d as SettingDescriptor<typeof SETTINGS_REGISTRY[K]['schema']>;
}

/**
 * Snapshot type used by `settings:getAll` IPC.
 *
 * `unknown` here is intentional: this crosses the IPC boundary, the renderer
 * narrows per-key via the SettingValue<K> type when it pulls from the snapshot.
 */
export type SettingsSnapshot = Partial<Record<SettingKey, unknown>>;
