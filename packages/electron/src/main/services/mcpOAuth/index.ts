/**
 * Process-wide access to the native MCP OAuth manager and the loopback
 * gateway. Both are created lazily: the credential store lives under
 * `app.getPath('userData')`, which is not valid at import time
 * (MAIN_PROCESS_INIT.md).
 */
import * as os from 'os';
import * as path from 'path';
import { app, safeStorage, shell } from 'electron';
import { logger } from '../../utils/logger';
import { McpOAuthCredentialStore } from './credentialStore';
import { McpOAuthManager } from './McpOAuthManager';
import { McpRemoteGateway, GATEWAY_PATH_PREFIX } from './gateway';

let manager: McpOAuthManager | null = null;
let gateway: McpRemoteGateway | null = null;
let gatewayEndpoint: { port: number; getToken: () => string | null } | null = null;

export { GATEWAY_PATH_PREFIX };

export function getLegacyMcpAuthDir(): string {
  return process.env.MCP_REMOTE_CONFIG_DIR || path.join(os.homedir(), '.mcp-auth');
}

function log(level: 'info' | 'warn', message: string, meta?: Record<string, unknown>): void {
  try {
    if (meta) {
      logger.mcp[level](message, meta);
    } else {
      logger.mcp[level](message);
    }
  } catch {
    // Logging must never break credential handling.
  }
}

export function getMcpOAuthManager(): McpOAuthManager {
  if (!manager) {
    const store = new McpOAuthCredentialStore(path.join(app.getPath('userData'), 'mcp-oauth'), {
      isEncryptionAvailable: () => {
        try {
          return safeStorage.isEncryptionAvailable();
        } catch {
          return false;
        }
      },
      encryptString: (plain) => safeStorage.encryptString(plain),
      decryptString: (encrypted) => safeStorage.decryptString(encrypted),
    });
    void store.pruneRevokedBackups().catch(() => undefined);
    manager = new McpOAuthManager({
      store,
      openExternal: (url) => shell.openExternal(url),
      legacyAuthDir: getLegacyMcpAuthDir,
      log,
    });
  }
  return manager;
}

export function getMcpRemoteGateway(): McpRemoteGateway {
  if (!gateway) {
    gateway = new McpRemoteGateway(getMcpOAuthManager(), { log });
  }
  return gateway;
}

/** Close upstream sessions at shutdown, without creating the gateway if it never started. */
export async function closeMcpRemoteGatewayIfStarted(): Promise<void> {
  await gateway?.closeAll();
}

/** Called once the internal MCP HTTP server is listening. */
export function configureMcpRemoteGatewayEndpoint(endpoint: { port: number; getToken: () => string | null }): void {
  gatewayEndpoint = endpoint;
}

export function getMcpRemoteGatewayEndpoint(): { port: number; token: string } | null {
  if (!gatewayEndpoint) {
    return null;
  }
  const token = gatewayEndpoint.getToken();
  return token ? { port: gatewayEndpoint.port, token } : null;
}

export function setMcpOAuthForTest(next: {
  manager?: McpOAuthManager | null;
  gateway?: McpRemoteGateway | null;
  endpoint?: { port: number; getToken: () => string | null } | null;
}): void {
  if (next.manager !== undefined) manager = next.manager;
  if (next.gateway !== undefined) gateway = next.gateway;
  if (next.endpoint !== undefined) gatewayEndpoint = next.endpoint;
}
