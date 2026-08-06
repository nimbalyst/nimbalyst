// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { asTeamMemberId } from '@nimbalyst/runtime/auth/jwtScopes';
import {
  describePresenceChange,
  emptyPresenceAnnouncementState,
} from '../presenceAnnouncements';
import type { CollabEditorParticipant } from '../types';

function participant(
  memberId: string,
  displayName: string,
  hasSelection = false,
): CollabEditorParticipant {
  return {
    memberId: asTeamMemberId(memberId),
    displayName,
    cursorColor: '#3A8FD6',
    hasSelection,
  };
}

const rowan = participant('member-rowan', 'Rowan Petrie');
const dana = participant('member-dana', 'Dana Okafor');

describe('presence announcements', () => {
  it('describes the existing roster once, then only membership changes', () => {
    const first = describePresenceChange(emptyPresenceAnnouncementState, [rowan]);
    expect(first.message).toBe('Rowan Petrie is also editing this document.');

    const unchanged = describePresenceChange(first, [rowan]);
    expect(unchanged.message).toBeNull();
  });

  it('stays silent while a participant moves, selects, or is renamed', () => {
    const described = describePresenceChange(emptyPresenceAnnouncementState, [rowan, dana]);
    expect(described.message).toContain('Rowan Petrie');

    // The presence surface re-emits on selection changes, so this is the shape
    // that would otherwise speak on every collaborator keystroke.
    const afterSelection = describePresenceChange(described, [
      participant('member-rowan', 'Rowan Petrie', true),
      participant('member-dana', 'Dana Okafor', true),
    ]);
    expect(afterSelection.message).toBeNull();

    const afterRename = describePresenceChange(afterSelection, [
      participant('member-rowan', 'rowan@example.com'),
      dana,
    ]);
    expect(afterRename.message).toBeNull();
  });

  it('folds a join and a departure in the same window into one message', () => {
    const described = describePresenceChange(emptyPresenceAnnouncementState, [rowan]);
    // Rowan left and Dana arrived between debounced flushes: the roster only
    // advances when something is said, so both survive into one sentence pair
    // rather than one overwriting the other in the live region.
    const folded = describePresenceChange(described, [dana]);
    expect(folded.message).toBe('Dana Okafor joined the document. Rowan Petrie left the document.');
  });

  it('names a departed participant from the last announced roster', () => {
    const described = describePresenceChange(emptyPresenceAnnouncementState, [rowan, dana]);
    const departed = describePresenceChange(described, [rowan]);
    expect(departed.message).toBe('Dana Okafor left the document.');
  });

  it('summarises large rooms instead of reading every name', () => {
    const crowd = ['ana', 'bo', 'cai', 'dev', 'eze']
      .map((name, index) => participant(`member-${name}`, `Member ${index}`));
    const described = describePresenceChange(emptyPresenceAnnouncementState, crowd);
    expect(described.message)
      .toBe('5 people are also editing this document: Member 0, Member 1 and 3 others.');
  });
});
