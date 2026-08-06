// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { parseInviteDeepLink } from '../inviteDeepLinks';

describe('parseInviteDeepLink', () => {
  it('reads the orgId from the authority form the console emits', () => {
    expect(parseInviteDeepLink('nimbalyst://invite/org-acme?email=Invitee%40Test.com')).toEqual({
      orgId: 'org-acme',
      email: 'invitee@test.com',
    });
  });

  it('reads the path form, which is how Windows/Linux argv-delivered links parse', () => {
    expect(parseInviteDeepLink('nimbalyst:///invite/org-acme')).toEqual({ orgId: 'org-acme' });
  });

  it('rejects a link that is not an invite route, so a mistyped host cannot join a team', () => {
    expect(() => parseInviteDeepLink('nimbalyst://doc/doc-1?orgId=org-acme'))
      .toThrow(/not a Nimbalyst invite deep link/);
  });

  it('rejects an invite route with no orgId', () => {
    expect(() => parseInviteDeepLink('nimbalyst://invite/?email=invitee@test.com'))
      .toThrow(/requires an orgId/);
  });
});
