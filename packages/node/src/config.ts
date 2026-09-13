/**
 * Configuration for a headless Nimbalyst node.
 *
 * Every value comes from a config file whose path the caller states. Nothing is
 * read from `process.env`, and credentials especially are not: a user with an
 * unrelated `ANTHROPIC_API_KEY` in a `.env` had it silently picked up,
 * auto-persisted and billed against their personal account. See the
 * "Never Use Environment Variables as Implicit API Key Sources" rule in
 * CLAUDE.md. There is no fallback here on purpose -- an absent key means the
 * provider runs on the `claude` CLI's own login, which is the correct headless
 * default.
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';

export interface NodeConfig {
  /**
   * Where `nimbalyst.sqlite` lives. Relative paths resolve against the config
   * file's own directory so a config file is portable with its data.
   */
  databasePath: string;

  /**
   * Directory holding the numbered schema migrations. Defaults to the copy
   * inside `packages/electron`, which is the only place they exist today --
   * see `resolveSchemaDir` for why that is a finding and not a design.
   */
  schemaDir?: string;

  /**
   * Absolute path to the `claude` executable. When absent the node resolves the
   * Claude Agent SDK's bundled native binary itself; see `nodeHost.ts`.
   */
  claudeCodePath?: string;

  /**
   * Explicitly-provisioned provider credentials, keyed by provider id. Only
   * ever read from this file. `claude-code` does not need one -- it authenticates
   * through the CLI's own login -- so this exists for the providers that do.
   */
  providerApiKeys?: Record<string, string>;

  /**
   * Workspace trust. A headless node has no user to ask, so the trust answer has
   * to be stated up front rather than defaulted: without it every tool call
   * blocks on a permission prompt nobody will ever answer.
   */
  trust: {
    mode: 'bypass-all';
  };

  /** Explicit MCP connections. Repository and user MCP/settings discovery is disabled. */
  mcpServers?: Record<string, unknown>;

  /**
   * Personal-sync settings for `serve` mode. Absent for the one-turn CLI, which
   * runs with no sync at all -- so this is validated only when `serve` starts,
   * not at load time.
   */
  sync?: NodeSyncConfig;

  /**
   * Path to the project -> checkout map `serve` consults on every create-session
   * request. Re-read per request so the desktop can update it without a restart.
   */
  workspacesPath?: string;

  /**
   * Absolute directory every `checkoutDir` must live under. Defaults to
   * `/workspace`, which is where the container mounts them.
   *
   * This is a confinement boundary, not a convenience: the update path resets a
   * git tree, so a mapping that pointed at `/` or at this node's own config
   * directory would reset it there. Set it explicitly when developing outside a
   * container, where `/workspace` does not exist.
   */
  checkoutRoot?: string;
}

/**
 * The sync half of the config file. The desktop writes these keys after it has
 * completed the RFC 8628 device grant on this node's behalf; do not rename them.
 *
 * There is deliberately no credential material here beyond a path: the refresh
 * token rotates on every use and lives in its own file, which this process
 * rewrites atomically.
 */
export interface NodeSyncConfig {
  /** Collab server origin, e.g. `https://sync.nimbalyst.com`. */
  serverUrl: string;
  /** Path to `node-credential.json`. Relative paths resolve against the config file. */
  credentialPath: string;
  /** Base64 seed the personal-sync AES key is derived from. */
  encryptionKeySeed: string;
  /** The user's PERSONAL org id. Never a team org -- see the two-JWT rule. */
  personalOrgId: string;
  /** The user's PERSONAL member id. Routes the index room and salts the key. */
  personalUserId: string;
  /** Stable id this node announces itself under; create-session requests target it. */
  deviceId: string;
  /** Human-readable name shown in the desktop's device list. */
  deviceName?: string;
}

export interface LoadedConfig extends NodeConfig {
  /** Absolute path the config was read from. */
  configPath: string;
  /** `databasePath` resolved to absolute. */
  resolvedDatabasePath: string;
  /** `sync.credentialPath` resolved to absolute, when sync is configured. */
  resolvedCredentialPath?: string;
  /** `workspacesPath` resolved to absolute, when set. */
  resolvedWorkspacesPath?: string;
}

function fail(message: string): never {
  throw new Error(`[nimbalyst-node] ${message}`);
}

/** Validate before opening a database or registering provider dependencies. */
export function requireExecutionPolicy(config: Partial<NodeConfig>): NodeConfig['trust'] {
  if (config.trust?.mode !== 'bypass-all') {
    fail('trust.mode must explicitly be "bypass-all". This grants host-user access; --workspace is not filesystem isolation. "ask" and "allow-all" require an interactive permission responder and are unsupported.');
  }
  return config.trust;
}

/** The `sync` keys `serve` cannot start without. Never consulted by the one-turn CLI. */
const REQUIRED_SYNC_KEYS = [
  'serverUrl',
  'credentialPath',
  'encryptionKeySeed',
  'personalOrgId',
  'personalUserId',
  'deviceId',
] as const;

/**
 * Validate the sync block before `serve` opens a socket.
 *
 * Deliberately separate from `loadConfig`: a config file that only ever runs
 * one-turn CLI invocations has no sync block, and rejecting it at load time
 * would break the existing entry point.
 */
export function requireSyncSettings(config: LoadedConfig): NodeSyncConfig & {
  credentialPath: string;
} {
  const sync = config.sync;
  if (!sync || typeof sync !== 'object' || Array.isArray(sync)) {
    fail(`config file ${config.configPath} must set a "sync" object to run "serve"`);
  }

  const missing = REQUIRED_SYNC_KEYS.filter(
    (key) => typeof sync[key] !== 'string' || (sync[key] as string).length === 0,
  );
  if (missing.length > 0) {
    fail(
      `config file ${config.configPath} is missing sync setting(s): `
      + `${missing.map((key) => `sync.${key}`).join(', ')}`,
    );
  }

  // The personal member id salts the encryption key and routes the index room.
  // A team member id here derives a different key and silently makes every
  // previously-encrypted row undecryptable -- see the two-JWT rule in CLAUDE.md.
  if (!config.resolvedCredentialPath) {
    fail(`config file ${config.configPath} has sync.credentialPath but it did not resolve`);
  }

  return { ...sync, credentialPath: config.resolvedCredentialPath };
}

export function loadConfig(configPath: string): LoadedConfig {
  const absoluteConfigPath = path.resolve(configPath);

  let raw: string;
  try {
    raw = readFileSync(absoluteConfigPath, 'utf-8');
  } catch (error) {
    fail(
      `could not read config file at ${absoluteConfigPath}. `
      + `Configuration, including any credentials, must come from a file you provisioned: `
      + `${(error as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(`config file ${absoluteConfigPath} is not valid JSON: ${(error as Error).message}`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    fail(`config file ${absoluteConfigPath} must contain a JSON object`);
  }

  const config = parsed as Partial<NodeConfig>;
  if (typeof config.databasePath !== 'string' || config.databasePath.length === 0) {
    fail(`config file ${absoluteConfigPath} must set "databasePath"`);
  }

  const configDir = path.dirname(absoluteConfigPath);
  const trust = requireExecutionPolicy(config);
  if (config.mcpServers !== undefined && (!config.mcpServers || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers))) {
    fail('mcpServers must be an object of explicitly provisioned connections');
  }

  if (config.sync !== undefined && (!config.sync || typeof config.sync !== 'object' || Array.isArray(config.sync))) {
    fail('sync must be an object of personal-sync settings');
  }

  return {
    ...config,
    databasePath: config.databasePath,
    trust,
    resolvedDatabasePath: path.resolve(configDir, config.databasePath),
    schemaDir: config.schemaDir ? path.resolve(configDir, config.schemaDir) : undefined,
    resolvedCredentialPath: config.sync?.credentialPath
      ? path.resolve(configDir, config.sync.credentialPath)
      : undefined,
    resolvedWorkspacesPath: config.workspacesPath
      ? path.resolve(configDir, config.workspacesPath)
      : undefined,
    configPath: absoluteConfigPath,
  };
}
