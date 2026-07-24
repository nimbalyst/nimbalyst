/**
 * Editor Context Store
 *
 * Module-level store for extension-provided editor context.
 * Extensions call host.setEditorContextItems() (or the legacy
 * host.setEditorContext()) to push one or more selected items here. The chat
 * panel renders each item as a removable chip and includes the non-dismissed
 * items' descriptions in the AI prompt.
 *
 * Context is retained per file so mounted background editors cannot overwrite
 * the active tab's selection. A changed set of selected ids resets per-item
 * dismissals; payload-only refreshes preserve them.
 *
 * Uses a useSyncExternalStore-compatible API (subscribe/getSnapshot).
 */

import type { EditorContext, EditorContextItem } from '@nimbalyst/runtime';

/** Well-known id used for the single-item legacy setEditorContext() shim. */
export const LEGACY_SINGLE_ITEM_ID = '__single';

export interface EditorContextEntry {
  filePath: string;
  /** All items pushed by the editor (including dismissed ones). */
  items: EditorContextItem[];
  /** Ids the user has dismissed for the current selection generation. */
  dismissedIds: Set<string>;
  /** Bumped on each push; a change means the selection was replaced. */
  generation: number;
  timestamp: number;
}

// Module-level state
const entriesByFilePath = new Map<string, EditorContextEntry>();
let mostRecentFilePath: string | null = null;
let listeners: Set<() => void> = new Set();
let snapshotVersion = 0;
let generationCounter = 0;

function notify(): void {
  snapshotVersion++;
  listeners.forEach((listener) => listener());
}

function chooseMostRecentRemainingFile(): void {
  const remaining = Array.from(entriesByFilePath.keys());
  mostRecentFilePath = remaining.length > 0 ? remaining[remaining.length - 1] : null;
}

function haveSameItemIds(previous: EditorContextItem[], next: EditorContextItem[]): boolean {
  if (previous.length !== next.length) return false;
  const previousIds = new Set(previous.map((item) => item.id));
  return next.every((item) => previousIds.has(item.id));
}

/**
 * Set the current list of editor context items for a file. Called by TabEditor
 * when the extension calls host.setEditorContextItems(). Passing null/[] clears
 * the context for that file. A changed set of ids resets per-item dismissals;
 * payload-only refreshes for the same ids preserve them.
 */
export function setEditorContextItems(
  filePath: string,
  items: EditorContextItem[] | null
): void {
  if (items && items.length > 0) {
    const previous = entriesByFilePath.get(filePath);
    const selectionChanged = !previous || !haveSameItemIds(previous.items, items);
    entriesByFilePath.set(filePath, {
      filePath,
      items,
      dismissedIds: selectionChanged ? new Set() : new Set(previous.dismissedIds),
      generation: ++generationCounter,
      timestamp: Date.now(),
    });
    mostRecentFilePath = filePath;
  } else if (entriesByFilePath.has(filePath)) {
    entriesByFilePath.delete(filePath);
    if (mostRecentFilePath === filePath) chooseMostRecentRemainingFile();
  } else {
    return;
  }
  notify();
}

/**
 * Legacy single-item API. Maps to a one-item list so existing extensions that
 * call host.setEditorContext() keep working and now reach the prompt.
 */
export function setEditorContext(filePath: string, context: EditorContext | null): void {
  if (context) {
    setEditorContextItems(filePath, [
      {
        id: LEGACY_SINGLE_ITEM_ID,
        label: context.label,
        description: context.description,
      },
    ]);
  } else {
    setEditorContextItems(filePath, null);
  }
}

/**
 * Clear editor context for a specific file (e.g., when tab closes).
 */
export function clearEditorContext(filePath: string): void {
  if (entriesByFilePath.delete(filePath)) {
    if (mostRecentFilePath === filePath) chooseMostRecentRemainingFile();
    notify();
  }
}

/**
 * Dismiss a single item so it is not sent to the model. Reversible until the
 * selection changes (a new push clears dismissals).
 */
export function dismissEditorContextItem(id: string, filePath?: string): void {
  const entry = getEditorContextEntry(filePath);
  if (!entry || entry.dismissedIds.has(id)) return;
  const dismissedIds = new Set(entry.dismissedIds);
  dismissedIds.add(id);
  entriesByFilePath.set(entry.filePath, { ...entry, dismissedIds });
  notify();
}

/** Restore a previously dismissed item. */
export function restoreEditorContextItem(id: string, filePath?: string): void {
  const entry = getEditorContextEntry(filePath);
  if (!entry || !entry.dismissedIds.has(id)) return;
  const dismissedIds = new Set(entry.dismissedIds);
  dismissedIds.delete(id);
  entriesByFilePath.set(entry.filePath, { ...entry, dismissedIds });
  notify();
}

/**
 * Get the current editor context entry (all items + dismissal state).
 */
export function getEditorContextEntry(filePath?: string): EditorContextEntry | null {
  if (filePath) return entriesByFilePath.get(filePath) ?? null;
  return mostRecentFilePath ? entriesByFilePath.get(mostRecentFilePath) ?? null : null;
}

/** Return the non-dismissed items for a file at message-send time. */
export function getActiveEditorContextItems(filePath: string): EditorContextItem[] | undefined {
  const entry = getEditorContextEntry(filePath);
  if (!entry) return undefined;
  const activeItems = entry.items.filter((item) => !entry.dismissedIds.has(item.id));
  return activeItems.length > 0 ? activeItems : undefined;
}

/**
 * Subscribe to editor context changes (useSyncExternalStore compatible).
 */
export function subscribeEditorContext(callback: () => void): () => void {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

/**
 * Get snapshot version (useSyncExternalStore compatible).
 */
export function getEditorContextSnapshot(): number {
  return snapshotVersion;
}
