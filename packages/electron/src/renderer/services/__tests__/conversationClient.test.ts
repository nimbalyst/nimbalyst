import { afterEach, describe, expect, it, vi } from 'vitest';

import { setConversationNotificationLevel } from '../conversationClient';

describe('conversation client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ['all', 'following'],
    ['mentions', 'following'],
    ['none', 'muted'],
  ] as const)(
    'maps notification level %s to subscription state %s',
    async (notificationLevel, state) => {
      const setSubscription = vi.fn(async (request) => ({
        conversationId: request.conversationId,
        userId: 'member-a',
        state: request.state,
        reason: 'explicit',
        notificationLevel: request.notificationLevel,
      }));
      vi.stubGlobal('window', {
        electronAPI: {
          conversation: { setSubscription },
        },
      });

      await setConversationNotificationLevel({
        orgId: 'org-a',
        conversationId: 'conversation-a',
        notificationLevel,
      });

      expect(setSubscription).toHaveBeenCalledWith({
        orgId: 'org-a',
        conversationId: 'conversation-a',
        state,
        notificationLevel,
      });
    },
  );
});
