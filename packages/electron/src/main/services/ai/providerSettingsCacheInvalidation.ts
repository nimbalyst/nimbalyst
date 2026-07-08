/**
 * Provider-settings cache invalidation wiring.
 *
 * AIService memoizes the normalized provider settings in
 * `cachedNormalizedProviderSettings`. The legacy `ai:saveSettings` IPC handler
 * nulls that cache inline after writing, but the renderer settings panels
 * persist provider toggles through the per-key path
 * (`settingsSet('ai.provider.<id>', config)` -> SettingsService), which never
 * touched AIService's cache. The result: disabling a provider (e.g. the Claude
 * Code CLI enable toggle) wrote `enabled:false` to disk but `ai:getModels` kept
 * returning the stale `enabled:true` snapshot until the next restart.
 *
 * This module wires AIService to SettingsService's in-process subscription so
 * any `ai.provider.*` change invalidates the cache immediately.
 */

/** Minimal shape of SettingsService needed for cache invalidation. */
type SettingsServiceLike = {
  subscribe: (fn: (key: string, value: unknown) => void) => () => void;
};

/** True for any per-provider config key (`ai.provider.<id>`). */
export function isProviderSettingsKey(key: string): boolean {
  return key.startsWith('ai.provider.');
}

/**
 * Fire `onProviderSettingsChanged` whenever any `ai.provider.*` setting changes
 * through SettingsService. Returns an unsubscribe function.
 */
export function subscribeProviderSettingsInvalidation(
  settingsService: SettingsServiceLike,
  onProviderSettingsChanged: (key: string) => void,
): () => void {
  return settingsService.subscribe((key) => {
    if (isProviderSettingsKey(key)) {
      onProviderSettingsChanged(key);
    }
  });
}
