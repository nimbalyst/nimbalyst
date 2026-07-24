/**
 * Shared utilities for the canonical transcript system.
 */

/**
 * Parse an MCP tool name in the format `mcp__<server>__<tool>`.
 * Returns the server and tool parts, or null if the name is not an MCP tool.
 */
export function parseMcpToolName(toolName: string): { server: string; tool: string } | null {
  if (!toolName.includes('__')) return null;
  const parts = toolName.split('__').filter(Boolean);
  if (parts.length < 3 || parts[0] !== 'mcp') return null;
  const tool = parts[parts.length - 1];
  const server = parts.slice(1, -1).join('__');
  return { server, tool };
}
