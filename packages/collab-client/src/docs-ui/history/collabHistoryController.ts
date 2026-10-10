/**
 * What a host hands the shared page history dialog for one open document.
 *
 * The desktop builds one per collaborative tab; the web console builds one per
 * mounted page. Both list and load revisions over the same REST surface on the
 * document's room (`CollabHistoryClient`, team JWT) and restore through the
 * live editor, so peers see the restore as an ordinary collaborative edit.
 */
import type { CollabHistoryClient } from '@nimbalyst/runtime/sync/collabHistoryClient';
import type { DocumentSyncStatus } from '@nimbalyst/runtime/sync/documentSyncTypes';

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
export function isCollabRestoreSafe(status: DocumentSyncStatus): boolean {
  return status === 'connected';
}

export function canRestoreCollabRevisions(controller: CollabHistoryController | null): boolean {
  return !!controller?.exportSnapshot && !!controller.applySnapshot && !controller.isReadOnly?.();
}

const READ_ONLY_MESSAGE = 'You do not have permission to edit this document.';
const UNSYNCED_MESSAGE = 'This document still has unsynced local changes. Wait for "Connected" before restoring.';

/** Checkpoints taken before giving up on a page that keeps changing under the restore. */
const RESTORE_CHECKPOINT_ATTEMPTS = 2;

function toBytes(snapshot: Uint8Array | ArrayLike<number>): Uint8Array {
  return snapshot instanceof Uint8Array ? snapshot : new Uint8Array(snapshot);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return typeof (value as PromiseLike<T> | null)?.then === 'function';
}

/** Read the live head. Synchronous when the host's export is, so nothing can land between it and a replace. */
function readHead(exportSnapshot: NonNullable<CollabHistoryController['exportSnapshot']>): Uint8Array | Promise<Uint8Array> {
  const raw = exportSnapshot();
  return isPromiseLike(raw) ? Promise.resolve(raw).then(toBytes) : toBytes(raw);
}

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
export async function restoreCollabRevision(
  controller: CollabHistoryController,
  revisionId: string,
): Promise<boolean> {
  const { exportSnapshot, applySnapshot } = controller;
  if (!exportSnapshot || !applySnapshot) return false;
  if (controller.isReadOnly?.()) throw new Error(READ_ONLY_MESSAGE);

  if (!isCollabRestoreSafe(controller.getStatus())) {
    if (!controller.waitForPendingWrites) return false;
    const settled = await controller.waitForPendingWrites(5_000);
    if (!settled || !isCollabRestoreSafe(controller.getStatus())) {
      throw new Error(UNSYNCED_MESSAGE);
    }
  }

  const loaded = await controller.client.loadRevision(revisionId);

  let checkpointed = await readHead(exportSnapshot);
  for (let attempt = 1; ; attempt++) {
    await controller.client.createRevision({
      revisionKind: 'restore-pre',
      editorType: controller.editorType,
      contentFormat: controller.contentFormat,
      plaintext: checkpointed,
      basisSequence: controller.getBasisSequence(),
    });

    const headOrPending = readHead(exportSnapshot);
    // An async export opens a gap here; the host's own exports are synchronous.
    const head = isPromiseLike(headOrPending) ? await headOrPending : headOrPending;
    // Everything from here to `applySnapshot` runs without yielding.
    if (controller.isReadOnly?.()) throw new Error(READ_ONLY_MESSAGE);
    if (!isCollabRestoreSafe(controller.getStatus())) throw new Error(UNSYNCED_MESSAGE);
    if (sameBytes(head, checkpointed)) break;
    if (attempt >= RESTORE_CHECKPOINT_ATTEMPTS) {
      throw new Error('This document changed while restoring, so the restore was cancelled. Nothing was lost; try again.');
    }
    checkpointed = head;
  }

  await applySnapshot(loaded.plaintext);

  await controller.client.createRevision({
    revisionKind: 'restore-head',
    editorType: controller.editorType,
    contentFormat: controller.contentFormat,
    plaintext: loaded.plaintext,
    basisSequence: controller.getBasisSequence(),
    restoredFromRevisionId: revisionId,
  });
  return true;
}
