import type { DocumentFeedbackIndexClientState } from "@nimbalyst/runtime/sync/DocumentFeedbackIndexClient";

export interface DocumentFeedbackIndexTarget {
  workspacePath: string;
  orgId: string;
  teamMemberId: string;
}
export interface DocumentFeedbackIndexUpdate
  extends DocumentFeedbackIndexTarget {
  state: DocumentFeedbackIndexClientState;
}
export const documentFeedbackTargetKey = (
  target: Pick<DocumentFeedbackIndexTarget, "workspacePath" | "orgId">
): string => JSON.stringify([target.workspacePath, target.orgId]);
export const documentFeedbackViewerKey = (
  target: DocumentFeedbackIndexTarget
): string =>
  JSON.stringify([target.workspacePath, target.orgId, target.teamMemberId]);
