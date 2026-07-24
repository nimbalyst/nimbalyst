import { describe, it, expect } from 'vitest';
import {
  getOrgIdFromJwt,
  getJwtExp,
  assertJwtMatchesOrg,
  AuthContextMismatchError,
} from '../jwtOrg';

/** Build an unsigned JWT (header.payload.sig) for claim-decoding tests. */
function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.sig`;
}

describe('jwtOrg', () => {
  it('extracts a top-level organization_id claim', () => {
    const jwt = makeJwt({ sub: 'm1', organization_id: 'org-team' });
    expect(getOrgIdFromJwt(jwt)).toBe('org-team');
  });

  // Real Stytch B2B session JWTs nest the org under the namespaced claim, NOT a
  // top-level organization_id. Reading only the top level returned null for
  // every real token, so assertJwtMatchesOrg rejected all valid org-scoped
  // tokens as "no-org" and team sync broke on restart (the regression this
  // helper exists to prevent, ironically caused by the helper itself).
  it('extracts the org from the Stytch namespaced organization claim', () => {
    const jwt = makeJwt({
      sub: 'member-live-1',
      'https://stytch.com/organization': { organization_id: 'organization-live-abc', slug: 'team' },
    });
    expect(getOrgIdFromJwt(jwt)).toBe('organization-live-abc');
  });

  it('passes assertJwtMatchesOrg for a real Stytch-shaped org token', () => {
    const jwt = makeJwt({
      sub: 'member-live-1',
      'https://stytch.com/organization': { organization_id: 'organization-live-abc' },
    });
    expect(() => assertJwtMatchesOrg(jwt, 'organization-live-abc')).not.toThrow();
  });

  it('prefers the namespaced claim over a top-level organization_id', () => {
    const jwt = makeJwt({
      organization_id: 'org-top',
      'https://stytch.com/organization': { organization_id: 'org-namespaced' },
    });
    expect(getOrgIdFromJwt(jwt)).toBe('org-namespaced');
  });

  it('returns null org for a malformed jwt', () => {
    expect(getOrgIdFromJwt('not-a-jwt')).toBeNull();
    expect(getOrgIdFromJwt('')).toBeNull();
    expect(getOrgIdFromJwt('a.b')).toBeNull();
  });

  it('extracts the exp claim', () => {
    const jwt = makeJwt({ sub: 'm1', organization_id: 'o', exp: 1234567890 });
    expect(getJwtExp(jwt)).toBe(1234567890);
    expect(getJwtExp('garbage')).toBeNull();
  });

  describe('assertJwtMatchesOrg', () => {
    it('passes when the token org matches the requested org', () => {
      const jwt = makeJwt({ sub: 'm1', organization_id: 'org-team' });
      expect(() => assertJwtMatchesOrg(jwt, 'org-team')).not.toThrow();
    });

    // NIM-949: a demoted/personal-org token exchanged under a team orgId must be
    // rejected, not cached and served. This is the data-safety regression guard.
    it('throws AuthContextMismatchError when the token is scoped to a different org', () => {
      const personalOrgToken = makeJwt({ sub: 'personal-member', organization_id: 'org-personal' });
      expect(() => assertJwtMatchesOrg(personalOrgToken, 'org-team')).toThrow(AuthContextMismatchError);
    });

    it('throws when the token carries no org claim', () => {
      const jwt = makeJwt({ sub: 'm1' });
      expect(() => assertJwtMatchesOrg(jwt, 'org-team')).toThrow(AuthContextMismatchError);
    });

    it('error carries requestedOrgId and tokenOrgId for diagnostics', () => {
      const jwt = makeJwt({ sub: 'm1', organization_id: 'org-personal' });
      try {
        assertJwtMatchesOrg(jwt, 'org-team');
        expect.unreachable('assertJwtMatchesOrg should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(AuthContextMismatchError);
        const err = e as AuthContextMismatchError;
        expect(err.requestedOrgId).toBe('org-team');
        expect(err.tokenOrgId).toBe('org-personal');
      }
    });
  });
});
