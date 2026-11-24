/**
 * Discovery for an interactive sign-in only. The result is pinned into the
 * credential record; background refresh never calls this.
 *
 * Checks beyond what the MCP SDK does on its own:
 *   - the authorization server metadata must name, as `issuer`, the URL it was
 *     fetched for (RFC 8414 section 3.3). The SDK binds to the discovery URL and
 *     deliberately does not check this.
 *   - protected-resource metadata must describe this server (same origin, path
 *     at or above it).
 *   - every endpoint passes the no-downgrade rule.
 */
import {
  discoverOAuthServerInfo,
  extractResourceMetadataUrl,
} from '@modelcontextprotocol/sdk/client/auth.js';
import { checkResourceAllowed } from '@modelcontextprotocol/sdk/shared/auth-utils.js';
import type { MCPRemoteConfigDescriptor } from '../MCPRemoteOAuth';
import { assertNoDowngrade, issuersMatch, sameOrigin } from './urlPolicy';
import { McpOAuthError, type FetchLike, type PinnedAuthorizationServer } from './types';

export interface PinnedDiscovery {
  issuer: string;
  asMetadata: PinnedAuthorizationServer;
  /** RFC 8707 resource to send, verbatim. */
  resource?: string;
  resourceMetadataUrl?: string;
  scope?: string;
}

export async function discoverForAuthorization(
  descriptor: MCPRemoteConfigDescriptor,
  fetchFn: FetchLike,
  options: { resourceMetadataUrl?: string } = {},
): Promise<PinnedDiscovery> {
  const serverUrl = descriptor.serverUrl;
  assertNoDowngrade(serverUrl, serverUrl, 'server URL');
  // A server may publish its protected-resource metadata only through the
  // `resource_metadata` parameter of its 401 challenge, not at a well-known
  // URL. Whatever it names is still checked below: the metadata's `resource`
  // must cover this server, and the issuer must match its own metadata.
  const resourceMetadataUrl = options.resourceMetadataUrl ?? await probeResourceMetadataUrl(descriptor, fetchFn);
  if (resourceMetadataUrl) {
    assertNoDowngrade(resourceMetadataUrl, serverUrl, 'resource metadata URL');
  }

  // The SDK reads a failed metadata request as "no metadata" and falls back to
  // default endpoints. Offline, that would pin made-up endpoints (and import
  // would trust them), so any request that did not complete fails discovery.
  let requestFailed = false;
  const trackingFetch: FetchLike = async (input, init) => {
    try {
      return await fetchFn(input, init);
    } catch (error) {
      requestFailed = true;
      throw error;
    }
  };

  let info: Awaited<ReturnType<typeof discoverOAuthServerInfo>>;
  try {
    info = await discoverOAuthServerInfo(serverUrl, {
      resourceMetadataUrl: resourceMetadataUrl ? new URL(resourceMetadataUrl) : undefined,
      fetchFn: trackingFetch,
    });
  } catch (error) {
    if (error instanceof McpOAuthError) {
      throw error;
    }
    throw new McpOAuthError('network', 'The OAuth discovery documents could not be loaded.');
  }
  if (requestFailed) {
    throw new McpOAuthError('network', 'The OAuth discovery documents could not be loaded.');
  }

  const resourceMetadata = info.resourceMetadata;
  if (resourceMetadata?.resource !== undefined) {
    let allowed = false;
    try {
      allowed = checkResourceAllowed({
        requestedResource: new URL(serverUrl),
        configuredResource: String(resourceMetadata.resource),
      });
    } catch {
      allowed = false;
    }
    if (!allowed) {
      throw new McpOAuthError(
        'resource_mismatch',
        'The server published protected-resource metadata for a different resource.',
      );
    }
  }

  const issuerUrl = assertNoDowngrade(info.authorizationServerUrl, serverUrl, 'authorization server');
  const issuer = issuerUrl.href;
  const metadata = info.authorizationServerMetadata;

  let pinned: PinnedAuthorizationServer;
  if (metadata) {
    if (typeof metadata.issuer !== 'string' || !issuersMatch(metadata.issuer, info.authorizationServerUrl)) {
      throw new McpOAuthError(
        'issuer_mismatch',
        'The authorization server metadata names a different issuer than the server it was loaded from.',
      );
    }
    const record = metadata as unknown as Record<string, unknown>;
    pinned = {
      issuer,
      authorization_endpoint: String(metadata.authorization_endpoint),
      token_endpoint: String(metadata.token_endpoint),
      registration_endpoint: optionalString(record.registration_endpoint),
      revocation_endpoint: optionalString(record.revocation_endpoint),
      response_types_supported: Array.isArray(metadata.response_types_supported)
        ? metadata.response_types_supported.map(String)
        : ['code'],
      code_challenge_methods_supported: optionalStringArray(record.code_challenge_methods_supported),
      token_endpoint_auth_methods_supported: optionalStringArray(record.token_endpoint_auth_methods_supported),
      revocation_endpoint_auth_methods_supported: optionalStringArray(record.revocation_endpoint_auth_methods_supported),
      authorization_response_iss_parameter_supported:
        record.authorization_response_iss_parameter_supported === true ? true : undefined,
    };
  } else {
    // The 2025-03-26 MCP fallback: no metadata anywhere, so the SDK uses
    // fixed paths on the authorization server. Only accepted when that server
    // is the MCP server's own origin; a foreign server with no metadata is not
    // something we can pin.
    if (!sameOrigin(issuerUrl, serverUrl)) {
      throw new McpOAuthError('network', 'The authorization server does not publish OAuth metadata.');
    }
    pinned = {
      issuer,
      authorization_endpoint: new URL('/authorize', issuerUrl).href,
      token_endpoint: new URL('/token', issuerUrl).href,
      registration_endpoint: new URL('/register', issuerUrl).href,
      response_types_supported: ['code'],
    };
  }

  assertNoDowngrade(pinned.authorization_endpoint, serverUrl, 'authorization endpoint');
  assertNoDowngrade(pinned.token_endpoint, serverUrl, 'token endpoint');
  if (pinned.registration_endpoint) {
    assertNoDowngrade(pinned.registration_endpoint, serverUrl, 'registration endpoint');
  }
  if (pinned.revocation_endpoint) {
    assertNoDowngrade(pinned.revocation_endpoint, serverUrl, 'revocation endpoint');
  }

  // The configured resource is the user's explicit choice and is sent as
  // given, exactly as mcp-remote's --resource did.
  const resource = descriptor.authorizeResource
    ?? (resourceMetadata?.resource !== undefined ? String(resourceMetadata.resource) : undefined);

  const configuredScope = descriptor.staticOAuthClientMetadata?.scope;
  const scope = typeof configuredScope === 'string' && configuredScope.length > 0
    ? configuredScope
    : Array.isArray(resourceMetadata?.scopes_supported) && resourceMetadata.scopes_supported.length > 0
      ? resourceMetadata.scopes_supported.join(' ')
      : undefined;

  return {
    issuer,
    asMetadata: pinned,
    resource,
    resourceMetadataUrl: options.resourceMetadataUrl,
    scope,
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : undefined;
}

/**
 * Ask the server, without credentials, for its 401 challenge and return the
 * `resource_metadata` URL it names, if any. Interactive sign-in and import
 * only; never background refresh.
 */
async function probeResourceMetadataUrl(
  descriptor: MCPRemoteConfigDescriptor,
  fetchFn: FetchLike,
): Promise<string | undefined> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  for (const [name, value] of Object.entries(descriptor.headers ?? {})) {
    if (name.toLowerCase() !== 'authorization') headers[name] = value;
  }
  try {
    const response = await fetchFn(descriptor.serverUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Nimbalyst', version: '1' } },
      }),
      redirect: 'manual',
    });
    await response.body?.cancel().catch(() => undefined);
    if (response.status !== 401) {
      return undefined;
    }
    const named = extractResourceMetadataUrl(response)?.href;
    // Same origin only: the server must not be able to point main at another
    // host or a loopback service.
    return named && sameOrigin(named, descriptor.serverUrl) ? named : undefined;
  } catch {
    return undefined;
  }
}
