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
