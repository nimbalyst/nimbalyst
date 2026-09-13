import { asPersonalJwt, type PersonalJwt } from '../auth/jwtScopes';

const PREFIX = 'nimnode_v1~';

/** Identifies the access-token lane; this does not validate claims or authenticity. */
export function isNodeAccessToken(token: string): boolean {
  return token.startsWith(PREFIX);
}

/**
 * Decode the personal device-grant claims, without verifying the signature.
 * Only the server can authenticate these values. Timestamps remain UNIX seconds;
 * callers must multiply by 1000 when comparing them with Date.now().
 */
export function decodeNodeAccessTokenClaims(token: string): { sub: string; org: string; nid: string; exp: number; iat: number } {
  try {
    const parts = token.split('~');
    if (!isNodeAccessToken(token) || parts.length !== 4 || parts.some(part => !part)) throw new Error();
    const payload = parts[2];
    if (!/^[A-Za-z0-9_-]+$/.test(payload)) throw new Error();
    const padded = payload.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - payload.length % 4) % 4);
    const bytes = Uint8Array.from(atob(padded), char => char.charCodeAt(0));
    const claims = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (
      !claims || claims.v !== 1 || claims.scope !== 'personal' ||
      !['sub', 'org', 'nid'].every(key => typeof claims[key] === 'string' && claims[key].trim().length > 0) ||
      !Number.isSafeInteger(claims.iat) || claims.iat < 0 ||
      !Number.isSafeInteger(claims.exp) || claims.exp <= claims.iat
    ) throw new Error();
    return { sub: claims.sub, org: claims.org, nid: claims.nid, exp: claims.exp, iat: claims.iat };
  } catch {
    // Never include the credential or its payload in an error/log message.
    throw new Error('Invalid node access token');
  }
}

/**
 * The only sanctioned way to brand a node token; do not call asPersonalJwt directly.
 * Adapt a personal device-grant access token to the personal-sync credential
 * interface. This is not a Stytch JWT and must never authorize a team lane.
 * Claim validation prevents accidentally branding a team JWT or refresh token;
 * the server still verifies the signature and personal-room authorization.
 */
export function nodeAccessTokenAsPersonalJwt(token: string): PersonalJwt {
  decodeNodeAccessTokenClaims(token);
  return asPersonalJwt(token);
}
