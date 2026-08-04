import type { ConversationMembership } from '@nimbalyst/collab-protocol';

import type {
  ConversationDirectoryEntry,
  CreateConversationInput,
} from '../../../shared/conversationDirectory';
import { roomLabel } from './orgSidebarViewModel';
import type { OrgRosterMember } from './useOrgRoster';

/**
 * Room ids are URL-safe room segments — the server rejects anything else with
 * "Conversation id must be a URL-safe room segment", so the create dialog has
 * to derive and validate against the same expression rather than discovering
 * the rule from a 400.
 */
export const ROOM_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Server constraint: a direct conversation has 2-8 fixed participants. */
export const MIN_DM_PARTICIPANTS = 2;
export const MAX_DM_PARTICIPANTS = 8;

/**
 * A room name typed by a human into the id the server will address the room by.
 *
 * Lowercased and hyphenated the way channel names read everywhere else, with
 * anything outside the server's allowed set dropped instead of substituted —
 * "Design & Review" becomes `design-review`, not `design-&-review`.
 */
export function deriveRoomId(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]+/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+/, '')
    .replace(/[-.]+$/, '');
}

/**
 * Why this room id is unusable, or null when it is fine.
 *
 * `existingIds` catches the collision the server would otherwise answer with a
 * flat 409 after the dialog had already been submitted.
 */
export function validateRoomId(
  id: string,
  existingIds: readonly string[] = [],
): string | null {
  if (!id) return 'Enter a room name to generate an id.';
  if (!ROOM_ID_PATTERN.test(id)) {
    return 'Room ids may only contain letters, numbers, dots, dashes and underscores.';
  }
  if (existingIds.some((existing) => existing.toLowerCase() === id.toLowerCase())) {
    return 'A room with this id already exists.';
  }
  return null;
}

export interface CreateRoomFormState {
  name: string;
  /** Empty means "follow the name"; a typed value overrides the derivation. */
  id: string;
  topic: string;
  visibility: 'public' | 'private';
  /** Other members to seed a private room with; ignored for public rooms. */
  memberIds: readonly string[];
  agentPostingEnabled: boolean;
}

export const EMPTY_CREATE_ROOM_FORM: CreateRoomFormState = {
  name: '',
  id: '',
  topic: '',
  visibility: 'public',
  memberIds: [],
  agentPostingEnabled: false,
};

export interface CreateRoomFormResult {
  /** What the id field shows: the typed override, else the derived slug. */
  resolvedId: string;
  nameError: string | null;
  idError: string | null;
  canSubmit: boolean;
  /** Only built when the form is valid. */
  request: CreateConversationInput | null;
}

/**
 * Validate a create-room form and build the request in one pass.
 *
 * Initial members are only sent for private rooms: the server drops explicit
 * memberships on public rooms (every active org member can already read them),
 * so offering the picker there would promise something that silently vanishes.
 * The creator is added by the server as `roomAdmin` and is never sent here.
 */
export function buildCreateRoomRequest(
  form: CreateRoomFormState,
  options: { existingIds?: readonly string[]; viewerUserId?: string | null } = {},
): CreateRoomFormResult {
  const name = form.name.trim();
  const resolvedId = form.id.trim() || deriveRoomId(form.name);
  const nameError = name ? null : 'Room name is required.';
  const idError = name ? validateRoomId(resolvedId, options.existingIds ?? []) : null;
  const canSubmit = !nameError && !idError;

  if (!canSubmit) {
    return { resolvedId, nameError, idError, canSubmit, request: null };
  }

  const topic = form.topic.trim();
  const memberships = form.visibility === 'private'
    ? [...new Set(form.memberIds)]
      .filter((userId) => userId && userId !== options.viewerUserId)
      .map((userId) => ({ userId, role: 'member' as const }))
    : [];

  return {
    resolvedId,
    nameError,
    idError,
    canSubmit,
    request: {
      id: resolvedId,
      kind: 'orgRoom',
      visibility: form.visibility,
      title: name,
      ...(topic ? { topic } : {}),
      ...(memberships.length > 0 ? { memberships } : {}),
      agentPostingEnabled: form.agentPostingEnabled,
    },
  };
}

export interface DmRequestResult {
  /** Every participant, the viewer included, as the server counts them. */
  participants: string[];
  error: string | null;
  request: CreateConversationInput | null;
}

/**
 * Build a direct-conversation create request from the picked members.
 *
 * The server counts the creator as a participant and rejects a set that does
 * not contain them, so the viewer is folded in here rather than being another
 * checkbox the user has to remember to tick.
 */
export function buildDirectMessageRequest(
  selectedMemberIds: readonly string[],
  viewerUserId: string | null | undefined,
): DmRequestResult {
  if (!viewerUserId) {
    return {
      participants: [],
      error: 'Your membership in this organization is still resolving.',
      request: null,
    };
  }
  const participants = [
    viewerUserId,
    ...[...new Set(selectedMemberIds)].filter(
      (userId) => userId && userId !== viewerUserId,
    ),
  ];
  if (participants.length < MIN_DM_PARTICIPANTS) {
    return { participants, error: 'Pick at least one person.', request: null };
  }
  if (participants.length > MAX_DM_PARTICIPANTS) {
    return {
      participants,
      error: `A direct message holds at most ${MAX_DM_PARTICIPANTS} people, including you.`,
      request: null,
    };
  }
  return {
    participants,
    error: null,
    request: {
      kind: 'dm',
      visibility: 'private',
      memberships: participants.map((userId) => ({
        userId,
        role: 'member' as const,
      })),
    },
  };
}

/**
 * An existing direct conversation with exactly this participant set, if the
 * caller knows any DM's participants.
 *
 * The directory listing embeds each DM's participants, so this normally
 * resolves and the compose flow reuses the existing conversation instead of
 * creating a duplicate. A DM whose participants the server did not supply is
 * skipped rather than guessed at.
 */
export function findExistingDirectMessage(
  conversations: readonly ConversationDirectoryEntry[],
  participantsByConversationId: Readonly<Record<string, readonly string[]>>,
  participants: readonly string[],
): ConversationDirectoryEntry | null {
  const wanted = participantKey(participants);
  for (const entry of conversations) {
    if (entry.kind !== 'dm' || entry.archivedAt !== undefined) continue;
    const known = participantsByConversationId[entry.id];
    if (!known) continue;
    if (participantKey(known) === wanted) return entry;
  }
  return null;
}

function participantKey(participants: readonly string[]): string {
  return [...new Set(participants)].sort().join('\u0000');
}

export type ComposeDestinationKind = 'room' | 'member';

export interface ComposeDestination {
  kind: ComposeDestinationKind;
  /** Conversation id for a room, member id for a person. */
  id: string;
  label: string;
  sublabel?: string;
  icon: string;
}

export interface ComposeDestinationInput {
  conversations: readonly ConversationDirectoryEntry[];
  members: readonly OrgRosterMember[];
  viewerUserId?: string | null;
  query?: string;
  /**
   * The organization's messaging gating. A disabled kind is dropped from the
   * picker entirely: offering a destination the server would reject is worse
   * than a shorter list. Both default to allowed so callers without settings
   * (tests, pre-settings servers) keep the full picker.
   */
  allowRooms?: boolean;
  allowDirectMessages?: boolean;
}

/**
 * The "New message" destination list: rooms the viewer can post in, then the
 * people they can start a direct message with.
 *
 * Rooms without `comment` are left out — the picker's whole purpose is to land
 * somewhere the user can type, and a read-only room is a dead end. Archived
 * rooms and the viewer's own roster row are excluded for the same reason.
 */
export function buildComposeDestinations(
  input: ComposeDestinationInput,
): ComposeDestination[] {
  const needle = (input.query ?? '').trim().toLowerCase();
  const rooms: ComposeDestination[] = [];
  for (const entry of input.conversations) {
    if (input.allowRooms === false) break;
    if (entry.kind !== 'orgRoom') continue;
    if (entry.archivedAt !== undefined) continue;
    if (!entry.capabilities.includes('comment')) continue;
    rooms.push({
      kind: 'room',
      id: entry.id,
      label: roomLabel(entry),
      sublabel: entry.topic?.trim() || undefined,
      icon: entry.visibility === 'private' ? 'lock' : 'tag',
    });
  }
  rooms.sort((left, right) => left.label.localeCompare(right.label, undefined, {
    sensitivity: 'base',
  }));

  const people: ComposeDestination[] = (
    input.allowDirectMessages === false ? [] : input.members
  )
    .filter((member) => member.memberId !== input.viewerUserId)
    .map((member) => ({
      kind: 'member' as const,
      id: member.memberId,
      label: member.name?.trim() || member.email || member.memberId,
      sublabel: member.email || undefined,
      icon: 'person',
    }))
    .sort((left, right) => left.label.localeCompare(right.label, undefined, {
      sensitivity: 'base',
    }));

  const all = [...rooms, ...people];
  if (!needle) return all;
  return all.filter((destination) => (
    destination.label.toLowerCase().includes(needle)
    || destination.id.toLowerCase().includes(needle)
    || (destination.sublabel?.toLowerCase().includes(needle) ?? false)
  ));
}

export interface RoomMemberRow {
  memberId: string;
  label: string;
  sublabel?: string;
  /** Null when the member has no explicit membership in this room. */
  roomRole: ConversationMembership['role'] | null;
  isViewer: boolean;
}

/**
 * Join the org roster against a conversation's memberships.
 *
 * `memberships` is only knowable after a membership mutation returns it — the
 * directory listing has no members and there is no per-conversation members
 * endpoint yet — so callers pass null until then and the room-settings sheet
 * says so instead of rendering an empty room.
 */
export function buildRoomMemberRows(
  members: readonly OrgRosterMember[],
  memberships: readonly ConversationMembership[] | null,
  viewerUserId?: string | null,
): RoomMemberRow[] {
  const roles = new Map<string, ConversationMembership['role']>();
  for (const membership of memberships ?? []) {
    if (membership.removedAt !== undefined) continue;
    roles.set(membership.userId, membership.role);
  }
  return members.map((member) => ({
    memberId: member.memberId,
    label: member.name?.trim() || member.email || member.memberId,
    sublabel: member.email || undefined,
    roomRole: memberships ? roles.get(member.memberId) ?? null : null,
    isViewer: member.memberId === viewerUserId,
  }));
}

export interface RoomSettingsFormState {
  name: string;
  topic: string;
}

export interface RoomSettingsSaveResult {
  error: string | null;
  /** Null when nothing changed, so an unchanged save is a no-op, not a PUT. */
  input: { title?: string; topic?: string | null } | null;
}

/**
 * The title/topic PUT for a room-settings save, containing only what changed.
 *
 * The server treats a present `topic` as a replacement and an absent one as
 * "leave alone", so a rename must not carry the topic along and an untouched
 * form must not send anything at all.
 */
export function buildRoomSettingsUpdate(
  form: RoomSettingsFormState,
  entry: ConversationDirectoryEntry,
): RoomSettingsSaveResult {
  const name = form.name.trim();
  if (!name) return { error: 'Room name is required.', input: null };

  const currentName = entry.title?.trim() ?? '';
  const currentTopic = entry.topic?.trim() ?? '';
  const topic = form.topic.trim();

  const input: { title?: string; topic?: string | null } = {};
  if (name !== currentName) input.title = name;
  if (topic !== currentTopic) input.topic = topic ? topic : null;
  if (Object.keys(input).length === 0) return { error: null, input: null };
  return { error: null, input };
}
