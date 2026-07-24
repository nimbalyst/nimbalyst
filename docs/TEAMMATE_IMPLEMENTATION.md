# Teammate System Implementation

This document describes the managed teammate system implemented on this branch. It covers what the Claude Agent SDK provides natively, what Nimbalyst replicates or extends, and how the pieces fit together.

## Architecture Overview

The teammate system allows Claude Code's lead agent to spawn sub-agents ("teammates") that run concurrently, communicate via messages, and appear in the Nimbalyst UI. The implementation spans three layers:

```
ClaudeCodeProvider (orchestrator)
  -> TeammateManager (lifecycle, messaging, config)
       -> Claude Agent SDK query() (actual agent execution)

Renderer UI
  -> sessionTeammatesAtom (derived from session metadata)
       -> TeammatePanel (sidebar display)
```

## What the Claude Agent SDK Provides

The SDK (`@anthropic-ai/claude-agent-sdk`) provides the following primitives that the teammate system uses:

### `query()` - Agent session execution
The core SDK function that spawns a Claude Code session. Each teammate is a `query()` call with its own prompt, model, cwd, and abort controller. The SDK handles:
- Tool execution (Read, Write, Edit, Bash, Grep, Glob, etc.)
- Permission checking via `canUseTool` callback and `permissionMode`
- Model selection and API communication
- Session persistence (`persistSession: true`) for later resume
- Streaming output as an async iterable of typed chunks (`assistant`, `user`, `result`)

### `Query` object - Stream control
The `query()` return value is an async iterable with a `.streamInput()` method. The SDK provides:
- **`streamInput(messages)`** - Inject new user messages into a running session. Used to deliver messages and shutdown requests to running teammates.
- **Session resumption** via the `resume` option, passing a previously captured `session_id` to continue where a session left off.

### `SDKUserMessage` type
The SDK's message format for injecting user messages into a running query stream:
```ts
{ type: 'user', message: { role: 'user', content: string }, parent_tool_use_id: null }
```

### SDK environment variables for team context
The SDK recognizes these env vars for its built-in team tools (TeamCreate, TeamDelete, TaskCreate, TaskList, TaskUpdate, SendMessage):
- `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` - Feature flag to enable team tools
- `CLAUDE_CODE_ENABLE_TASKS` - Enable task management tools (disabled by default in non-interactive SDK sessions)
- `CLAUDE_CODE_TEAM_NAME` / `CLAUDE_CODE_TASK_LIST_ID` - Team context
- `CLAUDE_CODE_AGENT_ID` / `CLAUDE_CODE_AGENT_NAME` / `CLAUDE_CODE_AGENT_TYPE` - Agent identity

### SDK's `extraArgs` for agent metadata
The SDK accepts an `extraArgs` option that passes agent identity metadata (`agent-id`, `agent-name`, `team-name`, `agent-color`, `agent-type`) into the spawned session.

### SDK `hooks` system
The SDK supports `PreToolUse` and `PostToolUse` hooks that run before/after every tool call. Nimbalyst uses these to intercept specific tool calls (Task spawns, SendMessage) before the SDK processes them.

### SDK-handled tools (pass-through)
These tools are fully handled by the SDK with no Nimbalyst intervention:
- **TeamCreate** / **TeamDelete** - Create/destroy team directories at `~/.claude/teams/{name}/`
- **TaskCreate** / **TaskList** / **TaskUpdate** - File-based task management at `~/.claude/tasks/{name}/`
- **SendMessage** (for completed teammates) - Falls through to SDK's native file-based inbox system

## What Nimbalyst Builds on Top

### 1. Tool Call Interception (PreToolUse hook)

**Why:** The SDK's native `Task` tool spawns a subprocess-based agent. Nimbalyst needs teammates to run as in-process `query()` calls so it can: log their output to the session transcript, deliver messages via `streamInput()`, and track their lifecycle.

**How:** The `createPreToolUseHook()` in ClaudeCodeProvider delegates to `TeammateManager.handlePreToolUse()`, which intercepts two tool calls:

- **`Task`**** with \****`team_name`***\* + \****`name`** - Instead of letting the SDK spawn a subprocess, TeammateManager denies the SDK tool call and spawns an in-process `query()`. The deny message tells the lead agent the teammate is running and not to retry.
- **`SendMessage`**** with a \****`recipient`** - Routes messages to running or idle teammates via `streamInput()` or session resume, rather than the SDK's file-based inbox.

The "deny SDK + log synthetic pair" pattern:
1. Return a PreToolUse `deny` decision so the SDK doesn't execute the tool
2. Log a synthetic `tool_use` + `tool_result` pair to the session transcript so the UI shows the tool call happened
3. Perform the actual operation (spawn teammate, deliver message) in-process

### 2. Teammate Lifecycle Management

**TeammateManager** (`TeammateManager.ts`, ~1,680 lines) manages three states:

| State | Storage | Meaning |
| --- | --- | --- |
| **Running** | `managedTeammates: Map<string, ManagedTeammate>` | Active `query()` stream, can receive `streamInput()` |
| **Idle** | `idleTeammates: Map<string, IdleTeammate>` | Stream completed but session persisted; can be resumed |
| **Completed** | `completedTeammates: Set<string>` | Shut down or errored; capped at 100 entries |

Agent IDs use the format `{name}@{teamName}` (e.g., `researcher@my-project`).

**Spawn flow:**
1. Lead agent calls `Task` with `team_name` and `name`
2. PreToolUse hook intercepts, denies SDK execution
3. `spawnManagedTeammate()` registers a placeholder in the map, then calls `streamTeammateOutput()`
4. `streamTeammateOutput()` calls `query()` with the teammate's prompt, model, hooks, and env vars
5. Each chunk is logged to the lead's session transcript with `_isTeammateOutput: true` tags
6. On stream completion: teammate moves to idle (if session ID captured) or completed (if shutdown approved)

**Resume flow (idle -> running):**
1. Lead sends a message to an idle teammate via `SendMessage`
2. `handlePreToolUse()` finds the teammate in `idleTeammates`
3. `resumeIdleTeammate()` calls `streamTeammateOutput()` with `resumeSessionId`
4. SDK resumes the persisted session with the new message as input

**Shutdown flow:**
1. Lead calls `SendMessage` with `type: "shutdown_request"`
2. TeammateManager builds a shutdown prompt and delivers it via `streamInput()` (running) or resume (idle)
3. Teammate's Claude instance processes the request and calls `SendMessage` with `type: "shutdown_response", approve: true`
4. TeammateManager detects the approval in the stream output and marks the teammate as completed
5. Teammate is removed from the team config file

### 3. Message Delivery System

**Why:** The SDK's native SendMessage writes to file-based inboxes (`~/.claude/teams/{team}/inboxes/{name}.json`). This doesn't work for in-process teammates that need real-time message injection.

**Nimbalyst's approach uses a multi-strategy delivery system:**

**Lead -> Teammate (running):**
1. Queue the message in `pendingLeadMessages`
2. Attempt delivery via `query.streamInput()` (real-time injection into the running stream)
3. If streamInput fails, fall back to file-based inbox append with file locking
4. Messages are flushed on every chunk from the teammate's stream (opportunistic delivery)

**Lead -> Teammate (idle):**
1. Resume the idle teammate's session with the message content as the new prompt

**Teammate -> Lead:**
1. TeammateManager watches the teammate's output stream for `SendMessage` tool calls targeting `team-lead`
2. When detected, `deliverMessageToLead()` logs a `teammate_message_to_lead` chunk to the session and emits a `teammate:messageToLead` event

**File-based inbox (fallback):**
- Uses `withSimpleFileLock()` for atomic writes (exclusive file lock with retry)
- Atomic file writes via temp file + rename pattern
- Used when `streamInput()` is unavailable or fails

### 4. Team Config File Management

**Why:** The SDK's TeamCreate tool creates `~/.claude/teams/{name}/config.json` with the lead agent's entry. Nimbalyst needs to register in-process teammates in this config so the SDK's built-in tools (like `SendMessage` for completed teammates) can discover them.

**Nimbalyst manages:**
- `updateTeamConfig()` - Adds a teammate member entry with `backendType: 'in-process'`
- `removeTeammateFromConfig()` - Removes the entry on shutdown/error (atomic write via temp+rename)
- Inbox directory creation (`~/.claude/teams/{name}/inboxes/`)
- Team context resolution across sessions (tracked teammates -> session metadata -> filesystem scan)

### 5. Team Context Persistence

**Why:** The SDK spawns a new `query()` process for each user message turn. Team context (which team is active) must survive across turns.

**Resolution strategy** (`resolveTeamContext()`):
1. Check in-memory `currentTeamContext` (set when TeamCreate result is processed)
2. Check tracked teammate maps for consistent team names
3. Check session metadata (`currentTeammates` array persisted in DB)
4. Scan `~/.claude/teams/` directories as last resort

**Context tracking from tool results:**
- `updateTeamContextFromToolResult()` watches for TeamCreate/TeamDelete results and updates `currentTeamContext`
- `processTeammateToolResult()` in ClaudeCodeProvider detects shutdown_request results for SDK-handled SendMessage calls

The lead agent's env vars (`CLAUDE_CODE_TEAM_NAME`, `CLAUDE_CODE_AGENT_ID`, etc.) are set on every `query()` call based on the resolved team context.

### 6. UI Integration

**Session metadata persistence:**
- `emitTeammateUpdate()` writes the `currentTeammates` array to the session's metadata in PGLite
- Debounced at 100ms via `scheduleEmitTeammateUpdate()` to batch rapid lifecycle transitions
- Each entry contains: `name`, `agentId`, `teamName`, `agentType`, `status`, `model`

**Jotai atoms** (`packages/electron/src/renderer/store/atoms/agentMode.ts`):
- `sessionTeammatesAtom(sessionId)` - atomFamily that derives teammate list from session metadata
- `teammatePanelCollapsedAtom` - Collapse state for the teammate panel
- `toggleTeammatePanelCollapsedAtom` - Action atom for toggling

**TeammatePanel** (`packages/electron/src/renderer/components/AgentMode/TeammatePanel.tsx`):
- Collapsible sidebar panel showing teammates with status indicators
- Color-coded status: green pulse (running), blue (idle), muted (completed/errored)
- Shows running/total count in header

**Transcript integration:**
- Teammate output chunks are tagged with `_isTeammateOutput: true` and `_teammateAgentId`
- Synthetic tool pairs logged for intercepted Task/SendMessage calls appear as normal tool calls in the transcript
- Teammate-to-lead messages logged as `teammate_message_to_lead` message type

### 7. System Prompt Additions

When `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` is enabled, the system prompt (`packages/runtime/src/ai/prompt.ts`) includes instructions explaining the "deny = success" pattern:
- Task spawn returns an "error" status even though it succeeds (because we deny the SDK tool call)
- Teammates must be spawned sequentially, not in parallel (parallel denies cancel siblings)
- Do not retry spawn calls

### 8. Security

**Input sanitization:**
- `sanitizeName()` validates team/teammate names: alphanumeric + hyphens/underscores only, max 100 chars, no path traversal (`..`, `/`, ``)
- Applied at every boundary: spawn, config update, inbox paths, message routing

**Teammate permissions:**
- Teammates run with `permissionMode: 'bypassPermissions'` and `canUseTool` always returning `allow`
- PreToolUse/PostToolUse hooks from the lead session are applied to teammate sessions (file tracking, snapshot creation)
- Lead agent's abort signal propagates to all teammate abort controllers

**Teammate session isolation from lead interception:**
- The `isTeammateSession` context flag prevents teammates from intercepting their own Task/SendMessage calls through the PreToolUse hook (only the lead's hook does interception)

## Summary: SDK vs Custom

| Capability | Provided by SDK | Built by Nimbalyst |
| --- | --- | --- |
| Agent execution (`query()`) | Yes | - |
| Tool execution (Read, Write, etc.) | Yes | - |
| Stream output (async iterable) | Yes | - |
| Message injection (`streamInput()`) | Yes | - |
| Session persistence + resume | Yes | - |
| TeamCreate/TeamDelete tools | Yes | - |
| TaskCreate/TaskList/TaskUpdate tools | Yes | - |
| Team env vars + identity | Yes | - |
| PreToolUse/PostToolUse hooks | Yes | - |
| SendMessage (file-based inbox) | Yes | - |
| In-process teammate spawning | - | Yes (intercept Task, call query()) |
| Real-time message delivery | - | Yes (streamInput + queue + fallback) |
| Teammate lifecycle state machine | - | Yes (running/idle/completed) |
| Resume-on-message for idle teammates | - | Yes (resume with message as prompt) |
| Session transcript logging | - | Yes (tagged chunks + synthetic pairs) |
| Team config registration | - | Yes (add/remove in-process members) |
| Team context persistence across turns | - | Yes (multi-source resolution) |
| UI teammate panel | - | Yes (Jotai atoms + React component) |
| Debounced status updates to DB | - | Yes (100ms batching) |
| System prompt team instructions | - | Yes (spawn behavior guidance) |
| Shutdown request/response protocol | - | Yes (prompt injection + stream detection) |
| File-locked inbox fallback | - | Yes (exclusive lock + atomic write) |
| Lead abort signal propagation | - | Yes (addEventListener on lead signal) |

## Files Changed

| File | Lines | Purpose |
| --- | --- | --- |
| `packages/runtime/src/ai/server/providers/TeammateManager.ts` | +1,683 | New file: all teammate management |
| `packages/runtime/src/ai/server/providers/ClaudeCodeProvider.ts` | +200/-32 | Delegation to TeammateManager, env setup, hook wiring |
| `packages/electron/src/renderer/components/AgentMode/TeammatePanel.tsx` | +131 | New file: teammate sidebar UI |
| `packages/electron/src/renderer/store/atoms/agentMode.ts` | +40/-2 | Teammate atoms + panel collapse state |
| `packages/runtime/src/ai/prompt.ts` | +19 | System prompt team instructions |
| `packages/runtime/src/ai/server/SessionManager.ts` | +41 | Session-level teammate support |
| `packages/runtime/src/ai/server/types.ts` | +2 | Type additions |
| `packages/electron/src/renderer/components/AgentMode/FilesEditedSidebar.tsx` | +6 | TeammatePanel integration |
