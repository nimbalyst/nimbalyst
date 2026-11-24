/**
 * Shared types for Nimbalyst's native remote-MCP OAuth client.
 *
 * Nimbalyst used to hand every OAuth decision for a remote MCP server to the
 * third-party `mcp-remote` helper. That helper kept credentials as plaintext
 * files in `~/.mcp-auth` (shared with every other app's copy) and refreshed
 * tokens against whatever token endpoint fresh discovery returned. This module
 * owns the flow instead: discovery is pinned at sign-in, every stored value
 * carries the authorization server that issued it, and nothing is sent to a
 * different one. See docs/MCP_OAUTH.md.
 */

/**
 * Failure categories reported to the renderer and to analytics. The renderer
 * allowlist in `mcpOAuthAnalytics.ts` must list every value here plus
 * `ipc_error`, which only the IPC boundary adds.
 */
export type McpOAuthErrorType =
  | 'invalid_config'
  | 'timeout'
  | 'browser_launch'
  | 'stale_pending_auth'
  | 'port_conflict'
  | 'command_unavailable'
  | 'provider_rejected'
  | 'dynamic_registration_unsupported'
  | 'callback_validation'
  | 'token_exchange'
  | 'network'
  | 'process_error'
  | 'process_exit'
  | 'issuer_mismatch'
  | 'resource_mismatch'
  | 'insecure_endpoint'
  | 'authorization_server_changed'
  | 'credential_storage_unavailable'
  | 'cancelled'
  | 'unknown';

export class McpOAuthError extends Error {
  constructor(
    public readonly errorType: McpOAuthErrorType,
    message: string,
  ) {
    super(message);
    this.name = 'McpOAuthError';
  }
}

/**
 * The authorization server as it was at sign-in. Refresh and revocation only
 * ever use these endpoints; background work never rediscovers them.
 */
export interface PinnedAuthorizationServer {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  revocation_endpoint?: string;
  response_types_supported: string[];
  code_challenge_methods_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
  revocation_endpoint_auth_methods_supported?: string[];
  authorization_response_iss_parameter_supported?: boolean;
}

export interface StoredClient {
  client_id: string;
  client_secret?: string;
  client_secret_expires_at?: number;
  token_endpoint_auth_method?: string;
  /** Exactly as registered or first used. Reused byte for byte. */
  redirect_uri: string;
  /** Every redirect URI the registration carries, for imported registrations. */
  redirect_uris: string[];
  /** True once a code exchange has succeeded with `redirect_uri`. */
  redirectUriConfirmed: boolean;
  source: 'dcr' | 'static' | 'imported';
  /** Authorization server this client is registered with. */
  issuer: string;
}

export interface StoredTokens {
  access_token: string;
  token_type?: string;
  refresh_token?: string;
  /** Epoch milliseconds. */
  expires_at?: number;
  scope?: string;
  /** Authorization server that issued these tokens. */
  issuer: string;
}

export type BindingState = 'active' | 'needs_reauthorization';

export interface McpOAuthBinding {
  version: 1;
  bindingKey: string;
  serverUrl: string;
  /** RFC 8707 resource indicator sent with token requests, if any. */
  resource?: string;
  resourceMetadataUrl?: string;
  scope?: string;
  issuer: string;
  asMetadata: PinnedAuthorizationServer;
  client: StoredClient;
  tokens?: StoredTokens;
  state: BindingState;
  reauthReason?: McpOAuthErrorType;
  /** The provider refused this client (invalid_client); the next sign-in registers a new one. */
  clientRejected?: boolean;
  origin: 'authorized' | 'imported-mcp-remote';
  /** SHA-256 of the legacy refresh token this binding was imported from. */
  importFingerprint?: string;
  /** Bumped on every authorization and revoke; all writes are compare-and-set on it. */
  generation: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Left behind by revoke. Holds no secrets. Outlives the 7-day backup of the
 * revoked record so the legacy importer cannot bring the server back.
 */
export interface McpOAuthTombstone {
  version: 1;
  bindingKey: string;
  revokedAt: string;
  generation: number;
  importFingerprints: string[];
}

export type McpOAuthStatus =
  | { state: 'authorized'; binding: McpOAuthBinding }
  | { state: 'needs_reauthorization'; reason: McpOAuthErrorType }
  | { state: 'unauthorized' }
  | { state: 'unreadable' };

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
