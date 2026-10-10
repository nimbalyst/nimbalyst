/**
 * Link and tracker cells: the tracker chip resolver wiring and the delegated
 * click listener that follows a link or opens a tracker item.
 */

import { useEffect, useState } from 'react';
import { navigateToTrackerReference } from '@nimbalyst/extension-sdk';
import { TRACKER_CELL_ATTRIBUTE, URL_CELL_ATTRIBUTE } from '../cells/cellRendering';
import type { EditorCore } from './editorCore';

/** Returns the tracker keys currently painted, one resolver hook per key. */
export function useCellLinks(core: EditorCore, isLoading: boolean, loadError: unknown): readonly string[] {
  const { trackerStore, repaintGrid, editorRef, hostRef } = core;
  // `trackerKeys` only exists to mount one resolver hook per key.
  const [trackerKeys, setTrackerKeys] = useState<readonly string[]>([]);

  // Tracker chips: newly-painted keys mount a resolver, and a resolution
  // repaints the cells already on screen.
  useEffect(() => {
    trackerStore.onKeysChanged((keys) => setTrackerKeys(keys));
    trackerStore.onRepaintNeeded(repaintGrid);
    return () => {
      trackerStore.onKeysChanged(null);
      trackerStore.onRepaintNeeded(null);
    };
  }, [trackerStore, repaintGrid]);

  useEffect(() => () => trackerStore.destroy(), [trackerStore]);

  /**
   * One delegated listener for link and tracker cells. Attaching handlers in the
   * hyperscript templates would fight RevoGrid's own cell mousedown handling;
   * this runs after selection has been applied, so a click both selects the cell
   * and follows the target.
   *
   * The deps matter: this component returns early while `isLoading`, and again
   * on `loadError`, so on the first commit the root div does not exist and the
   * ref is null. With an empty dep array the listener attached to nothing and
   * never retried — links and chips were inert. Re-running when either gate
   * clears is what actually binds it.
   */
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    const handleClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;

      const link = target.closest(`[${URL_CELL_ATTRIBUTE}]`);
      if (link) {
        const href = link.getAttribute(URL_CELL_ATTRIBUTE);
        if (href) {
          event.preventDefault();
          void hostRef.current.openExternal?.(href);
        }
        return;
      }

      const chip = target.closest(`[${TRACKER_CELL_ATTRIBUTE}]`);
      if (chip) {
        const itemId = chip.getAttribute(TRACKER_CELL_ATTRIBUTE);
        if (itemId) {
          event.preventDefault();
          // Through the SDK seam rather than dispatching the event ourselves, so
          // the navigation contract stays in one place.
          navigateToTrackerReference({ id: itemId, title: '' });
        }
      }
    };

    editor.addEventListener('click', handleClick);
    return () => editor.removeEventListener('click', handleClick);
  }, [isLoading, loadError]);

  return trackerKeys;
}
