import { useEffect, useState } from 'react';

import type { ConversationDirectoryEntry } from '../../../shared/conversationDirectory';
import { listConversationDirectory } from '../../services/conversationDirectoryClient';
import { selectConversationDirectory } from '../../store/conversationDirectoryViewModel';

export interface RoutedConversation {
  entry: ConversationDirectoryEntry | null;
  /** True while the entry may still arrive; the window shows a spinner. */
  resolving: boolean;
}

/**
 * The conversation the window is routed at, including archived ones.
 *
 * The sidebar's directory atom deliberately holds only unarchived rooms, but
 * the rooms directory offers "Open" on archived ones and inbox deep links can
 * point at a room archived since the delivery. Without this the window answered
 * "that conversation is no longer available" for a room whose history is meant
 * to stay readable. The archived read is a miss-path only: it runs once the
 * directory is loaded and the id is genuinely absent from it.
 *
 * Archived rooms open read-only — the descriptor carries `archivedAt`, which
 * the comments stack already turns into a disabled composer.
 */
export function useRoutedConversation(
  orgId: string,
  conversationId: string | undefined,
  conversations: readonly ConversationDirectoryEntry[],
  directoryReady: boolean,
): RoutedConversation {
  const listed = conversationId
    ? conversations.find((entry) => entry.id === conversationId) ?? null
    : null;
  const [archived, setArchived] = useState<ConversationDirectoryEntry | null>(
    null,
  );
  const [lookedUp, setLookedUp] = useState<string | null>(null);

  useEffect(() => {
    if (!conversationId || listed || !directoryReady) return;
    if (lookedUp === conversationId) return;
    let cancelled = false;
    void listConversationDirectory({ orgId, includeArchived: true })
      .then((entries) => {
        if (cancelled) return;
        setArchived(
          selectConversationDirectory(entries, { orgId, includeArchived: true })
            .find((entry) => entry.id === conversationId) ?? null,
        );
      })
      .catch(() => {
        if (!cancelled) setArchived(null);
      })
      .finally(() => {
        if (!cancelled) setLookedUp(conversationId);
      });
    return () => { cancelled = true; };
  }, [conversationId, directoryReady, listed, lookedUp, orgId]);

  // A different organization or a different room: the previous archived lookup
  // says nothing about this one.
  useEffect(() => {
    setArchived(null);
    setLookedUp(null);
  }, [orgId]);

  if (listed) return { entry: listed, resolving: false };
  if (!conversationId) return { entry: null, resolving: false };
  if (archived?.id === conversationId) {
    return { entry: archived, resolving: false };
  }
  return { entry: null, resolving: !directoryReady || lookedUp !== conversationId };
}
