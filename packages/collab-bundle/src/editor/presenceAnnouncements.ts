import type { CollabEditorParticipant } from './types';

/**
 * What a screen-reader user is told about the other people in the room.
 *
 * Presence is rendered as remote carets, selection rectangles and a participant
 * list — all of which are silent to assistive tech, and all of which change
 * constantly. `CollabPresenceSurface` emits on selection changes too, so
 * anything wired naively to that stream would speak on every collaborator
 * keystroke, which is unusable.
 *
 * The judgment here: announce *arrivals and departures* and nothing else.
 * Membership is the part of presence a person needs to know and cannot infer —
 * someone joining changes whether you are alone with the document — while
 * cursor position and typing are continuous and are already carried by the
 * document text. Diffing on member id, never on display name, color, or
 * selection state, is what keeps ordinary activity silent.
 */

interface KnownParticipant {
  memberId: string;
  displayName: string;
}

export interface PresenceAnnouncementState {
  /** The roster as of the last announcement, not the last presence emission. */
  known: readonly KnownParticipant[];
  /** Whether the room roster has been described once since mounting. */
  described: boolean;
}

export interface PresenceAnnouncementResult extends PresenceAnnouncementState {
  /** Null when nothing worth speaking changed. */
  message: string | null;
}

export const emptyPresenceAnnouncementState: PresenceAnnouncementState = {
  known: [],
  described: false,
};

/** "A", "A and B", "A, B and C", "A, B and 2 others". */
function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} others`;
}

function toKnown(participants: readonly CollabEditorParticipant[]): KnownParticipant[] {
  return participants.map((participant) => ({
    memberId: String(participant.memberId),
    displayName: participant.displayName,
  }));
}

/**
 * Fold a presence snapshot into the next announcement.
 *
 * Callers debounce: because the roster only advances when something is actually
 * said, a join and a departure inside one window collapse into a single message
 * instead of two that overwrite each other before a screen reader speaks them.
 */
export function describePresenceChange(
  state: PresenceAnnouncementState,
  participants: readonly CollabEditorParticipant[],
): PresenceAnnouncementResult {
  const next = toKnown(participants);

  if (!state.described) {
    // Say who is already here exactly once, so someone opening a shared
    // document learns they are not alone without going to find the roster.
    const names = next.map((participant) => participant.displayName);
    return {
      known: next,
      described: true,
      message: names.length === 0
        ? null
        : names.length === 1
          ? `${names[0]} is also editing this document.`
          : `${names.length} people are also editing this document: ${joinNames(names)}.`,
    };
  }

  const knownIds = new Set(state.known.map((participant) => participant.memberId));
  const currentIds = new Set(next.map((participant) => participant.memberId));
  const arrived = next.filter((participant) => !knownIds.has(participant.memberId));
  // Departed members are gone from the snapshot, so their names come from the
  // roster captured at the last announcement.
  const departed = state.known.filter((participant) => !currentIds.has(participant.memberId));

  if (arrived.length === 0 && departed.length === 0) {
    return { ...state, message: null };
  }

  const sentences: string[] = [];
  if (arrived.length > 0) {
    sentences.push(`${joinNames(arrived.map((one) => one.displayName))} joined the document.`);
  }
  if (departed.length > 0) {
    sentences.push(`${joinNames(departed.map((one) => one.displayName))} left the document.`);
  }
  return { known: next, described: true, message: sentences.join(' ') };
}
