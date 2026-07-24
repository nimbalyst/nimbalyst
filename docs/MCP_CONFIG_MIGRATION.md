# MCP Configuration Migration to ~/.claude.json

## Overview

Nimbalyst now uses `~/.claude.json` as the primary location for user-scope MCP server configurations, matching the Claude Code CLI behavior. This ensures full compatibility between Nimbalyst and the `claude` CLI command.

## What Changed

### Old Behavior (Pre-Migration)
- **User scope**: `~/.config/claude/mcp.json` (Linux/macOS) or `%APPDATA%/claude/mcp.json` (Windows)
- **Workspace scope**: `.mcp.json` in project root

### New Behavior (Post-Migration)
- **User scope**: `~/.claude.json` (top-level `mcpServers` key)
- **Workspace scope**: `.mcp.json` in project root (unchanged)
- **Legacy support**: Still reads from `~/.config/claude/mcp.json` for backward compatibility

## Migration Process

The migration happens automatically when Nimbalyst starts:

1. **First Read**: When `MCPConfigService.readUserMCPConfig()` is called
2. **Check Primary**: Looks for `mcpServers` in `~/.claude.json`
3. **Check Legacy**: If `mcpServers` key doesn't exist, checks `~/.config/claude/mcp.json`
4. **Migrate**: If legacy config has servers, merges them into `~/.claude.json`
5. **Cleanup**: Deletes the legacy file after successful migration
6. **Preserve**: Keeps all existing Claude Code settings in `~/.claude.json`

**Important**: The legacy location was Nimbalyst-only (never used by Claude Code CLI). After migration, the legacy file is deleted to prevent it from interfering with future reads (e.g., when the user intentionally deletes all servers).

## File Structure

### ~/.claude.json (Primary)
```json
{
  "numStartups": 263,
  "autoUpdates": true,
  "mcpServers": {
    "posthog": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "mcp-remote@latest", "https://mcp.posthog.com/sse"],
      "env": {
        "POSTHOG_PERSONAL_API_KEY": "..."
      }
    },
    "fetch": {
      "type": "stdio",
      "command": "uvx",
      "args": ["mcp-server-fetch"]
    }
  }
}
```

### ~/.config/claude/mcp.json (Legacy)
```json
{
  "mcpServers": {
    "posthog": { ... },
    "fetch": { ... }
  }
}
```

## Compatibility

### With Claude Code CLI
The `claude mcp list` command now correctly reads MCP servers configured in Nimbalyst, and vice versa. Both applications share the same `~/.claude.json` file.

### Backward Compatibility
- Nimbalyst reads from legacy location only if `mcpServers` key doesn't exist in `~/.claude.json`
- After successful migration, the legacy file is deleted to prevent conflicts
- An empty `mcpServers: {}` is respected as a valid user choice (no re-migration)
- All writes go to `~/.claude.json` going forward

## Testing

Run the migration test script to verify configuration:

```bash
node packages/electron/test-mcp-migration.js
```

This checks:
- Legacy config location and server count
- New config location and server count
- Migration status
- Preservation of other Claude Code settings

## Developer Notes

### MCPConfigService Changes

**Constructor**:
- Added `legacyConfigPath` property
- `userConfigPath` now points to `~/.claude.json`

**readUserMCPConfig()**:
- Reads from `~/.claude.json` → `mcpServers` key
- Falls back to `migrateLegacyConfig()` if empty
- Returns `MCPConfig` with just `mcpServers`

**writeUserMCPConfig()**:
- Reads existing `~/.claude.json` to preserve settings
- Updates only `mcpServers` key
- Writes back complete config

**migrateLegacyConfig()** (private):
- Reads from legacy location
- Merges into existing `~/.claude.json`
- Preserves all other Claude Code settings
- Deletes legacy file after successful migration

**deleteLegacyConfig()** (private):
- Deletes the legacy config file
- Attempts to remove empty parent directory

### Type Definitions

Added `ClaudeConfig` interface:
```typescript
interface ClaudeConfig {
  mcpServers?: Record<string, MCPServerConfig>;
  [key: string]: any; // Other Claude Code settings
}
```

## Known Issues

### Project-Specific Local Scope
The `claude` CLI also supports a project-specific local scope in `~/.claude.json` → `projects["/absolute/path"]` → `mcpServers`. This is not yet implemented in Nimbalyst but could be added in the future.

## References

- GitHub Issue: [Documentation incorrect about MCP configuration file location #4976](https://github.com/anthropics/claude-code/issues/4976)
- GitHub Issue: [MCP Configuration Inconsistency: CLI-managed vs File-based configs #3098](https://github.com/anthropics/claude-code/issues/3098)
- Claude Code CLI version: 2.1.12
