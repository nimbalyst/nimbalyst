/**
 * Central MCP Listeners
 *
 * Subscribes ONCE to:
 * - `mcp-config:test-progress` -> mcpTestProgressAtom (MCPServersPanel)
 * - `ai:mcp-status:changed`    -> mcpSessionStatusAtomFamily (session chip)
 *
 * Components never subscribe to either channel directly (IPC_LISTENERS rule).
 *
 * Call initMcpListeners() once at app startup.
 */

import { store } from '@nimbalyst/runtime/store';
import type { McpSessionStatusSnapshot } from '@nimbalyst/runtime/types/MCPServerConfig';
import { mcpSessionStatusAtomFamily, mcpTestProgressAtom } from '../atoms/mcpStatus';

let initialized = false;
let counter = 0;

export function initMcpListeners(): () => void {
  if (initialized) {
    return () => {};
  }
  initialized = true;

  const unsubscribe = window.electronAPI?.on?.(
    'mcp-config:test-progress',
    (data: { status: string; message: string }) => {
      counter += 1;
      store.set(mcpTestProgressAtom, {
        status: data.status,
        message: data.message,
        version: counter,
      });
    },
  );

  // Live MCP health transitions for a running session. Fires between turns as
  // well as during them, so it is not tied to any streaming lifecycle here.
  const unsubscribeSessionStatus = window.electronAPI?.on?.(
    'ai:mcp-status:changed',
    (data: McpSessionStatusSnapshot) => {
      if (!data?.sessionId) return;
      store.set(mcpSessionStatusAtomFamily(data.sessionId), data);
    },
  );

  return () => {
    initialized = false;
    if (typeof unsubscribe === 'function') {
      unsubscribe();
    }
    if (typeof unsubscribeSessionStatus === 'function') {
      unsubscribeSessionStatus();
    }
  };
}
