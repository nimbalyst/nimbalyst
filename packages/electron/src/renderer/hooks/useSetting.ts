/**
 * React hooks for reading and writing flat-key settings.
 *
 * Usage:
 *   const showToolCalls = useSetting('ai.showToolCalls');           // boolean
 *   const setShowToolCalls = useSetSetting('ai.showToolCalls');     // (b: boolean) => Promise<void>
 *   const [claudeCfg, setClaudeCfg] = useSettingState('ai.provider.claude');
 *
 * The hook signature is fully typed off the key: `useSetting('ai.provider.claude')`
 * is `ProviderConfig`, etc. See packages/electron/src/shared/settings/keys.ts
 * for the registry.
 */

import { useAtomValue, useSetAtom, useAtom } from 'jotai';
import { settingAtom } from '../store/atoms/settingAtomFamily';
import type { SettingKey, SettingValue } from '../../shared/settings/keys';

/**
 * Read a single setting. Subscribes to the atom -- the component re-renders
 * only when THIS key changes (not when any other setting changes).
 */
export function useSetting<K extends SettingKey>(key: K): SettingValue<K> {
  return useAtomValue(settingAtom(key));
}

/**
 * Get a setter for a single setting. The returned function writes through
 * main (`settings:set`), and the broadcast updates the atom on success.
 */
export function useSetSetting<K extends SettingKey>(
  key: K,
): (value: SettingValue<K>) => Promise<void> {
  const setter = useSetAtom(settingAtom(key));
  return setter as (value: SettingValue<K>) => Promise<void>;
}

/**
 * `[value, setValue]` tuple, like useState. Convenient for form controls
 * that read and write the same key.
 */
export function useSettingState<K extends SettingKey>(
  key: K,
): [SettingValue<K>, (value: SettingValue<K>) => Promise<void>] {
  const [value, set] = useAtom(settingAtom(key));
  return [value, set as (v: SettingValue<K>) => Promise<void>];
}
