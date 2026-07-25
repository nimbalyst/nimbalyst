/**
 * Pending shared-document registrations (NIM-1565).
 *
 * The Shared Items tree + titles are driven by the TeamRoom doc-index, which is
 * separate from a doc's Yjs content. `registerDocumentInIndex()` used to call
 * `provider.registerDocument()` only when a TeamSyncProvider already existed for
 * the workspace; when the provider was not connected yet (create/share happened
 * before `initSharedDocuments` finished) the server registration was silently
 * dropped. The optimistic atom entry showed the doc that session, but on restart
 * the atom was empty and the server index had no entry — the doc was orphaned
 * (full content, no tree row, no title).
 *
 * This queue holds registrations that could not be sent because no provider was
 * available, keyed by workspace path, and is flushed once the provider connects.
 * It is in-memory only: it covers the realistic case (doc created seconds before
 * sync connects, same session). Cross-restart durability is tracked separately.
 */

export interface PendingDocRegistration {
  documentId: string;
  title: string;
  documentType: string;
  parentFolderId: string | null;
  metadataVersion?: 2;
  fileExtension?: string;
  editorId?: string;
}

/** The minimal provider surface the queue needs to flush a registration. */
export interface DocRegistrationSink {
  registerDocument(
    documentId: string,
    title: string,
    documentType: string,
    parentFolderId: string | null,
    metadata?: { metadataVersion: 2; fileExtension: string; editorId: string },
  ): Promise<void>;
}

export interface FlushResult {
  /** Count of registrations successfully sent to the sink. */
  flushed: number;
  /** Registrations whose send threw; retained in the queue for a later flush. */
  failed: PendingDocRegistration[];
}

export class PendingDocRegistrationQueue {
  // workspacePath -> (documentId -> registration). The inner map dedupes by
  // documentId (latest title wins), matching the provider's own collapse of
  // duplicate register/update messages.
  private byWorkspace = new Map<string, Map<string, PendingDocRegistration>>();

  enqueue(workspacePath: string, registration: PendingDocRegistration): void {
    let queue = this.byWorkspace.get(workspacePath);
    if (!queue) {
      queue = new Map();
      this.byWorkspace.set(workspacePath, queue);
    }
    queue.set(registration.documentId, registration);
  }

  /** Current queued registrations for a workspace, in insertion order. */
  list(workspacePath: string): PendingDocRegistration[] {
    const queue = this.byWorkspace.get(workspacePath);
    return queue ? Array.from(queue.values()) : [];
  }

  clear(workspacePath: string): void {
    this.byWorkspace.delete(workspacePath);
  }

  /**
   * Send every queued registration for `workspacePath` through `sink`. Clears
   * the queue up front so registrations enqueued during the flush aren't lost,
   * then re-enqueues any that threw so a later flush retries them.
   */
  async flush(workspacePath: string, sink: DocRegistrationSink): Promise<FlushResult> {
    const pending = this.list(workspacePath);
    if (pending.length === 0) return { flushed: 0, failed: [] };

    this.clear(workspacePath);

    let flushed = 0;
    const failed: PendingDocRegistration[] = [];
    for (const registration of pending) {
      try {
        await sink.registerDocument(
          registration.documentId,
          registration.title,
          registration.documentType,
          registration.parentFolderId,
          registration.metadataVersion === 2 && registration.fileExtension && registration.editorId
            ? {
                metadataVersion: 2,
                fileExtension: registration.fileExtension,
                editorId: registration.editorId,
              }
            : undefined,
        );
        flushed++;
      } catch (err) {
        console.warn('[pendingDocRegistrations] flush failed for', registration.documentId, err);
        failed.push(registration);
      }
    }

    for (const registration of failed) {
      this.enqueue(workspacePath, registration);
    }

    return { flushed, failed };
  }
}

/** Process-wide queue used by the collab-documents atom module. */
export const pendingDocRegistrations = new PendingDocRegistrationQueue();
