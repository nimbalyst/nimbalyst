/**
 * MCP endpoint routing — Phase 1 of the MCP server consolidation.
 *
 * The unified internal HTTP server exposes one endpoint path per server in the
 * topology (`/mcp/core`, `/mcp/host`, `/mcp/trackers`, `/mcp/situational`,
 * `/mcp/extension-dev`, and `/mcp/ext/<extensionShortName>`), plus the legacy
 * `/mcp` which keeps serving the FULL surface during migration.
 *
 * Each endpoint's `ListTools` returns only that endpoint's tool subset; the
 * `CallTool` dispatch stays centralized (a tool dispatches the same regardless
 * of which endpoint surfaced it). This module is the pure routing/filtering
 * logic so it can be unit-tested without the HTTP server.
 */

import {
  MCP_FIRST_PARTY_TOPOLOGY,
  MCP_EXTENSION_ENDPOINT_PREFIX,
  FIRST_PARTY_TOOL_TO_SERVER,
} from "@nimbalyst/runtime/ai/server";

/** Which server a given endpoint path is serving. */
export type McpEndpointSelection =
  /** Legacy `/mcp`: the full first-party + all-extensions surface (migration). */
  | { kind: "legacy" }
  /** A first-party server endpoint (`/mcp/core`, `/mcp/trackers`, …). */
  | { kind: "firstParty"; configKey: string }
  /** A per-extension server endpoint (`/mcp/ext/<shortName>`). */
  | { kind: "extension"; extensionShortName: string };

/** endpointPath → first-party configKey (e.g. `/mcp/core` → `nimbalyst-core`). */
const ENDPOINT_PATH_TO_CONFIG_KEY: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const entry of MCP_FIRST_PARTY_TOPOLOGY) {
    map.set(entry.endpointPath, entry.configKey);
  }
  return map;
})();

/** True for `/mcp` and any `/mcp/...` sub-path (but not `/mcpfoo`, `/permission`, `/clip`). */
export function isMcpEndpoint(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return pathname === "/mcp" || pathname.startsWith("/mcp/");
}

/**
 * Resolve an endpoint path to which server it serves. Returns null when the
 * path is not an MCP endpoint. Unknown `/mcp/<x>` paths fall back to `legacy`
 * (full surface) so a stale/misrouted connection still functions.
 */
export function resolveMcpEndpoint(
  pathname: string | null | undefined,
): McpEndpointSelection | null {
  if (!isMcpEndpoint(pathname)) return null;
  const p = pathname as string;

  if (p === "/mcp") return { kind: "legacy" };

  if (p.startsWith(MCP_EXTENSION_ENDPOINT_PREFIX)) {
    const extensionShortName = p.slice(MCP_EXTENSION_ENDPOINT_PREFIX.length);
    if (extensionShortName) return { kind: "extension", extensionShortName };
    return { kind: "legacy" };
  }

  const configKey = ENDPOINT_PATH_TO_CONFIG_KEY.get(p);
  if (configKey) return { kind: "firstParty", configKey };

  // Unknown /mcp/<x> — be forgiving and serve the full surface.
  return { kind: "legacy" };
}

/** Extension id (`com.nimbalyst.excalidraw`) → short-name (`excalidraw`). */
export function extensionShortNameFromId(extensionId: string): string {
  const parts = extensionId.split(".");
  return parts[parts.length - 1] || extensionId;
}

interface NamedToolSchema {
  name: string;
}

/**
 * Filter the full first-party built-in tool schema list down to the subset
 * owned by `configKey` per the topology reverse index. Tools with no topology
 * mapping (e.g. the retired `open_workspace`) are excluded from every
 * first-party endpoint — they remain reachable only via legacy `/mcp`.
 */
export function selectFirstPartyToolsForEndpoint<T extends NamedToolSchema>(
  allBuiltInTools: T[],
  configKey: string,
): T[] {
  return allBuiltInTools.filter(
    (tool) => FIRST_PARTY_TOOL_TO_SERVER.get(tool.name) === configKey,
  );
}

interface ExtensionScopedTool {
  extensionId: string;
}

/** Filter extension tools to a single extension by its short-name. */
export function selectExtensionToolsForEndpoint<T extends ExtensionScopedTool>(
  extensionTools: T[],
  extensionShortName: string,
): T[] {
  return extensionTools.filter(
    (tool) => extensionShortNameFromId(tool.extensionId) === extensionShortName,
  );
}
