import type { PersonalJwt } from '../auth/jwtScopes';
import { decodeNodeAccessTokenClaims, isNodeAccessToken } from './nodeCredentialToken';

/**
 * Credential decoding, base64 and AES-GCM helpers for the CollabV3 personal
 * sync transport. Lifted out of CollabV3Sync.ts unchanged: they hold no
 * connection state, so they do not need to sit inside the provider closure.
 */

// ============================================================================
// JWT Utilities
// ============================================================================

export interface JwtClaims {
  sub: string;
  /** Node access-token expiry in UNIX seconds; Stytch refresh is owned by getJwt. */
  exp?: number;
  /** Stytch B2B organization_id claim. Personal-scoped JWTs carry the personal orgId; team-scoped JWTs carry the team orgId. */
  organization_id?: string;
}

/**
 * Decode a JWT's payload claims. Does not verify the signature -- the server does that.
 * The JWT is a base64url encoded string in the format: header.payload.signature
 */
export function decodeJwtClaims(jwt: PersonalJwt): JwtClaims {
  if (isNodeAccessToken(jwt)) {
    const { sub, org, exp } = decodeNodeAccessTokenClaims(jwt);
    return { sub, organization_id: org, exp };
  }
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) {
      throw new Error('Invalid JWT format');
    }

    // Decode the payload (second part)
    const payload = parts[1];
    // Add padding if needed for base64 decoding
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    const decoded = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
    const parsed = JSON.parse(decoded);

    if (!parsed.sub) {
      throw new Error('JWT missing sub claim');
    }

    return { sub: parsed.sub, organization_id: parsed.organization_id };
  } catch (error) {
    console.error('[CollabV3] Failed to decode JWT:', error);
    throw new Error('Invalid JWT: cannot decode claims');
  }
}

// ============================================================================
// Base64 Utilities (handles large byte arrays)
// ============================================================================

/**
 * Convert Uint8Array to base64 string.
 * Uses chunked approach to avoid call stack size limits with large arrays.
 */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  // For small arrays, use simple approach
  if (bytes.length < 1024) {
    return btoa(String.fromCharCode(...bytes));
  }

  // For large arrays, chunk to avoid stack overflow
  const CHUNK_SIZE = 8192;
  let result = '';
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const chunk = bytes.subarray(i, Math.min(i + CHUNK_SIZE, bytes.length));
    result += String.fromCharCode(...chunk);
  }
  return btoa(result);
}

/**
 * Convert base64 string to Uint8Array.
 * Returns a Uint8Array backed by an ArrayBuffer (not SharedArrayBuffer).
 */
export function base64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ============================================================================
// Encryption Utilities
// ============================================================================

export async function encrypt(
  content: string,
  key: CryptoKey
): Promise<{ encrypted: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoder = new TextEncoder();
  const data = encoder.encode(content);

  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    data
  );

  return {
    encrypted: uint8ArrayToBase64(new Uint8Array(encrypted)),
    iv: uint8ArrayToBase64(iv),
  };
}

export async function decrypt(
  encrypted: string,
  iv: string,
  key: CryptoKey
): Promise<string> {
  const encryptedBytes = base64ToUint8Array(encrypted);
  const ivBytes = base64ToUint8Array(iv);

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ivBytes },
    key,
    encryptedBytes
  );

  return new TextDecoder().decode(decrypted);
}

/**
 * Hex SHA-256 of a string. Used to derive an opaque, id-hiding routing key for
 * read receipts (so the server can dedup per entity without learning the id).
 */
export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
