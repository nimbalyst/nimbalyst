/**
 * In-process store of `LexicalExtension` contributions from Nimbalyst
 * extensions. Decoupled from the extension loader so callers in
 * `NimbalystEditor` can subscribe without depending on the loader
 * directly. The bridge (`packages/electron/src/renderer/extensions/
 * ExtensionPluginBridge.ts`) is the sole writer.
 *
 * The store is module-scoped because the extension graph is global to the
 * Nimbalyst window -- every editor instance sees the same extension set,
 * and toggling an extension on or off should rebuild every open editor.
 *
 * Phase 7.6 of the upgrade plan.
 */

import { useSyncExternalStore } from 'react';
import type { AnyLexicalExtensionArgument } from 'lexical';

const EMPTY: readonly AnyLexicalExtensionArgument[] = Object.freeze([]);
let currentExtensions: readonly AnyLexicalExtensionArgument[] = EMPTY;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch (err) {
      console.error('[extensionLexicalExtensionsStore] listener threw', err);
    }
  }
}

/**
 * Replace the current set of extension-contributed Lexical extensions.
 *
 * Skips the emit when the new array is reference-equal OR shallow-equal
 * (same length and pointwise reference-equal entries) to the current
 * value, so the bridge can republish on every loader-change tick without
 * forcing the editor to rebuild when nothing has actually changed.
 */
export function setExtensionLexicalExtensions(
  next: readonly AnyLexicalExtensionArgument[],
): void {
  if (next === currentExtensions) return;
  if (shallowEqualArrays(next, currentExtensions)) return;
  currentExtensions = next.length === 0 ? EMPTY : next;
  emit();
}

function shallowEqualArrays(
  a: readonly AnyLexicalExtensionArgument[],
  b: readonly AnyLexicalExtensionArgument[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function getExtensionLexicalExtensions(): readonly AnyLexicalExtensionArgument[] {
  return currentExtensions;
}

/**
 * Subscribe to publications. Returns an unsubscribe function. Primarily
 * intended for the React hook and host tests; production consumers should
 * read through `useExtensionLexicalExtensions`.
 */
export function subscribeToExtensionLexicalExtensions(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Subscribe to the current set of extension-contributed Lexical
 * extensions. Snapshot reference changes when the bridge publishes a new
 * list, so `useMemo` keyed on the snapshot rebuilds the editor.
 */
export function useExtensionLexicalExtensions(): readonly AnyLexicalExtensionArgument[] {
  return useSyncExternalStore(
    subscribeToExtensionLexicalExtensions,
    getExtensionLexicalExtensions,
    getExtensionLexicalExtensions,
  );
}
