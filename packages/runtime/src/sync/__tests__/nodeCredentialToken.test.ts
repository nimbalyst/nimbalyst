// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  decodeNodeAccessTokenClaims,
  isNodeAccessToken,
  nodeAccessTokenAsPersonalJwt,
} from '../nodeCredentialToken';

const claims = { v: 1, sub: 'member-personal', org: 'org-personal', scope: 'personal', nid: 'node-1', iat: 1800000000, exp: 1800000900 };
const tokenFor = (payload: unknown) => `nimnode_v1~key-1~${Buffer.from(JSON.stringify(payload)).toString('base64url')}~00`;

describe('node access tokens', () => {
  it('decodes personal claims with second-based timestamps and preserves the original token when branding', () => {
    const token = tokenFor(claims);
    expect(isNodeAccessToken(token)).toBe(true);
    expect(decodeNodeAccessTokenClaims(token)).toEqual({
      sub: claims.sub, org: claims.org, nid: claims.nid, iat: claims.iat, exp: claims.exp,
    });
    // Deliberately unsigned: authenticity belongs to the server, not this decoder.
    expect(nodeAccessTokenAsPersonalJwt(token)).toBe(token);
    expect(isNodeAccessToken('nimnodert_v1~node-1~secret')).toBe(false);
    expect(isNodeAccessToken('header.payload.signature')).toBe(false);
  });

  it.each([
    null, [], { ...claims, v: 2 }, { ...claims, scope: 'team' },
    { ...claims, sub: '' }, { ...claims, org: 123 }, { ...claims, nid: null },
    { ...claims, exp: '1800000900' }, { ...claims, iat: -1 },
    { ...claims, exp: 1.5 }, { ...claims, exp: claims.iat },
  ])('rejects malformed or non-personal claims before branding: %j', payload => {
    expect(() => decodeNodeAccessTokenClaims(tokenFor(payload))).toThrow('Invalid node access token');
    expect(() => nodeAccessTokenAsPersonalJwt(tokenFor(payload))).toThrow('Invalid node access token');
  });

  it.each([
    'header.payload.signature', 'nimnodert_v1~node-1~secret',
    'nimnode_v1~key~payload', 'nimnode_v1~~e30~00',
    'nimnode_v1~key~e30~', 'nimnode_v1~key~%%%~00',
    'nimnode_v1~key~bm90LWpzb24~00', 'nimnode_v1~key~e30~00~extra',
  ])('rejects malformed token framing: %s', token => {
    expect(() => decodeNodeAccessTokenClaims(token)).toThrow('Invalid node access token');
  });
});
