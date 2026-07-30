import { describe, expect, it } from 'vitest';

import {
  ORG_WIZARD_STEPS,
  addEmails,
  advance,
  canAdvance,
  canSkip,
  createOrgWizardState,
  deriveRoomId,
  isLikelyEmail,
  markInvited,
  markRoomsCreated,
  orgAvatarColor,
  orgAvatarInitials,
  parseEmailInput,
  pendingInvites,
  pendingStarterRooms,
  removeEmail,
  shouldPostWelcome,
  starterRoomCreateInput,
  stepStatus,
  toggleStarterRoom,
  welcomeMessageText,
  type OrgWizardState,
} from '../orgWizardModel';

function created(overrides: Partial<OrgWizardState> = {}): OrgWizardState {
  return {
    ...createOrgWizardState({ orgName: 'Acme' }),
    createdOrgId: 'org-1',
    step: 'invite',
    ...overrides,
  };
}

describe('step machine', () => {
  it('walks the four steps in order and stops at the end', () => {
    let state = createOrgWizardState({ orgName: 'Acme' });
    expect(state.step).toBe('identity');
    for (const step of ORG_WIZARD_STEPS.slice(1)) {
      state = advance(state);
      expect(state.step).toBe(step);
    }
    expect(advance(state).step).toBe('done');
  });

  it('reports each step as completed, active or upcoming', () => {
    const state = created({ step: 'rooms' });
    expect(stepStatus(state, 'identity')).toBe('completed');
    expect(stepStatus(state, 'invite')).toBe('completed');
    expect(stepStatus(state, 'rooms')).toBe('active');
    expect(stepStatus(state, 'done')).toBe('upcoming');
  });

  it('only lets the first step run once it has a name', () => {
    const empty = createOrgWizardState();
    expect(canAdvance(empty)).toBe(false);
    expect(canAdvance({ ...empty, orgName: '   ' })).toBe(false);
    expect(canAdvance({ ...empty, orgName: 'Acme' })).toBe(true);
  });

  it('blocks every action while a step is in flight', () => {
    expect(canAdvance({ ...created(), busy: true })).toBe(false);
    expect(canSkip({ ...created(), busy: true })).toBe(false);
  });

  it('offers a skip on the optional steps only', () => {
    expect(canSkip(createOrgWizardState({ orgName: 'Acme' }))).toBe(false);
    expect(canSkip(created({ step: 'invite' }))).toBe(true);
    expect(canSkip(created({ step: 'rooms' }))).toBe(true);
    expect(canSkip(created({ step: 'done' }))).toBe(false);
  });

  it('requires the organization to exist before the later steps act', () => {
    // Closing the wizard after step 1 leaves a valid org; the inverse — being
    // past step 1 without one — must never let an invite or room fire.
    expect(canAdvance({ ...createOrgWizardState({ orgName: 'Acme' }), step: 'invite' })).toBe(false);
  });
});

describe('email entry', () => {
  it('accepts plausible addresses and rejects text that cannot be one', () => {
    expect(isLikelyEmail('karl@example.com')).toBe(true);
    expect(isLikelyEmail(' karl@example.co.uk ')).toBe(true);
    expect(isLikelyEmail('karl@localhost')).toBe(false);
    expect(isLikelyEmail('karl example.com')).toBe(false);
    expect(isLikelyEmail('@example.com')).toBe(false);
  });

  it('splits a pasted list on commas, semicolons and whitespace', () => {
    const parsed = parseEmailInput('karl@example.com, josh@example.com; sarah@example.com\nnope');
    expect(parsed.emails).toEqual([
      'karl@example.com',
      'josh@example.com',
      'sarah@example.com',
    ]);
    expect(parsed.invalid).toEqual(['nope']);
  });

  it('normalizes case and drops duplicates within one paste', () => {
    expect(parseEmailInput('Karl@Example.com karl@example.com').emails)
      .toEqual(['karl@example.com']);
  });

  it('does not re-stage an address that is already a chip or already invited', () => {
    const state = created({ emails: ['karl@example.com'], invitedEmails: ['josh@example.com'] });
    const result = addEmails(state, 'KARL@example.com, josh@example.com, sarah@example.com');
    expect(result.state.emails).toEqual(['karl@example.com', 'sarah@example.com']);
  });

  it('returns the state untouched when a paste adds nothing', () => {
    const state = created({ emails: ['karl@example.com'] });
    expect(addEmails(state, 'karl@example.com').state).toBe(state);
  });

  it('removes a chip case-insensitively', () => {
    const state = created({ emails: ['karl@example.com', 'josh@example.com'] });
    expect(removeEmail(state, 'KARL@example.com').emails).toEqual(['josh@example.com']);
  });

  it('only owes invites to addresses the server has not accepted', () => {
    const state = created({
      emails: ['karl@example.com', 'josh@example.com'],
      invitedEmails: ['karl@example.com'],
    });
    expect(pendingInvites(state)).toEqual(['josh@example.com']);
  });

  it('records sent invites once, so a retry re-sends nothing', () => {
    let state = created({ emails: ['karl@example.com'] });
    state = markInvited(state, ['karl@example.com']);
    state = markInvited(state, ['KARL@example.com']);
    expect(state.invitedEmails).toEqual(['karl@example.com']);
    expect(pendingInvites(state)).toEqual([]);
  });
});

describe('starter rooms', () => {
  it('toggles a selection on and off', () => {
    const state = toggleStarterRoom(created(), 'dev');
    expect(state.selectedRoomIds).toEqual(['dev']);
    expect(toggleStarterRoom(state, 'dev').selectedRoomIds).toEqual([]);
  });

  it('only creates the rooms that were selected', () => {
    const state = created({ selectedRoomIds: ['dev', 'releases'] });
    expect(pendingStarterRooms(state).map((room) => room.id)).toEqual(['dev', 'releases']);
  });

  it('skips rooms this run already created', () => {
    const state = created({ selectedRoomIds: ['dev', 'design'], createdRoomIds: ['dev'] });
    expect(pendingStarterRooms(state).map((room) => room.id)).toEqual(['design']);
  });

  it('skips rooms the organization already has, including #general', () => {
    const state = created({ selectedRoomIds: ['dev', 'design'] });
    expect(pendingStarterRooms(state, ['general', 'design']).map((room) => room.id))
      .toEqual(['dev']);
  });

  it('records created rooms once', () => {
    let state = markRoomsCreated(created(), ['dev']);
    state = markRoomsCreated(state, ['dev']);
    expect(state.createdRoomIds).toEqual(['dev']);
  });

  it('builds a public org room from a starter option', () => {
    const input = starterRoomCreateInput({ id: 'dev', title: 'dev', topic: 'Engineering' });
    expect(input).toEqual({
      id: 'dev',
      kind: 'orgRoom',
      visibility: 'public',
      title: 'dev',
      topic: 'Engineering',
    });
  });

  it('derives a server-legal room id from a label', () => {
    expect(deriveRoomId('#Release Chatter!')).toBe('release-chatter');
    expect(deriveRoomId('  design  ')).toBe('design');
  });
});

describe('identity preview', () => {
  it('takes initials from the first two words', () => {
    expect(orgAvatarInitials('Acme Research Labs')).toBe('AR');
    expect(orgAvatarInitials('nimbalyst')).toBe('NI');
    expect(orgAvatarInitials('   ')).toBe('?');
  });

  it('picks a stable colour for a given name', () => {
    expect(orgAvatarColor('Acme')).toBe(orgAvatarColor('acme '));
    expect(orgAvatarColor('')).toBe(orgAvatarColor(''));
  });
});

describe('welcome message', () => {
  it('names the organization and explains the window', () => {
    const text = welcomeMessageText('Acme');
    expect(text).toContain('Welcome to Acme.');
    expect(text).toContain('#general');
    expect(text).toContain('Inbox');
  });

  it('posts once per organization', () => {
    const state = created();
    expect(shouldPostWelcome(state)).toBe(true);
    expect(shouldPostWelcome({ ...state, welcomePosted: true })).toBe(false);
    expect(shouldPostWelcome(createOrgWizardState())).toBe(false);
  });
});
