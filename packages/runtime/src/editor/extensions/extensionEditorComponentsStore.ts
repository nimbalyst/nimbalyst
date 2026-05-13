/**
 * Registry of React components that need to mount inside every editor's
 * Lexical context. Editor.tsx iterates the store and renders each entry so
 * the renderer (or any platform integration) can contribute headful
 * Lexical plugins -- typeahead menus, dialog hosts, focus trackers --
 * without depending on the deleted `PluginManager` / `PluginRegistry`.
 *
 * Each entry is identified by a stable name so callers can deregister or
 * overwrite their contribution without affecting unrelated entries. The
 * store preserves insertion order so toolbar-style plugins keep a
 * deterministic mount sequence.
 */

import { useSyncExternalStore } from 'react';
import type { ComponentType } from 'react';

export interface ExtensionEditorComponentEntry {
  /** Stable, human-readable identifier; collisions overwrite. */
  name: string;
  /** Component rendered inside `<LexicalExtensionComposer>`. */
  Component: ComponentType<unknown>;
}

const entries = new Map<string, ExtensionEditorComponentEntry>();
const listeners = new Set<() => void>();

let snapshot: ReadonlyArray<ExtensionEditorComponentEntry> = Object.freeze([]);

function rebuildSnapshot(): void {
  snapshot = Object.freeze(Array.from(entries.values()));
}

function emit(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch (err) {
      console.error('[extensionEditorComponentsStore] listener threw', err);
    }
  }
}

export function registerExtensionEditorComponent(
  entry: ExtensionEditorComponentEntry,
): void {
  entries.set(entry.name, entry);
  rebuildSnapshot();
  emit();
}

export function unregisterExtensionEditorComponent(name: string): void {
  if (!entries.delete(name)) return;
  rebuildSnapshot();
  emit();
}

export function getExtensionEditorComponents(): ReadonlyArray<ExtensionEditorComponentEntry> {
  return snapshot;
}

export function subscribeToExtensionEditorComponents(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useExtensionEditorComponents(): ReadonlyArray<ExtensionEditorComponentEntry> {
  return useSyncExternalStore(
    subscribeToExtensionEditorComponents,
    getExtensionEditorComponents,
    getExtensionEditorComponents,
  );
}
