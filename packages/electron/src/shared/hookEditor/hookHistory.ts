/**
 * Undo and redo for one hook editor tab. Every document in the history writes
 * onto the same base: the text on disk now. After a save the base moves to the
 * saved text, and the undo steps stay.
 */

import type { HookDocument, PausedHook } from './hookDocument';
import { writeDocument, type WriteBase } from './hookWriter';

export interface TabHistory {
  past: readonly HookDocument[];
  present: HookDocument;
  future: readonly HookDocument[];
  /** The text and scripts on disk now. */
  base: WriteBase;
  /** The paused list saved beside the file, as text so two lists compare by what they hold. */
  savedPaused: string;
}

export function startHistory(document: HookDocument, base: WriteBase): TabHistory {
  return { past: [], present: document, future: [], base, savedPaused: JSON.stringify(document.paused) };
}

/** Adds a step. A refused edit gives back the same document, so it adds nothing. */
export function record(history: TabHistory, document: HookDocument): TabHistory {
  if (document === history.present) return history;
  return { ...history, past: [...history.past, history.present], present: document, future: [] };
}

export function undo(history: TabHistory): TabHistory {
  if (history.past.length === 0) return history;
  return {
    ...history,
    past: history.past.slice(0, -1),
    present: history.past[history.past.length - 1],
    future: [history.present, ...history.future],
  };
}

export function redo(history: TabHistory): TabHistory {
  if (history.future.length === 0) return history;
  return {
    ...history,
    past: [...history.past, history.present],
    present: history.future[0],
    future: history.future.slice(1),
  };
}

/**
 * After a save, the saved text and scripts become the base, and the saved paused list
 * becomes the one to compare with. Without a list, the paused list on screen counts as saved.
 */
export function markSaved(history: TabHistory, base: WriteBase, savedPaused: readonly PausedHook[] = history.present.paused): TabHistory {
  return { ...history, base, savedPaused: JSON.stringify(savedPaused) };
}

/** True when the file text, a script or the paused list differs from what was last opened or saved. */
export function hasUnsavedChanges(history: TabHistory): boolean {
  const written = writeDocument(history.base, history.present);
  return (
    written.text !== history.base.text ||
    written.scriptWrites.length > 0 ||
    JSON.stringify(history.present.paused) !== history.savedPaused
  );
}
