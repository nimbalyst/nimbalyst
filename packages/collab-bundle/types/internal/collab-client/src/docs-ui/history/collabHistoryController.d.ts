/**
 * What a host hands the shared page history dialog for one open document.
 *
 * The desktop builds one per collaborative tab; the web console builds one per
 * mounted page. Both list and load revisions over the same REST surface on the
 * document's room (`CollabHistoryClient`, team JWT) and restore through the
 * live editor, so peers see the restore as an ordinary collaborative edit.
 */
import type { CollabHistoryClient } from '../../../../runtime/src/sync/collabHistoryClient';
import type { DocumentSyncStatus } from '../../../../runtime/src/sync/documentSyncTypes';
export interface CollabHistoryController {
    /** Stable per-document REST client. */
    client: Pick<CollabHistoryClient, 'listRevisions' | 'loadRevision' | 'createRevision'>;
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
    /** True when the reader may not write this document; restore is withheld. */
    isReadOnly?: () => boolean;
}
/**
 * Only restore from a fully synced state. `replaying` and `offline-unsynced`
 * mean the local document has writes the server has not yet acknowledged;
 * replacing content now would lose them.
 */
export declare function isCollabRestoreSafe(status: DocumentSyncStatus): boolean;
export declare function canRestoreCollabRevisions(controller: CollabHistoryController | null): boolean;
/**
 * Restore `revisionId` as the current version.
 *
 * 1. Load the selected revision, before anything is checkpointed.
 * 2. Record a `restore-pre` checkpoint of the current head, so the restore can
 *    itself be undone from history.
 * 3. Re-read the head and replace it through the live editor only if it is
 *    still exactly what was checkpointed, with no await between that check and
 *    the replace. A collaborator's edit that landed while the checkpoint was
 *    posting would otherwise be erased and be absent from `restore-pre` too;
 *    instead the head is checkpointed once more, and if it changes again the
 *    restore is refused and the live page left alone.
 * 4. Record a `restore-head` revision pointing back at the source.
 *
 * Returns false without writing anything when the document is not synced and
 * the controller cannot wait for it (an older controller); throws when it
 * waited and the document still has unsynced writes, when write access or the
 * connection is lost mid-restore, or when the page keeps changing.
 */
export declare function restoreCollabRevision(controller: CollabHistoryController, revisionId: string): Promise<boolean>;
