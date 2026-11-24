/**
 * Identity of a remote MCP server for credential storage, and the hashes and
 * defaults `mcp-remote` used, so existing users' registrations and tokens can
 * be found and their registered redirect URIs reproduced.
 */
import * as crypto from 'crypto';
import type { MCPRemoteConfigDescriptor } from '../MCPRemoteOAuth';

/**
 * `mcp-remote`'s server hash: MD5 of `serverUrl|resource|sortedHeadersJson`.
 * 0.16.x appends authorize params, a client metadata URL and a token endpoint,
 * none of which Nimbalyst ever passed, so for configs Nimbalyst generated the
 * first entry is the 0.16.x hash too. The second is the 0.1.x URL-only hash.
 */
export function getMcpRemoteServerHashes(
  descriptor: Pick<MCPRemoteConfigDescriptor, 'serverUrl' | 'authorizeResource' | 'headers'>,
): string[] {
  const parts = [descriptor.serverUrl];
  if (descriptor.authorizeResource) {
    parts.push(descriptor.authorizeResource);
  }
  if (descriptor.headers && Object.keys(descriptor.headers).length > 0) {
    const sortedKeys = Object.keys(descriptor.headers).sort();
    parts.push(JSON.stringify(descriptor.headers, sortedKeys));
  }

  const canonical = parts.join('|');
  const canonicalHash = crypto.createHash('md5').update(canonical).digest('hex');
  const legacyHash = crypto.createHash('md5').update(descriptor.serverUrl).digest('hex');
  return canonicalHash === legacyHash ? [canonicalHash] : [canonicalHash, legacyHash];
}

/** `calculateDefaultPort` from mcp-remote 0.16.7 `src/lib/utils.ts`. */
export function calculateMcpRemoteDefaultPort(serverUrlHash: string): number {
  const offset = parseInt(serverUrlHash.substring(0, 4), 16);
  return 3335 + (offset % 45816);
}

function isAuthorizationHeader(name: string): boolean {
  return name.toLowerCase() === 'authorization';
}

/**
 * Key for Nimbalyst's own credential record and gateway route. Covers what
 * makes two configs different servers: the URL, the configured resource, the
 * non-auth headers (a tenant header picks a different account) and a
 * pre-registered client id. `Authorization` headers are excluded: a config
 * that carries one is a static-key server and never holds OAuth tokens.
 */
export function computeBindingKey(
  descriptor: Pick<MCPRemoteConfigDescriptor, 'serverUrl' | 'authorizeResource' | 'headers' | 'staticOAuthClientInfo'>,
): string {
  const headers: Array<[string, string]> = Object.entries(descriptor.headers ?? {})
    .filter(([name]) => !isAuthorizationHeader(name))
    .map(([name, value]): [string, string] => [name.toLowerCase(), value])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canonical = JSON.stringify([
    normalizeServerUrl(descriptor.serverUrl),
    descriptor.authorizeResource ?? '',
    headers,
    descriptor.staticOAuthClientInfo?.client_id ?? '',
  ]);
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 40);
}

export function normalizeServerUrl(serverUrl: string): string {
  try {
    return new URL(serverUrl).href;
  } catch {
    return serverUrl;
  }
}

export function fingerprintSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex');
}
