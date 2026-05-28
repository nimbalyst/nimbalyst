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
  // TOML bare keys allow only [A-Za-z0-9_-]. A name with any other character
  // (e.g. a dot) must be quoted, or `[mcp_servers.a.b]` parses as nested tables.
  const tomlKey = /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name);
  const envKey = `${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;

  return [
    `The MCP server "${name}" in ~/.codex/config.toml uses a "url", which this Codex build does not support (it only launches stdio MCP servers via a "command"). Convert that entry, then restart.`,
    ``,
    `Universal fix - wrap the remote server as a stdio process:`,
    `     [mcp_servers.${tomlKey}]`,
    `     command = "npx"`,
    `     args = ["-y", "mcp-remote", "<url>"]`,
    ``,
    `If you run a local stdio build of this server (for example, a Personal API Key version that avoids OAuth token expiry), point Codex at it instead:`,
    `     [mcp_servers.${tomlKey}]`,
    `     command = "python"`,
    `     args = ["/path/to/${name}-server.py"]`,
    `     [mcp_servers.${tomlKey}.env]`,
    `     ${envKey} = "<your key>"`,
  ].join('\n');
}
