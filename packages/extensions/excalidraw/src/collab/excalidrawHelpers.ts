/**
 * Excalidraw collab helpers.
 *
 * Ported from the prior Crystal codebase (see `src/nodes/ExcalidrawNode/`).
 * These small utilities are used by the binding and diff modules to read the
 * canonical element ordering out of a Y.Array of Y.Map and to schedule
 * change-detection passes.
 */

import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import * as Y from 'yjs';

export const moveArrayItem = <T>(arr: T[], from: number, to: number, inPlace = true): T[] => {
  if (!inPlace) {
    arr = [...arr];
  }
  arr.splice(to, 0, arr.splice(from, 1)[0]);
  return arr;
};

/** Trailing-edge debounce. */
export const debounce = <Args extends unknown[]>(
  callback: (...args: Args) => void,
  wait: number,
): ((...args: Args) => void) => {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  return (...args: Args) => {
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      callback(...args);
    }, wait);
  };
};

export const areElementsSame = (
  els1: readonly { id: string; version: number }[],
  els2: readonly { id: string; version: number }[],
): boolean => {
  if (els1.length !== els2.length) return false;
  for (let i = 0; i < els1.length; i++) {
    if (els1[i].id !== els2[i].id || els1[i].version !== els2[i].version) {
      return false;
    }
  }
  return true;
};

/** Project the Y.Array<Y.Map> shape into a plain array of Excalidraw elements,
 *  ordered by the fractional-index `pos` field. */
export const yjsToExcalidraw = (yArray: Y.Array<Y.Map<unknown>>): ExcalidrawElement[] => {
  return yArray
    .toArray()
    .sort((a, b) => {
      const key1 = a.get('pos') as string;
      const key2 = b.get('pos') as string;
      return key1 > key2 ? 1 : key1 < key2 ? -1 : 0;
    })
    .map((x) => x.get('el') as ExcalidrawElement);
};
