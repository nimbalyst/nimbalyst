/**
 * Reports `collab-asset://` URIs that have *disappeared* from the live
 * editor state since the last scan. The host (CollaborativeTabEditor)
 * forwards the disappeared list to main, which deletes exactly those
 * R2 objects.
 *
 * Why diff-only and not "report current set": the naive design is unsafe
 * in collab because incoming Yjs updates from other clients may not have
 * arrived yet, so the local set may be a strict subset of the converged
 * truth. Reporting it as authoritative would delete still-live
 * attachments. The diff-only emit only flags URIs THIS client previously
 * observed and now no longer observes.
 *
 * Headless extension (Phase 7.3). Replaces the prior React-component
 * `AssetGCPlugin` mounted in Editor.tsx.
 */

import { defineExtension } from 'lexical';

const DEBOUNCE_MS = 5_000;
const COLLAB_ASSET_RE = /collab-asset:\/\/doc\/[^"\\\s)]+\/asset\/[^"\\\s)]+/g;

export interface AssetGcConfig {
  /**
   * Called (debounced) with `collab-asset://` URIs that disappeared from
   * the live editor state since the previous scan. May be empty -- callers
   * should treat empty as "nothing to do". When undefined, the extension
   * registers no listeners at all (idle).
   */
  onAssetReferencesRemoved?: (removedUris: string[]) => void;
}

function diff(previous: Set<string>, current: Set<string>): string[] {
  const removed: string[] = [];
  for (const uri of previous) {
    if (!current.has(uri)) removed.push(uri);
  }
  return removed;
}

export const AssetGcExtension = defineExtension({
  name: '@nimbalyst/editor/asset-gc',
  config: { onAssetReferencesRemoved: undefined } satisfies AssetGcConfig as AssetGcConfig,
  register: (editor, config) => {
    if (!config.onAssetReferencesRemoved) {
      return () => {};
    }
    const onRemoved = config.onAssetReferencesRemoved;

    let lastReferenced = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const compute = () => {
      timer = null;
      try {
        const json = JSON.stringify(editor.getEditorState().toJSON());
        const matches = json.match(COLLAB_ASSET_RE);
        const current = new Set<string>(matches ?? []);
        const removed = diff(lastReferenced, current);
        // Always update tracking even when nothing was removed -- new
        // additions from incoming Yjs updates need to be folded into
        // `lastReferenced` so future removals can be detected.
        lastReferenced = current;
        if (removed.length > 0) {
          onRemoved(removed);
        }
      } catch (err) {
        console.warn('[AssetGcExtension] scan failed', err);
      }
    };

    const schedule = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(compute, DEBOUNCE_MS);
    };

    // Initial scan to seed `lastReferenced` with whatever the editor
    // already has after Yjs hydration. The diff against the empty
    // baseline is empty, so this is safe even if sync hasn't finished --
    // it just establishes a starting point.
    schedule();

    const unregister = editor.registerUpdateListener(({ dirtyElements, dirtyLeaves }) => {
      if (dirtyElements.size === 0 && dirtyLeaves.size === 0) return;
      schedule();
    });

    return () => {
      unregister();
      if (timer !== null) clearTimeout(timer);
    };
  },
});
