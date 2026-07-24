import { spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MCPServerConfig } from '@nimbalyst/runtime/types/MCPServerConfig';
import { getEnhancedPath } from './CLIManager';
import { logger } from '../utils/logger';

export interface MCPRemoteConfigDescriptor {
  serverUrl: string;
  headers: Record<string, string>;
  callbackPort?: number;
  host?: string;
  authorizeResource?: string;
  transportStrategy?: 'http-first' | 'sse-first' | 'http-only' | 'sse-only';
  authTimeoutSeconds?: number;
  staticOAuthClientInfo?: Record<string, string>;
  staticOAuthClientMetadata?: Record<string, string | number | boolean | null>;
  requiresOAuth: boolean;
}

export interface MCPRemoteConfigOptions {
  /**
   * Codex cannot use native remote OAuth client metadata directly, so Nimbalyst
   * wraps those servers with mcp-remote at runtime. In that provider path, auth
   * status must be checked against mcp-remote's cache instead of treating the
   * native OAuth config as provider-managed.
   */
  useMcpRemoteForNativeOAuth?: boolean;
}

const OAUTH_DISCOVERY_TIMEOUT_MS = 2500;
const oauthRequirementCache = new Map<string, Promise<boolean>>();

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

    const headers = normalizeHeaders(config.headers);
    const requiresOAuth = Boolean(config.oauth);

    return {
      serverUrl: config.url,
      headers,
      callbackPort: config.oauth?.callbackPort,
      host: config.oauth?.host,
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
  configOrUrl: MCPServerConfig | string,
  options: MCPRemoteConfigOptions = {}
): Promise<{ authorized: boolean; tokenPath?: string }> {
  const descriptor = typeof configOrUrl === 'string'
    ? { serverUrl: configOrUrl, headers: {}, requiresOAuth: true }
    : extractMcpRemoteConfig(configOrUrl, options);

  if (!descriptor) {
    return { authorized: false };
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
): Promise<{ success: boolean; error?: string; isStalePortError?: boolean }> {
  const descriptor = typeof configOrUrl === 'string'
    ? { serverUrl: configOrUrl, headers: {}, requiresOAuth: true }
    : extractMcpRemoteConfig(configOrUrl);

  if (!descriptor) {
    return { success: false, error: 'Invalid OAuth configuration' };
  }

  return new Promise((resolve) => {
    safeLog('info', '[MCP] Triggering OAuth for:', descriptor.serverUrl);

    const npxCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const child = spawn(npxCommand, ['-y', ...buildMcpRemoteArgs(descriptor)], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PATH: getEnhancedPath() },
      shell: process.platform === 'win32'
    });

    let stdout = '';
    let stderr = '';
    let resolved = false;

    const cleanup = () => {
      if (!resolved) {
        resolved = true;
        child.kill();
      }
    };

    const timeout = setTimeout(() => {
      cleanup();
      resolve({ success: false, error: 'OAuth flow timed out. Please try again.' });
    }, 60000);

    child.stdout?.on('data', (data) => {
      stdout += data.toString();
      safeLog('debug', '[MCP OAuth] stdout:', data.toString());

      if (stdout.includes('authorized') || stdout.includes('success') || stdout.includes('token')) {
        clearTimeout(timeout);
        cleanup();
        resolve({ success: true });
      }
    });

    child.stderr?.on('data', (data) => {
      stderr += data.toString();
      safeLog('debug', '[MCP OAuth] stderr:', data.toString());
    });

    child.on('error', (error) => {
      clearTimeout(timeout);
      cleanup();
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const help = getCommandNotFoundHelp(npxCommand);
        resolve({ success: false, error: help.message });
      } else {
        resolve({ success: false, error: error.message });
      }
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      if (resolved) {
        return;
      }
      resolved = true;
      checkMcpRemoteAuthStatus(descriptor).then((status) => {
        if (status.authorized || code === 0) {
          resolve({ success: true });
          return;
        }

        if (stderr.includes('EADDRINUSE') || stderr.includes('address already in use')) {
          safeLog('warn', '[MCP OAuth] EADDRINUSE detected - likely stale lock file');
          resolve({
            success: false,
            error: 'Port conflict: Another process is using the OAuth callback port. This usually happens when a previous session did not clean up properly.',
            isStalePortError: true
          });
          return;
        }

        const notFoundMatch = stderr.match(/'([^']+)' is not recognized|(\S+): (?:command )?not found/i);
        if (notFoundMatch) {
          const cmdName = notFoundMatch[1] || notFoundMatch[2];
          const help = getCommandNotFoundHelp(cmdName);
          resolve({ success: false, error: help.message });
          return;
        }

        resolve({ success: false, error: stderr || `Process exited with code ${code}` });
      });
    });

    try {
      child.stdin?.write('{"jsonrpc":"2.0","method":"initialize","params":{},"id":1}\n');
    } catch (error) {
      safeLog('warn', '[MCP OAuth] Failed to write initialize probe:', error);
    }

    const checkInterval = setInterval(async () => {
      if (resolved) {
        clearInterval(checkInterval);
        return;
      }
      const status = await checkMcpRemoteAuthStatus(descriptor);
      if (status.authorized) {
        clearInterval(checkInterval);
        clearTimeout(timeout);
        cleanup();
        resolve({ success: true });
      }
    }, 2000);
  });
}

export async function revokeMcpRemoteOAuth(
  configOrUrl: MCPServerConfig | string
): Promise<{ success: boolean; error?: string }> {
  const descriptor = typeof configOrUrl === 'string'
    ? { serverUrl: configOrUrl, headers: {}, requiresOAuth: true }
    : extractMcpRemoteConfig(configOrUrl);

  if (!descriptor) {
    return { success: false, error: 'Invalid OAuth configuration' };
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
    const rawHeader = args[i + 1];
    const separatorIndex = rawHeader.indexOf(':');
    if (separatorIndex <= 0) {
      continue;
    }
    const key = rawHeader.slice(0, separatorIndex);
    const value = rawHeader.slice(separatorIndex + 1);
    headers[key] = value;
  }
  return headers;
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
