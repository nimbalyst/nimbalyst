/**
 * MCP Status Atoms
 *
 * Holds the latest progress event broadcast by the main process during MCP
 * server connection tests.
 *
 * Updated by store/listeners/mcpListeners.ts.
 */

import { atom } from 'jotai';
import type {
  McpSessionServerRow,
  McpSessionStatusSnapshot,
} from '@nimbalyst/runtime/types/MCPServerConfig';
import { atomFamily } from '../debug/atomFamilyRegistry';

export interface McpTestProgress {
  status: string;
  message: string;
  /** Monotonic counter so consumers can react to repeated identical messages. */
  version: number;
}

export const mcpTestProgressAtom = atom<McpTestProgress | null>(null);

/**
 * Per-session MCP server status (NIM-2272 / GH #1089).
 *
 * Null means "nothing known yet" — the chip must not render a state from it.
 * Written by the pull on popover/mount and by the central listener on live
 * transitions; components never subscribe to the IPC channel themselves.
 */
export const mcpSessionStatusAtomFamily = atomFamily((_sessionId: string) =>
  atom<McpSessionStatusSnapshot | null>(null)
);

export interface McpSessionStatusGroups {
  connected: McpSessionServerRow[];
  /** failed / needs-auth / pending / disabled — reported, but not usable. */
  problem: McpSessionServerRow[];
  /** In the session's config snapshot, never reported by the CLI at all. */
  absent: McpSessionServerRow[];
}

/**
 * Split rows into the three sets the popover renders.
 *
 * `absent` and `problem` are kept apart because they have different answers:
 * a problem server is one the session knows about and can retry, an absent one
 * never made it into the session and points at scope or config instead.
 */
export function groupMcpSessionServers(
  servers: McpSessionServerRow[],
): McpSessionStatusGroups {
  const groups: McpSessionStatusGroups = { connected: [], problem: [], absent: [] };
  for (const server of servers) {
    if (server.state === 'connected') groups.connected.push(server);
    else if (server.state === 'absent') groups.absent.push(server);
    else groups.problem.push(server);
  }
  return groups;
}
