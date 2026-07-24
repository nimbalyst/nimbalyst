/**
 * In-process registry of `LexicalExtension` instances contributed outside
 * of `NimbalystEditorExtensions.ts`'s built-in dependency list. Used both
 * by the renderer-side extension bridge (which publishes contributions
 * loaded from on-disk Nimbalyst extensions) and by app-level plugins like
 * the tracker that need to attach a node class without forking the editor
 * shell.
 *
 * Each contributor is keyed by a stable name so individual sources can
 * publish, replace, or remove their entry without disturbing other
 * contributors. The merged snapshot is the flattened concatenation of
 * each source's contributions in insertion order. `NimbalystEditor`
 * subscribes via the React hook and rebuilds when the merged array
 * reference changes (per the Phase 7 decision: enabling/disabling an
 * extension rebuilds the editor).
 */

import { useSyncExternalStore } from 'react';
import type { AnyLexicalExtensionArgument } from 'lexical';

const DEFAULT_SOURCE = '@nimbalyst/extension-loader/contributions';

const entries = new Map<string, readonly AnyLexicalExtensionArgument[]>();
const listeners = new Set<() => void>();

const EMPTY: readonly AnyLexicalExtensionArgument[] = Object.freeze([]);
let snapshot: readonly AnyLexicalExtensionArgument[] = EMPTY;

function rebuildSnapshot(): void {
  if (entries.size === 0) {
    snapshot = EMPTY;
    return;
  }
  const merged: AnyLexicalExtensionArgument[] = [];
  for (const arr of entries.values()) {
    for (const ext of arr) merged.push(ext);
  }
  snapshot = merged.length === 0 ? EMPTY : Object.freeze(merged);
}

function emit(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch (err) {
      console.error('[extensionLexicalExtensionsStore] listener threw', err);
    }
  }
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

/**
 * Publish (or replace) the Lexical extension associated with the given
 * source name. Pass `undefined` to remove the contribution.
 */
export function setExtensionLexicalExtension(
  name: string,
  extension: AnyLexicalExtensionArgument | undefined,
): void {
  if (extension === undefined) {
    if (!entries.has(name)) return;
    entries.delete(name);
  } else {
    const existing = entries.get(name);
    if (existing && existing.length === 1 && existing[0] === extension) {
      return;
    }
    entries.set(name, Object.freeze([extension]));
  }
  rebuildSnapshot();
  emit();
}

/**
 * Replace the entire contribution under `sourceName` with the given
 * extensions array. Used by the renderer extension bridge to publish the
 * loader's complete output. Each call overwrites the prior contribution
 * for that source.
 */
export function setExtensionLexicalExtensions(
  next: readonly AnyLexicalExtensionArgument[],
  sourceName: string = DEFAULT_SOURCE,
): void {
  const existing = entries.get(sourceName);
  if (next.length === 0) {
    if (!existing) return;
    entries.delete(sourceName);
    rebuildSnapshot();
    emit();
    return;
  }
  if (existing && shallowEqualArrays(existing, next)) {
    return;
  }
  entries.set(sourceName, Object.freeze([...next]));
  rebuildSnapshot();
  emit();
}

export function getExtensionLexicalExtensions(): readonly AnyLexicalExtensionArgument[] {
  return snapshot;
}

export function subscribeToExtensionLexicalExtensions(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Subscribe to the current set of extension-contributed Lexical
 * extensions. Snapshot reference changes when any contributor publishes
 * or removes their entry, so `useMemo` keyed on the snapshot rebuilds the
 * editor.
 */
export function useExtensionLexicalExtensions(): readonly AnyLexicalExtensionArgument[] {
  return useSyncExternalStore(
    subscribeToExtensionLexicalExtensions,
    getExtensionLexicalExtensions,
    getExtensionLexicalExtensions,
  );
}
