/**
 * URL rules shared by discovery, the browser launch, token requests and the
 * gateway. One rule set, applied everywhere a URL leaves the app, so a check
 * cannot be skipped by reaching the same endpoint through a different path.
 */
import { McpOAuthError } from './types';

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return LOOPBACK_HOSTNAMES.has(normalized) || /^127\.\d+\.\d+\.\d+$/.test(normalized);
}

/**
 * Loopback, private (RFC 1918), link-local and unique-local address
 * literals, plus `localhost`. Hostnames are not resolved, so a public name
 * that resolves to a private address is not caught here.
 */
export function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (isLoopbackHostname(host) || host === '0.0.0.0' || host.endsWith('.localhost')) {
    return true;
  }
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 0;
  }
  if (host.includes(':')) {
    return host === '::' || host === '::1' || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)
      || /^::ffff:(10|127|192\.168|169\.254|172\.(1[6-9]|2\d|3[01]))\./.test(host);
  }
  return false;
}

/**
 * A URL the remote server chose (through its metadata or a challenge) may
 * point at a loopback or private address only when the configured server is
 * itself on one. Otherwise a public server could make Nimbalyst send
 * requests to services on the user's machine or network.
 */
export function assertNotRedirectedToPrivate(target: string | URL, configuredServerUrl: string, what: string): void {
  let url: URL;
  let configured: URL;
  try {
    url = typeof target === 'string' ? new URL(target) : new URL(target.href);
    configured = new URL(configuredServerUrl);
  } catch {
    throw new McpOAuthError('invalid_config', `The ${what} is not a valid URL.`);
  }
  if (isPrivateHostname(url.hostname) && !isPrivateHostname(configured.hostname)) {
    throw new McpOAuthError('insecure_endpoint', `The ${what} points at a local or private address, which a public server may not do.`);
  }
}

/**
 * No downgrade: when the user configured an `https` server, every URL the
 * OAuth flow touches must be `https` too, except loopback. A server the user
 * configured as plain `http://` keeps working over `http`, matching the
 * `--allow-http` behavior Codex ACP passed to mcp-remote.
 */
export function assertNoDowngrade(target: string | URL, configuredServerUrl: string, what: string): URL {
  let url: URL;
  try {
    url = typeof target === 'string' ? new URL(target) : new URL(target.href);
  } catch {
    throw new McpOAuthError('invalid_config', `The ${what} is not a valid URL.`);
  }
  if (url.protocol === 'https:') {
    return url;
  }
  if (url.protocol !== 'http:') {
    throw new McpOAuthError('insecure_endpoint', `The ${what} uses an unsupported scheme.`);
  }
  if (isLoopbackHostname(url.hostname)) {
    return url;
  }
  let configured: URL;
  try {
    configured = new URL(configuredServerUrl);
  } catch {
    throw new McpOAuthError('invalid_config', 'The server URL is not valid.');
  }
  if (configured.protocol === 'http:') {
    return url;
  }
  throw new McpOAuthError(
    'insecure_endpoint',
    `The ${what} uses plain http for an https server, so Nimbalyst will not send credentials to it.`,
  );
}

/**
 * Authorization server identifiers compare as parsed URLs, tolerating one
 * trailing slash. Same semantics as the MCP SDK's own comparison, so a value
 * the SDK would accept is never refused here.
 */
export function issuersMatch(a: string, b: string): boolean {
  let [x, y] = [a, b];
  try {
    [x, y] = [new URL(a).href, new URL(b).href];
  } catch {
    // Not URLs: compare as written.
  }
  return x === y || (x.endsWith('/') && x.slice(0, -1) === y) || (y.endsWith('/') && y.slice(0, -1) === x);
}

/** True when `candidate` is the same origin as `base` and at or below its path. */
export function isWithinResource(candidate: string | URL, base: string | URL): boolean {
  try {
    const c = new URL(typeof candidate === 'string' ? candidate : candidate.href);
    const b = new URL(typeof base === 'string' ? base : base.href);
    if (c.origin !== b.origin) {
      return false;
    }
    if (c.username || c.password) {
      return false;
    }
    const cp = c.pathname.endsWith('/') ? c.pathname : `${c.pathname}/`;
    const bp = b.pathname.endsWith('/') ? b.pathname : `${b.pathname}/`;
    return cp.startsWith(bp);
  } catch {
    return false;
  }
}

export function sameOrigin(a: string | URL, b: string | URL): boolean {
  try {
    return new URL(typeof a === 'string' ? a : a.href).origin === new URL(typeof b === 'string' ? b : b.href).origin;
  } catch {
    return false;
  }
}
