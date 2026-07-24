/**
 * Parse a tool result string back into a structured object if it was JSON-stringified.
 *
 * Canonical transcript stores tool results as strings (via JSON.stringify in the
 * transcript adapters). Custom widgets that need structured results (e.g., MCP
 * content arrays) should use this function to parse them.
 *
 * Plain text results that aren't valid JSON are returned as-is.
 */
export function parseToolResult(result?: string): unknown {
  if (result == null) return undefined;
  try {
    return JSON.parse(result);
  } catch {
    return result;
  }
}
