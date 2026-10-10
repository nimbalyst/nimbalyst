/**
 * A tab's own Back and Forward, for tabs that navigate in place (Pages). Pure:
 * `TabsContext` applies a step to the tab, these functions only decide it.
 * History lives on the tab in memory; it does not survive a restart.
 */

export interface TabHistoryEntry {
  filePath: string;
  fileName: string;
}

export interface TabHistory {
  back: TabHistoryEntry[];
  forward: TabHistoryEntry[];
}

/** Older entries drop off past this, per direction. */
export const MAX_TAB_HISTORY = 50;

/** The history after leaving `from` for a new page: `from` joins Back, Forward empties. */
export function pushTabHistory(history: TabHistory | undefined, from: TabHistoryEntry): TabHistory {
  const back = [...(history?.back ?? []), from];
  return { back: back.slice(-MAX_TAB_HISTORY), forward: [] };
}

/**
 * One step Back (-1) or Forward (1) from `current`: the nearest entry that way
 * that `isAvailable` accepts, and the history after the step. Entries passed
 * over are gone (a trashed or deleted page) and drop out of the history; when
 * nothing that way is left, `target` is null and only that pruning applies.
 * Null when there is nothing that way at all.
 */
export function stepTabHistory(
  history: TabHistory | undefined,
  current: TabHistoryEntry,
  direction: -1 | 1,
  isAvailable: (entry: TabHistoryEntry) => boolean = () => true,
): { target: TabHistoryEntry | null; history: TabHistory } | null {
  const back = history?.back ?? [];
  const forward = history?.forward ?? [];
  if (direction === -1) {
    if (back.length === 0) return null;
    for (let index = back.length - 1; index >= 0; index--) {
      if (!isAvailable(back[index])) continue;
      return { target: back[index], history: { back: back.slice(0, index), forward: [current, ...forward].slice(0, MAX_TAB_HISTORY) } };
    }
    return { target: null, history: { back: [], forward } };
  }
  if (forward.length === 0) return null;
  const index = forward.findIndex(isAvailable);
  if (index === -1) return { target: null, history: { back, forward: [] } };
  return { target: forward[index], history: { back: [...back, current].slice(-MAX_TAB_HISTORY), forward: forward.slice(index + 1) } };
}
