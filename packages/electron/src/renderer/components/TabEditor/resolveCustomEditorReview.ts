interface CustomEditorReview {
  accepted: boolean;
  generation: number | undefined;
  content: string;
  sessionId: string | undefined;
  resolve: (accepted: boolean, request: { generation?: number }) => Promise<boolean>;
  clear: () => void;
  recordHistory: (content: string, sessionId: string | undefined, accepted: boolean) => Promise<void>;
}

/** The model's file/tag transaction ends review; ancillary history cannot undo it. */
export async function resolveCustomEditorReview(review: CustomEditorReview): Promise<void> {
  if (!await review.resolve(review.accepted, { generation: review.generation })) return;
  review.clear();
  // Use the decided generation's bytes and session, not a later disk read or
  // cleared pending-tag ref. A history failure must leave the resolved UI clear.
  await review.recordHistory(review.content, review.sessionId, review.accepted);
}
