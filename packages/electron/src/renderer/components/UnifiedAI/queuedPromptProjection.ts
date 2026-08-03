export interface DurableQueuedPromptProjection {
  id: string;
  clientSubmissionId?: string;
  submissionSequence?: number;
  sourceSessionId?: string;
  status?: 'awaiting_ack' | 'pending' | 'executing' | 'completed' | 'failed';
  prompt: string;
  timestamp: number;
  attachments?: any[];
  documentContext?: any;
  errorMessage?: string;
}

/**
 * Backend truth wins over optimistic state. The stable client submission ID is
 * the reconciliation key, with the row ID retained for legacy clients.
 */
export function projectQueuedPrompts(
  sourceSessionId: string,
  previous: DurableQueuedPromptProjection[],
  durable: DurableQueuedPromptProjection[],
): DurableQueuedPromptProjection[] {
  const byIdentity = new Map<string, DurableQueuedPromptProjection>();
  for (const row of previous) {
    if ((row.sourceSessionId ?? sourceSessionId) === sourceSessionId) {
      byIdentity.set(row.clientSubmissionId ?? row.id, row);
    }
  }
  for (const row of durable) {
    if ((row.sourceSessionId ?? sourceSessionId) !== sourceSessionId) continue;
    const key = row.clientSubmissionId ?? row.id;
    // A durable accepted/completed receipt clears stale local failure state.
    byIdentity.set(key, { ...byIdentity.get(key), ...row, errorMessage: row.status === 'failed' ? row.errorMessage : undefined });
  }
  return [...byIdentity.values()]
    .filter((row) => row.status !== 'completed' && row.status !== 'failed')
    .sort((a, b) => (a.submissionSequence ?? a.timestamp) - (b.submissionSequence ?? b.timestamp) || a.id.localeCompare(b.id));
}
