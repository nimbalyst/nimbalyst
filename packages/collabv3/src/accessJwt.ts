/**
 * Cloudflare Access JWT validation.
 *
 * Used to gate admin endpoints behind Zero Trust. Every request that passed
 * Cloudflare Access carries a `Cf-Access-Jwt-Assertion` header signed by the
 * team's Access JWKS. Verifying that JWT inside the worker means the endpoint
 * stops working if Access is ever removed or misconfigured, instead of falling
 * back to a shared bearer secret.
 *
 * Configure two env values on the worker:
 *   CF_ACCESS_TEAM_DOMAIN   e.g. "nimbalyst.cloudflareaccess.com" (no scheme)
 *   CF_ACCESS_AUD           the Application Audience (AUD) tag shown on the
 *                           Access application's Overview page in Zero Trust
 *
 * Cloudflare injects the same header for both human (OAuth) and service-token
 * authentications, so one code path covers both.
 */

import { createLogger } from './logger';

const log = createLogger('accessJwt');

const JWKS_CACHE_TTL_MS = 60 * 60 * 1000;
const CLOCK_SKEW_SECONDS = 30;

interface JsonWebKey {
  kid: string;
  kty: string;
  alg: string;
  n?: string;
  e?: string;
}

interface JsonWebKeySet {
  keys: JsonWebKey[];
}

interface JwtHeader {
  alg: string;
  kid: string;
  typ?: string;
}

interface AccessJwtPayload {
  iss: string;
  aud: string | string[];
  sub: string;
  iat: number;
  exp: number;
  nbf?: number;
  email?: string;
  identity_nonce?: string;
  common_name?: string;
  type?: string;
}

export interface AccessIdentity {
  /** JWT subject. For user logins this is the Access user UUID; for service tokens it is the token UUID. */
  sub: string;
  /** Email of the human who authenticated. Absent for service tokens. */
  email?: string;
  /** Service token name. Absent for human logins. */
  commonName?: string;
  isServiceToken: boolean;
}

export interface AccessVerifyConfig {
  teamDomain: string;
  audience: string;
}

const jwksCache = new Map<string, { keys: JsonWebKeySet; fetchedAt: number }>();

export async function verifyAccessJwt(
  request: Request,
  config: AccessVerifyConfig,
): Promise<AccessIdentity | null> {
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) {
    log.warn('No Cf-Access-Jwt-Assertion header on request');
    return null;
  }
  const parts = token.split('.');
  if (parts.length !== 3) {
    log.warn('Malformed Access JWT (expected 3 parts)');
    return null;
  }

  let header: JwtHeader;
  let payload: AccessJwtPayload;
  try {
    header = JSON.parse(base64UrlDecodeToString(parts[0]));
    payload = JSON.parse(base64UrlDecodeToString(parts[1]));
  } catch (err) {
    log.warn('Access JWT failed to decode:', err);
    return null;
  }

  // Issuer must match the configured team domain exactly. Reject anything else,
  // including JWTs issued for a different Zero Trust team.
  const expectedIssuer = `https://${config.teamDomain}`;
  if (payload.iss !== expectedIssuer) {
    log.warn('Access JWT issuer mismatch. Expected:', expectedIssuer, 'Got:', payload.iss);
    return null;
  }

  // Audience must include the specific application's AUD tag. This binds the
  // worker to one Access application; a JWT minted for another app on the same
  // team cannot satisfy it.
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(config.audience)) {
    log.warn('Access JWT audience mismatch. Expected:', config.audience, 'Got:', payload.aud);
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now - CLOCK_SKEW_SECONDS) {
    log.warn('Access JWT expired', { exp: payload.exp, now });
    return null;
  }
  if (payload.nbf && payload.nbf > now + CLOCK_SKEW_SECONDS) {
    log.warn('Access JWT not yet valid');
    return null;
  }

  if (header.alg !== 'RS256') {
    log.warn('Access JWT alg not RS256:', header.alg);
    return null;
  }

  const valid = await verifySignature(token, header, config);
  if (!valid) {
    log.warn('Access JWT signature verification failed');
    return null;
  }

  // Service tokens carry common_name + type='app' and no email; user logins
  // carry email and no common_name.
  const isServiceToken = !payload.email && Boolean(payload.common_name);
  return {
    sub: payload.sub,
    email: payload.email,
    commonName: payload.common_name,
    isServiceToken,
  };
}

async function verifySignature(
  token: string,
  header: JwtHeader,
  config: AccessVerifyConfig,
): Promise<boolean> {
  const jwks = await fetchJwks(config.teamDomain);
  if (!jwks) return false;

  let key = jwks.keys.find((k) => k.kid === header.kid);
  if (!key) {
    // Cloudflare rotates Access signing keys; force-refresh once on a miss.
    const fresh = await fetchJwks(config.teamDomain, true);
    key = fresh?.keys.find((k) => k.kid === header.kid);
    if (!key) {
      log.warn('Access JWT kid not found in JWKS even after refresh:', header.kid);
      return false;
    }
  }

  let cryptoKey: CryptoKey;
  try {
    cryptoKey = await crypto.subtle.importKey(
      'jwk',
      key as unknown as JsonWebKey,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
  } catch (err) {
    log.error('Failed to import Access JWK:', err);
    return false;
  }

  const parts = token.split('.');
  const signedData = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const signature = base64UrlToArrayBuffer(parts[2]);

  return crypto.subtle.verify(
    { name: 'RSASSA-PKCS1-v1_5' },
    cryptoKey,
    signature,
    signedData,
  );
}

async function fetchJwks(teamDomain: string, forceRefresh = false): Promise<JsonWebKeySet | null> {
  const url = `https://${teamDomain}/cdn-cgi/access/certs`;
  if (!forceRefresh) {
    const cached = jwksCache.get(url);
    if (cached && Date.now() - cached.fetchedAt < JWKS_CACHE_TTL_MS) {
      return cached.keys;
    }
  }
  try {
    const response = await fetch(url);
    if (!response.ok) {
      log.error('Access JWKS fetch failed:', response.status);
      return null;
    }
    const keys = (await response.json()) as JsonWebKeySet;
    jwksCache.set(url, { keys, fetchedAt: Date.now() });
    return keys;
  } catch (err) {
    log.error('Access JWKS fetch error:', err);
    return null;
  }
}

function base64UrlDecodeToString(input: string): string {
  const pad = input.length % 4;
  const padded = pad ? input + '='.repeat(4 - pad) : input;
  const base64 = padded.replace(/-/g, '+').replace(/_/g, '/');
  return atob(base64);
}

function base64UrlToArrayBuffer(input: string): ArrayBuffer {
  const decoded = base64UrlDecodeToString(input);
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
  return bytes.buffer;
}
