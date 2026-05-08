---
planStatus:
  planId: plan-agent-provider-architecture
  title: Agentic Provider Architecture
  status: draft
  planType: system-design
  priority: medium
  owner: ghinkle
  stakeholders:
    - ghinkle
  tags:
    - ai
    - agents
    - architecture
    - reference
  created: "2026-04-25"
  updated: "2026-04-25T00:00:00.000Z"
  progress: 0
---
# Agentic Provider Architecture

This document is a reference for implementing a new **agent provider** in Nimbalyst. It is the architectural counterpart to `docs/AI_PROVIDER_TYPES.md` (which is end-user / product oriented) and walks through every seam a new agent has to fit through: session start and resume, prompt handling, transcript output, tool calling, MCP configuration, and file-edit tracking.

A companion document, [`agent-providers-as-extensions.md`](./agent-providers-as-extensions.md), explores how the same surfaces could one day be exposed to extensions.

## 1. Two-layer abstraction

Nimbalyst splits an agent into **two stacked interfaces**, not one. New providers fill in both.

| Layer | File | Lifetime | Purpose |
| --- | --- | --- | --- |
| `AIProvider` | `packages/runtime/src/ai/server/AIProvider.ts:47` | One per `(provider type, sessionId)`, cached in `ProviderFactory` | High-level provider, owns config/system prompt/auth, drives the session, writes raw messages, emits stream chunks |
| `AgentProtocol` | `packages/runtime/src/ai/server/protocols/ProtocolInterface.ts:187` | One per provider instance (or shared singleton) | Transport adapter — speaks the SDK / wire protocol of the underlying agent and yields normalized `ProtocolEvent`s |

The split exists so that a provider can stay stable across SDK upgrades and so that protocol adapters are unit-testable without dragging in DB, IPC, or auth. **Chat providers** (`ClaudeProvider`, `OpenAIProvider`, `LMStudioProvider`) skip the protocol layer entirely — they call vendor APIs directly inside `sendMessage`. **Agent providers** (`ClaudeCodeProvider`, `OpenAICodexProvider`, `CopilotCLIProvider`, `OpenCodeProvider`) implement `AIProvider` and delegate transport to a corresponding `AgentProtocol`.

## 2. The `AgentProtocol` contract

Verbatim from `ProtocolInterface.ts`:

```ts
interface AgentProtocol {
  readonly platform: string;
  createSession(options: SessionOptions): Promise<ProtocolSession>;
  resumeSession(sessionId: string, options: SessionOptions): Promise<ProtocolSession>;
  forkSession(sessionId: string, options: SessionOptions): Promise<ProtocolSession>;
  sendMessage(session: ProtocolSession, message: ProtocolMessage): AsyncIterable<ProtocolEvent>;
  abortSession(session: ProtocolSession): void;
  cleanupSession(session: ProtocolSession): void;
}
```

Inputs:

- `SessionOptions`: `workspacePath`, `model`, `systemPrompt`, `abortSignal`, `permissionMode`, `mcpServers`, `env`, `allowedTools`, `disallowedTools`, plus a `raw` escape hatch for platform-specific knobs.
- `ProtocolMessage`: `content` (text), `attachments` (image / pdf), `sessionId` (for logging), `mode` (`'planning' | 'agent'`).

Output is a unified `ProtocolEvent` stream. Event types:

```ts
type ProtocolEventType =
  | 'raw_event' | 'text' | 'reasoning'
  | 'tool_call' | 'tool_result'
  | 'error' | 'complete' | 'usage'
  | 'planning_mode_entered' | 'planning_mode_exited';
```

A new agent's only job at this layer is: **translate its native event stream into this normalized event vocabulary**, and capture the platform-native session ID into `session.id` as soon as the underlying SDK reveals it.

### 2.1 The four reference adapters

The four shipping protocols deliberately use different transports — together they exercise every transport family we've considered.

| Adapter | File | Transport | Native session unit | Forking |
| --- | --- | --- | --- | --- |
| `ClaudeSDKProtocol` | `protocols/ClaudeSDKProtocol.ts:48` | In-process function call to `query()` from `@anthropic-ai/claude-agent-sdk` | Session is implicit — created by first `query()`, ID arrives in stream | Native (`forkSession: true`) |
| `CodexSDKProtocol` | `protocols/CodexSDKProtocol.ts:44` | In-process SDK from `@openai/codex-sdk` that spawns a native binary subprocess (`asarUnpack`'d in packaged builds) | Thread, `client.startThread()` | Not supported — degrades to new thread |
| `CopilotACPProtocol` | `protocols/CopilotACPProtocol.ts:59` | Long-lived subprocess `copilot --acp --stdio` over JSON-RPC framed by readline | ACP `session/new` returns ID | Not supported |
| `OpenCodeSDKProtocol` | `protocols/OpenCodeSDKProtocol.ts:44` | Reference-counted subprocess server, communicated with via HTTP + Server-Sent Events | Server-managed `session.create` | Not supported |

The shape is consistent regardless of transport: the adapter wraps process / socket / function-call lifecycle and yields `ProtocolEvent`s.

## 3. Session lifecycle

### 3.1 Where session state lives

Two stores, two scopes:

- **Database (`ai_sessions` table)** — durable. One row per Nimbalyst session. Holds `provider`, `model`, `provider_session_id` (the platform-native ID returned by the protocol), `workspace_id`, `parent_session_id`, `worktree_id`, `mode`, and JSONB `metadata`. See `AISessionsRepository` (`packages/runtime/src/storage/repositories/AISessionsRepository.ts`).
- **In-memory caches** — non-durable. `ProviderFactory.providers` keyed by `${type}-${sessionId}` (`ProviderFactory.ts:15`). Each protocol may also hold transport state (active subprocess, active queries).

The Nimbalyst `sessionId` is the canonical ID the rest of the system uses (UI, transcript, file tracking). The `provider_session_id` is platform-specific and belongs to the protocol — never assume the formats are interchangeable.

### 3.2 Starting a new session

1. UI / IPC asks for a session: `SessionHandlers.ts` calls `SessionManager.createSession({...})`.
2. `SessionManager` writes a row to `ai_sessions` and returns a Nimbalyst `sessionId`.
3. On first prompt: `ProviderFactory.createProvider(type, sessionId)` instantiates an `AIProvider`. The factory caches it.
4. `provider.initialize(config)` is called once with `apiKeys`, settings, ports for internal MCP servers, etc. (`ProviderConfig` in `packages/runtime/src/ai/server/types.ts`).
5. `provider.sendMessage(text, documentContext, sessionId, ..., workspacePath, attachments)` runs.
6. The provider builds `SessionOptions` (workspace path, model, MCP config, permission mode, abort signal) and calls `protocol.createSession(options)`.
7. The protocol returns a `ProtocolSession` whose `id` may be empty until the first stream chunk reveals it.
8. `protocol.sendMessage(session, message)` is iterated; on each `ProtocolEvent` the provider:
   - Writes raw audit messages to `ai_agent_messages`.
   - Emits chunks for the IPC layer.
   - Triggers transcript transformation (see §5).
9. When the first chunk surfaces the platform session ID, the provider updates `ai_sessions.provider_session_id` so resume works next time.

### 3.3 Resuming a session

Resume relies on `ai_sessions.provider_session_id`:

1. `SessionManager.loadSession(id)` returns the `SessionData` including `providerSessionId`.
2. `ProviderFactory.createProvider(type, sessionId)` (cache miss after a restart) builds a fresh provider.
3. `provider.sendMessage(...)` sees `providerSessionId` is set and calls `protocol.resumeSession(providerSessionId, options)` instead of `createSession`.
4. The transcript is rebuilt from `ai_agent_messages` lazily by `TranscriptTransformer.ensureUpToDate(sessionId)` — no provider replay required.

A small but important rule: a protocol that **cannot** resume (e.g. an early-stage transport) should still implement `resumeSession` and either degrade to a brand-new session or throw a typed error. The provider layer treats throw-on-resume as fatal, so prefer graceful degradation when continuity is acceptable.

### 3.4 Forking

`forkSession(sessionId, options)` is for branches in the session tree (UI feature — "branch from this message"). Today only `ClaudeSDKProtocol` actually forks. The other three create a fresh session and copy parentage in the DB. New providers should match whichever behavior their underlying agent supports — fork if there's a true branch primitive, otherwise let the higher layers do the bookkeeping.

### 3.5 Abort

Abort flows top-down:

1. Renderer fires `ai-session:abort` (or equivalent) IPC.
2. `SessionManager` flips an `AbortController` it owns for the session.
3. The signal is in `SessionOptions.abortSignal`, passed into the protocol via `createSession`/`resumeSession`.
4. Each adapter wires it natively — `ClaudeSDKProtocol` passes it as `abortController` into the SDK; `CodexSDKProtocol` calls `thread.abort()` when the signal fires; `CopilotACPProtocol` sends `session/cancel`; `OpenCodeSDKProtocol` calls `session.abort`.

The protocol's `abortSession()` method is for **bookkeeping** — clean up tracked queries, kill child processes, etc. It does not need to also cancel in-flight work if the abort signal already does.

## 4. Prompt handling

Prompt path from UI to protocol:

1. Renderer dispatches via `window.electronAPI.invoke('ai-session:send', { sessionId, text, attachments })` (channel name varies; `SessionHandlers.ts` is the registry).
2. Handler resolves the session, fetches/creates the provider, calls `provider.sendMessage(text, documentContext, sessionId, history, workspacePath, attachments)`.
3. Provider attaches a system prompt (`buildSystemPrompt(documentContext)` in `AIProvider.ts:215`) and constructs a `ProtocolMessage`.
4. Protocol converts attachments (`ClaudeSDKProtocol.buildImageBlocks` / `buildDocumentBlocks` are the model — base64 image/PDF blocks today).
5. Yielded events are forwarded to the renderer as IPC events through `mainWindow.webContents.send('ai-session:event', ...)`. Per `docs/IPC_LISTENERS.md`, the renderer never subscribes per-component — central listeners in `store/listeners/` push into Jotai atoms.

Attachments worth noting:

- **Images** travel as base64 + mime type. Adapters that don't support inline images should reject the message with a clear error rather than silently drop content.
- **PDFs** go as document blocks (Claude SDK only at the moment).
- Non-image text files are not first-class attachments — they're typically pasted into the prompt or referenced by `@path` (the path-mention pattern picked up by `SessionFileTracker`).

## 5. Transcript output

Nimbalyst's transcript is a two-tier system; new providers feed the bottom tier and get the top tier for free.

```
provider.sendMessage()
  └─ protocol yields ProtocolEvent
      ├─ provider.logAgentMessage(...)    →  ai_agent_messages       (raw, sole source of truth)
      └─ TranscriptTransformer            →  ai_transcript_events    (canonical, UI-facing)
                                                ↑
                                  IRawMessageParser per provider
```

### 5.1 Raw log

Every provider must call `logAgentMessage(sessionId, source, direction, content, metadata)` (`AIProvider.ts:240`) for both inputs (user/system → agent) and outputs (agent → user, including tool-use and tool-result events). The raw log:

- Is append-only and never rewritten.
- Stores **provider-native** payloads. There is no normalization on the way in.
- The `source` field is the provider/platform name and is used as the parser dispatch key.
- `searchable` should be set to `true` only for plain user prompts and assistant text (FTS would otherwise be polluted by JSON tool blobs).

There are blocking and non-blocking variants. Use the blocking `logAgentMessage` for user input and the final output of a turn. Use `logAgentMessageNonBlocking` for streaming chunks. Always call `flushPendingWrites()` before yielding the `complete` event.

### 5.2 Canonical events

Canonical events live in `ai_transcript_events` and are produced by `TranscriptTransformer` (`packages/runtime/src/ai/server/transcript/TranscriptTransformer.ts:79`). The transformer:

- Reads new raw rows since `lastRawMessageId`.
- Picks an `IRawMessageParser` based on `source`. Today: `ClaudeCodeRawParser`, `CodexRawParser`, `CopilotRawParser`, `OpenCodeRawParser`.
- Parsers return plain `CanonicalEventDescriptor[]` (see `parsers/IRawMessageParser.ts:38`). The transformer is the only thing that writes to the canonical table.
- Bumping `TranscriptTransformer.CURRENT_VERSION` causes all sessions to be re-parsed lazily on next load — useful when a parser bug is fixed.

To add a new agent provider you must:

1. Choose a unique `source` string and use it consistently in `logAgentMessage`.
2. Implement an `IRawMessageParser` that produces `CanonicalEventDescriptor`s for every interesting raw event (user/assistant/system messages, tool starts/completes/progress, subagent starts/completes, interactive prompts, `turn_ended` with usage / context fill).
3. Register the parser in `TranscriptTransformer`'s parser map.

The descriptor schema is shared across providers — that is what makes the renderer free of per-provider switches.

### 5.3 Streaming view

While a turn is in flight, the renderer reads from a **projection** of canonical events (`TranscriptProjector` in `transcript/TranscriptProjector.ts`). The provider doesn't push directly to the UI; instead, the transformer's incremental mode writes new canonical rows, and the renderer subscribes (via Jotai atoms wired by central IPC listeners) to whichever events arrive.

## 6. Tool calling

Tool calling is the most heavily customized surface — every provider does it slightly differently — but the abstractions hold.

### 6.1 Tool sources

There are **three** sources of tools, and an agent provider may compose all three:

1. **Built-in tools** registered in `toolRegistry` (`packages/runtime/src/ai/server/tools/`) — `applyDiff`, `streamContent`, etc. Used mostly by chat providers.
2. **MCP tools** advertised by the MCP servers configured into the session (see §7).
3. **Native agent tools** that the underlying SDK ships (Claude SDK's `Read`/`Edit`/`Bash`, Codex's `apply_patch` / `shell`, OpenCode's `edit`/`write`/`patch`/`shell`, etc.).

Agent providers don't need to register or describe tools to the SDK — the SDK ships its own and we layer MCP on top. They only need to **observe** tool calls in the stream and turn them into canonical events.

### 6.2 Permission flow

Agent tool calls go through:

- The agent SDK's own permission mode (`'ask' | 'auto' | 'plan'`), passed in `SessionOptions.permissionMode`.
- Nimbalyst's `AgentToolHooks` (`packages/runtime/src/ai/server/permissions/AgentToolHooks.ts`) for SDKs that support hooks (Claude SDK).
- `ToolPermissionService` (`packages/runtime/src/ai/server/permissions/ToolPermissionService.ts`) for our durable allow/deny rules.

When permission needs user input, providers emit an **interactive prompt** canonical event (`InteractivePromptCreatedDescriptor`) — the renderer renders the AskUserQuestion / ToolPermission widget, and the response flows back via `resolveAskUserQuestion` (see `AskUserQuestionProvider` in `AIProvider.ts:22`) or the tool-permission IPC. New providers integrate by:

1. Reading the active permission mode from settings before calling the SDK.
2. Routing tool-permission requests through `ToolPermissionService.evaluate()` first.
3. If the evaluation result is `prompt`, emit an interactive prompt canonical event and await the response.

`docs/AGENT_PERMISSIONS.md` and `docs/INTERACTIVE_PROMPTS.md` are the authoritative references for the durable-prompts pipeline.

## 7. MCP configuration

A new agent provider gets MCP for free if it can accept a `mcpServers` map shaped like the Claude SDK's. `McpConfigService` (`packages/runtime/src/ai/server/services/McpConfigService.ts`) builds that map: it injects ports for internal MCP servers (nimbalyst-mcp, session-naming, extension-dev, super-loop-progress, session-context, meta-agent) and runs loader functions for user/workspace config. In Electron, the loader is overridden in `packages/electron/src/main/index.ts` (`setMCPConfigLoader`) to point at `packages/electron/src/main/services/MCPConfigService.ts`, which adds platform-specific command resolution (e.g. `npx → npx.cmd` on Windows) via `processServerConfigForRuntime`.

Sources, in priority order (later wins):

1. **Built-in Nimbalyst servers** (HTTP/SSE on localhost, ports injected into the provider at init).
2. **User config** at `~/.config/claude/mcp.json`.
3. **Workspace config** at `<workspace>/.mcp.json`.
4. **Extension plugins** loaded via `PluginLoader` (`packages/runtime/src/ai/server/mcp/PluginLoader.ts`) — currently used by the Claude SDK's plugin system; see [`design/Extensions/claude-sdk-plugin-integration.md`](../Extensions/claude-sdk-plugin-integration.md).

Provider responsibilities:

- Call `mcpConfigService.getMcpServersConfig({ sessionId, workspacePath })` before each turn (workspace can change).
- Pass the result through to the protocol via `SessionOptions.mcpServers`.
- If the underlying SDK does not natively understand HTTP/SSE MCP, the protocol adapter is responsible for translating (e.g. spawning stdio bridges, or rewriting URLs).

Note: today only Claude Code can fully consume the merged set. Codex/Copilot/OpenCode still receive a degraded subset. New providers should aim for full parity but explicitly declare which MCP transport types they support.

## 8. File-edit tracking

When an agent edits a file, three systems must learn about it:

1. **`SessionFileTracker`** (`packages/electron/src/main/services/SessionFileTracker.ts`) — writes `session_files` rows linking files to sessions, attaches a chokidar watcher, and refreshes the document service. Edits are detected by tool name match (`Write`, `Edit`, `applyDiff`, `Bash`, `file_write`, `file_edit`, `patch`, `edit`, `write`, `create`, ...).
2. **`ToolCallMatcher`** (`packages/electron/src/main/services/ToolCallMatcher.ts`) — pairs tool-call-started events with the file path the tool actually touched, even when arguments encode paths in non-obvious ways.
3. **`HistoryManager`** (`packages/electron/src/main/HistoryManager.ts`) — creates `pre-edit` snapshots before each edit and `incremental-approval` tags, so the diff review UI can show the user what changed.

For a new agent provider this means:

- Use **standard tool names** wherever possible. The SessionFileTracker tool-name allowlist (`getLinkTypeForTool` at `SessionFileTracker.ts:45`) decides what counts as an edit. If your agent uses a non-standard name (`smart_replace`, etc.), add it to the list with the right `FileLinkType` (`edited` / `read` / `referenced`).
- Surface tool **arguments** in the canonical `tool_call_started` event with the targeted file path either in `targetFilePath` (preferred) or recoverable from `arguments`.
- Make sure tool-call IDs are stable across `tool_call_started` and `tool_call_completed` (`providerToolCallId`). This is what lets the matcher pair the start with the result.
- When your agent invokes shell commands that touch files (Bash-style), the matcher already has heuristics — but emitting an explicit canonical `tool_progress` event with elapsed seconds keeps the UI honest.

The user-facing diff review (`DiffPreview`, `TextDiffViewer`, `MonacoDiffViewer`) and the FilesEditedSidebar are downstream of these signals; if they look empty after a turn, a tool-name allowlist miss is the most common cause.

## 9. IPC surface

Agent IPC is split across several handler files; the relevant ones for a new provider are:

- `packages/electron/src/main/ipc/SessionHandlers.ts` — create / list / delete / fork sessions, send prompt, receive streamed events.
- `packages/electron/src/main/ipc/SessionFileHandlers.ts` — query session-file links for the FilesEditedSidebar.
- `packages/electron/src/main/ipc/PermissionHandlers.ts` — durable tool-permission decisions.
- `packages/electron/src/main/ipc/MCPConfigHandlers.ts` — read/write of user MCP config (used by settings UI; the provider itself reads via the service).
- `packages/electron/src/main/ipc/ClaudeCodeHandlers.ts`, `ClaudeCodeSessionHandlers.ts`, `ClaudeCodePluginHandlers.ts`, `ClaudeUsageHandlers.ts`, `CodexUsageHandlers.ts` — provider-specific extras (auth, plugin enablement, usage stats). New providers will likely want a similar dedicated handler file for anything that doesn't fit `SessionHandlers`.

The pattern is uniform: handlers register with `safeHandle`/`safeOn` from `ipcRegistry.ts`, never with raw `ipcMain.handle`. Renderer subscribes via central listeners in `packages/electron/src/renderer/store/listeners/`.

## 10. End-to-end summary

A user types a prompt:

1. Renderer dispatches via `electronAPI` → IPC handler in main.
2. `SessionManager` ensures a DB row; `ProviderFactory` returns a cached or fresh `AIProvider` keyed by session.
3. Provider builds `SessionOptions` with workspace path, model, abort signal, permission mode, and the result of `mcpConfigService.getMcpServersConfig`.
4. Provider calls `protocol.createSession` (or `resumeSession` if `provider_session_id` exists). Protocol returns a `ProtocolSession`.
5. Provider iterates `protocol.sendMessage(...)`. For each `ProtocolEvent`:
   - Raw payload is appended to `ai_agent_messages`.
   - The transformer parses raw rows into canonical events.
   - Tool-call events flow through `ToolCallMatcher` → `SessionFileTracker` → `HistoryManager`.
   - Renderer central listeners pull canonical events into Jotai atoms; UI updates atomically.
6. On `complete`, provider awaits `flushPendingWrites()` and emits a final IPC event so the UI reaches a steady state.
7. Aborting at any point flows the existing `AbortController` signal down — providers must treat abort as a normal terminal state, not an error.

## 11. What's coupled to the main process

These are deliberate couplings today; they constrain what a third-party agent provider could look like (and motivate the companion design doc on extensions).

- **Vendor SDKs assume Node + filesystem.** All four protocol adapters either spawn a child process, dynamically `require()` an installed binary, or open a socket on localhost. None of this works in a renderer or a worker without a host-side proxy.
- **`ProviderFactory` is a static singleton** in the runtime package. It's loaded eagerly by the main process at boot. Adding a provider means editing this file and the `AIProviderType` union.
- **`HistoryManager`, `SessionFileWatcher`, and the document service** all use Electron `app` paths and `BrowserWindow` references — they cannot be reached from outside the main process directly.
- **MCP server ports** are owned by the main process and injected into providers at init. There is no public way for code outside the main process to request an MCP config.
- **Permission decisions** end at IPC widgets the renderer renders. The flow is host-mediated — not a generic listener API.

A new agent provider that lives in this repo can ignore all of this. A new agent provider that lives **outside** this repo cannot, and that is the question the companion document picks up.

## 12. Checklist for a new agent provider

Use this when implementing one in-tree.

- [ ] Pick a unique provider type string and add it to `AIProviderType`.
- [ ] Implement `AgentProtocol` for the transport. Yield only normalized `ProtocolEvent`s.
- [ ] Implement `AIProvider` (extending `BaseAIProvider`). Wire `logAgentMessage` for every input and output.
- [ ] Add the provider to `ProviderFactory.createProvider` switch.
- [ ] Add a `IRawMessageParser` and register it in `TranscriptTransformer`.
- [ ] Add tool names your agent uses to `SessionFileTracker.getLinkTypeForTool`.
- [ ] If your SDK supports MCP, accept `SessionOptions.mcpServers` and wire `mcpConfigService` at provider init.
- [ ] Wire abort: pass `SessionOptions.abortSignal` into the SDK and clean up in `protocol.abortSession`.
- [ ] If the provider has unique IPC needs (auth, usage stats, custom settings), add a dedicated handler file under `packages/electron/src/main/ipc/`.
- [ ] Add provider-specific UI panel under `packages/electron/src/renderer/components/AIModels/panels/`.
- [ ] Decide forking semantics — native fork or DB-only branch — and document it on the protocol class.

## Appendix: Reference file index

| Concern | File |
| --- | --- |
| Protocol contract | `packages/runtime/src/ai/server/protocols/ProtocolInterface.ts` |
| Provider contract | `packages/runtime/src/ai/server/AIProvider.ts` |
| Factory | `packages/runtime/src/ai/server/ProviderFactory.ts` |
| Session manager | `packages/runtime/src/ai/server/SessionManager.ts` |
| Sessions table repository | `packages/runtime/src/storage/repositories/AISessionsRepository.ts` |
| Raw audit log repository | `packages/runtime/src/storage/repositories/AgentMessagesRepository.ts` |
| Transcript pipeline | `packages/runtime/src/ai/server/transcript/` |
| Per-provider parsers | `packages/runtime/src/ai/server/transcript/parsers/` |
| MCP config | `packages/runtime/src/ai/server/services/McpConfigService.ts`, `packages/electron/src/main/services/MCPConfigService.ts` |
| Permission service | `packages/runtime/src/ai/server/permissions/` |
| File-edit tracking | `packages/electron/src/main/services/SessionFileTracker.ts`, `ToolCallMatcher.ts` |
| Snapshots | `packages/electron/src/main/HistoryManager.ts` |
| Top-level IPC | `packages/electron/src/main/ipc/SessionHandlers.ts` |
