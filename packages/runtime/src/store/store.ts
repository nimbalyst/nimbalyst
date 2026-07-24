/**
 * Jotai Store Instance
 *
 * Shared store for cross-platform state management.
 * Used by both Electron and Capacitor (mobile) apps.
 *
 * Usage in React components:
 *   const [value, setValue] = useAtom(someAtom);
 *
 * Usage outside React (services, IPC handlers):
 *   import { store } from '@nimbalyst/runtime/store';
 *   store.get(someAtom);
 *   store.set(someAtom, value);
 *   store.sub(someAtom, () => { ... });
 */

import { createStore } from 'jotai';

/**
 * The default store instance.
 * Each window/app gets its own store (Electron windows are separate processes).
 */
export const store = createStore();

/**
 * Type-safe store accessor for use outside React.
 * Prefer useAtom/useAtomValue/useSetAtom in React components.
 */
export function getStore() {
  return store;
}
