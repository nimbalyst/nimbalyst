/**
 * Which redirect URI a sign-in uses.
 *
 * RFC 8252 section 7.3 lets a loopback redirect vary only in port; host and
 * path must match the registration. So once a redirect URI has worked for a
 * client it is reused byte for byte, and it only changes by registering a new
 * client (dynamic registration) or by the user editing the config (static).
 *
 * Existing users registered whatever mcp-remote sent:
 * `http://<host>:<port>/oauth/callback`, host from `oauth.host` (default
 * `127.0.0.1` on Windows, `localhost` elsewhere), port from
 * `oauth.callbackPort` or derived from the server hash.
 */
import type { MCPRemoteConfigDescriptor } from '../MCPRemoteOAuth';
import { calculateMcpRemoteDefaultPort, getMcpRemoteServerHashes } from './serverIdentity';
import type { StoredClient } from './types';

export const MCP_REMOTE_CALLBACK_PATH = '/oauth/callback';

export function formatHostForUrl(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

export function computeMcpRemoteRedirectUri(
  descriptor: Pick<MCPRemoteConfigDescriptor, 'serverUrl' | 'authorizeResource' | 'headers' | 'callbackPort' | 'host'>,
  platform: NodeJS.Platform,
): string {
  const port = descriptor.callbackPort
    ?? calculateMcpRemoteDefaultPort(getMcpRemoteServerHashes(descriptor)[0]);
  const host = descriptor.host
    ? formatHostForUrl(descriptor.host)
    : (platform === 'win32' ? '127.0.0.1' : 'localhost');
  return `http://${host}:${port}${MCP_REMOTE_CALLBACK_PATH}`;
}

export interface RedirectChoice {
  redirectUri: string;
  /** False when a dynamic client has to be (re-)registered for this URI. */
  reuseClient: boolean;
}

/**
 * @param existing a client already stored for this server and issuer, or an
 *   imported registration, if any.
 */
export function resolveRedirectUri(input: {
  descriptor: MCPRemoteConfigDescriptor;
  existing?: StoredClient;
  platform: NodeJS.Platform;
}): RedirectChoice {
  const { descriptor, existing, platform } = input;
  const computed = computeMcpRemoteRedirectUri(descriptor, platform);
  const explicit = descriptor.redirectUri;
  const staticClientId = descriptor.staticOAuthClientInfo?.client_id;

  if (staticClientId) {
    if (explicit) {
      return { redirectUri: explicit, reuseClient: true };
    }
    // A port or host the user sets is the registration they mean; the URI
    // that worked last time only stands in when they set neither.
    const userPinned = descriptor.callbackPort !== undefined || descriptor.host !== undefined;
    if (
      !userPinned
      && existing
      && existing.source === 'static'
      && existing.client_id === staticClientId
      && existing.redirectUriConfirmed
    ) {
      return { redirectUri: existing.redirect_uri, reuseClient: true };
    }
    return { redirectUri: computed, reuseClient: true };
  }

  if (existing && existing.source !== 'static') {
    const userPinned = explicit !== undefined || descriptor.callbackPort !== undefined || descriptor.host !== undefined;
    if (!userPinned) {
      if (existing.redirectUriConfirmed) {
        return { redirectUri: fillPort(existing.redirect_uri, computed), reuseClient: true };
      }
      const matching = existing.redirect_uris.find((uri) => uri === computed);
      return { redirectUri: fillPort(matching ?? existing.redirect_uris[0] ?? existing.redirect_uri, computed), reuseClient: true };
    }
    const wanted = explicit ?? computed;
    if (existing.redirect_uri === wanted || existing.redirect_uris.includes(wanted)) {
      return { redirectUri: wanted, reuseClient: true };
    }
    return { redirectUri: wanted, reuseClient: false };
  }

  return { redirectUri: explicit ?? computed, reuseClient: false };
}

/**
 * A loopback registration stored without a port matches any port (RFC 8252
 * section 7.3); send it with the port we will actually listen on. mcp-remote
 * 0.16.7 keeps such registrations for the same reason.
 */
function fillPort(stored: string, computed: string): string {
  try {
    const url = new URL(stored);
    if (url.port) {
      return stored;
    }
    const port = new URL(computed).port;
    if (!port) {
      return stored;
    }
    url.port = port;
    return url.href;
  } catch {
    return stored;
  }
}
