/** Authorized enumeration metadata; answers remain in the document room. */
export interface DocumentFeedbackIndexEntry {
  orgId: string;
  documentId: string;
  projectId: string;
  blockId: string;
  title: string;
  sentBy: string;
  sentAt: number;
  updatedAt: number;
  sealed: boolean;
  availability: "available" | "blockRemoved";
  recipientCount: number;
  answeredCount: number;
  quorum: number;
  isRecipient: boolean;
  needsMyResponse: boolean;
}

export interface DocumentFeedbackIndexSnapshot {
  entries: DocumentFeedbackIndexEntry[];
  generation: number;
  status: "partial" | "ready" | "error";
}

export interface DocumentFeedbackIndexSyncMessage {
  type: "documentFeedbackIndexSync";
}

export interface DocumentFeedbackIndexSnapshotMessage
  extends DocumentFeedbackIndexSnapshot {
  type: "documentFeedbackIndexSnapshot";
}

export function documentFeedbackKey(
  entry: Pick<DocumentFeedbackIndexEntry, "orgId" | "documentId" | "blockId">
): string {
  return JSON.stringify([entry.orgId, entry.documentId, entry.blockId]);
}
