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
 */

import type { MCPServerConfig } from '@nimbalyst/runtime/types/MCPServerConfig';
import { usesNativeRemoteOAuth } from './MCPRemoteOAuth';

export interface McpRemoteRequirementOptions {
  /**
   * Whether the CLI this config is being generated for speaks HTTP natively.
   * Defaults to false so an unknown caller keeps the existing behaviour.
   */
  nativeHttpSupported?: boolean;
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

  // No OAuth of any kind: the wrapper's only value is OAuth, so a CLI that
  // speaks HTTP natively should just talk to the server directly.
  return !options.nativeHttpSupported;
}
