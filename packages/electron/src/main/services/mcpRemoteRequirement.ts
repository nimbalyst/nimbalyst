/**
 * Whether an HTTP MCP server actually needs the `mcp-remote` stdio wrapper.
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
 * `nativeHttpSupported` is deliberately opt-in per caller. Claude Code was
 * verified by A/B test (same PAT, identical prompt, identical tool results and
 * org access, four fewer processes). Codex, Codex ACP and Copilot share this code
 * path and have NOT been verified, so they keep the wrapper until they are.
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
import { checkMcpRemoteAuthStatus, usesNativeRemoteOAuth } from './MCPRemoteOAuth';

export interface McpRemoteRequirementOptions {
  /**
   * Whether the CLI this config is being generated for speaks HTTP natively.
   * Defaults to false so an unknown caller keeps the existing behaviour.
   */
  nativeHttpSupported?: boolean;
  /**
   * Whether mcp-remote holds a usable token for this server under `~/.mcp-auth`.
   * Populated by `resolveMcpRemoteRequirementOptions`; left undefined by callers
   * that never take the native-HTTP shortcut, since they wrap regardless.
   */
  hasCachedMcpRemoteToken?: boolean;
}

/**
 * True when the server must be routed through `npx mcp-remote`.
 *
 * Only `http` servers are ever wrapped. `sse` is already a remote transport and
 * `stdio` is local, so neither is affected.
 */
export function requiresMcpRemote(
  config: MCPServerConfig,
  options: McpRemoteRequirementOptions,
): boolean {
  if (config.type !== 'http') {
    return false;
  }

  // Existing escape hatch: explicit OAuth credentials go native.
  if (usesNativeRemoteOAuth(config)) {
    return false;
  }

  // An oauth block without credentials means tokens are negotiated and stored by
  // mcp-remote (~/.mcp-auth). Those still need it.
  const declaresOAuth = config.oauth !== undefined && config.oauth !== null;
  if (declaresOAuth) {
    return true;
  }

  // A token in ~/.mcp-auth proves this server negotiated OAuth through
  // mcp-remote at some point, whatever the config claims. Only mcp-remote can
  // present and refresh that token, so the wrapper is the credential.
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
