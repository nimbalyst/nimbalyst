/**
 * Nimbalyst's OAuth client for remote MCP servers.
 *
 * Owns sign-in, token refresh, revoke and the one-time import from
 * mcp-remote's store. The security properties it holds (tested in
 * __tests__/McpOAuthManager.test.ts):
 *
 *   - Destination binding: a refresh token, client secret or authorization
 *     code is only sent to the token endpoint pinned at sign-in. Background
 *     work never rediscovers.
 *   - Flow integrity: `state` + PKCE S256, `iss` when advertised, registered
 *     redirect URI preserved.
 *   - No silent browser: only `authorize()` opens one, and only an explicit
 *     user action calls it.
 *   - Fencing: every write is compare-and-set on the record's generation, so
 *     a refresh that lands after revoke or re-sign-in is discarded.
 *
 * The MCP SDK's `auth()` is deliberately not used: on InvalidClientError it
 * clears everything and starts a fresh authorization, which in a background
 * path is both a browser popup and a fresh discovery. The lower-level SDK
 * functions are used with the pinned values instead.
 */
import { randomBytes } from 'crypto';
import {
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js';
import {
  InvalidClientError,
  InvalidClientMetadataError,
  InvalidGrantError,
  OAuthError,
  UnauthorizedClientError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { MCPRemoteConfigDescriptor } from '../MCPRemoteOAuth';
import type { McpOAuthCredentialStore } from './credentialStore';
import { discoverForAuthorization, type PinnedDiscovery } from './discovery';
import { findLegacyCredentials, legacyFingerprints, type LegacyCandidate } from './legacyImport';
import { resolveRedirectUri } from './redirectUri';
import { startCallbackListener, type CallbackListener } from './callbackServer';
import { computeBindingKey, normalizeServerUrl } from './serverIdentity';
import { assertNoDowngrade, issuersMatch, sameOrigin } from './urlPolicy';
import {
  McpOAuthError,
  type FetchLike,
  type McpOAuthBinding,
  type McpOAuthErrorType,
  type McpOAuthStatus,
  type StoredClient,
  type StoredTokens,
} from './types';

const REFRESH_MARGIN_MS = 60_000;
/** Upper bound for any single OAuth HTTP request (discovery, registration, token, revoke). */
const OAUTH_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_CLIENT_NAME = 'Nimbalyst';

export interface McpOAuthManagerDeps {
  store: McpOAuthCredentialStore;
  fetchFn?: FetchLike;
  openExternal: (url: string) => Promise<void>;
  /** Directory of mcp-remote's store, for the one-time import. */
  legacyAuthDir: () => string;
  platform?: NodeJS.Platform;
  now?: () => number;
  log?: (level: 'info' | 'warn', message: string, meta?: Record<string, unknown>) => void;
  /** Per-request deadline for OAuth HTTP calls. Defaults to 30 seconds. */
  requestTimeoutMs?: number;
}

export type AuthorizeResult =
  | { ok: true }
  | { ok: false; errorType: McpOAuthErrorType; message: string };

export type AccessTokenResult =
  | { ok: true; accessToken: string }
  | { ok: false; errorType: McpOAuthErrorType | 'unauthorized' };

export interface RevokeResult {
  success: boolean;
  /** 'revoked' at the provider, 'unsupported' when it has no revocation endpoint, 'failed' when it could not be reached. */
  provider?: 'revoked' | 'unsupported' | 'failed' | 'none';
  error?: string;
}

type Listener = (event: { bindingKey: string; serverUrl: string; reason: McpOAuthErrorType }) => void;

export class McpOAuthManager {
  private readonly store: McpOAuthCredentialStore;
  private readonly fetchFn: FetchLike;
  private readonly openExternal: (url: string) => Promise<void>;
  private readonly legacyAuthDir: () => string;
  private readonly platform: NodeJS.Platform;
  private readonly now: () => number;
  private readonly log: NonNullable<McpOAuthManagerDeps['log']>;
  private readonly pendingFlows = new Map<string, AbortController>();
  private readonly refreshes = new Map<string, Promise<AccessTokenResult>>();
  private readonly imports = new Map<string, Promise<void>>();
  private readonly listeners = new Set<Listener>();

  constructor(deps: McpOAuthManagerDeps) {
    this.store = deps.store;
    this.fetchFn = withRequestTimeout(
      deps.fetchFn ?? ((input, init) => fetch(input, init)),
      deps.requestTimeoutMs ?? OAUTH_REQUEST_TIMEOUT_MS,
    );
    this.openExternal = deps.openExternal;
    this.legacyAuthDir = deps.legacyAuthDir;
    this.platform = deps.platform ?? process.platform;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => undefined);
  }

  bindingKeyFor(descriptor: MCPRemoteConfigDescriptor): string {
    return computeBindingKey(descriptor);
  }

  onNeedsReauthorization(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Status for gating a session. Runs the one-time legacy import when there
   * is no record yet, which may make network requests (discovery only; no
   * credential is sent during import).
   */
  async getStatus(descriptor: MCPRemoteConfigDescriptor, options: { allowImport?: boolean } = {}): Promise<McpOAuthStatus> {
    const key = this.bindingKeyFor(descriptor);
    let effective = await this.effectiveBinding(key);
    if (effective.kind === 'absent' && options.allowImport !== false) {
      await this.importOnce(key, descriptor);
      effective = await this.effectiveBinding(key);
    }
    switch (effective.kind) {
      case 'present':
        if (effective.binding.state === 'needs_reauthorization') {
          return { state: 'needs_reauthorization', reason: effective.binding.reauthReason ?? 'unknown' };
        }
        if (!effective.binding.tokens) {
          return { state: 'unauthorized' };
        }
        return { state: 'authorized', binding: effective.binding };
      case 'unreadable':
        return { state: 'unreadable' };
      default:
        return { state: 'unauthorized' };
    }
  }

  /** A current access token for the gateway, refreshing at the pinned endpoint when needed. */
  async getAccessToken(key: string, options: { rejectedToken?: string } = {}): Promise<AccessTokenResult> {
    const effective = await this.effectiveBinding(key);
    if (effective.kind === 'unreadable') {
      return { ok: false, errorType: 'credential_storage_unavailable' };
    }
    if (effective.kind !== 'present') {
      return { ok: false, errorType: 'unauthorized' };
    }
    const binding = effective.binding;
    if (binding.state === 'needs_reauthorization') {
      return { ok: false, errorType: binding.reauthReason ?? 'unknown' };
    }
    const tokens = binding.tokens;
    if (!tokens) {
      return { ok: false, errorType: 'unauthorized' };
    }
    const rejectedCurrent = options.rejectedToken !== undefined && options.rejectedToken === tokens.access_token;
    const expiring = tokens.expires_at !== undefined && tokens.expires_at - this.now() < REFRESH_MARGIN_MS;
    if (!rejectedCurrent && !expiring) {
      return { ok: true, accessToken: tokens.access_token };
    }
    const inFlight = this.refreshes.get(key);
    if (inFlight) {
      return inFlight;
    }
    const refresh = this.refresh(binding).finally(() => this.refreshes.delete(key));
    this.refreshes.set(key, refresh);
    return refresh;
  }

  /**
   * Record that the server keeps refusing a freshly refreshed token. Checks,
   * without credentials, whether the server now names a different
   * authorization server, so the user is told why.
   */
  async reportPersistentUnauthorized(key: string, wwwAuthenticate: string | null, rejectedToken: string): Promise<void> {
    const effective = await this.effectiveBinding(key);
    if (effective.kind !== 'present') {
      return;
    }
    const binding = effective.binding;
    // Only the credential that was refused is affected. A request that
    // started before a re-sign-in must not clear the new tokens.
    if (binding.tokens?.access_token !== rejectedToken) {
      return;
    }
    let reason: McpOAuthErrorType = 'token_exchange';
    const resourceMetadataUrl = wwwAuthenticate ? /resource_metadata="([^"]+)"/i.exec(wwwAuthenticate)?.[1] : undefined;
    // Only a URL on the server's own origin is fetched: this runs in the
    // background, and a server must not be able to point main at an arbitrary
    // (for example loopback) address.
    if (resourceMetadataUrl && sameOrigin(resourceMetadataUrl, binding.serverUrl)) {
      try {
        assertNoDowngrade(resourceMetadataUrl, binding.serverUrl, 'resource metadata URL');
        const response = await this.fetchFn(resourceMetadataUrl, { redirect: 'manual', headers: { Accept: 'application/json' } });
        if (response.ok) {
          const prm = await response.json() as { authorization_servers?: unknown };
          const advertised = Array.isArray(prm.authorization_servers) ? prm.authorization_servers[0] : undefined;
          if (typeof advertised === 'string' && !issuersMatch(advertised, binding.issuer)) {
            reason = 'authorization_server_changed';
          }
        }
      } catch {
        // Keep the generic reason.
      }
    }
    await this.markNeedsReauthorization(binding, reason, { dropTokens: true });
  }

  async authorize(descriptor: MCPRemoteConfigDescriptor, options: { timeoutMs: number }): Promise<AuthorizeResult> {
    const key = this.bindingKeyFor(descriptor);
    this.pendingFlows.get(key)?.abort();
    const controller = new AbortController();
    this.pendingFlows.set(key, controller);

    let listener: CallbackListener | null = null;
    try {
      const startGeneration = await this.store.currentGeneration(key);
      const discovery = await discoverForAuthorization(descriptor, this.fetchFn);
      this.throwIfAborted(controller);

      const effective = await this.effectiveBinding(key);
      if (effective.kind === 'unreadable' && !this.store.canWrite(key)) {
        // The saved record cannot be read and a new one could not be written
        // over it; say so before the browser opens, not after.
        throw new McpOAuthError('credential_storage_unavailable', 'Nimbalyst cannot read or write its saved MCP sign-ins on this system right now.');
      }
      const existingClient = effective.kind === 'present'
        && !effective.binding.clientRejected
        && issuersMatch(effective.binding.client.issuer, discovery.issuer)
        ? effective.binding.client
        : undefined;
      const staticInfo = descriptor.staticOAuthClientInfo;
      const isStatic = Boolean(staticInfo?.client_id);

      const choice = resolveRedirectUri({ descriptor, existing: existingClient, platform: this.platform });
      let reuseClient = choice.reuseClient;
      try {
        listener = await startCallbackListener(choice.redirectUri);
      } catch (error) {
        if (!(error instanceof McpOAuthError) || error.errorType !== 'port_conflict' || isStatic) {
          throw error;
        }
        // A registered port is busy: register a new client on a free port.
        listener = await startCallbackListener(choice.redirectUri, 0);
        reuseClient = false;
      }
      const redirectUri = listener.redirectUri;

      let client: StoredClient;
      if (isStatic && staticInfo) {
        client = {
          client_id: staticInfo.client_id,
          client_secret: staticInfo.client_secret,
          redirect_uri: redirectUri,
          redirect_uris: [redirectUri],
          redirectUriConfirmed: false,
          source: 'static',
          issuer: discovery.issuer,
        };
      } else if (reuseClient && existingClient) {
        client = { ...existingClient, redirect_uri: redirectUri };
      } else {
        client = await this.register(descriptor, discovery, redirectUri);
      }
      this.throwIfAborted(controller);

      const state = randomBytes(32).toString('base64url');
      const { authorizationUrl, codeVerifier } = await startAuthorization(discovery.issuer, {
        metadata: discovery.asMetadata as never,
        clientInformation: toClientInformation(client),
        redirectUrl: redirectUri,
        scope: discovery.scope,
        state,
        resource: discovery.resource,
      });
      if (!sameOrigin(authorizationUrl, discovery.asMetadata.authorization_endpoint)) {
        throw new McpOAuthError('issuer_mismatch', 'The authorization URL does not belong to the authorization server.');
      }
      assertNoDowngrade(authorizationUrl, descriptor.serverUrl, 'authorization URL');

      listener.expect({
        state,
        issuer: discovery.issuer,
        requireIss: discovery.asMetadata.authorization_response_iss_parameter_supported === true,
      });
      try {
        await this.openExternal(authorizationUrl.href);
      } catch {
        throw new McpOAuthError('browser_launch', 'The browser could not be opened.');
      }

      const code = await listener.waitForCode(options.timeoutMs, controller.signal);
      listener.close();

      let tokens;
      try {
        tokens = await exchangeAuthorization(discovery.issuer, {
          metadata: discovery.asMetadata as never,
          clientInformation: toClientInformation(client),
          authorizationCode: code,
          codeVerifier,
          redirectUri,
          resource: discovery.resource,
          fetchFn: this.fetchFn,
        });
      } catch (error) {
        if (error instanceof InvalidClientError || error instanceof UnauthorizedClientError) {
          // The provider no longer knows this client (deleted registration).
          // Mark it so the next sign-in registers a new one instead of reusing it.
          if (effective.kind === 'present' && !isStatic && effective.binding.client.client_id === client.client_id) {
            await this.markClientRejected(effective.binding);
          }
        }
        throw classifySdkError(error, 'token_exchange');
      }

      const storedTokens = this.toStoredTokens(tokens, discovery.issuer);
      // Commit only if this flow is still the current one for the server and
      // nothing was revoked since it started. A newer flow aborts this one, so
      // a superseded flow never overwrites it; its tokens are revoked.
      const tombstone = await this.store.loadTombstone(key);
      const commitGeneration = await this.store.currentGeneration(key);
      const superseded = controller.signal.aborted || this.pendingFlows.get(key) !== controller;
      if (superseded || (tombstone !== null && tombstone.generation > startGeneration)) {
        await this.revokeAtProvider({ asMetadata: discovery.asMetadata, serverUrl: descriptor.serverUrl, client }, storedTokens);
        return { ok: false, errorType: 'cancelled', message: 'Authorization was cancelled.' };
      }
      const nowIso = new Date(this.now()).toISOString();
      const binding: McpOAuthBinding = {
        version: 1,
        bindingKey: key,
        serverUrl: normalizeServerUrl(descriptor.serverUrl),
        resource: discovery.resource,
        resourceMetadataUrl: discovery.resourceMetadataUrl,
        scope: discovery.scope,
        issuer: discovery.issuer,
        asMetadata: discovery.asMetadata,
        client: { ...client, redirect_uri: redirectUri, redirectUriConfirmed: true },
        tokens: storedTokens,
        state: 'active',
        origin: 'authorized',
        generation: commitGeneration + 1,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      const saved = await this.store.saveIfGeneration(binding, commitGeneration);
      if (!saved) {
        // Revoked or signed in again during the commit itself.
        await this.revokeAtProvider(binding, storedTokens);
        return { ok: false, errorType: 'cancelled', message: 'Authorization was cancelled.' };
      }
      this.log('info', '[MCP OAuth] Authorized', { issuerHost: safeHost(discovery.issuer) });
      return { ok: true };
    } catch (error) {
      const classified = error instanceof McpOAuthError ? error : classifySdkError(error, 'unknown');
      return { ok: false, errorType: classified.errorType, message: classified.message };
    } finally {
      listener?.close();
      if (this.pendingFlows.get(key) === controller) {
        this.pendingFlows.delete(key);
      }
    }
  }

  /**
   * Local access ends first; the provider is asked afterwards, best effort.
   */
  async revoke(descriptor: MCPRemoteConfigDescriptor): Promise<RevokeResult> {
    const key = this.bindingKeyFor(descriptor);
    this.pendingFlows.get(key)?.abort();
    let fingerprints: string[] = [];
    try {
      fingerprints = await legacyFingerprints(descriptor, this.legacyAuthDir());
    } catch {
      fingerprints = [];
    }
    const revoked = await this.store.revoke(key, fingerprints);
    if (!revoked) {
      return { success: true, provider: 'none' };
    }
    const provider = await this.revokeAtProvider(revoked, revoked.tokens);
    return { success: true, provider };
  }

  private async refresh(binding: McpOAuthBinding): Promise<AccessTokenResult> {
    const generation = binding.generation;
    const refreshToken = binding.tokens?.refresh_token;
    if (!refreshToken) {
      await this.markNeedsReauthorization(binding, 'token_exchange', { dropTokens: true });
      return { ok: false, errorType: 'token_exchange' };
    }
    let refreshed;
    try {
      refreshed = await refreshAuthorization(binding.issuer, {
        metadata: binding.asMetadata as never,
        clientInformation: toClientInformation(binding.client),
        refreshToken,
        resource: binding.resource,
        fetchFn: this.fetchFn,
      });
    } catch (error) {
      if (error instanceof InvalidGrantError) {
        await this.markNeedsReauthorization(binding, 'token_exchange', { dropTokens: true });
        return { ok: false, errorType: 'token_exchange' };
      }
      if (error instanceof InvalidClientError || error instanceof UnauthorizedClientError) {
        await this.markNeedsReauthorization(binding, 'token_exchange', { dropTokens: true, dropClient: true });
        return { ok: false, errorType: 'token_exchange' };
      }
      // Network trouble or a 5xx: nothing changes; the next request retries.
      this.log('warn', '[MCP OAuth] Token refresh failed', { kind: error instanceof OAuthError ? error.errorCode : 'network' });
      return { ok: false, errorType: 'network' };
    }

    const tokens = this.toStoredTokens(refreshed, binding.issuer);
    const next: McpOAuthBinding = {
      ...binding,
      tokens,
      updatedAt: new Date(this.now()).toISOString(),
    };
    let saved: boolean;
    try {
      saved = await this.store.saveIfGeneration(next, generation);
    } catch {
      // The disk write failed, but the store kept the rotated tokens in
      // memory, so this run keeps working; the old refresh token on disk
      // may force a sign-in after restart.
      this.log('warn', '[MCP OAuth] Could not save refreshed tokens');
      return { ok: true, accessToken: tokens.access_token };
    }
    if (!saved) {
      // Revoked or re-authorized while the refresh was in flight. The new
      // tokens are never used; if the record was revoked, revoke them too.
      const tombstone = await this.store.loadTombstone(binding.bindingKey);
      if (tombstone && tombstone.generation > generation) {
        await this.revokeAtProvider(binding, tokens);
      }
      return { ok: false, errorType: 'unauthorized' };
    }
    return { ok: true, accessToken: tokens.access_token };
  }

  private async register(
    descriptor: MCPRemoteConfigDescriptor,
    discovery: PinnedDiscovery,
    redirectUri: string,
  ): Promise<StoredClient> {
    const extra: Record<string, unknown> = { ...(descriptor.staticOAuthClientMetadata ?? {}) };
    delete extra.redirect_uris;
    const clientMetadata = {
      client_name: DEFAULT_CLIENT_NAME,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...extra,
      redirect_uris: [redirectUri],
    };
    if (!discovery.asMetadata.registration_endpoint) {
      throw new McpOAuthError(
        'dynamic_registration_unsupported',
        'This provider does not support dynamic client registration. Add a pre-registered OAuth client ID for this server and try again.',
      );
    }
    try {
      const full = await registerClient(discovery.issuer, {
        metadata: discovery.asMetadata as never,
        clientMetadata: clientMetadata as never,
        scope: discovery.scope,
        fetchFn: this.fetchFn,
      });
      return {
        client_id: full.client_id,
        client_secret: full.client_secret,
        client_secret_expires_at: full.client_secret_expires_at,
        token_endpoint_auth_method: full.token_endpoint_auth_method,
        redirect_uri: redirectUri,
        redirect_uris: Array.isArray(full.redirect_uris) ? full.redirect_uris.map(String) : [redirectUri],
        redirectUriConfirmed: false,
        source: 'dcr',
        issuer: discovery.issuer,
      };
    } catch (error) {
      if (error instanceof InvalidClientMetadataError) {
        throw new McpOAuthError(
          'dynamic_registration_unsupported',
          'This provider does not support dynamic client registration. Add a pre-registered OAuth client ID for this server and try again.',
        );
      }
      throw classifySdkError(error, 'network');
    }
  }

  private importOnce(key: string, descriptor: MCPRemoteConfigDescriptor): Promise<void> {
    const existing = this.imports.get(key);
    if (existing) {
      return existing;
    }
    const attempt = this.importLegacy(key, descriptor).catch((error) => {
      // A failed attempt (offline, provider down) is retried at the next
      // status check instead of hiding the legacy sign-in until restart.
      this.imports.delete(key);
      this.log('warn', '[MCP OAuth] Legacy credential import skipped', {
        reason: error instanceof McpOAuthError ? error.errorType : 'unknown',
      });
    });
    this.imports.set(key, attempt);
    return attempt;
  }

  /**
   * One-time import of mcp-remote's credentials. Trust on first use: the
   * authorization server found now is pinned, and the imported refresh token
   * is only ever sent there. Records stamped with a different issuer, and
   * records a revoke has fingerprinted, are never imported.
   */
  private async importLegacy(key: string, descriptor: MCPRemoteConfigDescriptor): Promise<void> {
    const candidates = await findLegacyCredentials(descriptor, this.legacyAuthDir());
    if (candidates.length === 0) {
      return;
    }
    const tombstone = await this.store.loadTombstone(key);
    const blocked = new Set(tombstone?.importFingerprints ?? []);
    const usable = candidates.filter((candidate) => !blocked.has(candidate.fingerprint));
    if (usable.length === 0) {
      return;
    }
    const startGeneration = await this.store.currentGeneration(key);
    const discovery = await discoverForAuthorization(descriptor, this.fetchFn);

    const pick = usable.find((candidate) => this.importable(candidate, discovery, descriptor));
    if (!pick) {
      return;
    }
    const staticInfo = descriptor.staticOAuthClientInfo;
    const client: StoredClient = staticInfo?.client_id
      ? {
          client_id: staticInfo.client_id,
          client_secret: staticInfo.client_secret,
          redirect_uri: '',
          redirect_uris: [],
          redirectUriConfirmed: false,
          source: 'static',
          issuer: discovery.issuer,
        }
      : {
          client_id: pick.client!.client_id,
          client_secret: pick.client!.client_secret,
          client_secret_expires_at: pick.client!.client_secret_expires_at,
          token_endpoint_auth_method: pick.client!.token_endpoint_auth_method,
          redirect_uri: pick.client!.redirect_uris[0] ?? '',
          redirect_uris: pick.client!.redirect_uris,
          redirectUriConfirmed: false,
          source: 'imported',
          issuer: discovery.issuer,
        };
    const nowIso = new Date(this.now()).toISOString();
    const binding: McpOAuthBinding = {
      version: 1,
      bindingKey: key,
      serverUrl: normalizeServerUrl(descriptor.serverUrl),
      resource: discovery.resource,
      scope: discovery.scope,
      issuer: discovery.issuer,
      asMetadata: discovery.asMetadata,
      client,
      tokens: {
        access_token: pick.tokens.access_token ?? '',
        refresh_token: pick.tokens.refresh_token,
        token_type: pick.tokens.token_type,
        scope: pick.tokens.scope,
        // An access token with no known expiry is refreshed on first use, so
        // a stale imported token is never presented without a refresh. With
        // no refresh token there is nothing to refresh with: the token is
        // used as is and a 401 decides.
        expires_at: pick.tokens.refresh_token
          ? (pick.tokens.access_token ? pick.tokens.expires_at ?? 0 : 0)
          : pick.tokens.expires_at,
        issuer: discovery.issuer,
      },
      state: 'active',
      origin: 'imported-mcp-remote',
      importFingerprint: pick.fingerprint,
      generation: startGeneration + 1,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    const saved = await this.store.saveIfGeneration(binding, startGeneration);
    if (saved) {
      this.log('info', '[MCP OAuth] Imported credentials from mcp-remote', { issuerHost: safeHost(discovery.issuer) });
    }
  }

  private importable(candidate: LegacyCandidate, discovery: PinnedDiscovery, descriptor: MCPRemoteConfigDescriptor): boolean {
    // Every issuer the legacy files record must match the one found now,
    // whichever client the tokens will be refreshed with.
    if (candidate.tokens.issuer && !issuersMatch(candidate.tokens.issuer, discovery.issuer)) {
      return false;
    }
    if (candidate.client?.issuer && !issuersMatch(candidate.client.issuer, discovery.issuer)) {
      return false;
    }
    const staticClientId = descriptor.staticOAuthClientInfo?.client_id;
    if (staticClientId) {
      // Tokens issued to a different client are not this client's to use.
      if (candidate.client && candidate.client.client_id !== staticClientId) {
        return false;
      }
      return Boolean(candidate.tokens.refresh_token || candidate.tokens.access_token);
    }
    return Boolean(candidate.client);
  }

  private async markClientRejected(binding: McpOAuthBinding): Promise<void> {
    await this.store.saveIfGeneration({ ...binding, clientRejected: true, updatedAt: new Date(this.now()).toISOString() }, binding.generation);
  }

  private async markNeedsReauthorization(
    binding: McpOAuthBinding,
    reason: McpOAuthErrorType,
    options: { dropTokens: boolean; dropClient?: boolean },
  ): Promise<void> {
    const next: McpOAuthBinding = {
      ...binding,
      tokens: options.dropTokens ? undefined : binding.tokens,
      clientRejected: options.dropClient ? true : binding.clientRejected,
      state: 'needs_reauthorization',
      reauthReason: reason,
      updatedAt: new Date(this.now()).toISOString(),
    };
    const saved = await this.store.saveIfGeneration(next, binding.generation);
    if (saved) {
      this.log('warn', '[MCP OAuth] Server needs authorization again', { reason });
      for (const listener of this.listeners) {
        try {
          listener({ bindingKey: binding.bindingKey, serverUrl: binding.serverUrl, reason });
        } catch {
          // Listener failures do not affect credential state.
        }
      }
    }
  }

  private async revokeAtProvider(
    binding: Pick<McpOAuthBinding, 'asMetadata' | 'serverUrl' | 'client'>,
    tokens: StoredTokens | undefined,
  ): Promise<RevokeResult['provider']> {
    const endpoint = binding.asMetadata.revocation_endpoint;
    if (!tokens) {
      return 'none';
    }
    if (!endpoint) {
      return 'unsupported';
    }
    try {
      assertNoDowngrade(endpoint, binding.serverUrl, 'revocation endpoint');
    } catch {
      return 'failed';
    }
    const toRevoke: Array<[string, string]> = [];
    if (tokens.refresh_token) toRevoke.push([tokens.refresh_token, 'refresh_token']);
    if (tokens.access_token) toRevoke.push([tokens.access_token, 'access_token']);
    let allOk = true;
    for (const [token, hint] of toRevoke) {
      const body = new URLSearchParams({ token, token_type_hint: hint });
      const headers: Record<string, string> = {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      };
      const client = binding.client;
      const methods = binding.asMetadata.revocation_endpoint_auth_methods_supported
        ?? binding.asMetadata.token_endpoint_auth_methods_supported;
      if (client.client_secret && (!methods || methods.includes('client_secret_basic'))) {
        headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(client.client_id)}:${encodeURIComponent(client.client_secret)}`).toString('base64')}`;
      } else {
        body.set('client_id', client.client_id);
        if (client.client_secret) {
          body.set('client_secret', client.client_secret);
        }
      }
      try {
        // Credentials never follow a redirect.
        const response = await this.fetchFn(endpoint, { method: 'POST', headers, body, redirect: 'manual' });
        if (!response.ok) {
          allOk = false;
        }
        await response.body?.cancel();
      } catch {
        allOk = false;
      }
    }
    return allOk ? 'revoked' : 'failed';
  }

  private async effectiveBinding(key: string): Promise<
    { kind: 'present'; binding: McpOAuthBinding } | { kind: 'absent' } | { kind: 'unreadable' }
  > {
    const loaded = await this.store.load(key);
    if (loaded.status === 'unreadable') {
      return { kind: 'unreadable' };
    }
    if (loaded.status === 'absent') {
      return { kind: 'absent' };
    }
    const tombstone = await this.store.loadTombstone(key);
    if (tombstone && tombstone.generation >= loaded.binding.generation) {
      // A revoke whose record move did not finish still wins.
      return { kind: 'absent' };
    }
    return { kind: 'present', binding: loaded.binding };
  }

  private toStoredTokens(tokens: { access_token: string; token_type?: string; refresh_token?: string; expires_in?: number; scope?: string }, issuer: string): StoredTokens {
    return {
      access_token: tokens.access_token,
      token_type: tokens.token_type,
      refresh_token: tokens.refresh_token,
      expires_at: typeof tokens.expires_in === 'number' ? this.now() + tokens.expires_in * 1000 : undefined,
      scope: tokens.scope,
      issuer,
    };
  }

  private throwIfAborted(controller: AbortController): void {
    if (controller.signal.aborted) {
      throw new McpOAuthError('cancelled', 'Authorization was cancelled.');
    }
  }
}

/**
 * Bound every OAuth request, so a hung discovery, registration or token
 * response cannot hold a sign-in open or occupy the single-flight refresh
 * slot indefinitely. A caller's own signal still applies.
 */
function withRequestTimeout(fetchFn: FetchLike, timeoutMs: number): FetchLike {
  return (input, init) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return fetchFn(input, { ...init, signal });
  };
}

function toClientInformation(client: StoredClient) {
  return {
    client_id: client.client_id,
    ...(client.client_secret ? { client_secret: client.client_secret } : {}),
    ...(client.client_secret_expires_at !== undefined ? { client_secret_expires_at: client.client_secret_expires_at } : {}),
    ...(client.token_endpoint_auth_method ? { token_endpoint_auth_method: client.token_endpoint_auth_method } : {}),
    redirect_uris: client.redirect_uris.length > 0 ? client.redirect_uris : [client.redirect_uri],
  };
}

function classifySdkError(error: unknown, fallback: McpOAuthErrorType): McpOAuthError {
  if (error instanceof McpOAuthError) {
    return error;
  }
  if (error instanceof InvalidClientMetadataError) {
    return new McpOAuthError('dynamic_registration_unsupported', 'This provider does not support dynamic client registration.');
  }
  if (error instanceof OAuthError) {
    return new McpOAuthError(fallback === 'unknown' ? 'token_exchange' : fallback, 'The provider did not accept the authorization response.');
  }
  if (error instanceof TypeError) {
    return new McpOAuthError('network', 'The OAuth provider could not be reached.');
  }
  const message = error instanceof Error ? error.message : '';
  if (/dynamic client registration/i.test(message)) {
    return new McpOAuthError('dynamic_registration_unsupported', 'This provider does not support dynamic client registration.');
  }
  if (/Incompatible auth server/i.test(message)) {
    return new McpOAuthError('invalid_config', 'The authorization server does not support the authorization code flow with PKCE.');
  }
  if (/Redirect .*not followed|HTTP 3\d\d/i.test(message)) {
    return new McpOAuthError('network', 'The OAuth provider answered with a redirect Nimbalyst does not follow.');
  }
  return new McpOAuthError(fallback, 'OAuth authorization failed.');
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid';
  }
}
