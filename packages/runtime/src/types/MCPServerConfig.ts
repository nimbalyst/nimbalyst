/**
 * MCP Server Configuration Types
 *
 * These types match Claude Code's .mcp.json schema for full compatibility.
 * https://docs.anthropic.com/claude/docs/claude-code
 */

/**
 * Environment variables for an MCP server.
 * Supports Claude Code's ${VAR} and ${VAR:-default} syntax.
 */
export interface MCPServerEnv {
  [key: string]: string;
}

/**
 * Optional OAuth settings for remote MCP servers.
 *
 * Two fields here look interchangeable and are not. They select WHO performs
 * the authorization, which is the difference that matters:
 *
 * - `staticClientInfo` -> Nimbalyst authorizes, via its own `mcp-remote` child
 *   process. The Authorize button works and tokens land in `~/.mcp-auth`.
 * - `clientId` / `clientSecret` -> the downstream CLI owns this server's auth
 *   and Nimbalyst stays out of it. `usesNativeRemoteOAuth` reads these two, and
 *   it also suppresses the `mcp-remote` wrapper and the OAuth probe, so setting
 *   them replaces the Authorize button with "authorize from a Claude or Codex
 *   session".
 *
 * Everything else maps to `mcp-remote` flags for servers that need OAuth
 * instead of an API key, a fixed callback port, or explicit client metadata.
 */
export interface MCPServerOAuthConfig {
  /** Fixed local callback port for OAuth redirects. */
  callbackPort?: number;

  /** Hostname to register in the OAuth callback URL (defaults to localhost). */
  host?: string;

  /** Resource parameter passed during OAuth authorization, when required by the server. */
  resource?: string;

  /** Transport preference for mcp-remote when talking to the remote server. */
  transportStrategy?: 'http-first' | 'sse-first' | 'http-only' | 'sse-only';

  /** OAuth callback timeout in seconds. */
  authTimeoutSeconds?: number;

  /**
   * Pre-registered OAuth client that NIMBALYST authorizes with, passed to
   * `mcp-remote` as `--static-oauth-client-info`. Use this for providers that
   * refuse RFC 7591 dynamic client registration -- without it `mcp-remote`
   * attempts registration, the provider rejects it, and the helper dies before
   * a browser opens (`dynamic_registration_unsupported`).
   *
   * Example: { client_id: 'abc' }
   *
   * Prefer a public client: `mcp-remote` already uses PKCE, and a `client_secret`
   * here lands in the MCP config JSON and on the helper's argv. If a confidential
   * client is unavoidable, `mcp-remote` also accepts `@/path/to/file.json` to read
   * the value off disk instead -- but note `safeJsonParse` in MCPRemoteOAuth.ts
   * deliberately ignores `@`-prefixed values when parsing a command line back
   * into a descriptor, so that form does not round-trip today.
   */
  staticClientInfo?: Record<string, string>;

  /**
   * Pre-registered OAuth client that THE DOWNSTREAM CLI authorizes with. Setting
   * this hands the server's auth to Claude/Codex entirely: Nimbalyst stops
   * wrapping it in `mcp-remote`, stops probing it for OAuth, and hides its own
   * Authorize button. This is not the field for making the Authorize button work
   * against a no-DCR provider -- that is `staticClientInfo`.
   */
  clientId?: string;

  /** Native MCP OAuth client secret, for a confidential client the CLI authorizes. */
  clientSecret?: string;

  /**
   * Static OAuth client metadata for servers that require explicit metadata/scopes.
   * Example: { scope: 'channels:history channels:read' }
   */
  staticClientMetadata?: Record<string, string | number | boolean | null>;
}

/**
 * Configuration for a single MCP server.
 * Supports stdio (local executable), SSE (legacy remote), and HTTP (modern remote) transports.
 */
export interface MCPServerConfig {
  /**
   * Transport type:
   * - stdio: local executables communicating via stdin/stdout
   * - sse: legacy remote servers using Server-Sent Events (deprecated)
   * - http: modern remote servers using Streamable HTTP (recommended)
   */
  type?: 'stdio' | 'sse' | 'http';

  /** Command to execute the MCP server (stdio only, supports env var expansion) */
  command?: string;

  /** Arguments to pass to the command (stdio only, supports env var expansion) */
  args?: string[];

  /** Server URL for remote transport (sse or http only) */
  url?: string;

  /** Custom HTTP headers for remote transport (http only) */
  headers?: Record<string, string>;

  /** Optional OAuth settings for remote MCP servers. */
  oauth?: MCPServerOAuthConfig;

  /** Environment variables to set (supports ${VAR} and ${VAR:-default} syntax) */
  env?: MCPServerEnv;

  /** Whether this server is disabled (default: false/enabled). @deprecated Use enabledForProviders instead. */
  disabled?: boolean;

  /**
   * Which AI agent providers this server is enabled for.
   * - undefined/absent: enabled for all providers (backward compatible default)
   * - ['claude-agent', 'codex']: enabled for all providers (explicit)
   * - ['claude-agent']: Claude Agent only
   * - ['codex']: Codex only
   * - []: disabled for all providers (equivalent to disabled: true)
   *
   * When both `disabled` and `enabledForProviders` are present, `enabledForProviders` takes priority.
   */
  enabledForProviders?: string[];
}

/** Provider IDs for enabledForProviders field */
export const MCP_PROVIDER_IDS = {
  CLAUDE_AGENT: 'claude-agent',
  CODEX: 'codex',
  COPILOT: 'copilot',
  KIMI: 'kimi',
} as const;

export type MCPProviderId = typeof MCP_PROVIDER_IDS[keyof typeof MCP_PROVIDER_IDS];

export const ALL_MCP_PROVIDER_IDS: MCPProviderId[] = [
  MCP_PROVIDER_IDS.CLAUDE_AGENT,
  MCP_PROVIDER_IDS.CODEX,
  MCP_PROVIDER_IDS.COPILOT,
  MCP_PROVIDER_IDS.KIMI,
];

/**
 * Determine if an MCP server is enabled for a given provider.
 * Handles backward compatibility with the legacy `disabled` field.
 */
export function isMCPServerEnabledForProvider(
  config: MCPServerConfig,
  providerId: MCPProviderId,
): boolean {
  if (config.enabledForProviders !== undefined) {
    return config.enabledForProviders.includes(providerId);
  }
  return !config.disabled;
}

/**
 * Root configuration object matching Claude Code's .mcp.json structure.
 */
export interface MCPConfig {
  /** Map of server name to server configuration */
  mcpServers: {
    [serverName: string]: MCPServerConfig;
  };
}

/**
 * Server configuration with its name (for UI display).
 */
export interface MCPServerWithName extends MCPServerConfig {
  name: string;
}

// ---------------------------------------------------------------------------
// Per-session MCP status (NIM-2272 / GH #1089)
//
// What a *running* agent session currently knows about its MCP servers, as
// opposed to the static config above. Shared by the runtime provider, the
// Electron main handler, and the renderer chip.
// ---------------------------------------------------------------------------

/**
 * Row status on the session surface.
 *
 * The first five mirror the SDK's `McpServerStatus.status`. `absent` is ours:
 * the server is in the config snapshot this session was spawned with but the
 * CLI never reported it at all — the connector-stripping case (GH #1088,
 * #1051), which is invisible without something to diff against.
 */
export type McpSessionServerState =
  | 'connected'
  | 'failed'
  | 'needs-auth'
  | 'pending'
  | 'disabled'
  | 'absent';

/**
 * One server row. Deliberately narrow: the SDK's status object also carries a
 * `config` with URLs, headers, and env, and the config snapshot holds
 * credentials. Neither may cross the IPC boundary, so this type has no field
 * that could hold one.
 */
export interface McpSessionServerRow {
  name: string;
  state: McpSessionServerState;
  /** project | user | local | claudeai | managed — undefined when the SDK omits it. */
  scope?: string;
  /** Error text from the SDK, when it supplied one. */
  error?: string;
  /** Number of tools the session registered for this server. */
  toolCount?: number;
  /** Server-reported version, for diagnosing a stale binary. */
  version?: string;
}

/** Everything the chip needs for one session. */
export interface McpSessionStatusSnapshot {
  sessionId: string;
  /** False when this session's provider has no MCP status support (e.g. Codex). */
  supported: boolean;
  /** False when no live provider exists yet — distinct from "no servers". */
  active: boolean;
  servers: McpSessionServerRow[];
  /** Epoch ms of the last successful poll. Null means never polled. */
  lastCheckedAt: number | null;
}

/** Structural shape of the SDK status object, so this module stays import-free. */
export interface McpSessionStatusInput {
  name: string;
  status: string;
  error?: string;
  scope?: string;
  serverInfo?: { name?: string; version?: string };
  tools?: unknown[];
}

const KNOWN_STATES: ReadonlySet<string> = new Set([
  'connected',
  'failed',
  'needs-auth',
  'pending',
  'disabled',
]);

/**
 * Build the IPC payload from what the provider knows.
 *
 * Two rules worth stating out loud:
 *
 * 1. Only whitelisted scalar fields are copied. Anything the SDK adds later —
 *    including a `config` with headers or env — is dropped by construction
 *    rather than by a blocklist that would go stale.
 * 2. Absent rows are only emitted once a poll has actually happened. Before the
 *    first poll every configured server is missing from the status list, and
 *    reporting that as "configured but never reached this session" would be a
 *    lie during the session's first seconds.
 * 3. Withheld servers arrive on their own channel, not via the absent diff. They
 *    are removed before `configuredNames` is built, so the diff's baseline never
 *    contained them and could never have surfaced them (GH #1057). They are also
 *    reported immediately: unlike absence, "we did not pass this server on" is
 *    known at spawn time and needs no poll to confirm.
 */
export function buildMcpSessionStatusSnapshot(params: {
  sessionId: string;
  supported: boolean;
  active: boolean;
  statuses: McpSessionStatusInput[];
  /** Server names from the frozen config snapshot; null when it hasn't settled. */
  configuredNames: string[] | null;
  /** Configured servers deliberately not passed to the CLI, for failing the OAuth check. */
  withheldNames?: string[] | null;
  lastCheckedAt: number | null;
}): McpSessionStatusSnapshot {
  const { sessionId, supported, active, statuses, configuredNames, withheldNames, lastCheckedAt } = params;

  const reported = new Set<string>();
  const servers: McpSessionServerRow[] = [];

  for (const status of statuses) {
    if (!status?.name) continue;
    reported.add(status.name);
    const row: McpSessionServerRow = {
      name: status.name,
      state: KNOWN_STATES.has(status.status)
        ? (status.status as McpSessionServerState)
        : 'pending',
    };
    if (status.scope) row.scope = status.scope;
    if (status.error) row.error = status.error;
    if (Array.isArray(status.tools)) row.toolCount = status.tools.length;
    if (status.serverInfo?.version) row.version = status.serverInfo.version;
    servers.push(row);
  }

  // Withheld rows come after the reported ones so a real status always wins: the
  // CLI reads its own config too, so a server we withheld may still have
  // connected on the CLI's own credentials. Saying "needs authorization" about a
  // server the user can see working would be worse than saying nothing.
  const withheld = new Set<string>();
  for (const name of withheldNames ?? []) {
    if (reported.has(name) || withheld.has(name)) continue;
    withheld.add(name);
    servers.push({ name, state: 'needs-auth' });
  }

  // See rule 2 above: no poll yet means we can't tell absent from not-yet-known.
  if (lastCheckedAt !== null && configuredNames) {
    for (const name of configuredNames) {
      if (!reported.has(name) && !withheld.has(name)) {
        servers.push({ name, state: 'absent' });
      }
    }
  }

  return { sessionId, supported, active, servers, lastCheckedAt };
}

/** True when a row is something the user may need to act on. */
export function isMcpSessionServerProblem(row: McpSessionServerRow): boolean {
  return row.state !== 'connected';
}
