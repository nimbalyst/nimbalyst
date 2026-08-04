import type { TeamPresenceMember } from '@nimbalyst/runtime/sync';
import { atom } from 'jotai';

import { atomFamily } from '../debug/atomFamilyRegistry';
import { teamInboxSnapshotAtom } from './teamInbox';

export type TeamPresenceAtomKey = {
  orgId: string;
  teamMemberId: string;
};

export const teamPresenceAtomFamily = atomFamily(
  (key: TeamPresenceAtomKey) => atom<TeamPresenceMember | null>((get) =>
    get(teamInboxSnapshotAtom).presence?.[key.orgId]?.[key.teamMemberId] ?? null),
  (left, right) =>
    left.orgId === right.orgId && left.teamMemberId === right.teamMemberId,
);

