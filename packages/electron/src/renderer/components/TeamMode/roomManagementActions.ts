import type { ConversationDirectoryEntry } from '../../../shared/conversationDirectory';
import { createDirectoryConversation } from '../../services/conversationDirectoryClient';
import {
  buildDirectMessageRequest,
  findExistingDirectMessage,
} from './roomManagementViewModel';

/**
 * Land on the direct conversation for a participant set, creating it only when
 * one is not already known.
 *
 * Reuse depends on `participantsByConversationId`, derived from the directory's
 * embedded DM identities so the compose path does not fetch every DM roster.
 */
export async function openOrCreateDirectMessage(options: {
  orgId: string;
  selectedMemberIds: readonly string[];
  viewerUserId: string | null;
  conversations: readonly ConversationDirectoryEntry[];
  participantsByConversationId?: Readonly<Record<string, readonly string[]>>;
}): Promise<string> {
  const { error, participants, request } = buildDirectMessageRequest(
    options.selectedMemberIds,
    options.viewerUserId,
  );
  if (error || !request) throw new Error(error ?? 'Unable to start a direct message.');

  const existing = findExistingDirectMessage(
    options.conversations,
    options.participantsByConversationId ?? {},
    participants,
  );
  if (existing) return existing.id;

  const created = await createDirectoryConversation({
    orgId: options.orgId,
    input: request,
  });
  return created.descriptor.id;
}
