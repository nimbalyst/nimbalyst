/**
 * Central MCP Listener
 *
 * Subscribes to `mcp-config:test-progress` ONCE and writes the latest event
 * (with a monotonic version) to mcpTestProgressAtom. The MCPServersPanel
 * watches the atom to display test progress.
 *
 * Call initMcpListeners() once at app startup.
 */

import { store } from '@nimbalyst/runtime/store';
import { mcpTestProgressAtom } from '../atoms/mcpStatus';

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

  return () => {
    initialized = false;
    if (typeof unsubscribe === 'function') {
      unsubscribe();
    }
  };
}
