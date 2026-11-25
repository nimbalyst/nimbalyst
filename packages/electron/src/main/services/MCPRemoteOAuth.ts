import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MCPServerConfig } from '@nimbalyst/runtime/types/MCPServerConfig';
import { getEnhancedPath, getShellEnvironment } from './shellEnvironment';
import { logger } from '../utils/logger';
import type { McpOAuthErrorType } from './mcpOAuth/types';
import { getMcpRemoteServerHashes } from './mcpOAuth/serverIdentity';
import { getMcpOAuthManager } from './mcpOAuth';

export interface MCPRemoteConfigDescriptor {
  serverUrl: string;
  headers: Record<string, string>;
  callbackPort?: number;
  host?: string;
  /** Exact redirect URI for a pre-registered client (`oauth.redirectUri`). */
  redirectUri?: string;
  authorizeResource?: string;
  transportStrategy?: 'http-first' | 'sse-first' | 'http-only' | 'sse-only';
  authTimeoutSeconds?: number;
  staticOAuthClientInfo?: Record<string, string>;
  staticOAuthClientMetadata?: Record<string, string | number | boolean | null>;
  requiresOAuth: boolean;
  /**
   * Set when the descriptor was parsed from an `npx mcp-remote <url> ...`
   * command that Nimbalyst cannot reproduce exactly (an option it does not
   * implement, a `${VAR}` it cannot resolve from the server's `env` or the
   * login shell, an
   * `@file` argument). Those keep running mcp-remote with its `~/.mcp-auth`
   * store. A command made only of options Nimbalyst implements is bridged
   * through the native gateway instead, without rewriting the saved config
   * (see `isBridgeableMcpRemoteCommand`). Every other remote server is
   * authorized by Nimbalyst's own OAuth client (see ./mcpOAuth and
   * docs/MCP_OAUTH.md).
   */
  source?: 'user-command';
}

export interface MCPRemoteConfigOptions {
  /**
   * Codex, Codex ACP and Copilot cannot run a server's own `oauth.clientId`
   * flow, so Nimbalyst authorizes those servers itself and routes them through
   * the gateway. In that provider path, auth status is Nimbalyst's credential,
   * not "managed by the CLI".
   */
  useMcpRemoteForNativeOAuth?: boolean;
}

const OAUTH_DISCOVERY_TIMEOUT_MS = 2500;
// mcp-remote imposes no hard auth deadline (its callback server waits on the
// auth code indefinitely; its 30s value only paces a long-poll cycle), so this
// outer timer is the true user-facing deadline. Keep it generous enough to
// cover a real consent + account-picker + MFA flow, otherwise legitimate auths
// get killed and reported as `timed_out`.
const DEFAULT_OAUTH_FLOW_TIMEOUT_MS = 180_000;
const CONFIGURED_TIMEOUT_GRACE_MS = 5_000;
const MAX_DIAGNOSTIC_OUTPUT_CHARS = 32_000;
const oauthRequirementCache = new Map<string, Promise<boolean>>();

export type MCPRemoteOAuthOutcome = 'authorized' | 'rejected' | 'timed_out' | 'failed';

// Failure categories. The renderer analytics allowlist (mcpOAuthAnalytics.ts,
// MCP_OAUTH_ERROR_TYPES) is the superset: it also carries `ipc_error`, which
// only the IPC boundary adds. Keep the two lists in sync.
export type MCPRemoteOAuthErrorType = McpOAuthErrorType;

export interface MCPRemoteOAuthResult {
  success: boolean;
  outcome: MCPRemoteOAuthOutcome;
  errorType?: MCPRemoteOAuthErrorType;
  error?: string;
  isStalePortError?: boolean;
  canRetryAfterCacheClear?: boolean;
}

interface MCPRemoteOAuthFailureClassification {
  outcome: Exclude<MCPRemoteOAuthOutcome, 'authorized'>;
  errorType: MCPRemoteOAuthErrorType;
}

interface MCPRemoteOAuthFailureContext {
  timedOut?: boolean;
  processErrorCode?: string;
  exited?: boolean;
}

export function getMcpAuthDir(): string {
  return process.env.MCP_REMOTE_CONFIG_DIR || path.join(os.homedir(), '.mcp-auth');
}

export function usesNativeRemoteOAuth(config: MCPServerConfig): boolean {
  if (config.type !== 'http' && config.type !== 'sse') {
    return false;
  }

  return Boolean(config.oauth?.clientId || config.oauth?.clientSecret);
}

function getStaticOAuthClientInfo(
  oauthConfig: MCPServerConfig['oauth']
): Record<string, string> | undefined {
  if (!oauthConfig) {
    return undefined;
  }

  if (oauthConfig.staticClientInfo && Object.keys(oauthConfig.staticClientInfo).length > 0) {
    return oauthConfig.staticClientInfo;
  }

  if (!oauthConfig.clientId && !oauthConfig.clientSecret) {
    return undefined;
  }

  const clientInfo: Record<string, string> = {};
  if (oauthConfig.clientId) {
    clientInfo.client_id = oauthConfig.clientId;
  }
  if (oauthConfig.clientSecret) {
    clientInfo.client_secret = oauthConfig.clientSecret;
  }
  return Object.keys(clientInfo).length > 0 ? clientInfo : undefined;
}

/**
 * `oauth.redirectUri`, or the first string in a hand-edited
 * `staticClientMetadata.redirect_uris` array. The typed field is scalar; the
 * array form is read leniently because configs written for mcp-remote could
 * carry it.
 */
function getConfiguredRedirectUri(oauthConfig: MCPServerConfig['oauth']): string | undefined {
  if (typeof oauthConfig?.redirectUri === 'string' && oauthConfig.redirectUri.length > 0) {
    return oauthConfig.redirectUri;
  }
  const raw = (oauthConfig?.staticClientMetadata as Record<string, unknown> | undefined)?.redirect_uris;
  if (Array.isArray(raw)) {
    const first = raw.find((value): value is string => typeof value === 'string' && value.length > 0);
    if (first) {
      return first;
    }
  }
  return undefined;
}

export function extractMcpRemoteConfig(
  config: MCPServerConfig,
  options: MCPRemoteConfigOptions = {}
): MCPRemoteConfigDescriptor | null {
  if (usesNativeRemoteOAuth(config) && !options.useMcpRemoteForNativeOAuth) {
    return null;
  }

  if (config.type === 'http' || config.type === 'sse') {
    if (!config.url) {
      return null;
    }

    // `${VAR}` in a URL or header resolves from the server's own `env`, then
    // the login-shell environment, which is what the old helper inherited.
    // Unresolved references stay literal, as before.
    const env = resolveGatewayEnv(config.env);
    const headers = normalizeHeaders(expandHeaderValues(config.headers, env));
    const requiresOAuth = Boolean(config.oauth);

    return {
      serverUrl: expandServerVariables(config.url, env).value,
      headers,
      callbackPort: config.oauth?.callbackPort,
      host: config.oauth?.host,
      redirectUri: getConfiguredRedirectUri(config.oauth),
      authorizeResource: config.oauth?.resource,
      transportStrategy: config.oauth?.transportStrategy,
      authTimeoutSeconds: config.oauth?.authTimeoutSeconds,
      staticOAuthClientInfo: getStaticOAuthClientInfo(config.oauth),
      staticOAuthClientMetadata: config.oauth?.staticClientMetadata,
      requiresOAuth,
    };
  }

  if (!looksLikeMcpRemoteCommand(config.command, config.args)) {
    return null;
  }

  const bridged = parseBridgeableMcpRemoteCommand(config);
  if (bridged) {
    return bridged;
  }

  const args = [...(config.args || [])];
  const remoteIndex = args.findIndex((arg) => arg === 'mcp-remote' || arg.startsWith('mcp-remote@'));
  if (remoteIndex === -1 || remoteIndex + 1 >= args.length) {
    return null;
  }

  const serverUrl = args[remoteIndex + 1];
  if (!serverUrl.startsWith('http://') && !serverUrl.startsWith('https://')) {
    return null;
  }

  let callbackPort: number | undefined;
  const possiblePort = args[remoteIndex + 2];
  if (possiblePort && /^\d+$/.test(possiblePort)) {
    callbackPort = Number(possiblePort);
  }

  const headers = parseMcpRemoteHeaders(args);
  const parsed = parseMcpRemoteFlags(args);
  const requiresOAuth = Boolean(config.oauth);

  return {
    serverUrl,
    headers,
    callbackPort: config.oauth?.callbackPort ?? callbackPort,
    host: config.oauth?.host ?? parsed.host,
    authorizeResource: config.oauth?.resource ?? parsed.authorizeResource,
    transportStrategy: config.oauth?.transportStrategy ?? parsed.transportStrategy,
    authTimeoutSeconds: config.oauth?.authTimeoutSeconds ?? parsed.authTimeoutSeconds,
    staticOAuthClientInfo: config.oauth?.staticClientInfo ?? parsed.staticOAuthClientInfo,
    staticOAuthClientMetadata: config.oauth?.staticClientMetadata ?? parsed.staticOAuthClientMetadata,
    requiresOAuth,
    source: 'user-command',
  };
}

export function buildMcpRemoteArgs(descriptor: MCPRemoteConfigDescriptor, packageName = 'mcp-remote'): string[] {
  const args = [packageName, descriptor.serverUrl];

  if (descriptor.callbackPort) {
    args.push(String(descriptor.callbackPort));
  }

  if (descriptor.host) {
    args.push('--host', descriptor.host);
  }

  if (descriptor.transportStrategy) {
    args.push('--transport', descriptor.transportStrategy);
  }

  if (descriptor.authorizeResource) {
    args.push('--resource', descriptor.authorizeResource);
  }

  if (descriptor.authTimeoutSeconds) {
    args.push('--auth-timeout', String(descriptor.authTimeoutSeconds));
  }

  const sortedHeaderKeys = Object.keys(descriptor.headers).sort();
  for (const key of sortedHeaderKeys) {
    args.push('--header', `${key}:${descriptor.headers[key]}`);
  }

  if (descriptor.staticOAuthClientMetadata) {
    args.push('--static-oauth-client-metadata', JSON.stringify(descriptor.staticOAuthClientMetadata));
  }

  if (descriptor.staticOAuthClientInfo) {
    args.push('--static-oauth-client-info', JSON.stringify(descriptor.staticOAuthClientInfo));
  }

  return args;
}

export async function checkMcpRemoteAuthStatus(
  configOrUrl: MCPServerConfig | MCPRemoteConfigDescriptor | string,
  options: MCPRemoteConfigOptions = {}
): Promise<{ authorized: boolean; tokenPath?: string }> {
  const descriptor = typeof configOrUrl === 'string'
    ? { serverUrl: configOrUrl, headers: {}, requiresOAuth: true }
    : isMcpRemoteConfigDescriptor(configOrUrl)
      ? configOrUrl
      : extractMcpRemoteConfig(configOrUrl, options);

  if (!descriptor) {
    return { authorized: false };
  }

  if (descriptor.source !== 'user-command') {
    const status = await getMcpOAuthManager().getStatus(descriptor);
    return { authorized: status.state === 'authorized' };
  }

  const startTime = Date.now();
  const authDir = getMcpAuthDir();
  const serverHashes = getServerHashes(descriptor);

  try {
    const entries = await fs.promises.readdir(authDir, { withFileTypes: true });
    const versionDirs = entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('mcp-remote-'))
      .map((entry) => entry.name)
      .sort()
      .reverse();

    for (const versionDir of versionDirs) {
      const versionPath = path.join(authDir, versionDir);
      const tokenPath = await findAuthorizedTokenFile(versionPath, serverHashes);
      if (tokenPath) {
        logSlowAuthCheck(startTime, true);
        return { authorized: true, tokenPath };
      }
    }

    const tokenPath = await findAuthorizedTokenFile(authDir, serverHashes);
    if (tokenPath) {
      logSlowAuthCheck(startTime, true);
      return { authorized: true, tokenPath };
    }
  } catch {
    // Auth directory missing is a normal "not authorized" case.
  }

  logSlowAuthCheck(startTime, false);
  return { authorized: false };
}

function isMcpRemoteConfigDescriptor(
  value: MCPServerConfig | MCPRemoteConfigDescriptor
): value is MCPRemoteConfigDescriptor {
  return typeof (value as MCPRemoteConfigDescriptor).serverUrl === 'string';
}

export async function discoverMcpRemoteOAuthRequirement(
  descriptor: MCPRemoteConfigDescriptor
): Promise<boolean> {
  if (descriptor.requiresOAuth) {
    return true;
  }

  if (hasBearerAuthorization(descriptor.headers)) {
    return false;
  }

  const cacheKey = getOAuthDiscoveryCacheKey(descriptor);
  let cached = oauthRequirementCache.get(cacheKey);
  if (!cached) {
    cached = probeMcpRemoteOAuthRequirement(descriptor)
      .then((requiresOAuth) => {
        if (!requiresOAuth) {
          oauthRequirementCache.delete(cacheKey);
        }
        return requiresOAuth;
      })
      .catch(() => {
        oauthRequirementCache.delete(cacheKey);
        return false;
      });
    oauthRequirementCache.set(cacheKey, cached);
  }
  return cached;
}

export async function triggerMcpRemoteOAuth(
  configOrUrl: MCPServerConfig | string
): Promise<MCPRemoteOAuthResult> {
  const descriptor = typeof configOrUrl === 'string'
    ? { serverUrl: configOrUrl, headers: {}, requiresOAuth: true }
    : extractMcpRemoteConfig(configOrUrl);

  if (!descriptor) {
    return createMcpRemoteOAuthFailure(
      { outcome: 'failed', errorType: 'invalid_config' }
    );
  }

  if (descriptor.source !== 'user-command') {
    return triggerNativeOAuth(descriptor);
  }

  return new Promise((resolve) => {
    safeLog('info', '[MCP OAuth] Starting authorization');

    const npxCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const child = spawn(npxCommand, ['-y', ...buildMcpRemoteArgs(descriptor)], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PATH: getEnhancedPath() },
      shell: process.platform === 'win32'
    });

    let stderr = '';
    let resolved = false;

    const finish = (result: MCPRemoteOAuthResult, killChild = true) => {
      if (resolved) {
        return;
      }
      resolved = true;
      clearTimeout(timeout);
      if (checkInterval) {
        clearInterval(checkInterval);
      }
      if (killChild && !child.killed) {
        child.kill();
      }
      safeLog('info', '[MCP OAuth] Authorization finished', {
        outcome: result.outcome,
        errorType: result.errorType,
      });
      resolve(result);
    };

    const timeout = setTimeout(() => {
      finish(createMcpRemoteOAuthFailure(
        classifyMcpRemoteOAuthFailure(stderr, { timedOut: true })
      ));
    }, getMcpRemoteOAuthTimeoutMs(descriptor));

    child.stdout?.resume();

    child.stderr?.on('data', (data) => {
      stderr = appendBoundedDiagnosticOutput(stderr, data.toString());
    });

    child.on('error', (error) => {
      const processErrorCode = (error as NodeJS.ErrnoException).code;
      finish(createMcpRemoteOAuthFailure(
        classifyMcpRemoteOAuthFailure(stderr, { processErrorCode }),
        processErrorCode === 'ENOENT' ? getCommandNotFoundHelp(npxCommand).message : undefined
      ));
    });

    child.on('close', (code) => {
      if (resolved) {
        return;
      }
      void checkMcpRemoteAuthStatus(descriptor)
        .then((status) => {
          if (status.authorized) {
            finish({ success: true, outcome: 'authorized' }, false);
            return;
          }

          finish(createMcpRemoteOAuthFailure(
            classifyMcpRemoteOAuthFailure(stderr, { exited: true }),
            undefined,
            code
          ), false);
        })
        .catch(() => {
          finish(createMcpRemoteOAuthFailure(
            { outcome: 'failed', errorType: 'unknown' }
          ), false);
        });
    });

    const checkInterval = setInterval(async () => {
      if (resolved) {
        return;
      }
      try {
        const status = await checkMcpRemoteAuthStatus(descriptor);
        if (status.authorized) {
          finish({ success: true, outcome: 'authorized' });
        }
      } catch {
        // Keep waiting for the helper's terminal result.
      }
    }, 2000);
  });
}

async function triggerNativeOAuth(descriptor: MCPRemoteConfigDescriptor): Promise<MCPRemoteOAuthResult> {
  safeLog('info', '[MCP OAuth] Starting authorization');
  const result = await getMcpOAuthManager().authorize(descriptor, {
    timeoutMs: getMcpRemoteOAuthTimeoutMs(descriptor),
  });
  if (result.ok) {
    safeLog('info', '[MCP OAuth] Authorization finished', { outcome: 'authorized' });
    return { success: true, outcome: 'authorized' };
  }
  const outcome: MCPRemoteOAuthResult['outcome'] = result.errorType === 'provider_rejected'
    ? 'rejected'
    : result.errorType === 'timeout'
      ? 'timed_out'
      : 'failed';
  safeLog('info', '[MCP OAuth] Authorization finished', { outcome, errorType: result.errorType });
  // No cache-clear retry here: clearing credentials cannot free a busy port
  // and would only discard a working sign-in.
  return {
    success: false,
    outcome,
    errorType: result.errorType,
    error: getMcpRemoteOAuthErrorMessage(result.errorType, undefined, { native: true }),
  };
}

export function classifyMcpRemoteOAuthFailure(
  diagnosticOutput: string,
  context: MCPRemoteOAuthFailureContext = {}
): MCPRemoteOAuthFailureClassification {
  const diagnostic = diagnosticOutput.toLowerCase();

  if (context.processErrorCode === 'ENOENT') {
    return { outcome: 'failed', errorType: 'command_unavailable' };
  }

  if (diagnostic.includes('eaddrinuse') || diagnostic.includes('address already in use')) {
    return { outcome: 'failed', errorType: 'port_conflict' };
  }

  if (
    diagnostic.includes('access_denied')
    || diagnostic.includes('authorization denied')
    || diagnostic.includes('authorization rejected')
    || diagnostic.includes('user denied')
  ) {
    return { outcome: 'rejected', errorType: 'provider_rejected' };
  }

  // mcp-remote always attempts RFC 7591 dynamic client registration, so a provider
  // that only accepts pre-registered clients kills the helper before any browser
  // opens. Must stay ahead of the generic `exited` fallback, which reported this as
  // `process_exit` and pointed users at cache-clearing remedies that cannot help.
  if (
    diagnostic.includes('invalidclientmetadataerror')
    || diagnostic.includes('dynamic client registration')
    || diagnostic.includes('dynamic registration is not available')
  ) {
    return { outcome: 'failed', errorType: 'dynamic_registration_unsupported' };
  }

  if (
    diagnostic.includes('state mismatch')
    || diagnostic.includes('invalid state')
    || diagnostic.includes('no authorization code received')
  ) {
    return { outcome: 'failed', errorType: 'callback_validation' };
  }

  if (
    diagnostic.includes('token exchange failed')
    || diagnostic.includes('invalid_grant')
    || diagnostic.includes('code verifier')
    || diagnostic.includes('pkce')
  ) {
    return { outcome: 'failed', errorType: 'token_exchange' };
  }

  if (
    diagnostic.includes('another instance is handling authentication')
    || diagnostic.includes('waiting for authentication from the server')
  ) {
    return {
      outcome: context.timedOut ? 'timed_out' : 'failed',
      errorType: 'stale_pending_auth',
    };
  }

  if (context.timedOut && diagnostic.includes('could not open browser automatically')) {
    return { outcome: 'timed_out', errorType: 'browser_launch' };
  }

  if (
    diagnostic.includes('enotfound')
    || diagnostic.includes('econnrefused')
    || diagnostic.includes('etimedout')
    || diagnostic.includes('fetch failed')
    || diagnostic.includes('network error')
  ) {
    return { outcome: 'failed', errorType: 'network' };
  }

  if (context.timedOut) {
    return { outcome: 'timed_out', errorType: 'timeout' };
  }

  if (context.processErrorCode) {
    return { outcome: 'failed', errorType: 'process_error' };
  }

  if (context.exited) {
    return { outcome: 'failed', errorType: 'process_exit' };
  }

  return { outcome: 'failed', errorType: 'unknown' };
}

export function getMcpRemoteOAuthTimeoutMs(
  descriptor: Pick<MCPRemoteConfigDescriptor, 'authTimeoutSeconds'>
): number {
  if (!descriptor.authTimeoutSeconds) {
    return DEFAULT_OAUTH_FLOW_TIMEOUT_MS;
  }
  return Math.max(
    DEFAULT_OAUTH_FLOW_TIMEOUT_MS,
    descriptor.authTimeoutSeconds * 1000 + CONFIGURED_TIMEOUT_GRACE_MS
  );
}

function createMcpRemoteOAuthFailure(
  classification: MCPRemoteOAuthFailureClassification,
  errorOverride?: string,
  exitCode?: number | null
): MCPRemoteOAuthResult {
  const canRetryAfterCacheClear = classification.errorType === 'port_conflict'
    || classification.errorType === 'stale_pending_auth';

  return {
    success: false,
    outcome: classification.outcome,
    errorType: classification.errorType,
    error: errorOverride ?? getMcpRemoteOAuthErrorMessage(classification.errorType, exitCode),
    ...(classification.errorType === 'port_conflict' ? { isStalePortError: true } : {}),
    ...(canRetryAfterCacheClear ? { canRetryAfterCacheClear: true } : {}),
  };
}

function getMcpRemoteOAuthErrorMessage(
  errorType: MCPRemoteOAuthErrorType,
  exitCode?: number | null,
  options: { native?: boolean } = {}
): string {
  if (options.native && errorType === 'port_conflict') {
    return 'Another process is using the OAuth callback port. Close it, or set a different callback port for this server, and try again.';
  }
  switch (errorType) {
    case 'issuer_mismatch':
      return 'The sign-in provider published inconsistent details about itself, so Nimbalyst did not send credentials to it.';
    case 'resource_mismatch':
      return 'The server described itself as a different resource, so Nimbalyst did not continue the sign-in.';
    case 'insecure_endpoint':
      return 'The sign-in provider uses plain http for an https server, so Nimbalyst did not send credentials to it.';
    case 'authorization_server_changed':
      return 'This server now uses a different sign-in provider. Authorize it again.';
    case 'credential_storage_unavailable':
      return 'Nimbalyst could not read or save the sign-in for this server.';
    case 'cancelled':
      return 'Authorization was cancelled.';
    case 'invalid_config':
      return 'Invalid OAuth configuration.';
    case 'timeout':
      return 'OAuth authorization timed out. Please try again.';
    case 'browser_launch':
      return 'The authorization page could not be opened. Check your default browser and try again.';
    case 'stale_pending_auth':
      return 'Another OAuth authorization is still pending. Clear the auth cache and try again.';
    case 'port_conflict':
      return 'Another process is using the OAuth callback port. Clear the auth cache and try again.';
    case 'command_unavailable':
      return 'The OAuth helper could not be started because a required command is unavailable.';
    case 'provider_rejected':
      return 'The provider did not approve authorization.';
    case 'dynamic_registration_unsupported':
      return 'This provider does not support dynamic client registration, so it cannot be authorized from here. Add a pre-registered OAuth client ID for this server (oauth.staticClientInfo) and try again. Clearing the auth cache will not help.';
    case 'callback_validation':
      return 'The OAuth callback could not be validated. Please try again.';
    case 'token_exchange':
      return 'The provider did not accept the authorization response. Please try again.';
    case 'network':
      return 'The OAuth provider could not be reached. Check your connection and try again.';
    case 'process_error':
      return 'The OAuth helper could not be started.';
    case 'process_exit':
      return exitCode === null || exitCode === undefined
        ? 'The OAuth helper exited before authorization completed.'
        : `The OAuth helper exited before authorization completed (exit code ${exitCode}).`;
    case 'unknown':
      return 'OAuth authorization failed for an unknown reason.';
  }
}

function appendBoundedDiagnosticOutput(current: string, next: string): string {
  const combined = current + next;
  return combined.length <= MAX_DIAGNOSTIC_OUTPUT_CHARS
    ? combined
    : combined.slice(-MAX_DIAGNOSTIC_OUTPUT_CHARS);
}

export async function revokeMcpRemoteOAuth(
  configOrUrl: MCPServerConfig | string
): Promise<{ success: boolean; error?: string; providerRevocation?: 'revoked' | 'unsupported' | 'failed' | 'none' }> {
  const descriptor = typeof configOrUrl === 'string'
    ? { serverUrl: configOrUrl, headers: {}, requiresOAuth: true }
    : extractMcpRemoteConfig(configOrUrl);

  if (!descriptor) {
    return { success: false, error: 'Invalid OAuth configuration' };
  }

  if (descriptor.source !== 'user-command') {
    try {
      const result = await getMcpOAuthManager().revoke(descriptor);
      return { success: result.success, providerRevocation: result.provider };
    } catch (error: unknown) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  const authDir = getMcpAuthDir();
  const serverHashes = getServerHashes(descriptor);

  try {
    const entries = await fs.promises.readdir(authDir, { withFileTypes: true });
    const versionDirs = entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('mcp-remote-'))
      .map((entry) => entry.name);

    for (const versionDir of versionDirs) {
      const versionPath = path.join(authDir, versionDir);
      for (const hash of serverHashes) {
        await tryKillStaleProcess(path.join(versionPath, `${hash}_lock.json`));
      }
    }

    for (const hash of serverHashes) {
      await tryKillStaleProcess(path.join(authDir, `${hash}_lock.json`));
    }

    for (const versionDir of versionDirs) {
      const versionPath = path.join(authDir, versionDir);
      await deleteMatchingAuthFiles(versionPath, serverHashes);
    }

    await deleteMatchingAuthFiles(authDir, serverHashes);
    return { success: true };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: message };
  }
}

function looksLikeMcpRemoteCommand(command?: string, args?: string[]): boolean {
  if (command !== 'npx' && command !== 'npx.cmd') {
    return false;
  }
  return Boolean(args?.some((arg) => arg === 'mcp-remote' || arg.startsWith('mcp-remote@')));
}

/** mcp-remote options the native gateway reproduces, and whether each takes a value. */
const BRIDGEABLE_VALUE_FLAGS = new Set([
  '--header',
  '--host',
  '--transport',
  '--resource',
  '--auth-timeout',
  '--static-oauth-client-info',
  '--static-oauth-client-metadata',
]);
// `--allow-http`: the gateway already allows a configured http:// server.
// `--debug` / `--silent` only change mcp-remote's own logging.
const BRIDGEABLE_BOOLEAN_FLAGS = new Set(['--allow-http', '--debug', '--silent']);

/**
 * True when a stored `npx mcp-remote <url> ...` command is made only of
 * options Nimbalyst implements, so it runs through the native gateway instead
 * of the third-party helper. The saved config is not rewritten.
 */
export function isBridgeableMcpRemoteCommand(config: MCPServerConfig): boolean {
  return (config.type === undefined || config.type === 'stdio')
    && looksLikeMcpRemoteCommand(config.command, config.args)
    && parseBridgeableMcpRemoteCommand(config) !== null;
}

/**
 * Parse `npx [-y|--yes]... mcp-remote[@version] <url> [port] [options]` into a
 * native descriptor, or return null when any part cannot be reproduced
 * exactly: an unknown npx or mcp-remote option, an `@file` argument, malformed
 * JSON, or a `${VAR}` neither the server's `env` nor the login shell defines.
 */
function parseBridgeableMcpRemoteCommand(config: MCPServerConfig): MCPRemoteConfigDescriptor | null {
  const args = config.args ?? [];
  let index = 0;
  while (index < args.length && (args[index] === '-y' || args[index] === '--yes')) {
    index += 1;
  }
  const pkg = args[index];
  if (pkg !== 'mcp-remote' && !(typeof pkg === 'string' && pkg.startsWith('mcp-remote@'))) {
    return null;
  }
  index += 1;

  const env = resolveGatewayEnv(config.env);
  const expand = (value: string): string | null => {
    const result = expandServerVariables(value, env);
    return result.unresolved ? null : result.value;
  };

  const serverUrl = typeof args[index] === 'string' ? expand(args[index]) : null;
  if (!serverUrl || !/^https?:\/\//i.test(serverUrl)) {
    return null;
  }
  try {
    new URL(serverUrl);
  } catch {
    return null;
  }
  index += 1;

  let callbackPort: number | undefined;
  if (index < args.length && /^\d+$/.test(args[index])) {
    callbackPort = Number(args[index]);
    if (callbackPort < 1 || callbackPort > 65535) {
      return null;
    }
    index += 1;
  }

  const headers: Record<string, string> = {};
  let host: string | undefined;
  let authorizeResource: string | undefined;
  let transportStrategy: MCPRemoteConfigDescriptor['transportStrategy'];
  let authTimeoutSeconds: number | undefined;
  let staticOAuthClientInfo: Record<string, string> | undefined;
  let staticOAuthClientMetadata: Record<string, string | number | boolean | null> | undefined;

  while (index < args.length) {
    const flag = args[index];
    if (BRIDGEABLE_BOOLEAN_FLAGS.has(flag)) {
      index += 1;
      continue;
    }
    if (!BRIDGEABLE_VALUE_FLAGS.has(flag) || index + 1 >= args.length) {
      return null;
    }
    const value = expand(args[index + 1]);
    if (value === null) {
      return null;
    }
    index += 2;

    switch (flag) {
      case '--header': {
        const header = parseMcpRemoteHeader(value);
        if (!header) {
          return null;
        }
        headers[header[0]] = header[1];
        break;
      }
      case '--host':
        host = value;
        break;
      case '--resource':
        authorizeResource = value;
        break;
      case '--transport':
        if (!isTransportStrategy(value)) {
          return null;
        }
        transportStrategy = value;
        break;
      case '--auth-timeout':
        if (!/^\d+$/.test(value)) {
          return null;
        }
        authTimeoutSeconds = Number(value);
        break;
      case '--static-oauth-client-info': {
        const parsed = parseJsonObject(value);
        if (!parsed || !Object.values(parsed).every((v) => typeof v === 'string')) {
          return null;
        }
        staticOAuthClientInfo = parsed as Record<string, string>;
        break;
      }
      case '--static-oauth-client-metadata': {
        const parsed = parseJsonObject(value);
        if (!parsed) {
          return null;
        }
        staticOAuthClientMetadata = parsed as Record<string, string | number | boolean | null>;
        break;
      }
      default:
        return null;
    }
  }

  return {
    serverUrl,
    headers: normalizeHeaders(headers),
    callbackPort: config.oauth?.callbackPort ?? callbackPort,
    host: config.oauth?.host ?? host,
    // The metadata in effect (config or --static-oauth-client-metadata) also
    // names the pre-registered redirect URI, as it did for mcp-remote.
    redirectUri: getConfiguredRedirectUri({
      ...config.oauth,
      staticClientMetadata: config.oauth?.staticClientMetadata ?? staticOAuthClientMetadata,
    } as MCPServerConfig['oauth']),
    authorizeResource: config.oauth?.resource ?? authorizeResource,
    transportStrategy: config.oauth?.transportStrategy ?? transportStrategy,
    authTimeoutSeconds: config.oauth?.authTimeoutSeconds ?? authTimeoutSeconds,
    staticOAuthClientInfo: getStaticOAuthClientInfo(config.oauth) ?? staticOAuthClientInfo,
    staticOAuthClientMetadata: config.oauth?.staticClientMetadata ?? staticOAuthClientMetadata,
    requiresOAuth: Boolean(config.oauth),
  };
}

/**
 * Resolve `${VAR}` in a remote server's URL and header values from the
 * server's own `env` block. Unresolved references stay literal, so a CLI that
 * expands variables from its own environment still can. Other config kinds
 * are returned unchanged.
 */
export function expandRemoteServerVariables(config: MCPServerConfig): MCPServerConfig {
  if ((config.type !== 'http' && config.type !== 'sse') || !config.env) {
    return config;
  }
  // The env block's own values may name login-shell variables; only names the
  // block defines are substituted into the URL and headers.
  const env = resolveServerEnv(config.env, getShellEnvironment() ?? {});
  if (Object.keys(env).length === 0) {
    return config;
  }
  // A `:-default` is left for the CLI when the server's env does not define
  // the variable: the CLI may resolve it from its own environment first.
  const keepDefaults = { applyDefaults: false };
  return {
    ...config,
    url: config.url ? expandServerVariables(config.url, env, keepDefaults).value : config.url,
    headers: expandHeaderValues(config.headers, env, keepDefaults),
  };
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  if (value.startsWith('@')) {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * What `${VAR}` resolves against when Nimbalyst's gateway is the consumer:
 * the server's own `env` first, then the user's login-shell environment
 * (`getShellEnvironment`, the same environment the CLIs are given). That is
 * what mcp-remote inherited. Nimbalyst's own `process.env` is not consulted.
 */
function resolveGatewayEnv(env: MCPServerConfig['env']): Record<string, string> {
  const shell = getShellEnvironment() ?? {};
  return { ...shell, ...resolveServerEnv(env, shell) };
}

/**
 * The variables a server's `${VAR}` references resolve against: its own `env`
 * block, each value itself expanded against `base` and earlier entries. An
 * explicit empty value is kept: it overrides the shell, as it would for a
 * process given that env. Nimbalyst's own process environment is
 * deliberately not consulted.
 */
function resolveServerEnv(env: MCPServerConfig['env'], base: Record<string, string> = {}): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (typeof value !== 'string') {
      continue;
    }
    const expanded = expandServerVariables(value, { ...base, ...resolved });
    if (!expanded.unresolved) {
      resolved[key] = expanded.value;
    }
  }
  return resolved;
}

/** Expand `${VAR}` and `${VAR:-default}`; report whether any reference had no value. */
function expandServerVariables(
  value: string,
  env: Record<string, string>,
  options: { applyDefaults?: boolean } = {},
): { value: string; unresolved: boolean } {
  let unresolved = false;
  const expanded = value.replace(/\$\{([^}:]+)(:-([^}]*))?\}/g, (match, name: string, _group: string, fallback?: string) => {
    if (Object.prototype.hasOwnProperty.call(env, name)) {
      return env[name];
    }
    if (fallback !== undefined && options.applyDefaults !== false) {
      return fallback;
    }
    unresolved = true;
    return match;
  });
  return { value: expanded, unresolved };
}

function expandHeaderValues(
  headers: Record<string, string> | undefined,
  env: Record<string, string>,
  options: { applyDefaults?: boolean } = {},
): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }
  const expanded: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    expanded[key] = typeof value === 'string' ? expandServerVariables(value, env, options).value : value;
  }
  return expanded;
}

function normalizeHeaders(headers?: Record<string, string>): Record<string, string> {
  if (!headers) {
    return {};
  }
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string' && value.length > 0) {
      normalized[key] = value;
    }
  }
  return normalized;
}

function hasBearerAuthorization(headers: Record<string, string>): boolean {
  const authorization = headers.Authorization || headers.authorization;
  return Boolean(authorization?.trim().toLowerCase().startsWith('bearer '));
}

function getOAuthDiscoveryCacheKey(descriptor: MCPRemoteConfigDescriptor): string {
  const sortedHeaderKeys = Object.keys(descriptor.headers).sort();
  return [
    descriptor.serverUrl,
    JSON.stringify(descriptor.headers, sortedHeaderKeys),
  ].join('|');
}

async function probeMcpRemoteOAuthRequirement(
  descriptor: MCPRemoteConfigDescriptor
): Promise<boolean> {
  const metadataUrls = getOAuthProtectedResourceMetadataUrls(descriptor.serverUrl);

  for (const metadataUrl of metadataUrls) {
    const response = await fetchWithTimeout(metadataUrl, descriptor.headers);
    if (!response) {
      continue;
    }

    if (isOAuthChallenge(response)) {
      return true;
    }

    if (!response.ok) {
      continue;
    }

    const metadata = await readJsonObject(response);
    if (metadata && isOAuthProtectedResourceMetadata(metadata)) {
      return true;
    }
  }

  const serverResponse = await fetchWithTimeout(descriptor.serverUrl, descriptor.headers);
  return Boolean(serverResponse && isOAuthChallenge(serverResponse));
}

function getOAuthProtectedResourceMetadataUrls(serverUrl: string): string[] {
  try {
    const url = new URL(serverUrl);
    const urls = new Set<string>();
    const normalizedPath = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
    if (normalizedPath) {
      urls.add(`${url.origin}/.well-known/oauth-protected-resource${normalizedPath}`);
    }
    urls.add(`${url.origin}/.well-known/oauth-protected-resource`);
    return Array.from(urls);
  } catch {
    return [];
  }
}

async function fetchWithTimeout(
  url: string,
  headers: Record<string, string>
): Promise<Response | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OAUTH_DISCOVERY_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...headers,
      },
      signal: controller.signal,
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function isOAuthChallenge(response: Response): boolean {
  const authenticate = response.headers.get('www-authenticate') || '';
  return response.status === 401 && /\bbearer\b/i.test(authenticate);
}

async function readJsonObject(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const contentType = response.headers.get('content-type') || '';
    if (contentType && !contentType.toLowerCase().includes('json')) {
      return null;
    }
    const data = await response.json();
    return data && typeof data === 'object' && !Array.isArray(data)
      ? data as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function isOAuthProtectedResourceMetadata(metadata: Record<string, unknown>): boolean {
  return typeof metadata.resource === 'string'
    || Array.isArray(metadata.authorization_servers)
    || typeof metadata.authorization_server === 'string';
}

function parseMcpRemoteHeaders(args: string[]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== '--header' || i + 1 >= args.length) {
      continue;
    }
    const header = parseMcpRemoteHeader(args[i + 1]);
    if (header) {
      headers[header[0]] = header[1];
    }
  }
  return headers;
}

/**
 * `Name: value` exactly as mcp-remote reads it (0.1.x and 0.16.x): the space
 * after the colon is dropped, and a name outside `[A-Za-z0-9_-]` is ignored.
 * The token-store hash covers headers, so any difference here would miss
 * existing tokens.
 */
function parseMcpRemoteHeader(raw: string): [string, string] | null {
  const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(raw);
  return match ? [match[1], match[2]] : null;
}

function parseMcpRemoteFlags(args: string[]): {
  host?: string;
  authorizeResource?: string;
  transportStrategy?: 'http-first' | 'sse-first' | 'http-only' | 'sse-only';
  authTimeoutSeconds?: number;
  staticOAuthClientInfo?: Record<string, string>;
  staticOAuthClientMetadata?: Record<string, string | number | boolean | null>;
} {
  const result: ReturnType<typeof parseMcpRemoteFlags> = {};

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];
    if (!next) {
      continue;
    }

    if (arg === '--host') {
      result.host = next;
    } else if (arg === '--resource') {
      result.authorizeResource = next;
    } else if (arg === '--transport' && isTransportStrategy(next)) {
      result.transportStrategy = next;
    } else if (arg === '--auth-timeout' && /^\d+$/.test(next)) {
      result.authTimeoutSeconds = Number(next);
    } else if (arg === '--static-oauth-client-info') {
      result.staticOAuthClientInfo = safeJsonParse<Record<string, string>>(next);
    } else if (arg === '--static-oauth-client-metadata') {
      result.staticOAuthClientMetadata = safeJsonParse<Record<string, string | number | boolean | null>>(next);
    }
  }

  return result;
}

function isTransportStrategy(value: string): value is 'http-first' | 'sse-first' | 'http-only' | 'sse-only' {
  return value === 'http-first' || value === 'sse-first' || value === 'http-only' || value === 'sse-only';
}

function safeJsonParse<T>(value: string): T | undefined {
  if (!value || value.startsWith('@')) {
    return undefined;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function getServerHashes(descriptor: Pick<MCPRemoteConfigDescriptor, 'serverUrl' | 'authorizeResource' | 'headers'>): string[] {
  return getMcpRemoteServerHashes(descriptor);
}

async function findAuthorizedTokenFile(baseDir: string, hashes: string[]): Promise<string | null> {
  try {
    const files = await fs.promises.readdir(baseDir);
    for (const file of files) {
      if (!file.endsWith('_tokens.json')) {
        continue;
      }
      const fileHash = file.replace('_tokens.json', '');
      if (!hashes.includes(fileHash)) {
        continue;
      }
      const tokenPath = path.join(baseDir, file);
      if (await hasUsableTokens(tokenPath)) {
        // safeLog('info', '[MCP] Found OAuth tokens at:', tokenPath);
        return tokenPath;
      }
    }
  } catch {
    // Directory missing or unreadable.
  }

  for (const hash of hashes) {
    for (const fileName of [`${hash}_tokens.json`, `${hash}.json`]) {
      const tokenPath = path.join(baseDir, fileName);
      if (await hasUsableTokens(tokenPath)) {
        // safeLog('info', '[MCP] Found OAuth tokens at:', tokenPath);
        return tokenPath;
      }
    }
  }

  return null;
}

async function hasUsableTokens(tokenPath: string): Promise<boolean> {
  try {
    const content = await fs.promises.readFile(tokenPath, 'utf-8');
    const tokens = JSON.parse(content);
    return Boolean(
      tokens.access_token ||
      tokens.accessToken ||
      tokens.refresh_token ||
      tokens.refreshToken
    );
  } catch {
    return false;
  }
}

async function tryKillStaleProcess(lockFilePath: string): Promise<boolean> {
  try {
    const content = await fs.promises.readFile(lockFilePath, 'utf-8');
    const lock = JSON.parse(content);
    if (!lock.pid || typeof lock.pid !== 'number') {
      return false;
    }

    if (process.platform === 'win32') {
      const { execSync } = await import('child_process');
      try {
        execSync(`taskkill /F /PID ${lock.pid}`, { stdio: 'ignore' });
        await new Promise((resolve) => setTimeout(resolve, 500));
      } catch {
        return true;
      }
      return true;
    }

    try {
      process.kill(lock.pid, 0);
      process.kill(lock.pid, 'SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 500));
      return true;
    } catch (error: unknown) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') {
        return true;
      }
      safeLog('warn', '[MCP] Cannot kill process from lock file:', error);
      return false;
    }
  } catch {
    return false;
  }
}

async function deleteMatchingAuthFiles(baseDir: string, hashes: string[]): Promise<void> {
  try {
    const files = await fs.promises.readdir(baseDir);
    for (const file of files) {
      if (!hashes.some((hash) => file.startsWith(hash))) {
        continue;
      }
      try {
        await fs.promises.unlink(path.join(baseDir, file));
      } catch (error) {
        safeLog('warn', '[MCP] Failed to delete auth file:', path.join(baseDir, file), error);
      }
    }
  } catch {
    // Directory missing or unreadable.
  }
}

function logSlowAuthCheck(startTime: number, foundToken: boolean): void {
  const totalDuration = Date.now() - startTime;
  if (totalDuration <= 1000) {
    return;
  }
  safeLog(
    'warn',
    `[MCP] checkMcpRemoteAuthStatus: ${foundToken ? 'found token' : 'no token found'}, took ${totalDuration}ms total (>1s threshold)`
  );
}

function getCommandNotFoundHelp(command: string): { message: string; helpUrl?: string } {
  const commandHelp: Record<string, { message: string; helpUrl: string }> = {
    npx: {
      message: `Command 'npx' not found. Node.js needs to be installed to use this MCP server.`,
      helpUrl: 'https://nodejs.org/en/download'
    },
    node: {
      message: `Command 'node' not found. Node.js needs to be installed to use this MCP server.`,
      helpUrl: 'https://nodejs.org/en/download'
    },
  };

  const normalizedCommand = command.replace(/\.(cmd|exe)$/i, '');
  return commandHelp[normalizedCommand] || {
    message: `Command '${command}' not found. Please ensure it is installed and available in your PATH.`
  };
}

function safeLog(level: 'debug' | 'info' | 'warn', ...args: unknown[]): void {
  if (!process.versions.electron) {
    return;
  }
  try {
    const logFn = logger.main[level] as (...logArgs: unknown[]) => void;
    logFn(...args);
  } catch {
    // electron-log needs a live Electron app in some test environments.
  }
}
