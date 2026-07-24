# Agent Permissions System

This document describes Nimbalyst's permission system for AI agent tool calls. The system provides fine-grained control over what actions the AI agent can perform in your projects.

## Overview

When an AI agent runs in Nimbalyst, it can execute various tools: reading files, writing code, running bash commands, making web requests, and more. The permission system ensures users maintain control over these operations while minimizing friction for trusted workflows.

### Key Design Principles

1. **Trust is per-project** - Each workspace has its own trust status and permission settings
2. **Patterns, not individual calls** - Approve tool patterns once, remembered forever (not just for the session)
3. **Read-only by default** - Safe read operations are auto-approved within the workspace
4. **Workspace-scoped by default** - The agent cannot read or write files outside the project unless you explicitly grant access
5. **Fine-grained bash control** - The system understands command structure (allow `npm test` but block `rm -rf`)
6. **URL pattern matching** - Control which domains the agent can access

## Permission Modes

When you first open a project with an AI agent, the trust dialog presents four autonomy levels. The labels map onto the existing stored permission mode plus the Agent-verified reviewer flag.

### Agent-verified (Recommended)

- Routine work proceeds without interrupting you
- Risky operations are evaluated by the provider's native automatic reviewer
- Claude Agent uses the Claude SDK's auto-mode classifier
- OpenAI Codex uses `workspace-write`, `approval_policy = "on-request"`, and `approvals_reviewer = "auto_review"`
- Stored as `permissionMode: "bypass-all"` with `allowAllUsesClassifier: true`

### Allow everything

- All operations run without approval prompts or automatic review
- Uses unrestricted provider access where supported
- Only for projects you fully trust
- Stored as `permissionMode: "bypass-all"` with `allowAllUsesClassifier: false`

### Allow edits only

- File operations are auto-approved
- Bash commands and web requests follow provider permission settings
- Stored as `permissionMode: "allow-all"`

### Ask every time

- Read-only tools are auto-approved (file reads, `git status`, `npm list`, etc.)
- Writing tools prompt for approval on first use
- When approving, you choose the scope:
  - **Just this time** - One-time approval, won't be remembered
  - **For this session** - Allowed until you close the project
  - **Always in this project** - Permanently saved to `.claude/settings.local.json`
- All approved patterns can be managed in **Settings > Agent Permissions**
- Stored as `permissionMode: "ask"`

## What Gets Auto-Approved

In "Ask for Approval" mode, these operations are automatically allowed when they only access files within the workspace:

### Read-only Bash Commands
- `ls`, `cat`, `head`, `tail`, `less`, `more`
- `find`, `grep`, `rg`, `ag`
- `wc`, `diff`, `file`, `stat`
- `pwd`, `which`, `whereis`, `type`
- `env`, `printenv`, `echo`

### Git Read-only Commands
- `status`, `log`, `diff`, `show`, `branch`
- `remote`, `tag`, `stash list`, `config --get`
- `rev-parse`, `ls-files`, `ls-tree`

### NPM Read-only Commands
- `list`, `ls`, `outdated`, `view`, `info`, `search`

### File Tools
- `Read` - Reading files within workspace
- `Glob` - Finding files by pattern
- `Grep` - Searching file contents

## Permission Patterns

The system generates patterns for tool calls that can be allowed or denied:

### Bash Command Patterns
```
bash:ls           # ls command
bash:npm:test     # npm test
bash:npm:run:*    # any npm run script
bash:git:push     # git push
```

### Tool Patterns
```
edit:relative     # Edit files with relative paths
write:relative    # Write files with relative paths
read              # Read tool
```

### Examples

When you approve "npm test", the pattern `bash:npm:test` is saved. Next time the agent runs `npm test`, it's automatically allowed.

When you approve "git push origin main", the pattern `bash:git:push` is saved, allowing future `git push` commands.

## Path Controls

By default, the agent is **sandboxed to your project directory**. It cannot read or write files outside the workspace root.

### What Happens When Agent Tries to Access Outside Files

- **Read outside workspace** - Requires approval (will ask)
- **Write outside workspace** - Requires approval (will ask)
- **Sensitive paths** (e.g., `~/.ssh`, `~/.aws`, `/etc`) - Always blocked

### Why This Matters

Even read access to files outside your project can be dangerous:
- A malicious prompt could exfiltrate secrets from `~/.aws/credentials`
- Reading other project directories could leak proprietary code
- System files could reveal information about your environment

The agent will ask before accessing any path outside the project, giving you a chance to review.

## Additional Directories

If you need the agent to access files outside the workspace, you can explicitly grant access:

1. Open Settings > Agent Permissions
2. Click "Add Directory"
3. Choose between:
  - **Read** - Agent can read files but not modify
  - **Write** - Agent can read and write files

This is useful for:
- Shared configuration directories
- Monorepo setups where you want to reference other packages
- External dependency directories

## URL Patterns

Control which domains the agent can fetch or curl:

### Pattern Syntax

| Pattern | Matches |
| --- | --- |
| `github.com` | Exact match only |
| `*.github.com` | Any subdomain (api.github.com, raw.github.com) |
| `https://api.example.com/*` | Any path on that URL |
| `*.anthropic.com` | docs.anthropic.com, api.anthropic.com, etc. |

### Adding URL Patterns

1. Open Settings > Agent Permissions
2. Scroll to "Allowed URL Patterns"
3. Click "Add URL Pattern"
4. Enter the pattern and optional description

## Approval Scopes

When a tool requires approval, you choose one of four scopes:

| Scope | What Happens | Persistence |
|-------|--------------|-------------|
| **Just this time** | Approves this single call only | None |
| **For this session** | Approves until you restart the app | Memory only |
| **Always in this project** | Saves pattern to settings file | `.claude/settings.local.json` |
| **Allow all domains** | WebFetch only: allows all URLs | `.claude/settings.local.json` |

### Scope Details

**Just this time** (`once`)
- Single-use approval for this exact tool call
- Not cached anywhere
- Next similar call will prompt again

**For this session** (`session`)
- Pattern cached in memory for the current app session
- On app restart, the pattern is forgotten (will prompt again unless also in settings)
- Useful for temporary tasks you don't want to permanently allow

**Always in this project** (`always`)
- Saved to `.claude/settings.local.json` in the project's `.claude/` folder
- Persists across sessions and syncs with Claude CLI
- Also cached in session memory to avoid re-prompting

**Allow all domains** (`always-all`)
- WebFetch-specific scope
- Saves a wildcard pattern that allows all domains
- Cannot be used for Bash commands (too dangerous)

## Managing Approved Patterns

All patterns you've approved (or denied) are saved and can be managed:

1. Click the **shield icon** in the navigation gutter
2. Select **"Permission settings"**
3. Or go to **Settings > Agent Permissions**

From here you can:
- **View all allowed patterns** - See every command pattern you've approved
- **View all denied patterns** - See patterns you've blocked
- **Remove patterns** - Click the trash icon to remove any pattern
- **Reset to defaults** - Clear all patterns and start fresh

This is especially useful when:
- You accidentally approved something you shouldn't have
- You want to tighten security after a period of "Allow All"
- You're debugging why certain commands are/aren't being allowed

## Architecture

### Components

```
┌─────────────────────────────────────────────────────────────┐
│                     Renderer Process                         │
├─────────────────────────────────────────────────────────────┤
│  ProjectTrustToast         - First-time trust dialog        │
│  TrustIndicator            - Nav gutter status icon         │
│  ProjectPermissionsPanel   - Full settings UI               │
│  ToolPermissionConfirmation - Inline approval dialog        │
│  InteractivePromptWidget   - Embedded permission in transcript│
└─────────────────────────────────────────────────────────────┘
                              │
                              │ IPC
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      Main Process                            │
├─────────────────────────────────────────────────────────────┤
│  PermissionService      - Workspace trust state management  │
│  ClaudeSettingsManager  - Settings file read/write          │
│  PermissionHandlers     - IPC handlers for renderer         │
│  AIService              - Tool permission IPC handlers      │
└─────────────────────────────────────────────────────────────┘
                              │
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Runtime Package                           │
├─────────────────────────────────────────────────────────────┤
│  ClaudeCodeProvider  - auto-mode + canUseTool handling      │
│  OpenAICodexProvider - native automatic approval reviewer   │
│  Codex protocols     - sandbox / approval policy mapping    │
│  sessionApprovedPatterns - Session-level pattern cache      │
│  pendingToolPermissions - Awaiting approval requests        │
└─────────────────────────────────────────────────────────────┘
                              │
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Settings Files                            │
├─────────────────────────────────────────────────────────────┤
│  ~/.claude/settings.json         - User-level defaults      │
│  .claude/settings.json           - Project shared patterns  │
│  .claude/settings.local.json     - Project personal patterns│
└─────────────────────────────────────────────────────────────┘
```

### Data Flow

1. **Agent requests tool** → Provider evaluates it using its native approval mechanism
2. **Permission service or provider reviewer evaluates the request**
3. **Decision returned**:
  - `allow` - Tool executes immediately
  - `deny` - Tool blocked, agent notified
  - `ask` - UI shows approval dialog
4. **User responds** → Pattern saved if "always" selected
5. **Tool executes or blocks** based on response

### Storage

The permission system uses a dual storage approach:

**Workspace Trust State** (managed by PermissionService):
- Trust status and permission mode stored in Nimbalyst's internal workspace settings
- Controls whether the agent can run at all in a workspace
- Stored separately from Claude Code's settings files

#### Workspace Trust Storage

Trust state is stored per-workspace in Nimbalyst's workspace settings store:

```json
{
  "agentPermissions": {
    "permissionMode": "bypass-all",
    "allowAllUsesClassifier": true
  }
}
```

| permissionMode Value | Meaning |
|---------------------|---------|
| `null` | Untrusted - agent cannot run, trust dialog shown |
| `"ask"` | Ask every time |
| `"allow-all"` | Allow edits only |
| `"bypass-all"` + reviewer on | Agent-verified (recommended) |
| `"bypass-all"` + reviewer off | Allow everything |

When `permissionMode` is `null` or undefined, the workspace is considered untrusted and the ProjectTrustToast dialog will be shown before the agent can operate.

**Tool Patterns** (managed by ClaudeSettingsManager):
- Uses Claude Code's native settings file format
- Compatible with Claude CLI (`claude` command)
- Settings are merged from multiple sources

#### Settings File Hierarchy

Settings are read and merged in this order (later files override earlier):

| File | Scope | Purpose |
|------|-------|---------|
| `~/.claude/settings.json` | User-level | Global defaults for all projects |
| `.claude/settings.json` | Project-shared | Team settings (commit to git) |
| `.claude/settings.local.json` | Project-personal | Your patterns (gitignored) |

When you approve a pattern with "Always in this project", it's saved to `.claude/settings.local.json`:

```json
{
  "permissions": {
    "allow": [
      "Bash(npm test:*)",
      "Bash(git commit:*)",
      "WebFetch(domain:api.github.com)"
    ],
    "deny": []
  },
  "additionalDirectories": [
    "/Users/dev/shared-config"
  ]
}
```

#### Pattern Format

Patterns use Claude Code SDK format:

| Tool | Pattern Format | Example |
|------|---------------|---------|
| Bash | `Bash(command:*)` | `Bash(npm test:*)` |
| Bash (git) | `Bash(git subcommand:*)` | `Bash(git commit:*)` |
| WebFetch | `WebFetch(domain:host)` | `WebFetch(domain:github.com)` |
| WebFetch (all) | `WebFetch` | Allows all domains |
| MCP tools | `mcp__server__tool` | `mcp__server__function_name` |

#### Session-Level Caching

In addition to file-based persistence, patterns are cached in memory:

- The `sessionApprovedPatterns` Set holds all patterns approved this session
- Patterns approved with "session" or "always" scope are added to this cache
- This prevents re-prompting for the same pattern within one app session
- The Claude SDK doesn't hot-reload settings files, so this cache is essential for "always" approvals to take effect immediately

## Integration with Claude Code SDK

The permission system integrates with the Claude Code SDK through two mechanisms:

### PreToolUse Hook

Returns empty object `{}` to let requests flow through to `canUseTool`. This allows the permission engine to evaluate all tool calls.

```typescript
// In ClaudeCodeProvider.ts
createPreToolUseHook() {
  return async (event) => {
    // Tag files for history before edits
    // ...
    // Return {} to continue to canUseTool
    return {};
  };
}
```

### canUseTool Callback

Called by the SDK when a tool needs permission. This is where the PermissionEngine evaluates the request:

```typescript
canUseTool: async ({ toolName, input }) => {
  const evaluation = permissionService.evaluateCommand(
    workspacePath,
    toolName,
    getToolDescription(toolName, input),
    sessionId
  );

  if (evaluation.overallDecision === 'allow') {
    return true;
  }
  if (evaluation.overallDecision === 'deny') {
    return false;
  }
  // 'ask' - show UI and wait for response
  return await showPermissionDialog(evaluation);
}
```

### Important: SDK Configuration

To ensure `canUseTool` is called, do NOT set `allowedTools: ['*']` in agent mode. This would bypass the permission flow entirely.

## UI Components

### ProjectTrustToast

Modal dialog shown when opening an untrusted project. User must choose a permission mode before the agent can operate.

**Features:**
- Clear explanation of trust implications
- Two options: "Smart Permissions" and "Always Allow"
- Highlights benefits of Smart Permissions (permanent patterns, fine-grained control)
- Link to advanced settings

### TrustIndicator

Small icon in the navigation gutter showing current trust status:

| Icon | Status |
| --- | --- |
| Shield with checkmark | Trusted, Ask mode |
| Plain shield | Trusted, Allow-all mode |
| Shield with question | Not trusted |

**Click actions:**
- Shows dropdown with current status
- "Change permission mode" - Reopens trust dialog
- "Permission settings" - Opens full settings panel

### ToolPermissionConfirmation

Inline dialog shown in the agent panel when a tool needs approval:

- Shows tool name and description
- Pattern to approve
- Options: "Just this time", "For this session", "Always in this project"
- Deny/Allow buttons

## Security Considerations

### Compound Command Protection

The Claude Agent SDK has a known limitation where bash pattern matching uses simple prefix matching. This means a pattern like `Bash(git status:*)` could potentially match a compound command like `git status && rm -rf /`.

**Our Mitigation:**

Nimbalyst's PreToolUse hook intercepts compound commands (those containing `&&`, `||`, or `;`) and checks each sub-command separately:

1. When you run `git status && git describe`, both commands are evaluated independently
2. If `git status` is allowed but `git describe` is not, you'll be prompted for `git describe`
3. Each sub-command approval is saved as its own pattern

**Pattern Validation:**

The `ClaudeSettingsManager.addAllowedTool()` method includes security validation:

- **Compound patterns blocked**: Patterns like `Bash:compound:*` are never saved to settings. These are one-time approvals that must be re-approved each session.
- **Garbage pattern filtering**: Invalid patterns that look like code fragments (e.g., `Bash(const:*)`, `Bash(//:*)`) are rejected. These can occur if Claude's output is incorrectly parsed as bash commands.

**Invalid pattern examples that are blocked:**
- `Bash(const:*)` - JavaScript keyword
- `Bash([]:*)` - Array syntax
- `Bash(//:*)` - Comment syntax
- `Bash(```:*)` - Code fence
- `Bash(}:*)` - Closing brace

### Path Validation

All file paths are validated against:
1. Workspace root directory
2. Additional allowed directories
3. Sensitive path blocklist (e.g., `~/.ssh`, `~/.aws`)

### Destructive Command Detection

Commands are analyzed for destructive patterns:
- `rm -rf`, `rm -r`
- File overwrite operations
- Database drop commands
- System modification commands

These are flagged with warnings even if the pattern is allowed.

### URL Validation

Web requests are checked against:
1. Allowed URL patterns
2. Blocked domains (if configured)

## Cross-Device Support

The permission system supports approval from mobile devices and cross-session workflows:

### How It Works

1. **Request Persistence**: Permission requests are stored as messages in the AgentMessagesRepository
2. **Polling Mechanism**: Mobile/remote clients poll for pending requests via `pollForPermissionResponse()`
3. **Response Messages**: Responses are also persisted as messages with a linking `requestId`
4. **Desktop Fast Path**: Desktop uses IPC for immediate response, with polling as fallback

### Message Types

```typescript
// Permission request stored in database
{
  type: 'permission_request',
  requestId: 'unique-id',
  toolName: 'Bash',
  pattern: 'Bash(npm test:*)',
  description: 'Run npm test',
  timestamp: 1703001234567
}

// Permission response stored in database
{
  type: 'permission_response',
  requestId: 'unique-id',  // Links to request
  decision: 'allow',
  scope: 'always',
  respondedBy: 'mobile',
  timestamp: 1703001234568
}
```

### Use Cases

- Approve tool calls from the mobile app while desktop is running
- Resume sessions across devices with pending permissions
- Review and respond to permissions asynchronously

## Testing

E2E tests are located in `packages/electron/e2e/permissions/`:

```bash
# Run permission tests
npx playwright test e2e/permissions/
```

Test coverage includes:
- Trust indicator visibility and states
- Permission mode switching
- Pattern allow/deny persistence
- Additional directory management
- URL pattern matching

## Future Enhancements

- [ ] Global permission presets (share settings across projects)
- [ ] Import/export permission configurations
- [ ] Permission audit log
- [ ] Time-limited approvals
- [ ] Team-shared permission policies
