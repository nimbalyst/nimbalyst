/**
 * Whether a remote MCP server has to go through Nimbalyst's bridge instead of
 * straight to the CLI.
 *
 * The bridge used to be the third-party `mcp-remote` stdio helper; it is now
 * Nimbalyst's own loopback gateway (`./mcpOAuth/gateway.ts`), which holds the
 * OAuth credential so the CLI never sees it. The function names keep the old
 * `McpRemote` wording because the routing rule itself did not change.
 *
 * `convertHttpToStdio` rewrote every `type: "http"` server into
 * `npx mcp-remote <url> --header ...`. That was reasonable when it landed
 * (#c79feace) because it delivered an HTTP option plus OAuth without writing an
 * HTTP transport. But the same conversion is applied when generating configs for
 * external CLIs, and Claude Code has had native HTTP and its own OAuth for a long
 * time. The only escape was `usesNativeRemoteOAuth`, which tests for
 * `oauth.clientId || oauth.clientSecret` -- so a server authenticating with a
 * plain static bearer header, needing no OAuth at all, still got wrapped.
 *
 * Measured cost of wrapping on a machine running 9 concurrent sessions:
 *   - 136 processes / 4,641 MB, about 15 processes and 516 MB per session
 *   - the token moves from an HTTP header into argv, where any process can read
 *     it (65 live processes were carrying a GitHub PAT on their command line)
 *   - servers answering 401 to an OAuth probe are classified as unauthorized and
 *     silently dropped, so they never reach the CLI at all
 *
 * `nativeHttpSupported` is deliberately opt-in per caller. Claude Code and Codex
 * have both been verified with their native Streamable HTTP transports. Unknown
 * callers keep the wrapper until their transport support is verified.
 *
 * The declared config alone is NOT a sufficient discriminator (NIM-2433). A
 * server that was authorized through mcp-remote keeps its token in `~/.mcp-auth`
 * and carries no `oauth` block in the config, so it looks exactly like a server
 * that needs no credential at all. On the native-HTTP path it was therefore sent
 * to the CLI bare, got a 401, and the CLI cached that failure in
 * `~/.claude/mcp-needs-auth-cache.json` -- broken across restarts, while the same
 * server kept working under Codex because Codex always wrapped it.
 *
 * So the answer needs one input beyond the config: whether mcp-remote actually
 * holds a token for this server URL. `resolveMcpRemoteRequirementOptions` reads
 * that off disk. A server with a token is wrapped on every path; a server without
 * one still goes native, which is where all of the savings above come from.
 */

import type { MCPServerConfig } from '@nimbalyst/runtime/types/MCPServerConfig';
import { checkMcpRemoteAuthStatus, isBridgeableMcpRemoteCommand, usesNativeRemoteOAuth } from './MCPRemoteOAuth';

export interface McpRemoteRequirementOptions {
  /**
   * Whether the CLI this config is being generated for speaks HTTP natively.
   * Defaults to false so an unknown caller keeps the existing behaviour.
   */
  nativeHttpSupported?: boolean;
  /**
   * Whether Nimbalyst holds a usable OAuth credential for this server
   * (including one imported once from mcp-remote's `~/.mcp-auth`).
   * Populated by `resolveMcpRemoteRequirementOptions`; left undefined by callers
   * that never take the native-HTTP shortcut, since they bridge regardless.
   */
  hasCachedMcpRemoteToken?: boolean;
  /**
   * The caller cannot use a server's own `oauth.clientId` flow (Codex, Codex
   * ACP, Copilot), so Nimbalyst authorizes those servers itself and bridges
   * them, along with any `sse` server that declares OAuth.
   */
  useMcpRemoteForNativeOAuth?: boolean;
}

/**
 * True when the server must be routed through Nimbalyst's gateway.
 *
 * `http` servers are bridged when Nimbalyst holds their OAuth or the CLI does
 * not speak HTTP. `sse` is bridged only for callers that cannot run its OAuth.
 * A stdio entry is bridged only when it is an `npx mcp-remote <url>` command
 * made entirely of options the gateway reproduces (`isBridgeableMcpRemoteCommand`);
 * that replaces the third-party helper and its system Node dependency with the
 * gateway for every caller. Any other stdio server is local and untouched.
 */
export function requiresMcpRemote(
  config: MCPServerConfig,
  options: McpRemoteRequirementOptions,
): boolean {
  const declaresOAuth = config.oauth !== undefined && config.oauth !== null;

  if (config.type === 'sse') {
    // sse is already a remote transport the CLIs speak. Only a caller that
    // cannot run the server's OAuth itself needs Nimbalyst to hold it.
    return Boolean(options.useMcpRemoteForNativeOAuth && declaresOAuth);
  }

  if (config.type !== 'http') {
    return isBridgeableMcpRemoteCommand(config);
  }

  // Explicit OAuth credentials go native, unless this caller cannot use them.
  if (usesNativeRemoteOAuth(config)) {
    return Boolean(options.useMcpRemoteForNativeOAuth);
  }

  // An oauth block without credentials means Nimbalyst negotiates and holds the
  // tokens, so the server goes through the gateway.
  if (declaresOAuth) {
    return true;
  }

  // A stored credential proves this server negotiated OAuth through Nimbalyst
  // (or mcp-remote before it), whatever the config claims. Only the gateway
  // can present and refresh it.
  if (options.hasCachedMcpRemoteToken) {
    return true;
  }

  // No OAuth of any kind: the wrapper's only value is OAuth, so a CLI that
  // speaks HTTP natively should just talk to the server directly.
  return !options.nativeHttpSupported;
}

/**
 * Fill in the parts of the requirement that cannot be read off the config.
 *
 * Only the native-HTTP shortcut can reach a wrong answer, and only for a config
 * that declares no OAuth at all, so every other case returns without touching
 * the disk.
 */
export async function resolveMcpRemoteRequirementOptions(
  config: MCPServerConfig,
  options: McpRemoteRequirementOptions,
): Promise<McpRemoteRequirementOptions> {
  if (!options.nativeHttpSupported || config.type !== 'http') {
    return options;
  }
  if (usesNativeRemoteOAuth(config) || (config.oauth !== undefined && config.oauth !== null)) {
    return options;
  }

  const { authorized } = await checkMcpRemoteAuthStatus(config);
  return { ...options, hasCachedMcpRemoteToken: authorized };
}
