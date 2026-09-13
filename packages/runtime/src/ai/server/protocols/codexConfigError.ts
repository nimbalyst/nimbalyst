/**
 * When Codex resolves an MCP server as stdio but the merged configuration still
 * contains a remote `url`, the raw error does not explain that two transports
 * were combined. Detect that case and show valid, mutually exclusive HTTP and
 * stdio shapes.
 *
 * Returns null when the error is not a recognized url-vs-stdio MCP config error,
 * so callers can fall back to the raw message.
 */
export function describeCodexConfigError(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;

  const match = raw.match(/url is not supported for stdio in mcp_servers\.([A-Za-z0-9._-]+)/i);
  if (!match) return null;

  const name = match[1];
  // TOML bare keys allow only [A-Za-z0-9_-]. A name with any other character
  // (e.g. a dot) must be quoted, or `[mcp_servers.a.b]` parses as nested tables.
  const tomlKey = /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name);
  return [
    `The MCP server "${name}" resolved to a mixed transport configuration containing both a stdio "command" and a remote "url". Keep exactly one transport, then restart.`,
    ``,
    `For a Streamable HTTP server:`,
    `     [mcp_servers.${tomlKey}]`,
    `     url = "<url>"`,
    ``,
    `For a local stdio server:`,
    `     [mcp_servers.${tomlKey}]`,
    `     command = "<command>"`,
    `     args = ["<arg>"]`,
  ].join('\n');
}
