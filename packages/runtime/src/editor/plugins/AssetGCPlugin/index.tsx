/**
 * AssetGCPlugin
 *
 * Reports `collab-asset://` URIs that have *disappeared* from the live
 * editor state since the last scan. The host (CollaborativeTabEditor)
 * forwards the disappeared list to main, which deletes exactly those
 * R2 objects -- no diff against the server-side list.
 *
 * Why diff-only and not "report current set":
 *   The naive design ("report the current referenced set; server deletes
 *   anything not in it") is unsafe in collab. If initial Yjs sync isn't
 *   complete, or another client just inserted an asset we haven't received
 *   yet, our local set is a *subset* of the converged truth. Reporting it
 *   as authoritative would delete still-live attachments.
 *
 *   The diff-only emit is safe because it only flags URIs THIS client
 *   previously observed and now no longer observes. We never claim to
 *   know about, or to have removed, a URI we never received. Concurrent
 *   inserts on other clients are invisible to us and stay invisible --
 *   we leave them alone.
 *
 *   Trade-off: if a user uploads an asset, removes it, and the upload +
 *   removal both happen within the debounce window, the asset is never
 *   added to `lastReferenced` and never reported as removed -- so it
 *   leaks. That's a small cost; an out-of-band janitor can sweep
 *   genuinely-orphaned assets later.
 */
import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';

const DEBOUNCE_MS = 5_000;
const COLLAB_ASSET_RE = /collab-asset:\/\/doc\/[^"\\\s)]+\/asset\/[^"\\\s)]+/g;

function diff(previous: Set<string>, current: Set<string>): string[] {
  const removed: string[] = [];
  for (const uri of previous) {
    if (!current.has(uri)) removed.push(uri);
  }
  return removed;
}

export default function AssetGCPlugin({
  onAssetReferencesRemoved,
}: {
  /**
   * Called (debounced) with the list of `collab-asset://` URIs that have
   * disappeared from the live editor state since the last scan. May be
   * empty -- callers should treat empty as "nothing to do".
   */
  onAssetReferencesRemoved?: (removedUris: string[]) => void;
}): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    if (!onAssetReferencesRemoved) return;

    let lastReferenced = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const compute = () => {
      timer = null;
      try {
        const json = JSON.stringify(editor.getEditorState().toJSON());
        const matches = json.match(COLLAB_ASSET_RE);
        const current = new Set<string>(matches ?? []);
        const removed = diff(lastReferenced, current);
        // Always update tracking, even when nothing was removed -- new
        // additions from incoming Yjs updates need to be folded into
        // `lastReferenced` so future removals can be detected.
        lastReferenced = current;
        if (removed.length > 0) {
          onAssetReferencesRemoved(removed);
        }
      } catch (err) {
        console.warn('[AssetGCPlugin] scan failed', err);
      }
    };

    const schedule = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(compute, DEBOUNCE_MS);
    };

    // Initial scan to seed `lastReferenced` with whatever the editor
    // already has after Yjs hydration. The diff against the empty
    // baseline is empty, so this is safe even if sync hasn't finished
    // -- it just establishes a starting point.
    schedule();

    const unregister = editor.registerUpdateListener(({ dirtyElements, dirtyLeaves }) => {
      if (dirtyElements.size === 0 && dirtyLeaves.size === 0) return;
      schedule();
    });

    return () => {
      unregister();
      if (timer !== null) clearTimeout(timer);
    };
  }, [editor, onAssetReferencesRemoved]);

  return null;
}
