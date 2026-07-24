/**
 * MCP Status Atoms
 *
 * Holds the latest progress event broadcast by the main process during MCP
 * server connection tests.
 *
 * Updated by store/listeners/mcpListeners.ts.
 */

import { atom } from 'jotai';

export interface McpTestProgress {
  status: string;
  message: string;
  /** Monotonic counter so consumers can react to repeated identical messages. */
  version: number;
}

export const mcpTestProgressAtom = atom<McpTestProgress | null>(null);
