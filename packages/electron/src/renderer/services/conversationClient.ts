import type { ConversationSubscription } from '@nimbalyst/collab-protocol';

import type { ConversationSetSubscriptionRequest } from '../../shared/conversationDirectory';

export type ConversationNotificationLevel =
  ConversationSubscription['notificationLevel'];

/**
 * Persist one notification level through the main-owned ConversationRoom
 * connection. "Nothing" is the muted subscription state; the other levels
 * keep the conversation followed and let the server filter deliveries.
 */
export function setConversationNotificationLevel(
  request: Omit<ConversationSetSubscriptionRequest, 'state'>,
): Promise<ConversationSubscription> {
  return window.electronAPI.conversation.setSubscription({
    ...request,
    state: request.notificationLevel === 'none' ? 'muted' : 'following',
  });
}
