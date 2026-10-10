/**
 * Per-tab controller for shared-document history.
 *
 * CollaborativeTabEditor publishes a controller on mount keyed by the
 * `collab://` URI. The history dialog reads from here so it can:
 *   - construct a CollabHistoryClient bound to the live document key
 *   - take a snapshot from the running editor (`exportSnapshot`)
 *   - apply a restored snapshot through the collab path (`applySnapshot`)
 *   - read the latest sync sequence for `basisSequence`
 *
 * Cleared on unmount so the dialog can detect "doc isn't open" and prompt
 * the user to open it before restoring.
 */
import { atom } from 'jotai';
import type { CollabHistoryController } from '@nimbalyst/collab-client/docs-ui/history';

// The contract is shared with the web console's page history.
export type { CollabHistoryController };

const controllers = new Map<string, CollabHistoryController>();
const versionAtom = atom(0);

/** Read the controller for a given collab URI (null if not mounted). */
export const collabHistoryControllerAtom = atom(
  (get) => {
    void get(versionAtom);
    return (uri: string): CollabHistoryController | null => controllers.get(uri) ?? null;
  }
);

/** Non-reactive read for services outside React (e.g. the agent edit path). */
export function getCollabHistoryController(uri: string): CollabHistoryController | null {
  return controllers.get(uri) ?? null;
}

export function registerCollabHistoryController(
  uri: string,
  controller: CollabHistoryController,
  bump: () => void
): () => void {
  controllers.set(uri, controller);
  bump();
  return () => {
    if (controllers.get(uri) === controller) {
      controllers.delete(uri);
      bump();
    }
  };
}

/** Force subscribers to re-read. Use after register/unregister. */
export const collabHistoryControllerBumpAtom = atom(null, (get, set) => {
  set(versionAtom, get(versionAtom) + 1);
});
