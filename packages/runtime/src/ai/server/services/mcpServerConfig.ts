/**
 * Shared internal-MCP-server configuration.
 *
 * Single source of truth for the deps that decide WHICH internal Nimbalyst MCP
 * servers/tools an agent session gets. Previously every agent provider
 * (ClaudeCode, OpenAICodex, OpenAICodexACP, OpenCode, CopilotCLI) plus the
 * `claude-code-cli` launcher carried its own static copy of each port/loader,
 * so adding one MCP-enablement dep meant editing ~6 files in lockstep. Now the
 * electron main process calls `configureMcpServers(...)` once and every provider
 * reads the same object via `getMcpConfigService(...)`.
 *
 * Only the genuinely provider-specific deps stay per-provider and are passed as
 * `overrides`:
 *  - `mcpConfigLoader` — the user/workspace `.mcp.json` merge is filtered per
 *    provider (Claude Agent vs Codex vs Copilot enablement).
 *  - `claudeSettingsEnvLoader` / `shellEnvironmentLoader` — also feed each
 *    provider's SDK-subprocess env, so they're owned by the provider DI.
 */

import { McpConfigService, McpConfigServiceDeps } from './McpConfigService';
import type { DocumentContext } from '../types';

/**
 * MCP-enablement deps shared across every agent provider. Mutated in place by
 * `configureMcpServers` so a `McpConfigService` built from it sees live updates
 * (ports/tokens are set once at startup; the loaders are read per config build).
 */
export type SharedMcpServerConfig = Pick<
  McpConfigServiceDeps,
  | 'mcpServerPort'
  | 'extensionDevServerPort'
  | 'settingsAgentToolsDisabledLoader'
  | 'trackersAgentToolsDisabledLoader'
  | 'extensionMcpServerNamesLoader'
  | 'mcpAuthToken'
  | 'mcpSessionCredentialIssuer'
>;

/** Provider-owned deps merged on top of the shared config per `getMcpConfigService`. */
export interface PerProviderMcpDeps {
  mcpConfigLoader: McpConfigServiceDeps['mcpConfigLoader'];
  claudeSettingsEnvLoader: McpConfigServiceDeps['claudeSettingsEnvLoader'];
  shellEnvironmentLoader: McpConfigServiceDeps['shellEnvironmentLoader'];
}

const shared: SharedMcpServerConfig = {
  mcpServerPort: null,
  extensionDevServerPort: null,
  settingsAgentToolsDisabledLoader: null,
  trackersAgentToolsDisabledLoader: null,
  extensionMcpServerNamesLoader: null,
  mcpAuthToken: null,
  mcpSessionCredentialIssuer: null,
};

/** Set/update the shared MCP-enablement deps. Called once from electron main. */
export function configureMcpServers(partial: Partial<SharedMcpServerConfig>): void {
  Object.assign(shared, partial);
}

/**
 * True once the unified internal MCP HTTP server is up. Proxy for "the agent
 * gets Nimbalyst's internal tools" — e.g. `update_session_meta` (eager core),
 * which providers use to decide whether to include the session-naming prompt.
 */
export function isInternalMcpServerEnabled(): boolean {
  return shared.mcpServerPort !== null;
}

/**
 * True when tracker agent tools are enabled for the workspace. Providers use
 * this to skip tracker-related system-prompt guidance when the workspace has
 * trackers disabled (no loader wired = enabled, matching McpConfigService).
 */
/**
 * Workspace path for tracker-enablement lookups from a session's document
 * context. Prefers the MCP config path (parent project for worktrees), same
 * scope `McpConfigService.getMcpServersConfig` keys the trackers opt-out on.
 */
export function resolveTrackersWorkspacePath(documentContext?: DocumentContext): string | undefined {
  return (
    documentContext?.mcpConfigWorkspacePath ??
    documentContext?.worktreeProjectPath ??
    documentContext?.worktreePath
  );
}

export function areTrackerToolsEnabled(workspacePath?: string): boolean {
  try {
    return !shared.trackersAgentToolsDisabledLoader?.(workspacePath);
  } catch {
    return true;
  }
}

/** Build a `McpConfigService` from the shared config + the provider's own loaders. */
export function getMcpConfigService(overrides: PerProviderMcpDeps): McpConfigService {
  return new McpConfigService({
    ...shared,
    mcpConfigLoader: overrides.mcpConfigLoader,
    claudeSettingsEnvLoader: overrides.claudeSettingsEnvLoader,
    shellEnvironmentLoader: overrides.shellEnvironmentLoader,
  });
}

/** Build the Claude meta-agent override from the canonical MCP config path. */
export async function buildClaudeMetaAgentMcpConfig(
  service: Pick<McpConfigService, 'getMcpServersConfig'>,
  context: {
    sessionId?: string;
    providerWorkspacePath: string;
    mcpConfigWorkspacePath?: string;
  },
): Promise<Record<string, any>> {
  return service.getMcpServersConfig({
    sessionId: context.sessionId,
    workspacePath: context.mcpConfigWorkspacePath ?? context.providerWorkspacePath,
    profile: 'meta-agent',
  });
}
