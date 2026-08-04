/**
 * Per-session MCP status IPC (NIM-2272 / GH #1089).
 *
 * The pull half of the surface. `ClaudeCodeProvider` already polls the SDK for
 * MCP server health every 30s; this exposes the cached result so a session can
 * answer "which servers do I actually have right now, and why is that tool
 * missing" without being killed and restarted.
 *
 * The push half (live transitions) lives in MessageStreamingHandler, which is
 * where provider event listeners are installed. Both are needed: the push
 * covers transitions, the pull covers first render, since no listener exists
 * until a message has been sent.
 *
 * Read-only by construction — see the plan's NIM-1988 section. Nothing here may
 * call `setMcpServers`/`toggleMcpServer`; both would replace the frozen server
 * set and blow the prompt cache for the whole conversation.
 */

import { ProviderFactory } from '@nimbalyst/runtime/ai/server';
import type { AIProviderType } from '@nimbalyst/runtime/ai/server/types';
import {
  buildMcpSessionStatusSnapshot,
  type McpSessionStatusSnapshot,
} from '@nimbalyst/runtime/types/MCPServerConfig';
import { safeHandle } from '../utils/ipcRegistry';

/**
 * Providers that can report per-session MCP status.
 *
 * Codex is deliberately absent: `CodexAppServerProtocol` receives
 * `mcpServer/startupStatus/updated` but drops it as informational, and there is
 * no verified equivalent of `mcpServerStatus()` through the app-server
 * protocol. An unsupported session must read as "not supported here", never as
 * an empty list implying the session has no MCP servers.
 */
const MCP_STATUS_PROVIDERS: ReadonlySet<string> = new Set(['claude-code']);

/** Structural view of the provider methods this module needs. */
interface McpStatusCapableProvider {
  getMcpSessionStatus(): {
    servers: { name: string; status: string; error?: string; scope?: string; serverInfo?: { name?: string; version?: string }; tools?: unknown[] }[];
    configuredNames: string[] | null;
    withheldNames?: string[] | null;
    lastCheckedAt: number | null;
  };
}

function isMcpStatusCapable(provider: unknown): provider is McpStatusCapableProvider {
  return typeof (provider as McpStatusCapableProvider)?.getMcpSessionStatus === 'function';
}

/**
 * Build the renderer payload for a session. Exported for the push path and for
 * tests; both must produce byte-identical snapshots.
 */
export function getMcpSessionStatusSnapshot(
  sessionId: string,
  provider: string,
): McpSessionStatusSnapshot {
  const supported = MCP_STATUS_PROVIDERS.has(provider);
  if (!supported) {
    return { sessionId, supported: false, active: false, servers: [], lastCheckedAt: null };
  }

  // Cache lookup only — never creates a provider. A session that has not run a
  // turn yet legitimately has none, and that is `active: false`, not an error.
  const instance = ProviderFactory.getProvider(provider as AIProviderType, sessionId);
  if (!isMcpStatusCapable(instance)) {
    return { sessionId, supported: true, active: false, servers: [], lastCheckedAt: null };
  }

  const { servers, configuredNames, withheldNames, lastCheckedAt } = instance.getMcpSessionStatus();
  return buildMcpSessionStatusSnapshot({
    sessionId,
    supported: true,
    active: true,
    statuses: servers,
    configuredNames,
    withheldNames,
    lastCheckedAt,
  });
}

export function registerMcpSessionStatusHandlers(): void {
  safeHandle(
    'ai:mcp-status:get',
    async (_event, payload: { sessionId?: string; provider?: string }) => {
      const sessionId = payload?.sessionId;
      const provider = payload?.provider;
      if (!sessionId) {
        throw new Error('ai:mcp-status:get requires sessionId');
      }
      if (!provider) {
        throw new Error('ai:mcp-status:get requires provider');
      }
      return getMcpSessionStatusSnapshot(sessionId, provider);
    },
  );
}
