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
 *   import { store } from './index';
 *   store.get(someAtom);
 *   store.set(someAtom, value);
 *   store.sub(someAtom, () => { ... });
 */
/**
 * The default store instance.
 * Each window/app gets its own store (Electron windows are separate processes).
 */
export declare const store: import("jotai/vanilla/internals").INTERNAL_Store;
/**
 * Type-safe store accessor for use outside React.
 * Prefer useAtom/useAtomValue/useSetAtom in React components.
 */
export declare function getStore(): import("jotai/vanilla/internals").INTERNAL_Store;
