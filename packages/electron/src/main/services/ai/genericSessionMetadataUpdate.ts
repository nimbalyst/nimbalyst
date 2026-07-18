import { assertNoReservedAttentionSupervisorMetadataMutation } from '../AttentionSupervisorAuthorization';

export interface AIUpdateSessionMetadataDeps {
  updateMetadata: (
    sessionId: string,
    update: { metadata: Record<string, any> },
  ) => Promise<void>;
  onSessionUnread: (sessionId: string, hasUnread: boolean) => void;
  pushLastReadAt: (sessionId: string, lastReadAt: number) => Promise<void>;
}

/** Actual implementation behind the `ai:updateSessionMetadata` IPC route. */
export async function handleAIUpdateSessionMetadata(
  sessionId: string,
  metadata: Record<string, any>,
  deps: AIUpdateSessionMetadataDeps,
): Promise<{ success: true }> {
  assertNoReservedAttentionSupervisorMetadataMutation(metadata, 'ai:updateSessionMetadata');
  await deps.updateMetadata(sessionId, { metadata });

  if (metadata.metadata?.hasUnread !== undefined) {
    deps.onSessionUnread(sessionId, !!metadata.metadata.hasUnread);
  }
  if (metadata.metadata?.lastReadAt) {
    await deps.pushLastReadAt(sessionId, metadata.metadata.lastReadAt);
  }
  return { success: true };
}
