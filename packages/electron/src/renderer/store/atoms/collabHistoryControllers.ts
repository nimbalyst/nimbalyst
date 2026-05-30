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
import type {
  CollabHistoryClient,
  DocumentSyncStatus,
} from '@nimbalyst/runtime/sync';

export interface CollabHistoryController {
  /** Stable per-document REST client. */
  client: CollabHistoryClient;
  /** Logical editor type, e.g. `markdown`, `excalidraw`. */
  editorType: string;
  /** Snapshot content format string returned by `exportSnapshot`. */
  contentFormat: string;
  /** How much the dialog can do for this editor right now. */
  previewKind?: 'text' | 'metadata-only';
  /** Capture the current document content for a new revision. */
  exportSnapshot?: () => Promise<Uint8Array> | Uint8Array;
  /** Apply a restored snapshot into the live document. */
  applySnapshot?: (plaintext: Uint8Array) => Promise<void> | void;
  /** Largest server sequence known to this client. */
  getBasisSequence: () => number;
  /** Current sync status -- restore is blocked while this is unsafe. */
  getStatus: () => DocumentSyncStatus;
  /** Wait for local collab writes to settle before restore-sensitive actions. */
  waitForPendingWrites?: (timeoutMs?: number) => Promise<boolean>;
}

const controllers = new Map<string, CollabHistoryController>();
const versionAtom = atom(0);

/** Read the controller for a given collab URI (null if not mounted). */
export const collabHistoryControllerAtom = atom(
  (get) => {
    void get(versionAtom);
    return (uri: string): CollabHistoryController | null => controllers.get(uri) ?? null;
  }
);

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
