// @vitest-environment node
import { describe, expect, it } from 'vitest';

import type { ConversationDirectoryEntry } from '../../../../shared/conversationDirectory';
import {
  buildRoomHeader,
  roomEmptyLabel,
  toCommentCapabilities,
  toMentionDirectory,
} from '../roomViewModel';
import { memberNamesById, resolveViewerMemberId } from '../useOrgRoster';

function descriptor(
  overrides: Partial<ConversationDirectoryEntry> = {},
): ConversationDirectoryEntry {
  return {
    id: 'general',
    orgId: 'org-a',
    kind: 'orgRoom',
    visibility: 'public',
    title: 'General',
    agentPostingEnabled: false,
    createdByUserId: 'member-a',
    createdAt: 1,
    capabilities: ['read', 'comment', 'react', 'editOwnComment', 'deleteOwnComment'],
    ...overrides,
  };
}

const members = [
  { memberId: 'member-a', email: 'greg@example.com', name: 'Greg Hinkle', role: 'owner' },
  { memberId: 'member-b', email: 'karl@example.com', name: 'Karl', role: 'member' },
  { memberId: 'member-c', email: 'karl@other.example.com', name: 'Karl B', role: 'member' },
];

describe('toCommentCapabilities', () => {
  it('grants only what the server resolved', () => {
    expect(toCommentCapabilities(['read', 'receiveNotification'])).toEqual({
      read: true,
      comment: false,
      react: false,
      editOwn: false,
      deleteOwn: false,
      moderate: false,
      manageRoom: false,
    });
    expect(toCommentCapabilities(['read', 'comment', 'manageRoom']).manageRoom).toBe(true);
  });
});

describe('buildRoomHeader', () => {
  it('renders a room with its hash prefix, topic and composer label', () => {
    const header = buildRoomHeader(descriptor({ topic: '  Org-wide chat  ' }));
    expect(header).toMatchObject({
      title: 'General',
      prefix: '#',
      topic: 'Org-wide chat',
      isPrivate: false,
      archived: false,
      composerLabel: 'Message #General',
    });
  });

  it('labels a DM by its participants and never prefixes it', () => {
    const header = buildRoomHeader(
      descriptor({ id: 'dm-1', kind: 'dm', visibility: 'private', title: undefined }),
      {
        dmParticipants: ['member-a', 'member-b'],
        memberNames: { 'member-a': 'Greg', 'member-b': 'Karl' },
        viewerUserId: 'member-a',
      },
    );
    expect(header.title).toBe('Karl');
    expect(header.prefix).toBe('');
    expect(header.isPrivate).toBe(true);
    expect(header.composerLabel).toBe('Message Karl');
  });

  it('marks an archived room', () => {
    expect(buildRoomHeader(descriptor({ archivedAt: 42 })).archived).toBe(true);
  });
});

describe('roomEmptyLabel', () => {
  it('invites the first message in an empty room', () => {
    expect(roomEmptyLabel(buildRoomHeader(descriptor()), true))
      .toBe('This is the beginning of #General. Send the first message to get it started.');
  });

  it('drops the invitation when the viewer may only read', () => {
    const label = roomEmptyLabel(buildRoomHeader(descriptor()), false);
    expect(label).toContain('This is the beginning of #General');
    expect(label).not.toContain('Send the first message');
  });

  it('greets the other person in an empty DM', () => {
    const header = buildRoomHeader(
      descriptor({ id: 'dm-1', kind: 'dm', visibility: 'private', title: undefined }),
      {
        dmParticipants: ['member-a', 'member-b'],
        memberNames: { 'member-a': 'Greg', 'member-b': 'Karl' },
        viewerUserId: 'member-a',
      },
    );
    expect(roomEmptyLabel(header, true))
      .toBe('This is the beginning of your conversation with Karl. Say hello.');
  });

  it('says so instead of inviting a message an archived room cannot take', () => {
    expect(roomEmptyLabel(buildRoomHeader(descriptor({ archivedAt: 42 })), true))
      .toBe('#General was archived without any messages.');
  });
});

describe('toMentionDirectory', () => {
  it('derives typeable handles from emails and keeps collisions addressable', () => {
    const directory = toMentionDirectory(members, 'member-a');
    expect(directory.people.map((person) => person.handle))
      .toEqual(['greg', 'karl', 'karl2']);
    expect(directory.people[0].displayName).toBe('You');
    expect(directory.people[1].avatarInitials).toBe('KA');
    expect(directory.displayNames['member-b']).toBe('Karl');
  });
});

describe('viewer identity', () => {
  it('joins the signed-in account to the roster by email', () => {
    expect(resolveViewerMemberId(members, ['GREG@example.com'])).toBe('member-a');
    expect(resolveViewerMemberId(members, ['nobody@example.com'])).toBeNull();
    expect(resolveViewerMemberId(members, [null, undefined])).toBeNull();
  });

  // NIM-2459: with both accounts on the roster the viewer used to be whichever
  // row the server listed first, so a DM titled itself after the viewer.
  it('picks the sync account when two signed-in accounts are both on the roster', () => {
    const both = ['karl@example.com', 'greg@example.com'];
    expect(resolveViewerMemberId(members, both, 'karl@example.com')).toBe('member-b');
    expect(resolveViewerMemberId(members, both, 'greg@example.com')).toBe('member-a');

    const dm = descriptor({ id: 'dm-1', kind: 'dm', title: undefined });
    const names = memberNamesById(members);
    expect(buildRoomHeader(dm, {
      dmParticipants: ['member-a', 'member-b'],
      memberNames: names,
      viewerUserId: resolveViewerMemberId(members, both, 'karl@example.com') ?? undefined,
    }).title).toBe('Greg Hinkle');

    // A sync account off this roster still falls back to first-match.
    expect(resolveViewerMemberId(members, both, 'elsewhere@example.com')).toBe('member-a');
  });

  it('names members by display name, falling back to email', () => {
    expect(memberNamesById([
      ...members,
      { memberId: 'member-d', email: 'no.name@example.com', name: '', role: 'member' },
    ])).toMatchObject({
      'member-a': 'Greg Hinkle',
      'member-d': 'no.name@example.com',
    });
  });
});
