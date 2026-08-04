import type { TeamInboxSnapshot, TeamPresenceMember } from '@nimbalyst/runtime/sync';

import type { ConversationDirectoryEntry } from '../../../shared/conversationDirectory';
import { isUnreadDelivery } from '../../store/conversationDirectoryViewModel';
import type { OrgSettings } from '../../../shared/orgSettings';
import { DEFAULT_ORG_SETTINGS } from '../../../shared/orgSettings';
import type { AdminTab } from './orgWindowState';

/**
 * The organization-wide room every member is in. The server auto-seeds it with
 * this fixed id, so the client can pin it without a "is this the default room"
 * flag on the descriptor.
 */
export const GENERAL_CONVERSATION_ID = 'general';

export type OrgSidebarItemKind = 'orgRoom' | 'dm';

export interface OrgSidebarItem {
  conversationId: string;
  kind: OrgSidebarItemKind;
  label: string;
  isPrivate: boolean;
  /** Pinned to the top of the rooms section and never left behind by sorting. */
  isGeneral: boolean;
  unreadCount: number;
  presenceStatus?: TeamPresenceMember['status'];
}

export interface OrgSidebarModel {
  rooms: OrgSidebarItem[];
  dms: OrgSidebarItem[];
  /**
   * What the organization's messaging settings allow this viewer to see and
   * do. Presentation only — the server rejects the disabled kinds on its own,
   * so hiding a section is a courtesy, never the security boundary.
   */
  gating: OrgMessagingGating;
}

export interface OrgAdminTabDescriptor {
  id: AdminTab;
  label: string;
  icon: string;
  /**
   * Hidden from plain members rather than shown disabled: the panel is nothing
   * but administration, so an entry they can never act in is only clutter.
   */
  adminOnly: boolean;
}

/**
 * The administration panels, in the order they appear in the management
 * dialog's tab column (NIM-2322 moved them out of this window's sidebar; the
 * list and its role gating are unchanged, so the two never drifted apart).
 *
 * Members and Projects stay visible to everyone — the roster is org-wide
 * knowledge and their panels already reduce to read-only actions for members.
 * Settings likewise: it renders read-only for non-admins rather than 403-ing on
 * click. Billing and the Danger zone have nothing a member may read or do.
 */
export const ORG_ADMIN_TABS: readonly OrgAdminTabDescriptor[] = [
  { id: 'members', label: 'Members', icon: 'groups', adminOnly: false },
  { id: 'projects', label: 'Projects', icon: 'folder', adminOnly: false },
  { id: 'settings', label: 'Settings', icon: 'settings', adminOnly: false },
  { id: 'billing', label: 'Billing', icon: 'credit_card', adminOnly: true },
  { id: 'danger', label: 'Danger zone', icon: 'warning', adminOnly: true },
];

/** The administration tabs one viewer may see. Presentation gating, as ever. */
export function visibleAdminTabs(
  isOrgAdmin: boolean | undefined,
): OrgAdminTabDescriptor[] {
  return ORG_ADMIN_TABS.filter((tab) => !tab.adminOnly || isOrgAdmin === true);
}

/**
 * Whether an organization role may administer the organization.
 *
 * The same rule the members panel applies: Stytch's `owner` and `admin` are
 * both administrators, everything else is a plain member.
 */
export function isOrgAdminRole(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

export interface OrgMessagingGating {
  /** Rooms section, rooms directory and "Browse rooms". */
  roomsVisible: boolean;
  /** Direct-messages section and every DM compose path. */
  dmsVisible: boolean;
  /** The rooms `[+]`; false when creation is admins-only and you are not one. */
  canCreateRoom: boolean;
  /** The direct-messages `[+]`. */
  canCreateDirectMessage: boolean;
}

/**
 * Resolve the messaging gating for one viewer.
 *
 * Rooms and DMs are independently toggleable, and `roomCreation: 'admins'`
 * only narrows who may create — members keep reading and posting in the rooms
 * that exist. The Inbox is never gated: it also carries tracker and document
 * activity, which is not chat.
 */
export function resolveOrgMessagingGating(
  settings: OrgSettings = DEFAULT_ORG_SETTINGS,
  viewer: { isOrgAdmin?: boolean } = {},
): OrgMessagingGating {
  const messaging = settings?.messaging ?? DEFAULT_ORG_SETTINGS.messaging;
  const roomsVisible = messaging.roomsEnabled !== false;
  const dmsVisible = messaging.dmsEnabled !== false;
  const creationRestricted = messaging.roomCreation === 'admins';
  return {
    roomsVisible,
    dmsVisible,
    canCreateRoom: roomsVisible
      && (!creationRestricted || viewer.isOrgAdmin === true),
    canCreateDirectMessage: dmsVisible,
  };
}

export interface OrgSidebarInput {
  conversations: readonly ConversationDirectoryEntry[];
  /** The organization's messaging settings; defaults apply while they load. */
  settings?: OrgSettings;
  /** Drives `roomCreation: 'admins'`. */
  isOrgAdmin?: boolean;
  /** Per-conversation unread totals, keyed by conversation id. */
  unreadCounts?: Readonly<Record<string, number>>;
  /** DM participants keyed by conversation id, derived from the directory. */
  dmParticipants?: Readonly<Record<string, readonly string[]>>;
  /** Member id to display name, used to label DMs. */
  memberNames?: Readonly<Record<string, string>>;
  /** Excluded from a DM's label — you already know you are in it. */
  viewerUserId?: string;
  presenceByMemberId?: Readonly<Record<string, TeamPresenceMember>>;
}

/**
 * Rooms are addressed by their slug id (`#general`), which is what the create
 * flow derives from the room name, but the title is authoritative when the two
 * diverge — a room created through the API can carry any id.
 */
export function roomLabel(entry: ConversationDirectoryEntry): string {
  return entry.title?.trim() || entry.id;
}

/**
 * DM descriptors have no title: the label is the other participants. With no
 * participants resolved the DM is still listed, under a generic label, rather
 * than disappearing from the sidebar.
 */
export function dmLabel(
  participants: readonly string[],
  memberNames: Readonly<Record<string, string>> = {},
  viewerUserId?: string,
): string {
  const others = participants.filter((userId) => userId !== viewerUserId);
  if (others.length === 0) return 'Direct message';
  return others
    .map((userId) => memberNames[userId] ?? userId)
    .sort((left, right) => left.localeCompare(right))
    .join(', ');
}

/**
 * Build the sidebar's rooms and direct-message sections from the conversation
 * directory.
 *
 * Public rooms are readable by every active organization member (the server
 * resolves capabilities that way), so "the rooms I am in" is every readable,
 * unarchived room — explicit membership only changes notification defaults.
 * Document discussions never appear here; they belong to their document.
 *
 * A kind the organization has turned off produces no items at all, so a
 * disabled section cannot leak room names through a stale directory listing.
 * The rooms themselves are retained server-side: re-enabling restores them.
 */
export function buildOrgSidebar(input: OrgSidebarInput): OrgSidebarModel {
  const rooms: OrgSidebarItem[] = [];
  const dms: OrgSidebarItem[] = [];
  const gating = resolveOrgMessagingGating(input.settings, {
    isOrgAdmin: input.isOrgAdmin,
  });

  for (const entry of input.conversations) {
    if (entry.archivedAt !== undefined) continue;
    if (entry.kind === 'orgRoom' && gating.roomsVisible) {
      rooms.push({
        conversationId: entry.id,
        kind: 'orgRoom',
        label: roomLabel(entry),
        isPrivate: entry.visibility === 'private',
        isGeneral: entry.id === GENERAL_CONVERSATION_ID,
        unreadCount: input.unreadCounts?.[entry.id] ?? 0,
      });
    } else if (entry.kind === 'dm' && gating.dmsVisible) {
      const otherParticipantId = (input.dmParticipants?.[entry.id] ?? [])
        .find((userId) => userId !== input.viewerUserId);
      dms.push({
        conversationId: entry.id,
        kind: 'dm',
        label: dmLabel(
          input.dmParticipants?.[entry.id] ?? [],
          input.memberNames,
          input.viewerUserId,
        ),
        isPrivate: true,
        isGeneral: false,
        unreadCount: input.unreadCounts?.[entry.id] ?? 0,
        presenceStatus: otherParticipantId
          ? input.presenceByMemberId?.[otherParticipantId]?.status
          : undefined,
      });
    }
  }

  rooms.sort(compareSidebarItems);
  dms.sort(compareSidebarItems);
  return { rooms, dms, gating };
}

/**
 * The conversations the sidebar lists, top to bottom: rooms then direct
 * messages, each in their shipped order. This is the sequence Next/Previous
 * Conversation walks, so the keyboard order and the visible order are the same
 * list rather than two that can drift.
 */
export function orderedConversationIds(model: OrgSidebarModel): string[] {
  return [...model.rooms, ...model.dms].map((item) => item.conversationId);
}

/**
 * The conversation one step from `currentId` in the sidebar order, wrapping at
 * both ends.
 *
 * With nothing selected — the Inbox, the rooms directory, an admin panel — the
 * step lands on the first conversation going forward and the last going back,
 * so the shortcut is also how you get into the list from outside it. A
 * `currentId` the sidebar does not list (a conversation still loading, or one
 * just gated off) is treated the same way.
 */
export function adjacentConversationId(
  model: OrgSidebarModel,
  currentId: string | undefined,
  direction: 1 | -1,
): string | null {
  const ids = orderedConversationIds(model);
  if (ids.length === 0) return null;
  const index = currentId ? ids.indexOf(currentId) : -1;
  if (index === -1) return direction === 1 ? ids[0] : ids[ids.length - 1];
  return ids[(index + direction + ids.length) % ids.length];
}

function compareSidebarItems(
  left: OrgSidebarItem,
  right: OrgSidebarItem,
): number {
  if (left.isGeneral !== right.isGeneral) return left.isGeneral ? -1 : 1;
  return left.label.localeCompare(right.label, undefined, {
    sensitivity: 'base',
  });
}

/**
 * Everything unread in one organization's inbox, conversations included. This
 * is the sidebar's Inbox pill: the inbox also carries tracker and document
 * activity, so it is deliberately wider than the per-room counts below.
 */
export function inboxUnreadCount(
  snapshot: TeamInboxSnapshot,
  orgId: string,
): number {
  return snapshot.deliveries.filter((delivery) => (
    delivery.orgId === orgId && isUnreadDelivery(delivery)
  )).length;
}

/**
 * Unread totals per conversation for one organization, derived from the inbox
 * watermarks the fan-in already broadcasts, through the shared
 * `isUnreadDelivery` rule so the sidebar and the mark-read-on-open path can
 * never disagree about what counts.
 */
export function unreadCountsByConversation(
  snapshot: TeamInboxSnapshot,
  orgId: string,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const delivery of snapshot.deliveries) {
    if (delivery.orgId !== orgId) continue;
    const source = delivery.source;
    if (!source || !('sourceId' in source) || !source.sourceId) continue;
    if (!isUnreadDelivery(delivery)) continue;
    counts[source.sourceId] = (counts[source.sourceId] ?? 0) + 1;
  }
  return counts;
}
