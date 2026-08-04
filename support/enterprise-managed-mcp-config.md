# Claude Code sessions on machines with an enterprise MCP config

## Symptom

Claude Code sessions fail to start, or start without any Nimbalyst tools. Older Nimbalyst versions showed:

```
Claude Code process exited with code 1.
stderr: You cannot use --strict-mcp-config when an enterprise MCP config is present
```

## What is happening

The organization has deployed a `managed-mcp.json` to the machine:

| Platform | Path |
| --- | --- |
| macOS | `/Library/Application Support/ClaudeCode/managed-mcp.json` |
| Windows | `C:\Program Files\ClaudeCode\managed-mcp.json` |
| Linux | `/etc/claude-code/managed-mcp.json` |

That file puts Claude Code into an exclusive-control lockdown. The binary then refuses two things outright: the `--strict-mcp-config` flag, and **any** MCP server passed in at launch by a host application. The only exception hardcoded in the binary is the VS Code extension's own in-process server.

## What Nimbalyst does now

Nimbalyst no longer passes `--strict-mcp-config` at all. When it detects a `managed-mcp.json` it also stops passing its own MCP servers, so sessions start and run normally on the organization's servers.

The trade-off on those machines is that Nimbalyst's own agent tools are unavailable for Claude Code sessions:

- the interactive question and structured-input widgets (the agent asks in plain text instead)
- automatic session naming
- tracker tools
- extension-provided tools

Nothing else about the session is affected, and other providers (Codex, Copilot) are not affected at all.

## What an administrator can change

If the goal is to govern which MCP servers are allowed rather than to block host applications, use the managed **settings** policy instead of deploying `managed-mcp.json`:

- `allowedMcpServers` / `deniedMcpServers` in managed settings enforce an allowlist or denylist by server name or command, and do not trigger the exclusive-control lockdown. Host applications keep working, and only approved servers load.
- `allowAllClaudeAiMcps` re-permits claude.ai account connectors under a lockdown, if `managed-mcp.json` must stay.

With managed settings in place instead of `managed-mcp.json`, Nimbalyst sessions get their full tool set back automatically — no change is needed on the user's side.
