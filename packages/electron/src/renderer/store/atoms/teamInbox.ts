import type { TeamInboxSnapshot } from '@nimbalyst/runtime/sync';
import { atom } from 'jotai';

export const EMPTY_TEAM_INBOX_SNAPSHOT: TeamInboxSnapshot = {
  status: 'loading',
  deliveries: [],
  organizations: [],
};

/**
 * Materialized renderer view of every authorized organization inbox.
 *
 * Only the central team-inbox listener writes this atom. Components reach it
 * through the InboxProvider adapter rather than subscribing to IPC.
 */
export const teamInboxSnapshotAtom = atom<TeamInboxSnapshot>(
  EMPTY_TEAM_INBOX_SNAPSHOT,
);
