import { useEffect } from 'react';
import { useAtomValue } from 'jotai';

import { teamInboxSnapshotAtom } from '../../store/atoms/teamInbox';
import { unreadDeliveryIdsForOrg } from '../../store/conversationDirectoryViewModel';
import type { InboxProvider } from './Inbox/inboxProvider';
import {
  requestInboxSearchFocus,
  subscribeOrgWindowCommand,
} from './orgWindowCommandBus';
import { adjacentConversationId, type OrgSidebarModel } from './orgSidebarViewModel';
import {
  INBOX_ROUTE,
  conversationRoute,
  type OrgWindowRoute,
} from './orgWindowState';

/**
 * Turns the org window's messaging commands into route changes, a compose
 * dialog and mark-read calls.
 *
 * Renders nothing. It exists as a component rather than a hook inside
 * `TeamMode` so the whole behaviour lives in one file the window mounts with a
 * single line — the org window's body is under active layout work, and this
 * keeps the two from sharing a diff.
 *
 * Everything here is deliberately idempotent: the native accelerator and the
 * window's own key handling can both deliver the same command, and re-opening
 * an open dialog or routing where you already are must be a no-op.
 */
export function OrgWindowCommandBridge({
  orgId,
  route,
  sidebar,
  inboxProvider,
  onRoute,
  onCompose,
}: {
  orgId: string;
  route: OrgWindowRoute;
  sidebar: OrgSidebarModel;
  inboxProvider: InboxProvider;
  onRoute: (route: OrgWindowRoute) => void;
  /**
   * Opens the destination picker. Omitted when the organization has turned both
   * rooms and direct messages off, where there is nothing to compose to — the
   * command then does nothing rather than opening an empty picker.
   */
  onCompose?: () => void;
}) {
  // Read here rather than taken as a prop: Mark All Read is the only command
  // that needs the whole fan-in, and threading it through the window meant
  // every delivery and presence heartbeat re-rendered the body.
  const inboxSnapshot = useAtomValue(teamInboxSnapshotAtom);

  useEffect(() => {
    if (!onCompose) return;
    return subscribeOrgWindowCommand('newMessage', onCompose);
  }, [onCompose]);

  useEffect(() => (
    subscribeOrgWindowCommand('goToInbox', () => onRoute(INBOX_ROUTE))
  ), [onRoute]);

  useEffect(() => (
    subscribeOrgWindowCommand('searchMessages', () => {
      // The field lives on the Inbox, so the command has to land there first;
      // the focus request is latched for the mount that follows.
      onRoute(INBOX_ROUTE);
      requestInboxSearchFocus();
    })
  ), [onRoute]);

  useEffect(() => (
    subscribeOrgWindowCommand('markAllRead', () => {
      const unread = unreadDeliveryIdsForOrg(inboxSnapshot, orgId);
      if (unread.length === 0) return;
      void inboxProvider.markRead(unread).catch(() => {
        // The snapshot keeps them unread, so the next invocation retries.
      });
    })
  ), [inboxProvider, inboxSnapshot, orgId]);

  const currentConversationId = route.view === 'conversation'
    ? route.conversationId
    : undefined;

  useEffect(() => {
    const step = (direction: 1 | -1) => () => {
      const next = adjacentConversationId(sidebar, currentConversationId, direction);
      if (next) onRoute(conversationRoute(next));
    };
    const offNext = subscribeOrgWindowCommand('nextConversation', step(1));
    const offPrevious = subscribeOrgWindowCommand('previousConversation', step(-1));
    return () => { offNext(); offPrevious(); };
  }, [currentConversationId, onRoute, sidebar]);

  return null;
}
