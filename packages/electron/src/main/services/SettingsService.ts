/**
 * SettingsService — main-process authority for flat-key settings.
 *
 * Architecture (see nimbalyst-local/plans/settings-atomwithstorage-rewrite.md):
 *   - Main owns the truth: every settings read/write goes through this service.
 *   - Per-key API: `get(key)`, `set(key, value)`, `delete(key)`.
 *   - On every mutation, broadcast `settings:changed` `{key, value}` to every
 *     BrowserWindow so all renderers stay in lockstep without their own
 *     persistence pipelines.
 *
 * Why this exists: the old AI settings pipeline ("renderer holds a blob, sends
 * it to main, main spreads it over the stored blob") repeatedly lost
 * unrelated keys whenever one path's view of the blob was stale. The fix is
 * structural: never send blobs. Each key is its own write.
 *
 * Storage backing: each key in the registry declares its `store` name +
 * dot-notation `path`. Reads/writes go through the matching electron-store
 * instance, which preserves the existing on-disk shape during the migration
 * (so legacy code that reads `aiStore.get('providerSettings.claude')` keeps
 * working unchanged while the renderer talks only to this service).
 */

import Store from 'electron-store';
import { BrowserWindow } from 'electron';
import {
  SETTINGS_REGISTRY,
  SETTING_KEYS,
  getDescriptor,
  isSettingKey,
  type SettingKey,
  type SettingValue,
  type SettingsSnapshot,
  type SettingStorage,
} from '../../shared/settings/keys';
import { logger } from '../utils/logger';

/**
 * Providers that use dynamic model discovery -- their `models` field must
 * never be persisted (the API is the source of truth, a stale list would
 * outlive the user's actual entitlements). Kept here as a local constant so
 * SettingsService doesn't have to import runtime utilities.
 */
const DYNAMIC_MODEL_PROVIDERS = new Set(['openai-codex', 'copilot-cli']);

/**
 * Strip fields that must never reach disk from a provider config:
 *   - `testStatus` / `testMessage`: renderer-only UI state for the
 *     "Test connection" flow. A persisted `testStatus: 'testing'` would
 *     render every future session as mid-test until the user clicked again.
 *   - `models` (for dynamic-model providers): see DYNAMIC_MODEL_PROVIDERS.
 *
 * This runs at the SettingsService boundary so even a future `useSetting()`
 * call that hands us a polluted object can't end up persisting transient state.
 * The renderer keeps transient fields in its own atoms; the broadcast bridge
 * preserves them across broadcasts (see appSettings.ts).
 */
function sanitizeProviderConfig(key: SettingKey, value: unknown): unknown {
  if (!key.startsWith('ai.provider.')) return value;
  if (!value || typeof value !== 'object') return value;
  const providerId = key.slice('ai.provider.'.length);
  const v = value as Record<string, unknown>;
  const stripModels = DYNAMIC_MODEL_PROVIDERS.has(providerId) && 'models' in v;
  const stripTransient = 'testStatus' in v || 'testMessage' in v;
  if (!stripModels && !stripTransient) return value;
  const { testStatus: _ts, testMessage: _tm, models, ...rest } = v;
  return stripModels ? rest : { ...rest, models };
}

type Subscriber = (key: SettingKey, value: unknown) => void;

class SettingsServiceImpl {
  private stores = new Map<SettingStorage['store'], Store<Record<string, unknown>>>();
  private subscribers = new Set<Subscriber>();
  private initialized = false;

  private getStore(name: SettingStorage['store']): Store<Record<string, unknown>> {
    let s = this.stores.get(name);
    if (!s) {
      s = new Store<Record<string, unknown>>({ name });
      this.stores.set(name, s);
    }
    return s;
  }

  /**
   * Lazy init -- no-op idempotent. Called from get/set so callers don't have to
   * coordinate startup ordering. The first call opens the backing stores; later
   * calls are free.
   */
  init(): void {
    if (this.initialized) return;
    // Touch each unique store so we fail-fast at startup if any can't open,
    // and so the stores Map is populated before broadcast/getAll runs.
    const seen = new Set<SettingStorage['store']>();
    for (const key of SETTING_KEYS) {
      const { storage } = getDescriptor(key);
      if (!seen.has(storage.store)) {
        seen.add(storage.store);
        this.getStore(storage.store);
      }
    }
    this.initialized = true;
  }

  /**
   * Read a single value. Returns the descriptor's default when the key is
   * absent on disk; throws on schema mismatch (loud, not silent).
   */
  get<K extends SettingKey>(key: K): SettingValue<K> {
    this.init();
    const desc = getDescriptor(key);
    const raw = this.getStore(desc.storage.store).get(desc.storage.path);
    if (raw === undefined || raw === null) {
      // null is intentional for diffPeekSize-style nullable values, but only
      // when the schema accepts null. The fallback to default covers the
      // common "key never written" case.
      if (raw === null) {
        const parsed = desc.schema.safeParse(null);
        if (parsed.success) return parsed.data as SettingValue<K>;
      }
      return (desc.defaultValue as SettingValue<K>);
    }
    const parsed = desc.schema.safeParse(raw);
    if (!parsed.success) {
      // Defensive: don't crash the app over malformed disk state -- fall back
      // to the default and log loudly so the corruption is visible.
      logger.main?.error?.(
        `[SettingsService] Schema validation failed for ${key}; using default.`,
        parsed.error.issues,
      );
      return (desc.defaultValue as SettingValue<K>);
    }
    return parsed.data as SettingValue<K>;
  }

  /**
   * Write a single value. Validates against the per-key Zod schema first so
   * bad payloads from the renderer can't reach disk. Broadcasts `settings:changed`
   * to every window after a successful write.
   */
  set<K extends SettingKey>(key: K, value: SettingValue<K>): void {
    this.init();
    const desc = getDescriptor(key);
    const parsed = desc.schema.safeParse(value);
    if (!parsed.success) {
      throw new Error(
        `[SettingsService] Refused to set ${key}: schema validation failed: ${parsed.error.message}`,
      );
    }
    // Strip transient / dynamic-model fields at the boundary so disk and the
    // broadcast both reflect the persisted truth, not whatever transient UI
    // state the caller happened to send. See sanitizeProviderConfig.
    const sanitized = sanitizeProviderConfig(key, parsed.data);
    this.getStore(desc.storage.store).set(desc.storage.path, sanitized);
    this.notify(key, sanitized);
  }

  /**
   * Delete a single key (reverts to default on next read).
   */
  delete<K extends SettingKey>(key: K): void {
    this.init();
    const desc = getDescriptor(key);
    this.getStore(desc.storage.store).delete(desc.storage.path as any);
    // Broadcast the post-delete value (= default) so renderers update their
    // atoms to the default in lockstep.
    const next = this.get(key);
    this.notify(key, next);
  }

  /**
   * Read every registered key into one flat snapshot. Used by the renderer at
   * startup to seed every atom synchronously before React mounts.
   */
  getAll(): SettingsSnapshot {
    this.init();
    const out: SettingsSnapshot = {};
    for (const key of SETTING_KEYS) {
      out[key] = this.get(key);
    }
    return out;
  }

  /**
   * Subscribe to settings changes (in-process). The IPC broadcast is separate;
   * this exists so main-process services can react to renderer-driven changes
   * without polling.
   */
  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  /**
   * Internal: announce a change to every window + every in-process subscriber.
   *
   * We use `webContents.send` for each window rather than a single broadcast
   * channel because Electron has no native broadcast and `webContents` is the
   * natural per-window send target. Empty windows array (no UI yet) is fine --
   * the renderer will pull the latest via getAll() on mount.
   */
  private notify(key: SettingKey, value: unknown): void {
    for (const fn of this.subscribers) {
      try {
        fn(key, value);
      } catch (err) {
        logger.main?.error?.(`[SettingsService] subscriber threw for ${key}`, err);
      }
    }
    const payload = { key, value };
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      win.webContents.send('settings:changed', payload);
    }
  }
}

let _instance: SettingsServiceImpl | null = null;

/**
 * Singleton accessor. SettingsService has no per-window state and is safe
 * across IPC handlers, MCP servers, and other main-process callers.
 */
export function getSettingsService(): SettingsServiceImpl {
  if (!_instance) _instance = new SettingsServiceImpl();
  return _instance;
}

export type { SettingKey, SettingValue, SettingsSnapshot };
export { isSettingKey };
