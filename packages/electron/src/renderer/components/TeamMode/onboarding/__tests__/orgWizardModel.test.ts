import { describe, expect, it } from 'vitest';

import {
  ORG_WIZARD_STEPS,
  addEmails,
  advance,
  canAdvance,
  canSkip,
  createOrgWizardState,
  defaultSourcePersonalOrgId,
  draftOwnerMatches,
  isLikelyEmail,
  markInvited,
  orgAvatarColor,
  orgAvatarInitials,
  orgWizardSteps,
  rehydrateOrgWizardDraft,
  resolveAuthenticatedAccount,
  resolveSourcePersonalOrgId,
  serializeOrgWizardDraft,
  parseEmailInput,
  pendingInvites,
  removeEmail,
  stepStatus,
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
  it('starts signed-out users at account and skips account for signed-in users', () => {
    expect(orgWizardSteps(false)).toEqual([
      'account',
      'identity',
      'invite',
      'done',
    ]);
    expect(orgWizardSteps(true)).toEqual([
      'identity',
      'invite',
      'done',
    ]);
    expect(createOrgWizardState({ isAuthenticated: false }).step).toBe('account');
    expect(createOrgWizardState({ isAuthenticated: true }).step).toBe('identity');
  });

  it('walks the steps in order and stops at the end', () => {
    let state = createOrgWizardState({ orgName: 'Acme', isAuthenticated: false });
    expect(state.step).toBe('account');
    for (const step of ORG_WIZARD_STEPS.slice(1)) {
      state = advance(state);
      expect(state.step).toBe(step);
    }
    expect(advance(state).step).toBe('done');
  });

  it('reports each step as completed, active or upcoming', () => {
    const state = created({ step: 'invite' });
    expect(stepStatus(state, 'identity')).toBe('completed');
    expect(stepStatus(state, 'invite')).toBe('active');
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

  it('offers a skip on the optional step only', () => {
    expect(canSkip(createOrgWizardState({ orgName: 'Acme' }))).toBe(false);
    expect(canSkip(created({ step: 'invite' }))).toBe(true);
    expect(canSkip(created({ step: 'done' }))).toBe(false);
  });

  it('requires the organization to exist before the later steps act', () => {
    // Closing the wizard after step 1 leaves a valid org; the inverse — being
    // past step 1 without one — must never let an invite fire.
    expect(canAdvance({ ...createOrgWizardState({ orgName: 'Acme' }), step: 'invite' })).toBe(false);
  });
});

describe('authentication branch', () => {
  it('exposes a pending invitation matching the signed-in email', () => {
    const state = resolveAuthenticatedAccount(
      createOrgWizardState({ isAuthenticated: false }),
      {
        orgId: 'org-acme',
        name: 'Acme Robotics',
        email: 'member@example.com',
      },
    );

    expect(state.step).toBe('identity');
    expect(state.pendingInvitation).toEqual({
      orgId: 'org-acme',
      name: 'Acme Robotics',
      email: 'member@example.com',
    });
  });

  it('continues directly to identity when there is no matching invitation', () => {
    const state = resolveAuthenticatedAccount(
      createOrgWizardState({ isAuthenticated: false }),
      null,
    );

    expect(state.step).toBe('identity');
    expect(state.pendingInvitation).toBeNull();
  });
});

describe('draft persistence', () => {
  it('rehydrates the organization name and staged choices', () => {
    const draft = serializeOrgWizardDraft({
      ...createOrgWizardState({ orgName: 'Acme Robotics' }),
      emails: ['member@example.com'],
    });

    expect(rehydrateOrgWizardDraft(draft)).toMatchObject({
      orgName: 'Acme Robotics',
      emails: ['member@example.com'],
    });
  });

  /**
   * One machine, several accounts: the draft key is global, so the identity
   * that typed it is the only thing that can tell whose org name this is.
   */
  it('round-trips the owner and only matches that identity', () => {
    const draft = serializeOrgWizardDraft({
      ...createOrgWizardState({ orgName: 'Acme Robotics', owner: 'me@example.com' }),
    });

    expect(draft.owner).toBe('me@example.com');
    expect(rehydrateOrgWizardDraft(draft)?.owner).toBe('me@example.com');
    expect(draftOwnerMatches('me@example.com', 'ME@Example.com')).toBe(true);
    expect(draftOwnerMatches('me@example.com', 'other@example.com')).toBe(false);
    expect(draftOwnerMatches('me@example.com', null)).toBe(false);
  });

  it('treats a draft typed before sign-in as belonging to whoever signs in', () => {
    const draft = serializeOrgWizardDraft(
      createOrgWizardState({ orgName: 'Acme Robotics', isAuthenticated: false }),
    );

    expect(draft.owner).toBeNull();
    expect(draftOwnerMatches(null, 'me@example.com')).toBe(true);
    expect(draftOwnerMatches(null, null)).toBe(true);
  });

  // Drafts written before owner scoping existed have no `owner` key at all.
  it('reads a version-1 draft with no owner field as owner-less', () => {
    const state = rehydrateOrgWizardDraft({
      version: 1,
      step: 'identity',
      orgName: 'Legacy',
      sourcePersonalOrgId: '',
      workspacePath: null,
      createdOrgId: null,
      emails: [],
      invitedEmails: [],
    });

    expect(state?.owner).toBeNull();
    expect(state?.orgName).toBe('Legacy');
  });

  /**
   * Invite and done are entirely about an organization. A draft that names one
   * of them without an id would render a screen whose every action needs an org
   * that does not exist.
   */
  it('rewinds a post-create step that has no created organization', () => {
    const base = {
      version: 1 as const,
      orgName: 'Acme',
      sourcePersonalOrgId: '',
      workspacePath: null,
      createdOrgId: null,
      emails: [],
      invitedEmails: [],
    };

    for (const step of ['invite', 'rooms', 'done'] as const) {
      expect(rehydrateOrgWizardDraft({ ...base, step, owner: 'me@example.com' })?.step)
        .toBe('identity');
      // Nobody ever signed in, so naming an org is not the next thing either.
      expect(rehydrateOrgWizardDraft({ ...base, step })?.step).toBe('account');
    }
  });

  it('keeps a post-create step that does have its organization', () => {
    const state = rehydrateOrgWizardDraft({
      version: 1,
      step: 'invite',
      orgName: 'Acme',
      owner: 'me@example.com',
      sourcePersonalOrgId: '',
      workspacePath: null,
      createdOrgId: 'org-1',
      emails: [],
      invitedEmails: [],
    });

    expect(state?.step).toBe('invite');
    expect(state?.createdOrgId).toBe('org-1');
  });

  /**
   * The retired starter-rooms step sat between invite and done, so a draft
   * paused there has an organization already and nothing left to do — dropping
   * the draft would offer to create a second one.
   */
  it('resumes a draft paused on the retired rooms step at done', () => {
    const state = rehydrateOrgWizardDraft({
      version: 1,
      step: 'rooms',
      orgName: 'Acme',
      owner: 'me@example.com',
      sourcePersonalOrgId: '',
      workspacePath: null,
      createdOrgId: 'org-1',
      emails: [],
      invitedEmails: ['karl@example.com'],
      selectedRoomIds: ['dev'],
      createdRoomIds: [],
      welcomePosted: false,
    });

    expect(state?.step).toBe('done');
    expect(state?.createdOrgId).toBe('org-1');
    expect(state?.invitedEmails).toEqual(['karl@example.com']);
  });
});

/**
 * The retired CreateTeamDialog picked the sync account, not the first row the
 * accounts directory happened to return; folding it into the wizard kept the
 * picker but had lost that preference.
 */
describe('owning personal account', () => {
  const accounts = [
    { personalOrgId: 'work', email: 'work@example.com', isSyncAccount: false, sessionStatus: 'active' as const },
    { personalOrgId: 'personal', email: 'me@example.com', isSyncAccount: true, sessionStatus: 'active' as const },
  ];

  it('defaults to the sync account instead of ambient account order', () => {
    expect(defaultSourcePersonalOrgId(accounts)).toBe('personal');
  });

  it('falls back to the first account when none is the sync account', () => {
    expect(defaultSourcePersonalOrgId([
      { personalOrgId: 'work', email: 'work@example.com', isSyncAccount: false },
      { personalOrgId: 'other', email: 'other@example.com', isSyncAccount: false },
    ])).toBe('work');
    expect(defaultSourcePersonalOrgId([])).toBe('');
  });

  // An expired session cannot create anything, so it does not win the default
  // just for being the sync account.
  it('skips an expired session while another account is usable', () => {
    expect(defaultSourcePersonalOrgId([
      { personalOrgId: 'work', email: 'work@example.com', isSyncAccount: false, sessionStatus: 'active' },
      { personalOrgId: 'personal', email: 'me@example.com', isSyncAccount: true, sessionStatus: 'expired' },
    ])).toBe('work');
  });

  it('keeps a restored choice that still exists and resets one that does not', () => {
    expect(resolveSourcePersonalOrgId('work', accounts)).toBe('work');
    expect(resolveSourcePersonalOrgId('removed', accounts)).toBe('personal');
    // No account list is not evidence the choice is gone.
    expect(resolveSourcePersonalOrgId('work', [])).toBe('work');
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
