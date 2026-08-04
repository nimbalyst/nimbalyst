import type { MCPServerOAuthConfig } from '@nimbalyst/runtime/types/MCPServerConfig';

/**
 * Apply a user-entered OAuth client id to a server's `oauth` block.
 *
 * Deliberately writes `staticClientInfo` and NOT `clientId`: the former is the
 * pre-registered client Nimbalyst authorizes with through `mcp-remote`, while
 * the latter hands the server's auth to Claude/Codex and hides the Authorize
 * button (see MCPServerOAuthConfig).
 *
 * Extracted from MCPServersPanel so the emptiness handling is testable without
 * rendering the panel.
 */
export function withStaticClientId(
  oauth: MCPServerOAuthConfig | undefined,
  clientId: string
): MCPServerOAuthConfig | undefined {
  const { client_id: _replaced, ...otherClientInfo } = oauth?.staticClientInfo ?? {};
  const trimmed = clientId.trim();
  const staticClientInfo = trimmed ? { ...otherClientInfo, client_id: trimmed } : otherClientInfo;

  const next: MCPServerOAuthConfig = {
    ...oauth,
    staticClientInfo: Object.keys(staticClientInfo).length > 0 ? staticClientInfo : undefined,
  };

  // A bare `oauth: {}` reads downstream as "this server requires OAuth"
  // (`requiresOAuth` in extractMcpRemoteConfig, `declaresOAuth` in
  // requiresMcpRemote), which would wrap a static-key server in mcp-remote.
  // Clearing the field on a server that had no oauth block must leave it none.
  return Object.values(next).some((setting) => setting !== undefined) ? next : undefined;
}
