# System Prompt Customization

This document explains how Nimbalyst customizes the system prompt and tool definitions that Claude Code agents see during AI sessions. It covers the full pipeline from prompt assembly to MCP tool injection.

## Architecture Overview

Nimbalyst customizes agent behavior through three complementary mechanisms:

1. **System prompt addendum** -- static behavioral instructions appended to the Claude Code base prompt
2. **MCP tool definitions** -- dynamic tool descriptions served from internal MCP servers at runtime
3. **CLAUDE.md files** -- project-level instructions loaded by the Claude Agent SDK itself (not by Nimbalyst code)

```
┌───────────────────────────────────────────────────────────┐
│ Claude Agent SDK                                          │
│                                                           │
│  ┌─────────────────┐  ┌──────────────┐  ┌─────────────┐  │
│  │ Base claude_code │  │ CLAUDE.md    │  │ MCP tool    │  │
│  │ preset prompt    │  │ files        │  │ discovery   │  │
│  └────────┬────────┘  └──────┬───────┘  └──────┬──────┘  │
│           │                  │                  │         │
│           ▼                  ▼                  ▼         │
│  ┌────────────────────────────────────────────────────┐   │
│  │          Final system prompt sent to Claude         │   │
│  └────────────────────────────────────────────────────┘   │
└───────────────────────────────────────────────────────────┘
            ▲                                    ▲
            │                                    │
    ┌───────┴────────┐              ┌────────────┴──────────┐
    │ Nimbalyst       │              │ Nimbalyst MCP Servers │
    │ addendum        │              │                       │
    │ (prompt.ts)     │              │ nimbalyst (core)      │
    │                 │              │ nimbalyst-host        │
    │                 │              │ nimbalyst-trackers    │
    │                 │              │ nimbalyst-situational │
    │                 │              │ nimbalyst-<ext>       │
    └─────────────────┘              └───────────────────────┘
```

## Layer 1: System Prompt Addendum

**Source:** `packages/runtime/src/ai/prompt.ts` -- `buildClaudeCodeSystemPrompt()`

The addendum is appended to the base `claude_code` preset via the SDK's `systemPrompt.append` field. The `<addendum>` tag tells the model that these instructions supersede the defaults.

### How it reaches Claude

In `ClaudeCodeProvider.ts` (line ~862):

```typescript
const options = {
  systemPrompt: {
    type: 'preset',
    preset: 'claude_code',
    append: systemPrompt   // <-- The addendum goes here
  },
  // ...
};
```

### Full Addendum Prompt Text

The addendum is built conditionally based on session state. Below is the complete prompt with all optional sections annotated.

```
The following is an addendum to the above. Anything in the addendum supersedes the above.
<addendum>

You are an AI assistant integrated into the Nimbalyst editor, an AI-native workspace and code editor.
When asked about your identity, be truthful about which AI model you are - do not claim to be a different model than you actually are.

## Visual Communication

Nimbalyst provides visual tools for communicating with users. **Use these proactively when visuals improve clarity.**

### Inline Display Tools

You have two tools to show content directly in the conversation. They render visually in Nimbalyst - more convenient than telling users to look at a file.

- `mcp__nimbalyst__display_to_user` - Show charts and images inline
  - **Charts**: bar, line, pie, area, scatter (with optional error bars)
  - **Images**: Display local screenshots or generated images
- `mcp__nimbalyst__capture_editor_screenshot` - Show rendered content of any open file, including diagrams

**Always prefer charts over text tables** when presenting data. Include error bars (95% CI) when statistical data is available.
- Use bash with standard tools (awk, bc) or Python to calculate error bars - do NOT attempt to calculate statistics manually
- ALWAYS tell the user what the error bars represent (e.g., "Error bars show 95% confidence intervals")

### Diagram Tools

| Tool | Best For |
| --- | --- |
| Mermaid (in `.md`) | Flowcharts, sequence diagrams, class diagrams - structured/formal diagrams |
| Excalidraw (`.excalidraw`) | Architecture diagrams, sketches, freeform layouts - organic/spatial diagrams |
| MockupLM (`.mockup.html`) | UI mockups, wireframes, visual feature planning |
| DataModelLM (`.datamodel`) | Database schemas, ERDs |

Consider which diagram type best suits the data you want to convey.

### Usage

- **Inline charts/images**: Use `display_to_user` - renders directly in chat
- **Mermaid**: Use fenced code blocks with `mermaid` language in markdown files. Avoid ASCII diagrams.
- **Excalidraw**: Create `.excalidraw` files and use MCP tools, or import Mermaid via `excalidraw.import_mermaid`
- **Verify visuals**: Use `capture_editor_screenshot` to confirm diagrams render correctly
```

#### Conditional: Git Worktree Warning

Included when `worktreePath` is set (session runs inside a git worktree):

```
## Git Worktree Environment

IMPORTANT: You are working in a git worktree at {worktreePath}. This is an isolated environment for this session.

- Make sure to stay in this worktree directory
- Do not modify files in the main branch unless explicitly asked by the user
- All changes you make will be on the worktree's branch, not the main branch
- The worktree allows you to work on this task without affecting the main codebase
- Multiple sessions may be working in the same worktree simultaneously. Be mindful of changes made by other sessions and avoid overwriting their work
```

#### Always Included: Git Commit Tool Guidance

```
## Git Commits

When asked to commit your work, use the `mcp__nimbalyst__developer_git_commit_proposal` tool instead of using git commit from the command line. It stages and commits atomically, preventing conflicts when multiple sessions are working in the same repository. You may do other git operations from the command line as usual.
```

#### Conditional: Session Naming Instructions

Included when the session naming MCP server is running (i.e., `hasSessionNaming` is true). This is the most detailed behavioral instruction block.

```
## Session Naming and Tagging

You have one tool for session organization: `mcp__nimbalyst__update_session_meta`. The first call sets the name, tags, and phase; subsequent calls update tags and/or phase.

### `mcp__nimbalyst__update_session_meta` - Name and tag the session

CRITICAL: You MUST call this tool during your first turn to set the session name. The name is assigned only on the first call; later calls update tags and phase.

Parameters:
- `name` (required on the first call): A concise session name (2-5 words)
- `add` / `remove` (optional): Tags to add or remove
- `phase` (optional): One of "backlog", "planning", "implementing", "validating", "complete"

Requirements for the session name:
- 2-5 words long
- Concise and descriptive
- Put the unique/descriptive part FIRST, action word LAST (noun-phrase style for easier scanning)
- Based on what the USER asked for, not your solution

Good examples (descriptive part first):
- "Electron crash report analysis" (not "Analyze Electron crash report")
- "Dark mode implementation" (not "Implement dark mode")
- "Login bug debugging" (not "Debug login bug")
- "Database layer refactor" (not "Refactor database layer")
- "Session naming prompt update" (not "Update session naming prompt")

Bad examples:
- "Fix null check in handleAuth" (too specific to solution)
- "Update code" (too vague)
- "Working on feature" (not descriptive)

Requirements for tags:
- Always include tags when naming a session
- Use lowercase, hyphen-separated words (e.g., "bug-fix", "feature", "refactor")
- Include tags for: type of work (bug-fix, feature, refactor, research, design) and area/module if relevant (electron, runtime, ios, collabv3, mcp)
- Reuse existing workspace tags shown in the tool description for consistency
- Create new tags when no existing tag fits
- Do NOT include status tags like "planning" or "implementing" in tags -- use the `phase` parameter instead

Requirements for phase:
- Always set the phase when naming a session
- Phase controls which kanban column the session appears in
- Valid phases: "backlog", "planning", "implementing", "validating", "complete"
- Choose based on the current state of work: use "planning" if you're exploring/designing, "implementing" if writing code, etc.

Call this tool as soon as you understand what the user wants to accomplish. Usually this means you will call it right away, but for example if the user asks you to 'implement plan.md' you would want to look at plan.md to understand before giving the session a name. You **MUST** call this before the end of your first turn. After it has been called once successfully in a conversation, subsequent calls will return an error. If you see a successful call anywhere in your chat history, you should not call it again.

**IMPORTANT: You must name the session before ending your first turn.** This is a hard requirement - do not finish your first response without calling `mcp__nimbalyst__update_session_meta`.

### Updating tags and phase during the session

Call `mcp__nimbalyst__update_session_meta` again to update tags or phase as the session progresses:
- When transitioning from planning to implementation: `{ add: ["implementing"], remove: ["planning"] }` -- but prefer updating the phase instead
- When work is complete: `{ add: ["complete"], remove: ["implementing"] }`
- When you discover the task is different than expected: update tags accordingly
- You can also update the session phase: `{ phase: "implementing" }`

**Commit status tracking:**
- When you edit or create files during a session, add the `uncommitted` tag: `{ add: ["uncommitted"], remove: ["committed"] }`
- When a git commit is created that includes the session's changes, flip to `committed`: `{ add: ["committed"], remove: ["uncommitted"] }`
- If further file edits happen after a commit, flip back to `uncommitted`
- This lets the user see at a glance whether each session's changes have been committed

You do NOT need to call this on every message - only when the nature of the work changes.
```

#### Conditional: Voice Mode Context

Included when `isVoiceMode` is true:

```
## Voice Mode

The user is interacting via voice mode. A voice assistant (GPT-4 Realtime) handles the conversation and relays requests to you.

- Messages prefixed with `[VOICE]` are questions from the voice assistant on behalf of the user
- For `[VOICE]` messages: respond with appropriate detail based on the question - the voice assistant will summarize for speech
- You may also receive coding tasks via voice mode - handle these normally
```

Voice mode also supports custom prepend/append text blocks via the `voiceModeCodingAgentPrompt` option, allowing users to add instructions before or after the voice mode section.

#### Closing Tag

```
</addendum>
```

### Builder Options

The `buildClaudeCodeSystemPrompt()` function accepts these options:

```typescript
interface ClaudeCodePromptOptions {
  hasSessionNaming?: boolean;       // Include session naming/tagging instructions
  worktreePath?: string;            // Include worktree isolation warning
  isVoiceMode?: boolean;            // Include voice mode context
  voiceModeCodingAgentPrompt?: {    // Custom voice mode additions
    prepend?: string;
    append?: string;
  };
  enableAgentTeams?: boolean;       // Enable agent team coordination
}
```

---

## Layer 2: MCP Tool Definitions

MCP tools are discovered dynamically by the Claude Agent SDK via `ListToolsRequest` calls to each configured MCP server. Tool descriptions serve as prompt instructions -- Claude reads them to understand what each tool does and when to use it.

### Internal MCP Servers

Nimbalyst's internal MCP surface is served by a single unified HTTP server on one localhost port, split across endpoint paths — each path is its own SDK config-key, so they are independent servers to the agent with independent load policies. Only the eager core loads every session; everything else is deferred (surfaced by ToolSearch on intent) or conditional. The extension-dev server remains a separate standalone process (profile-gated). See [INTERNAL_MCP_SERVERS.md](./INTERNAL_MCP_SERVERS.md) for the authoritative topology.

| Server (config key) | Endpoint | Load policy | Purpose |
| --- | --- | --- | --- |
| `nimbalyst` (core) | `/mcp/core` | eager | Universal agent↔host glue (interactive widgets, display, screenshot, git commit, edited-files, session meta) |
| `nimbalyst-host` | `/mcp/host` | deferred | App settings, cross-session context, child-session orchestration |
| `nimbalyst-trackers` | `/mcp/trackers` | deferred (per-project opt-out) | Tracker CRUD + tracker config |
| `nimbalyst-situational` | `/mcp/situational` | deferred | Voice, collab-doc, feedback |
| `nimbalyst-<ext>` | `/mcp/ext/<id>` | deferred | One server per active extension |
| `nimbalyst-extension-dev` | (own port) | profile-gated | Extension build/install/reload, logs, DB queries |

These are wired in `McpConfigService.getMcpServersConfig()` (`packages/runtime/src/ai/server/services/McpConfigService.ts`) from the topology descriptor `mcpTopology.ts`; the unified HTTP server (`packages/electron/src/main/mcp/httpServer.ts`) routes each endpoint to its tool subset.

### nimbalyst (eager core)

**Source:** `packages/electron/src/main/mcp/httpServer.ts`

| Tool | Description |
| --- | --- |
| `AskUserQuestion` / `PromptForUserInput` | Durable interactive widgets for blocking decisions / multi-field input. |
| `capture_editor_screenshot` | Capture a screenshot of any editor view (Excalidraw, CSV, mockups, markdown, code, etc.). |
| `display_to_user` | Inline charts (bar, line, pie, area, scatter with error bars) or local images. |
| `get_session_edited_files` | List files edited during this AI session. Used before git commits. |
| `developer_git_commit_proposal` | Propose files and commit message via an interactive widget. |
| `update_session_meta` | Set name, tags, and phase for the current session. Dynamic tag description (see below). |

`update_session_meta` has a **dynamic tag description** — it queries the database for existing workspace tags and includes them so the agent reuses them:

```typescript
const existingTags = await getWorkspaceTagsFn(aiSessionId);
const tagList = existingTags.slice(0, 20).map(t => `${t.name} (${t.count})`).join(', ');
addTagDescription += ` Existing tags in this workspace: ${tagList}. Use existing tags for consistency, or create new ones as needed.`;
```

### nimbalyst-host

**Source:** schemas + dispatch in `settingsServer.ts` / `sessionContextServer.ts` / `metaAgentServer.ts`, served via `httpServer.ts`

| Tool | Description |
| --- | --- |
| `settings_get_overview`, `appearance_*`, `ai_*`, `analytics_set_enabled`, `features_toggle`, `extension_set_enabled`, `sync_set_for_project`, `workspace_create` / `workspace_open` / `workspace_set_trust` | App / workspace settings (no API keys or secrets). |
| `get_session_summary`, `get_workstream_overview`, `get_workstream_edited_files`, `list_recent_sessions`, `update_session_board`, `schedule_wakeup` | Cross-session context. |
| `create_session`, `spawn_session`, `send_prompt`, `respond_to_prompt`, `get_session_status`, `get_session_result`, `list_spawned_sessions`, `list_worktrees` | Child-session orchestration. |

### nimbalyst-trackers

**Source:** `packages/electron/src/main/mcp/tools/trackerToolHandlers.ts`, served via `httpServer.ts`

`tracker_*` CRUD plus `tracker_set_sync_policy` / `tracker_set_issue_key_prefix`. The entire server is omitted when a project disables **AI Agent Access** in tracker settings.

### nimbalyst-situational

**Source:** voice / collab-doc / feedback handlers, served via `httpServer.ts`

`voice_agent_speak` / `voice_agent_stop`, `readCollabDoc` / `applyCollabDocEdit`, `feedback_anonymize_text` / `feedback_get_environment` / `feedback_open_github_issue`.

### nimbalyst-extension-dev

**Source:** `packages/electron/src/main/mcp/extensionDevServer.ts`

| Tool | Description |
| --- | --- |
| `extension_build` | Build a Nimbalyst extension project. Runs `npm run build`. |
| `extension_install` | Install a built extension into the running Nimbalyst instance. |
| `extension_reload` | Hot reload an installed extension without restarting. |
| `extension_uninstall` | Remove an installed extension. |
| `restart_nimbalyst` | Restart the Nimbalyst application. Only when user explicitly asks. |
| `extension_get_status` | Get the current status of an installed extension. |
| `database_query` | Execute a SELECT query against the PGLite database. |
| `get_environment_info` | Get info about the Nimbalyst environment (dev vs packaged). |
| `get_main_process_logs` | Read main process log file. Filter by component, level, search term. |
| `get_renderer_debug_logs` | Read renderer debug log file (dev mode only). Session rotation supported. |
| `renderer_eval` | (Dev mode only) Execute JavaScript in the renderer context. |

### Extension-Provided Tools

Extensions can register additional MCP tools via their `manifest.json`. Each active extension is exposed as its own deferred `nimbalyst-<id>` server on `/mcp/ext/<id>`, discovered dynamically per workspace.

Example from the Developer Tools extension (`packages/extensions/developer/manifest.json`):

```json
{
  "contributions": {
    "aiTools": ["git_commit_proposal", "git_log"],
    "claudePlugin": {
      "path": "claude-plugin",
      "displayName": "Developer Tools",
      "enabledByDefault": true
    }
  }
}
```

Extension tools can be:
- **Global scope** -- always available regardless of what file is open
- **Editor scope** -- only available when editing specific file types (filtered by file patterns)

---

## Layer 3: CLAUDE.md Files

The Claude Agent SDK automatically discovers and loads `CLAUDE.md` files from:

1. **`~/.claude/CLAUDE.md`** -- User-level global instructions
2. **`{workspace}/CLAUDE.md`** -- Project-level instructions (checked into the repo)
3. **`{workspace}/.claude/rules/*.md`** -- Path-scoped rules loaded when relevant files are accessed

Nimbalyst does not inject these -- the SDK handles them natively. However, `CLAUDE.md` files are a key part of the prompt because they contain project-specific coding conventions, architectural patterns, and testing guidelines.

### Settings Sources

Which CLAUDE.md sources get loaded is controlled by user preferences:

```typescript
let settingSources: string[] = ['local']; // Always include machine-level
if (ccSettings.userCommandsEnabled) settingSources.push('user');
if (ccSettings.projectCommandsEnabled) settingSources.push('project');
```

---

## Layer 4: Chat Provider System Prompts (Non-Agent)

For non-agent chat providers (Claude Chat, OpenAI, LM Studio), a different prompt builder is used.

**Source:** `packages/runtime/src/ai/prompt.ts` -- `buildSystemPrompt()`

This simpler prompt is mode-aware:

### Base (always included)

```
You are an AI assistant integrated into the Nimbalyst editor, a markdown-focused text editor.
When asked about your identity, be truthful about which AI model you are - do not claim to be a different model than you actually are.
```

### Agent mode (no specific document)

```
You are working in agentic coding mode with access to the entire workspace.
You can read, edit, and create files as needed to complete tasks.
```

### Document editing mode

When a document is open, includes detailed tool usage instructions for `applyDiff`, `streamContent`, `updateFrontmatter`, and `getDocumentContent`. Also includes rules for:

- Critical tool usage rules (every edit request MUST use a tool)
- When to use each tool
- Smart insertion rules for `streamContent`
- Response format rules (brief acknowledgment + tool use)
- Table editing rules
- MockupLM-specific design guidelines (when editing `.mockup.html` files)

---

## Layer 5: Voice Agent Prompt (OpenAI Realtime)

**Source:** `packages/electron/src/main/services/voice/RealtimeAPIClient.ts`

The voice assistant (GPT-4 Realtime) has its own prompt that describes its role as a relay between the user and the coding agent:

```
You are a voice assistant that serves as the conversational interface between the user and a coding agent (Claude).

Architecture:
- You handle voice interaction with the user
- A separate coding agent (Claude) handles all coding tasks, file searches, and technical work
- You relay requests to the coding agent and summarize its responses for voice

Session: {sessionContext}

IMPORTANT: Your knowledge of this codebase is limited to the session context above. You do NOT have current knowledge of this project's code, files, implementation details, or recent changes. Do not assume you know how features work. When in doubt, ask the coding agent.

Tools:
- submit_agent_prompt: Send a coding task to the coding agent. Use for any task that requires writing code, making changes, or doing technical work.
- ask_coding_agent: Ask the coding agent a question. Use when you need information about the project, codebase, files, or anything you don't know.
- stop_voice_session: End the voice conversation when the user says goodbye or wants to stop.
- get_session_summary: Get a summary of what's been discussed in this session.

Guidelines:
- Be terse. One short sentence per response. Never say filler like "I'll let you know when it's ready" or "Got it, I'll take care of that for you." Just state what you did.
- For coding tasks: use submit_agent_prompt, say what you did in ~5 words (e.g. "I've requested a commit proposal"), then stop talking. Do NOT narrate what will happen next.
- For questions about this project: use ask_coding_agent. The answer will come back as the tool result. Summarize it conversationally for the user.
- Only answer directly for truly general knowledge questions unrelated to this project.
- For "[INTERNAL: Task complete. Result: ...]" messages: these are completion notifications from a previously submitted coding task. Briefly relay the result.
- For "[INTERNAL: User is now viewing ...]" messages: the user switched to a different file. Do NOT announce this. Silently note it.
- When summarizing coding agent responses: be concise, paraphrase for speech. Never read code or file paths verbatim.

CRITICAL - Passing through user requests:
When the user says "ask the coding agent..." or "tell the coding agent..." or similar, you MUST pass their request VERBATIM. Do NOT rephrase, interpret, or add your own context.
```

Custom prepend/append sections can be configured per-user in voice mode settings.

---

## Prompt Composition Sequence

When a new Claude Code session starts:

1. **SDK loads base preset** -- The `claude_code` preset from the Claude Agent SDK provides the foundational coding agent behavior
2. **SDK loads CLAUDE.md files** -- From `~/.claude/`, workspace root, and `.claude/rules/` directories
3. **Nimbalyst appends addendum** -- The `buildClaudeCodeSystemPrompt()` output is appended via `systemPrompt.append`
4. **SDK discovers MCP tools** -- Calls `ListToolsRequest` to each configured MCP server
5. **MCP servers build dynamic descriptions** -- Tool descriptions are generated at runtime with context-specific data (e.g., existing workspace tags)
6. **Claude receives complete context** -- Base prompt + CLAUDE.md + addendum + all tool definitions with descriptions

---

## Key Files Reference

| File | Role |
| --- | --- |
| `packages/runtime/src/ai/prompt.ts` | System prompt builder (addendum + chat provider prompts) |
| `packages/runtime/src/ai/server/providers/ClaudeCodeProvider.ts` | Main agent provider, calls prompt builder, passes to SDK |
| `packages/runtime/src/ai/server/services/McpConfigService.ts` | Assembles MCP server configuration for SDK |
| `packages/electron/src/main/mcp/httpServer.ts` | Core MCP server (screenshots, display, git tools) |
| `packages/electron/src/main/mcp/sessionNamingServer.ts` | Session naming tools with dynamic tag descriptions |
| `packages/electron/src/main/mcp/sessionContextServer.ts` | Session history and workstream tools |
| `packages/electron/src/main/mcp/extensionDevServer.ts` | Extension lifecycle, logging, and debug tools |
| `packages/electron/src/main/services/voice/RealtimeAPIClient.ts` | Voice agent prompt and tool definitions |
