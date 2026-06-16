/**
 * settingAtomFamily — per-key Jotai atoms backed by the main-process SettingsService.
 *
 * Reads:   useAtomValue(settingAtom('ai.provider.claude'))
 * Writes:  useSetSetting('ai.provider.claude')(newValue)
 *          // or: store.set(settingAtom(key), newValue)  ← writes go to main via IPC
 *
 * Design (see nimbalyst-local/plans/settings-atomwithstorage-rewrite.md):
 *
 *   - Each key has its own atom; mutating one key never touches another. No
 *     spread, no blob merge. This is the structural fix for the NIM-801 /
 *     codex-lost class of bug.
 *
 *   - Hydration is synchronous from the renderer's POV: index.tsx awaits
 *     `settingsGetAll`, then calls `hydrateSettingsAtoms(snapshot)` BEFORE
 *     React mounts. Every component reads `T`, never `T | undefined`.
 *
 *   - Writes are server-authoritative: setting an atom calls
 *     `settingsSet(key, value)` and waits for the `settings:changed`
 *     broadcast to land. The listener (registered once at startup) writes the
 *     new value back into the atom. We do NOT optimistically update locally;
 *     a single write path eliminates the "two updaters racing" failure mode.
 */

import { atom, type WritableAtom } from 'jotai';
import { store } from '@nimbalyst/runtime/store';
import {
  SETTINGS_REGISTRY,
  SETTING_KEYS,
  getDescriptor,
  type SettingKey,
  type SettingValue,
  type SettingsSnapshot,
} from '../../../shared/settings/keys';

/**
 * Sentinel value: route an atom write straight to its internal primitive
 * (skipping IPC). Used by hydration + the broadcast listener. Anything that
 * isn't a DirectSetEnvelope is treated as a user-driven write and forwarded
 * to main via `settingsSet`.
 *
 * Why a sentinel instead of two atom shapes: keeps a single public atom per
 * key, so consumers can both read and write through one entry point and Jotai
 * keeps a single subscription.
 */
const DIRECT_SET = Symbol('settings.directSet');
interface DirectSetEnvelope {
  readonly _kind: typeof DIRECT_SET;
  readonly value: unknown;
}
function isDirectSet(v: unknown): v is DirectSetEnvelope {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as { _kind?: unknown })._kind === DIRECT_SET
  );
}

type SettingsWritableAtom = WritableAtom<unknown, [unknown], Promise<void> | void>;

const atomCache = new Map<SettingKey, SettingsWritableAtom>();

function makeAtomFor(key: SettingKey): SettingsWritableAtom {
  const desc = getDescriptor(key);
  // Initial value = descriptor default. Real value lands in hydrateSettingsAtoms
  // before React mounts, so consumers never observe the default in normal flow.
  const inner = atom<unknown>(desc.defaultValue);
  return atom(
    (get) => get(inner),
    async (_get, set, value: unknown) => {
      if (isDirectSet(value)) {
        // Hydration / broadcast path: write straight to the primitive.
        set(inner, value.value);
        return;
      }
      if (typeof window === 'undefined' || !window.electronAPI?.settingsSet) {
        // Tests / SSR / preload not yet wired: fall back to a local write so
        // tests can drive state without the IPC roundtrip.
        set(inner, value);
        return;
      }
      try {
        await window.electronAPI.settingsSet(key, value);
        // The `settings:changed` broadcast will land asynchronously and
        // update the inner atom via DIRECT_SET. We don't optimistically set
        // here -- if validation rejects on main, the optimistic update would
        // diverge from disk.
      } catch (err) {
        console.error(`[settings] settingsSet(${key}) failed:`, err);
        throw err;
      }
    },
  );
}

/**
 * Get the atom for a given setting key. Stable across calls.
 *
 * Typed so `useAtomValue(settingAtom('ai.showToolCalls'))` is `boolean`,
 * `useAtomValue(settingAtom('ai.provider.claude'))` is `ProviderConfig`, etc.
 */
export function settingAtom<K extends SettingKey>(
  key: K,
): WritableAtom<SettingValue<K>, [SettingValue<K>], Promise<void> | void> {
  let cached = atomCache.get(key);
  if (!cached) {
    cached = makeAtomFor(key);
    atomCache.set(key, cached);
  }
  return cached as WritableAtom<SettingValue<K>, [SettingValue<K>], Promise<void> | void>;
}

/**
 * Seed every atom from the snapshot returned by `settings:getAll`.
 *
 * MUST be called before React mounts. Each write uses the DIRECT_SET sentinel
 * to route the value into the inner atom without bouncing back to main.
 */
export function hydrateSettingsAtoms(snapshot: SettingsSnapshot): void {
  for (const key of SETTING_KEYS) {
    const v = snapshot[key];
    if (v === undefined) continue; // descriptor default already in place
    store.set(settingAtom(key) as SettingsWritableAtom, {
      _kind: DIRECT_SET,
      value: v,
    });
  }
}

let listenerRegistered = false;

/**
 * Extra per-key handlers fired alongside the atom update. Legacy atoms that
 * haven't migrated to `settingAtom(key)` use this to stay in lockstep when
 * another window writes the same key.
 */
const extraHandlers = new Map<SettingKey, Set<(value: unknown) => void>>();

/**
 * Subscribe once to the `settings:changed` broadcast from main. Every
 * broadcast updates the corresponding atom via DIRECT_SET so the renderer
 * stays in lockstep with disk without running its own write pipeline.
 *
 * Idempotent: subsequent calls are no-ops.
 */
export function registerSettingsChangeListener(): void {
  if (listenerRegistered) return;
  if (typeof window === 'undefined' || !window.electronAPI?.onSettingsChanged) return;
  listenerRegistered = true;
  window.electronAPI.onSettingsChanged(({ key, value }) => {
    if (!(key in SETTINGS_REGISTRY)) {
      // Unknown key in broadcast -- main and renderer registries are out of
      // sync (different builds, perhaps). Warn but don't crash.
      console.warn(`[settings] Received broadcast for unknown key: ${key}`);
      return;
    }
    store.set(settingAtom(key as SettingKey) as SettingsWritableAtom, {
      _kind: DIRECT_SET,
      value,
    });
    const handlers = extraHandlers.get(key as SettingKey);
    if (handlers) {
      for (const fn of handlers) {
        try {
          fn(value);
        } catch (err) {
          console.error(`[settings] handler for ${key} threw:`, err);
        }
      }
    }
  });
}

/**
 * Register a callback that fires whenever the given key is broadcast.
 *
 * Used by legacy atom files that have their own state (autoCommit, diffPeek,
 * trackerAutomation, etc.) and need to mirror cross-window writes into that
 * state. Returns an unsubscribe function.
 *
 * Prefer `useSetting(key)` / `settingAtom(key)` for new code -- this exists
 * to give the older atoms lockstep behavior without forcing a wholesale
 * migration of every consumer.
 */
export function onSettingChanged<K extends SettingKey>(
  key: K,
  handler: (value: SettingValue<K>) => void,
): () => void {
  let set = extraHandlers.get(key);
  if (!set) {
    set = new Set();
    extraHandlers.set(key, set);
  }
  const wrapped = handler as (value: unknown) => void;
  set.add(wrapped);
  return () => {
    set?.delete(wrapped);
  };
}
