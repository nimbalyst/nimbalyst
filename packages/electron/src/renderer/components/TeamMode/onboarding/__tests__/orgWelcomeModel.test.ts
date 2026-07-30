import { describe, expect, it } from 'vitest';

import {
  buildOrgWelcomeCard,
  generalRoomRoute,
  isGeneralRoomId,
  parseDismissedOrgIds,
  parsePendingRoute,
  pendingGeneralRoute,
  routeForPending,
  shouldShowOrgWelcome,
  withDismissedOrgId,
  type OrgWelcomeCardInput,
} from '../orgWelcomeModel';

function input(overrides: Partial<OrgWelcomeCardInput> = {}): OrgWelcomeCardInput {
  return {
    orgName: 'Acme',
    memberCount: 4,
    dismissed: false,
    ready: true,
    ...overrides,
  };
}

describe('pending route hand-off', () => {
  it('routes a window showing the queued organization onto #general', () => {
    const stored = pendingGeneralRoute('org-1');
    expect(routeForPending(stored, 'org-1')).toEqual(generalRoomRoute());
  });

  it('ignores a hand-off queued for a different organization', () => {
    expect(routeForPending(pendingGeneralRoute('org-1'), 'org-2')).toBeNull();
  });

  it('ignores an unset or malformed hand-off', () => {
    expect(routeForPending(null, 'org-1')).toBeNull();
    expect(routeForPending({ orgId: 'org-1' }, 'org-1')).toBeNull();
    expect(routeForPending('org-1', 'org-1')).toBeNull();
    expect(parsePendingRoute({ orgId: '', conversationId: 'general' })).toBeNull();
  });

  it('ignores a hand-off when no organization has resolved yet', () => {
    expect(routeForPending(pendingGeneralRoute('org-1'), null)).toBeNull();
  });
});

// The welcome card lives inside the room it describes, so every room view asks
// whether it is the one rather than each of them knowing the id.
describe('general room identity', () => {
  it('recognises #general and nothing else', () => {
    expect(isGeneralRoomId('general')).toBe(true);
    expect(isGeneralRoomId('design')).toBe(false);
    expect(isGeneralRoomId(null)).toBe(false);
    expect(isGeneralRoomId(undefined)).toBe(false);
  });
});

describe('dismissal set', () => {
  it('reads only string entries', () => {
    expect(parseDismissedOrgIds(['org-1', 2, null, 'org-2'])).toEqual(['org-1', 'org-2']);
    expect(parseDismissedOrgIds(undefined)).toEqual([]);
  });

  it('adds an organization once', () => {
    const first = withDismissedOrgId(undefined, 'org-1');
    expect(first).toEqual(['org-1']);
    expect(withDismissedOrgId(first, 'org-1')).toEqual(['org-1']);
    expect(withDismissedOrgId(first, 'org-2')).toEqual(['org-1', 'org-2']);
  });
});

describe('welcome card', () => {
  it('shows once the roster is ready and the card was never dismissed', () => {
    expect(shouldShowOrgWelcome(input())).toBe(true);
    expect(shouldShowOrgWelcome(input({ dismissed: true }))).toBe(false);
    expect(shouldShowOrgWelcome(input({ ready: false }))).toBe(false);
  });

  it('names the organization, the member count and the window sections', () => {
    const card = buildOrgWelcomeCard(input());
    expect(card.title).toBe('Welcome to Acme');
    expect(card.subtitle).toBe('4 members so far.');
    expect(card.points.join(' ')).toContain('#general');
    expect(card.points.join(' ')).toContain('Inbox');
  });

  it('credits the inviter when one is known', () => {
    expect(buildOrgWelcomeCard(input({ inviterName: 'Karl' })).subtitle)
      .toBe('Karl invited you. 4 members so far.');
  });

  it('reads naturally for a single member and an unnamed organization', () => {
    const card = buildOrgWelcomeCard(input({ memberCount: 1, orgName: '  ' }));
    expect(card.title).toBe('Welcome to your organization');
    expect(card.subtitle).toBe('1 member so far.');
  });
});
