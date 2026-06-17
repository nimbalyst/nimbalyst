import { describe, it, expect } from 'vitest';
import {
  asPersonalJwt,
  asTeamJwt,
  asPersonalMemberId,
  asTeamMemberId,
  type PersonalJwt,
  type TeamJwt,
  type PersonalMemberId,
} from '../jwtScopes';

describe('jwtScopes branded identities', () => {
  it('preserves the underlying string value through branding', () => {
    expect(asPersonalJwt('a.b.c')).toBe('a.b.c');
    expect(asTeamJwt('x.y.z')).toBe('x.y.z');
    expect(asPersonalMemberId('member-live-1')).toBe('member-live-1');
    expect(asTeamMemberId('member-live-2')).toBe('member-live-2');
  });

  it('a branded JWT is still usable as a plain string (split/template)', () => {
    const jwt: PersonalJwt = asPersonalJwt('h.p.s');
    expect(jwt.split('.').length).toBe(3);
    expect(`Bearer ${jwt}`).toBe('Bearer h.p.s');
  });

  it('only accepts the matching brand at a brand-typed call site (compile-time contract)', () => {
    // This is a type-level guarantee; at runtime we just assert the helper wiring.
    // The following would be a COMPILE error if uncommented (kept as documentation):
    //   const p: PersonalJwt = asTeamJwt('t');            // TeamJwt -> PersonalJwt: error
    //   const id: PersonalMemberId = asTeamMemberId('m');  // TeamMemberId -> PersonalMemberId: error
    const onlyPersonal = (_jwt: PersonalJwt): string => 'ok';
    expect(onlyPersonal(asPersonalJwt('a.b.c'))).toBe('ok');
    const teamOnly = (_jwt: TeamJwt): string => 'ok';
    expect(teamOnly(asTeamJwt('a.b.c'))).toBe('ok');
  });
});
