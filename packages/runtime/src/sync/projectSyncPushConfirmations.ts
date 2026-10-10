import type { ProjectSyncResponseMessage } from '@nimbalyst/collab-protocol';

/** A pushed file, by the hash the client sent. */
export interface PushedFileRef {
  syncId: string;
  contentHash: string;
  lastModifiedAt: number;
}

/**
 * Pushes that left this client but got no ack, per project. Each is either
 * stored on the server or not, and only the server can say which: the next
 * sync request asks (`confirm`), and the response reports the hash the server
 * holds (`pushConfirmations`). A push the server holds is confirmed, so the
 * caller may advance its baseline; any other answer leaves the baseline alone
 * and the same response's diff carries the file.
 */
export class UnconfirmedPushes {
  private byProject = new Map<string, Map<string, PushedFileRef>>();

  add(projectId: string, files: PushedFileRef[]): void {
    const entries = this.byProject.get(projectId) ?? new Map<string, PushedFileRef>();
    for (const file of files) entries.set(file.syncId, file);
    this.byProject.set(projectId, entries);
  }

  /** A newer push of the same file answers for itself. */
  supersede(projectId: string, syncIds: string[]): void {
    const entries = this.byProject.get(projectId);
    for (const syncId of syncIds) entries?.delete(syncId);
  }

  syncIds(projectId: string): string[] {
    return [...(this.byProject.get(projectId)?.keys() ?? [])];
  }

  /**
   * Settle what one response batch answers. A server that does not advertise
   * acks stores what it receives, so every entry is confirmed.
   */
  settle(projectId: string, response: Pick<ProjectSyncResponseMessage, 'pushAck' | 'pushConfirmations'>): PushedFileRef[] {
    const entries = this.byProject.get(projectId);
    if (!entries?.size) return [];
    if (response.pushAck !== true) {
      const all = [...entries.values()];
      entries.clear();
      return all;
    }
    const confirmed: PushedFileRef[] = [];
    for (const { syncId, contentHash } of response.pushConfirmations ?? []) {
      const entry = entries.get(syncId);
      if (!entry) continue;
      entries.delete(syncId);
      if (contentHash === entry.contentHash) confirmed.push(entry);
    }
    return confirmed;
  }
}
