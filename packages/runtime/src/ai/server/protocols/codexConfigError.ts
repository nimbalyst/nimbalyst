/**
 * When Codex fails to load `config.toml` because an MCP server entry uses a
 * remote `url` that the bundled Codex build does not accept (older builds only
 * support stdio MCP servers), the raw error is opaque: "url is not supported for
 * stdio in mcp_servers.<name>". Detect that case and return actionable guidance
 * that names the offending server and shows how to convert it to a stdio entry.
 *
 * Returns null when the error is not a recognized url-vs-stdio MCP config error,
 * so callers can fall back to the raw message.
 */
export function describeCodexConfigError(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;

  const match = raw.match(/url is not supported for stdio in mcp_servers\.([A-Za-z0-9._-]+)/i);
  if (!match) return null;

  const name = match[1];
  const envKey = `${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;

  return [
    `The MCP server "${name}" in ~/.codex/config.toml uses a "url", which this Codex build does not support (it only launches stdio MCP servers via a "command"). Convert that entry one of two ways, then restart:`,
    ``,
    `1) Keep the same remote server, wrapped as a stdio process:`,
    `     [mcp_servers.${name}]`,
    `     command = "npx"`,
    `     args = ["-y", "mcp-remote", "<url>"]`,
    ``,
    `2) Switch to a local stdio server authenticated with a Personal API Key (avoids OAuth token expiry):`,
    `     [mcp_servers.${name}]`,
    `     command = "python"`,
    `     args = ["/path/to/${name}-mcp/server.py"]`,
    `     [mcp_servers.${name}.env]`,
    `     ${envKey} = "<your key>"`,
  ].join('\n');
}
