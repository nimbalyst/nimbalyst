# Voice Mode

Voice mode provides a hands-free conversational interface to Nimbalyst's AI coding sessions. A voice agent (OpenAI Realtime API) handles speech-to-speech interaction with the user, while the existing coding agent (Claude Code or Codex) performs all technical work. The two agents coordinate through the main process.

## Architecture Overview

Voice mode is a **dual-agent architecture** layered on top of existing AI sessions:

```
                    ┌──────────────────────────────────┐
                    │         Renderer Process          │
                    │                                   │
                    │  VoiceModeButton ─ AudioCapture    │
                    │       │              │             │
                    │  voiceModeListeners  AudioPlayback │
                    │       │                            │
                    │  Jotai atoms (voiceModeState)      │
                    │       │                            │
                    │  AIInput (pending voice commands)  │
                    └───────┬──────────────────────┬─────┘
                            │ IPC                  │ IPC
                    ┌───────▼──────────────────────▼─────┐
                    │          Main Process               │
                    │                                     │
                    │  VoiceModeService                   │
                    │       │                              │
                    │  RealtimeAPIClient ──── WebSocket    │
                    │       │                     │        │
                    │  VoiceModeSettingsHandler    │        │
                    │                              ▼        │
                    │                     OpenAI Realtime   │
                    │                  API (gpt-realtime-2) │
                    └──────────────────────────────────────┘
```

Voice mode does **not** replace the coding session. It augments it. The voice agent serves as a conversational relay -- translating spoken requests into coding tasks, forwarding them to the coding agent, and speaking the results back.

## Key Files

| File | Process | Responsibility |
| --- | --- | --- |
| `packages/electron/src/main/services/voice/VoiceModeService.ts` | Main | IPC handler registration, session lifecycle, callback wiring between RealtimeAPIClient and renderer |
| `packages/electron/src/main/services/voice/RealtimeAPIClient.ts` | Main | WebSocket connection to OpenAI Realtime API, audio streaming, function call handling, session configuration |
| `packages/electron/src/main/services/voice/VoiceModeSettingsHandler.ts` | Main | Persists voice settings to `nimbalyst-settings` electron-store, broadcasts changes to all windows |
| `packages/electron/src/renderer/store/listeners/voiceModeListeners.ts` | Renderer | Centralized IPC listener hub, state atom updates, transcript persistence, session switching, editor context tracking, interactive prompt forwarding |
| `packages/electron/src/renderer/store/atoms/voiceModeState.ts` | Renderer | Jotai atoms for voice session state, transcript entries, token usage, listen state, callback registrations |
| `packages/electron/src/renderer/store/atoms/appSettings.ts` | Renderer | `VoiceModeSettings` interface and atoms (`voiceModeSettingsAtom`, `voiceModeEnabledAtom`, etc.) |
| `packages/electron/src/renderer/components/UnifiedAI/VoiceModeButton.tsx` | Renderer | UI toggle in NavigationGutter, audio capture/playback lifecycle, pending command routing |
| `packages/electron/src/renderer/utils/audioCapture.ts` | Renderer | Microphone capture at 24kHz, Float32-to-PCM16 conversion, base64 encoding |
| `packages/electron/src/renderer/utils/audioPlayback.ts` | Renderer | PCM16 playback via AudioBufferSourceNode, echo-cancellation-aware routing through MediaStreamDestination |
| `packages/runtime/src/ai/prompt.ts` | Runtime | `buildClaudeCodeSystemPrompt()` injects voice mode section when `isVoiceMode` flag is set |
| `packages/electron/src/main/mcp/httpServer.ts` | Main | MCP tools `voice_agent_speak` and `voice_agent_stop` exposed to coding agent |
| `packages/electron/src/main/services/voice/voiceToolBridge.ts` | Main | Pure: converts extension AI tools (`voiceAgent: true`) into Realtime function-tool schemas + a realtime↔namespaced name map |
| `packages/runtime/src/extensions/VoiceContextProviderRegistry.ts` | Renderer | Registry where extensions register voice session-context providers; produces the capped concatenated context |
| `packages/runtime/src/ai/server/transcript/parsers/VoiceRawParser.ts` | Runtime | Parses `openai-realtime` raw messages (user/assistant speech, `[system]` diagnostics, and `voiceToolCall` JSON) into canonical transcript events, so voice-agent tool calls render as real tool widgets |

## Data Flow

### User Speaks -> Coding Agent Executes -> Voice Responds

```
1. User speaks into microphone
     │
2. AudioCapture (renderer) captures 24kHz PCM16, base64-encodes
     │
3. VoiceModeButton sends via IPC: voice-mode:send-audio
     │  (gated: only when listenState === 'listening')
     │
4. VoiceModeService (main) forwards to RealtimeAPIClient.sendAudio()
     │
5. RealtimeAPIClient sends to OpenAI via WebSocket: input_audio_buffer.append
     │
6. OpenAI VAD detects speech end, transcribes (streaming gpt-realtime-whisper), generates response
     │
7. If voice agent calls submit_agent_prompt tool:
     │  a. RealtimeAPIClient.handleFunctionCall() invokes onSubmitPromptCallback
     │  b. VoiceModeService sends IPC: voice-mode:submit-prompt -> renderer
     │  c. voiceModeListeners invokes registered submit callback
     │  d. VoiceModeButton routes to AIInput's pendingVoiceCommandSetter
     │  e. After delay (configurable submitDelayMs), prompt is queued via ai:createQueuedPrompt
     │  f. Coding agent (Claude Code) processes the prompt
     │  g. On completion, voiceModeListeners receives onAIStreamResponse with isComplete=true
     │  h. Renderer sends IPC: voice-mode:agent-task-complete with summary
     │  i. VoiceModeService receives completion. On gpt-realtime-2 it resolves the
     │     still-open submit_agent_prompt call with the summary (async function
     │     calling); on the gpt-realtime fallback it injects [INTERNAL: Task complete...]
     │  j. Voice agent speaks the result to the user
     │
8. Voice agent audio response flows back:
     a. OpenAI sends response.audio.delta events
     b. RealtimeAPIClient invokes onAudioCallback
     c. VoiceModeService sends IPC: voice-mode:audio-received -> renderer
     d. voiceModeListeners invokes registered audio callback
     e. AudioPlayback (renderer) decodes and plays PCM16
```

### Ask Coding Agent (Synchronous Q&A)

The `ask_coding_agent` tool provides a synchronous request-response pattern. The voice agent submits a question prefixed with `[VOICE]`, the coding agent processes it, and the voice agent receives the answer as the function call result (with a 60-second timeout).

### Interactive Prompt Forwarding

When the coding agent presents an interactive prompt (AskUserQuestion, ExitPlanMode, GitCommitProposal):

1. `voiceModeListeners` subscribes to `sessionPendingPromptsAtom` for the linked session
2. On new prompt, wakes voice from sleeping state
3. Sends IPC `voice-mode:interactive-prompt` with a voice-friendly description
4. VoiceModeService calls `poc.sendUserMessage()` with `[INTERACTIVE PROMPT: ...]`
5. Voice agent reads the prompt aloud and waits for user answer
6. Voice agent calls `respond_to_interactive_prompt` tool
7. VoiceModeService sends IPC `voice-mode:respond-to-prompt` -> renderer
8. `voiceModeListeners` uses `respondToPromptAtom` to submit the answer

## State Management

### Jotai Atoms

All voice state lives in workspace-scoped atoms (not per-session) because only one voice session can be active at a time. Atoms are updated exclusively by `voiceModeListeners.ts` -- components never subscribe to IPC directly.

| Atom | Type | Purpose |
| --- | --- | --- |
| `voiceActiveSessionIdAtom` | `string \ | null` | ID of the linked coding session (not the voice DB session) |
| `voiceListenStateAtom` | `'off' \ | 'listening' \ | 'sleeping'` | Three-state listening model |
| `voiceTranscriptEntriesAtom` | `VoiceTranscriptEntry[]` | Accumulated user/assistant transcript entries |
| `voiceCurrentUserTextAtom` | `string` | Live partial transcription while user speaks |
| `voiceTokenUsageAtom` | `VoiceTokenUsage \ | null` | Input/output audio and text token counts |
| `voiceSessionStartTimeAtom` | `number \ | null` | When the current voice session started |
| `voiceWorkspacePathAtom` | `string \ | null` | Workspace path for the voice session |
| `voiceDbSessionIdAtom` | `string \ | null` | Database session ID (separate from linked coding session) |
| `voiceLastReportedFileAtom` | `string \ | null` | Last file path sent to voice agent (dedup) |
| `voiceErrorAtom` | `{ type; message } \ | null` | Current error state |
| `pendingVoiceCommandAtom` | `PendingVoiceCommand \ | null` | Pending voice command awaiting countdown |

### Listen State Machine

Voice mode uses a three-state listening model managed by `voiceModeListeners.ts`:

```
  ┌─────────┐
  │   off   │ ◄── Voice mode not active
  └────┬────┘
       │ start
  ┌────▼────┐
  │listening│ ◄── Mic open, audio flowing, timer running
  └────┬────┘
       │ timer expires / pause_listening tool
  ┌────▼────┐
  │sleeping │ ◄── WebSocket connected, mic paused
  └────┬────┘
       │ wake events (task complete, interactive prompt, user tap)
       └────── back to listening
```

**Timer management:**
- `startListenWindowTimer()` starts a countdown (default 15s, configurable via `listenWindowMs`)
- Timer is paused during speech (speech_started clears timer)
- Timer restarts after speech ends (speech_stopped) or after assistant finishes responding (token-usage)
- Timer is cleared while assistant is speaking (audio chunks arriving)
- Expiry transitions to `sleeping` state

When sleeping:
- Audio capture continues running but `VoiceModeButton` gates sending based on listen state
- Main process inactivity monitor is suspended
- Voice wakes automatically on: interactive prompt, task completion, or user clicking the button

## IPC Channels

### Renderer -> Main (invoke)

| Channel | Purpose |
| --- | --- |
| `voice-mode:test-connection` | Start voice session (connect WebSocket, get API key, build context) |
| `voice-mode:test-disconnect` | Stop voice session (disconnect, return final token usage) |
| `voice-mode:send-audio` | Stream PCM16 audio chunk to OpenAI |
| `voice-mode:get-settings` | Load voice mode settings |
| `voice-mode:set-settings` | Save voice mode settings |
| `voice-mode:createSession` | Create voice session row in ai_sessions table |
| `voice-mode:resumeSession` | Resume a recent voice session (touch updated_at) |
| `voice-mode:findRecentSession` | Find voice session updated within timeout window |
| `voice-mode:appendMessage` | Write a single transcript entry to ai_agent_messages |
| `voice-mode:updateSessionMetadata` | Update token usage and duration on session stop |

### Main -> Renderer (send)

| Channel | Purpose |
| --- | --- |
| `voice-mode:audio-received` | PCM16 audio chunk from voice agent to play |
| `voice-mode:text-received` | Text delta from voice agent response |
| `voice-mode:transcript-complete` | Final user speech transcription |
| `voice-mode:transcript-delta` | Partial/streaming user transcription |
| `voice-mode:token-usage` | Token usage update after response completes |
| `voice-mode:submit-prompt` | Voice agent wants to send a coding task |
| `voice-mode:interrupt` | VAD detected user speech (stop playback) |
| `voice-mode:speech-stopped` | VAD detected silence after speech |
| `voice-mode:stopped` | Voice session ended (with final token usage) |
| `voice-mode:error` | Error (quota, rate limit, connection failure, reconnect exhausted) |
| `voice-mode:reconnecting` | Socket dropped; backoff reconnect in progress (transient) |
| `voice-mode:reconnected` | Reconnect succeeded; session config re-applied |
| `voice-mode:pause-listening` | Voice agent requested mic sleep |
| `voice-mode:settings-changed` | Settings changed (broadcast to all windows) |
| `voice-mode:respond-to-prompt` | Voice agent answered an interactive prompt |
| `voice-mode:interactive-prompt` | Coding agent needs user input (forwarded to voice) |

### Renderer -> Main (send, fire-and-forget)

| Channel | Purpose |
| --- | --- |
| `voice-mode:agent-task-complete` | Coding agent finished; includes summary for voice agent |
| `voice-mode:update-linked-session` | User switched coding sessions while voice active |
| `voice-mode:listen-state-changed` | Listen state transitioned (sleeping/waking) |
| `voice-mode:editor-context-changed` | User viewing a different file |

## Voice Agent Tools

The OpenAI Realtime API session is configured with these function-calling tools:

| Tool | Purpose |
| --- | --- |
| `submit_agent_prompt` | Queue a coding task for the coding agent. On gpt-realtime-2 this is an async (deferred) call: it stays open and the coding agent's summary is delivered as the tool result when work completes. On the gpt-realtime fallback it returns a synthetic "queued" result and the completion arrives via an injected `[INTERNAL: Task complete]` wake message. |
| `ask_coding_agent` | Send a synchronous question to the coding agent (60s timeout) |
| `respond_to_interactive_prompt` | Answer a pending AskUserQuestion, ExitPlanMode, or GitCommitProposal |
| `stop_voice_session` | End the voice session |
| `pause_listening` | Put the mic to sleep (WebSocket stays connected) |
| `get_session_summary` | Get a summary of the linked coding session |
| `list_sessions` | List recent AI sessions in the workspace |
| `navigate_to_session` | Switch the UI to a specific AI session |
| `create_session` | Create a new coding session and switch to it. The voice agent's linked session updates automatically via `voiceModeListeners.syncLinkedSession`. |
| `propose_commit` | Trigger the "Commit with AI" feature. Sends `voice-mode:propose-commit` to the renderer, which runs the same logic as the Smart Commit button in `GitOperationsPanel`: pre-fetches files via `git:get-commit-context`, then dispatches an `ai:sendMessage` with the canonical `Use the developer_git_commit_proposal tool to create a commit.` prefix so the `CommitRequestCard` widget appears in the transcript. The resulting `git_commit_proposal_request` interactive prompt flows back to the voice agent through the existing interactive-prompt forwarding for verbal approve/reject. |

## Extension Voice Tools & Context Providers (general core hooks)

Any extension can contribute to the voice agent, not just a dedicated grounding extension. There are two general hooks, both bridging the renderer (where extension code runs) to the main process (where the voice session runs).

### Core hook 1 — Extension voice tools

An extension AI tool opts in by setting `voiceAgent: true` on its `ExtensionAITool`. The same tool shape/handler/`inputSchema` serves both the coding agent and the voice agent.

- The flag is threaded through the existing tool registry: `MCPToolDefinition` (renderer, `ExtensionAIToolsBridge`) → `ExtensionToolDefinition` (main, `mcpWorkspaceResolver`). `getVoiceEnabledExtensionTools(workspacePath)` returns the opted-in tools for a workspace.
- At voice session start, `VoiceModeService` queries those tools, converts each via `buildVoiceToolSet()` (`voiceToolBridge.ts`) into a Realtime function-tool schema (tool names are sanitized `.`→`_` because Realtime function names disallow dots; built-in tool names are reserved so they can't be shadowed), and hands them to `RealtimeAPIClient.setExtensionVoiceTools()`. The client appends them to the session `tools` array (`buildSessionTools()`).
- Dispatch: any function call whose name is not a built-in routes through `RealtimeAPIClient`'s generic `onExtensionVoiceTool(namespacedName, args)` callback. `VoiceModeService` invokes the tool through the **existing extension execution path** (`handleExtensionTool`, the same route MCP uses), so the tool runs in the renderer with an `AIToolContext` (workspacePath, activeFilePath) mirroring the coding path.

Voice tools should generally be `scope: 'global'` and self-contained (low latency, no required editor mount) since the voice agent has no reliable active-file context.

### Core hook 2 — Voice session context providers

An extension registers `context.services.ai.registerVoiceContextProvider((ctx) => string | Promise<string>)` to inject text into the voice agent's session context at start (e.g. top-N grounding facts). Providers live in the renderer-side `VoiceContextProviderRegistry`; on voice session start the main process requests the concatenated, capped output over a one-shot request/response IPC (`voice-mode:collect-extension-context`) and appends it to `sessionContext` in `loadSessionContext`. Each provider's output and the combined total are capped (the Realtime context window is expensive); providers run highest-priority-first and a throwing provider is isolated.

Use a context provider for zero-latency grounding the agent should know up front; expose on-demand lookups as `voiceAgent: true` tools instead.

### Core hook 3 — Backend-module voice tools (no renderer hop)

Extension **backend modules** (utility-process runtimes) can also contribute voice/agent tools, without running their handler in the renderer. A backend module calls `services.registerMcpTools([{ name, description, inputSchema, voiceAgent }])`; the host stores them in a workspace-keyed `backendToolRegistry` (advertised as `<ext-short>.<name>`) and merges them into both the coding-agent MCP surface (`httpServer` ListTools/CallTool) and the voice tool set. A voice (or coding) call to a backend tool is dispatched **main→backend** via `handleBackendTool` → `PrivilegedExtensionHost.request(...)` — no renderer round-trip — so a native engine (e.g. better-sqlite3 + embeddings) answers in-process. Backend modules start/stop with the extension via `extensions/backendModuleLifecycle.ts` (start-on-enable, stop-on-disable, start-on-workspace-open).

### Grounding extension — Nimbalyst Memory (`com.nimbalyst.memory`)

The flagship consumer of the hooks above. Its backend module hosts the host-agnostic `MemoryEngine` (markdown indexer → rebuildable SQLite shadow index → hybrid dense+BM25+RRF retrieval) and registers `search_project_knowledge` / `recall` / `remember` (voice + coding) plus `expand` / `read_doc` / `status` (coding). Embeddings use OpenAI `text-embedding-3-small`, keyed only from the user's configured Nimbalyst OpenAI key (the `getApiKey` broker — never `process.env`). It indexes `design/**`, `docs/**`, `nimbalyst-local/plans/**`, the `CLAUDE.md` tree, and `nimbalyst-local/voice-memory/**`. A renderer-side voice context provider injects a short "you have a project memory — use these tools" note at session start (v1: static note; live top-N facts await a renderer→backend read bridge). This replaces the slow `ask_coding_agent` round-trip for grounded answers with a sub-second in-process lookup. Dev note: backend modules only auto-grant (no consent UI) when `npm run dev` runs with `NIMBALYST_ALLOW_DEV_BACKEND_MODULES=1` in a non-packaged build.

**Brainstorm-loop tools (Phase 4).** The extension also closes the talk-it-through-on-a-bike-ride loop. Two host-agnostic backend voice tools — `get_latest_plan` (read back the most recently edited plan to summarize aloud) and `read_plan` (a plan by bare name or path) — let the agent summarize a just-written plan verbally; both cap their body for the Realtime budget. One Nimbalyst-specific renderer voice tool — `get_task_status` — answers "is it done yet?" by reading the active voice-linked session's `ai_sessions.status` (`running` / `waiting_for_input` / `idle` / `error`) through a new host API (`extensions:ai-get-task-status` → `ExtensionAIService.getTaskStatus()`), so the agent never blocks on the coding agent to report progress. Kickoff itself reuses the built-in `submit_agent_prompt` tool (the agent phrases `/design` and `/implement`); the extension's voice context provider injects the brainstorm→design→summarize→refine→implement choreography so the core voice prompt never assumes the memory tools exist.

## MCP Tools for Coding Agent

The coding agent (Claude Code) has access to two MCP tools for voice interaction, registered in `httpServer.ts`:

| MCP Tool | Purpose |
| --- | --- |
| `voice_agent_speak` | Send a text message to the voice agent for speech output. Uses `sendToVoiceAgent()` which calls `poc.sendUserMessage()`. Returns gracefully if no voice session is active. |
| `voice_agent_stop` | Programmatically stop the active voice session. Calls `stopVoiceSession()`. |

## System Prompt Injection

When a prompt is submitted via voice mode, the `isVoiceMode` flag and optional `voiceModeCodingAgentPrompt` are passed through the prompt queue to the provider.

In `buildClaudeCodeSystemPrompt()` (packages/runtime/src/ai/prompt.ts), when `isVoiceMode` is true:

1. Optional `voiceModeCodingAgentPrompt.prepend` is added before the voice section
2. A `## Voice Mode` section is appended explaining:
  - The user is interacting via voice mode
  - A voice assistant handles the conversation and relays requests
  - The `voice_agent_speak` MCP tool is available for spoken updates
3. Optional `voiceModeCodingAgentPrompt.append` is added after

Both ClaudeCodeProvider and OpenAICodexProvider extract `isVoiceMode` and `voiceModeCodingAgentPrompt` from the document context and pass them to the prompt builder.

## Project Summary

A workspace-specific, voice-friendly project summary lives at `nimbalyst-local/voice-project-summary.md`. When a voice session starts, `VoiceModeService.loadSessionContext` reads this file and appends its contents to the voice agent's session context, giving the voice assistant a quick overview it can reference during conversations.

Generation happens in the Voice Mode settings panel (`packages/electron/src/renderer/components/Settings/VoiceModePanel.tsx`):

1. The user clicks "Generate Project Summary".
2. A confirmation dialog explains that an agent session will be launched using the user's default agent (`defaultAgentModelAtom`).
3. On confirm, the renderer creates a normal AI session titled "Voice mode: project summary" via the `sessions:create` IPC, then sends a single prompt (`buildVoiceProjectSummaryPrompt()` in `voiceModeSummaryPrompt.ts`) via `ai:sendMessage`.
4. The agent reads whichever project files it considers useful and writes the result to `nimbalyst-local/voice-project-summary.md` using its Write tool.
5. The window switches to Agent mode and selects the new session so the user can watch it run.

There is no main-process IPC handler for summary generation -- the agent does the work through its existing tooling. If no agent is configured (`defaultAgentModel` is empty), the button is disabled and the panel shows a link into the AI Models settings instead. The previous direct-Anthropic-API implementation was removed because it required a chat API key the user might not have, even though voice mode itself only requires an OpenAI key.

## Session Persistence

Voice mode maintains two separate but linked sessions in the database:

### Voice Session (ai_sessions)

- Created with ID format `voice-{timestamp}-{random}` and provider `openai-realtime`
- Transcript entries stored in `ai_agent_messages` incrementally as they arrive
- Metadata (linked coding session ID, token usage, duration) stored in the session's metadata JSONB field
- Sessions can be **resumed**: if a voice session for the same workspace was updated within the last 30 minutes (`VOICE_SESSION_TIMEOUT_MS`), new transcript entries append to it instead of creating a new session
- Diagnostic entries (file changes, state transitions) are written with `[system]` prefix and `diag-` ID prefix
- Tool calls the voice agent makes (memory lookups, `ask_coding_agent`, etc.) are written as `voiceToolCall` JSON entries with a `tool-` ID prefix — emitted from `RealtimeAPIClient.handleFunctionCall` (started) and `sendFunctionCallResult` (completed), forwarded via `voice-mode:tool-call` IPC, and rendered as real tool widgets by `VoiceRawParser`. Previously these executed silently and were invisible in the transcript.

### Linked Coding Session (ai_sessions)

- The regular coding session the user was viewing when voice started
- Voice commands (submit_agent_prompt, ask_coding_agent) target this session
- If the user switches active sessions while voice is active, `voiceModeListeners` updates the linked session ID and notifies the main process

## Voice Session Following

When voice is active and the user switches coding sessions:

1. `voiceModeListeners` subscribes to `activeSessionIdAtom`
2. On change, updates `voiceActiveSessionIdAtom` to the new session ID
3. Sends `voice-mode:update-linked-session` IPC with the new session ID and name
4. `VoiceModeService` updates `activeVoiceSession.sessionId` and injects context to the voice agent: `[INTERNAL: User switched to session "name"]`
5. VoiceModeButton's module-level `activeVoiceSessionId` is synced via the `onLinkedSessionChanged` callback

## Editor Context Tracking

While voice is active, the currently viewed file is tracked and reported to the voice agent:

1. `voiceModeListeners` subscribes to `activeTabIdAtom`, `activeSessionIdAtom`, and `windowModeAtom`
2. On change (debounced 300ms), computes the current file path
3. If different from `voiceLastReportedFileAtom`, sends `voice-mode:editor-context-changed` IPC
4. `VoiceModeService` calls `poc.injectContext()` with `[INTERNAL: User is now viewing {filename}]`
5. The voice agent silently notes this for context without announcing it

## Audio Pipeline

### Capture (Renderer)

`AudioCapture` uses `getUserMedia` with 24kHz mono, echo cancellation, noise suppression, and auto gain control. A `ScriptProcessorNode` (buffer size 4096 = ~170ms) converts Float32 samples to PCM16 Int16, base64-encodes the result, and passes it to the callback.

Audio is gated by listen state in `VoiceModeButton`: the callback only sends IPC when `voiceListenStateAtom === 'listening'`.

### Playback (Renderer)

`AudioPlayback` decodes base64 PCM16 to Float32, creates `AudioBuffer` objects, and schedules them via `AudioBufferSourceNode`. Audio is routed through a `MediaStreamAudioDestinationNode` connected to an `<audio>` element -- this makes the output visible to the browser's echo cancellation (AEC), preventing the assistant's voice from being picked up by the microphone.

Playback is interrupted on `voice-mode:interrupt` events (VAD detected user speech) by stopping all scheduled sources and clearing the queue.

### Echo Cancellation on iOS (native)

The native iOS voice agent does not rely on browser AEC. `packages/ios/NimbalystNative/Sources/Voice/AudioPipeline.swift` runs a single `kAudioUnitSubType_VoiceProcessingIO` (VPIO) audio unit: microphone capture comes in on bus 1 (48kHz PCM16), and assistant playback is rendered through a render callback on bus 0. Because playback flows through the same unit that captures, VPIO uses the bus 0 output signal as its echo-cancellation reference, so Apple's AEC subtracts the assistant's own voice from the mic — enabling barge-in without the agent interrupting itself.

Because AEC is imperfect on open speakers, both platforms route every VAD `speech_started` through a shared barge-in policy (`voiceBargeInPolicy.ts` / `BargeInPolicy.swift`, NIM-1314). A trigger while agent audio is audibly playing is **echo-suspect**: instead of interrupting immediately, playback continues through a 500ms probation window; if the speech ends inside it (an echo blip) nothing happens, and if it persists (a real barge-in) the interrupt fires with truncation measured at fire time. Triggers while silent interrupt immediately. Server-side, responses are gated (`create_response`/`interrupt_response=false`) while agent audio plays. All decisions are logged with `[barge-in]` tags including a per-session summary (echo-suspect vs genuine vs suppressed counts).

## Settings

Voice mode settings are stored in `nimbalyst-settings` electron-store (not `ai-settings`) under the `voiceMode` key.

| Setting | Type | Default | Purpose |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `false` | Show/hide the voice mode button |
| `voice` | `VoiceId` | `'alloy'` | OpenAI Realtime voice (alloy, ash, ballad, coral, echo, sage, shimmer, verse, marin, cedar) |
| `model` | `RealtimeModel` | `'gpt-realtime-2'` | Realtime speech-to-speech model. Falls back to `gpt-realtime` automatically if the account/region lacks access |
| `reasoningEffort` | `RealtimeReasoningEffort` | `'low'` | Reasoning throttle (minimal/low/medium/high/xhigh). Higher = smarter but slower. Applies to gpt-realtime-2 |
| `turnDetection.mode` | `'server_vad' \ | 'push_to_talk'` | `'server_vad'` | Automatic voice detection or manual |
| `turnDetection.vadThreshold` | `number` | `0.5` | VAD sensitivity (0.0-1.0, higher = less sensitive) |
| `turnDetection.silenceDuration` | `number` | `500` | Silence duration (ms) before processing |
| `turnDetection.interruptible` | `boolean` | `true` | Whether user can interrupt assistant |
| `voiceAgentPrompt` | `SystemPromptConfig` | `{}` | Custom prepend/append for voice agent system prompt |
| `codingAgentPrompt` | `SystemPromptConfig` | `{}` | Custom prepend/append for coding agent when in voice mode |
| `submitDelayMs` | `number` | `3000` | Delay before auto-submitting voice commands (0 = immediate) |
| `listenWindowMs` | `number` | `15000` | How long to keep listening after speech ends before sleeping |

## Callback Registration Pattern

Voice mode uses a module-level callback pattern to bridge centralized listeners with component-specific behavior, avoiding direct IPC subscriptions in components:

1. `voiceModeState.ts` exports `register*Callback()` and `get*Callback()` pairs
2. `VoiceModeButton` registers callbacks on module load via `registerVoiceCallbacks()`
3. `voiceModeListeners.ts` invokes callbacks via getters when IPC events arrive

This follows the project's centralized listener architecture: components never subscribe to IPC directly; centralized listeners update atoms, and components read from atoms.

## Inactivity Management

Two independent timers manage voice session lifecycle:

1. **Listen window timer** (renderer, `voiceModeListeners.ts`): Transitions from `listening` to `sleeping` after configurable inactivity period. Does not disconnect the WebSocket.

2. **Inactivity monitor** (main, `RealtimeAPIClient.ts`): Disconnects the WebSocket entirely after 5 minutes of inactivity (`INACTIVITY_TIMEOUT_MS`). Suspended when listen state is sleeping (renderer notifies via `voice-mode:listen-state-changed`).

## Connection Reliability (Reconnect / Resume)

A dropped socket no longer silently ends voice mode. `RealtimeAPIClient` distinguishes intentional disconnects (`user_stopped`, inactivity `timeout`) from unexpected ones:

- On an unexpected `close`/`error` after the socket was open, it reconnects with bounded exponential backoff (`RECONNECT_BASE_DELAY_MS` 500ms, doubling, capped at `RECONNECT_MAX_DELAY_MS` 8s, up to `MAX_RECONNECT_ATTEMPTS` = 5).
- On reconnect, `session.created` re-runs `updateSession()` which re-sends the **identical** voice/model/reasoning/instructions, so recovery is inaudible. Token-usage accumulators are instance fields and survive the reconnect (the live indicator doesn't reset).
- The renderer shows a transient "reconnecting…" state (`voiceReconnectingAtom`, set from `voice-mode:reconnecting`, cleared on `voice-mode:reconnected`). A hard `voice-mode:error` is emitted only after retries are exhausted.

## Model Selection & Fallback

Voice mode defaults to `gpt-realtime-2` (GPT-5-class reasoning, 128K context, more consistent voice rendering). If the initial socket fails to open on `gpt-realtime-2` (no account/region access), the client falls back **once** to `gpt-realtime`, logs a warning, and emits the `voice_model_fallback` analytics event. The fallback model is also manually selectable. `supportsAsyncFunctionCalls()` (true only for gpt-realtime-2) gates the async `submit_agent_prompt` path; the fallback uses the legacy queue + wake path.

The output voice is set once in `session.update` and intentionally **not** re-asserted on each `response.create` — gpt-realtime-2 renders a consistent voice for the whole session. The `session.updated` handler compares the server-reported voice against the requested voice and emits `voice_voice_mismatch` if they diverge, turning drift into a measurable signal.

`createResponse()` guards against an already-active response (`hasActiveResponse`, set optimistically on send and on `response.created`, cleared on `response.done`/cancel). The method is invoked from several async paths (tool results, wake / task-complete messages, interactive-prompt injection); without the guard a trigger arriving mid-turn would start a **second overlapping response**, i.e. two concurrent audio renderings that — under the expressive voices (marin/cedar) — are heard as the voice "switching" mid-turn. This is distinct from the configured voice being wrong: the session and per-response voice are both correctly pinned; the perceived switch comes from overlap.

## Spoken Language

The voice agent's spoken language is pinned to the desktop's **preferred agent language** setting (`preferredAgentLanguage`, configured in AI Models settings) so it never auto-detects or drifts into a different language at startup. The pin is applied as a final `LANGUAGE: Always speak to the user in <language>...` directive appended to the session instructions in `RealtimeAPIClient.updateSession()` (desktop) and `VoiceAgent.buildCompactInstructions()` (iOS). When no preference is set, both fall back to **English**.

On iOS the setting arrives via settings sync: `preferredAgentLanguage` is a top-level field on `SyncedSettings`, persisted into `VoiceModeSettings.language` (UserDefaults) when the desktop pushes settings. Because the directive lives in `updateSession()`, it is re-sent identically on reconnect, like voice/model/reasoning.

## Mobile (iOS) Voice Agent

The iOS app runs its own on-device voice agent (`packages/ios/.../Voice/VoiceAgent.swift` + the floating `VoiceOverlay`), reusing the same tool surface.

`RealtimeClient.swift` mirrors the desktop Realtime session config: `gpt-realtime-2` with the same one-shot fallback to `gpt-realtime` (a connection that dies before `session.created` retries once on the fallback), `gpt-realtime-whisper` streaming transcription, `reasoning.effort=low`, semantic_vad turn detection with response gating, and far-field noise reduction. The output voice comes from `VoiceModeSettings.voice` (Settings picker, or synced from the desktop's voice preference). Intentional divergences, each commented in code: the instructions length cap is model-aware (8000 chars on gpt-realtime-2, 2000 on the fallback where longer instructions crash audio generation); `submit_agent_prompt` is never a deferred call (the prompt relays over the sync channel and completion arrives as a separate broadcast, so the call can't stay open); and there is no exponential-backoff reconnect (connection loss tears down voice mode; the user re-taps the mic).

Two mobile-specific behaviors:

- **Create-session navigation.** `create_session` is fire-and-forget to the desktop over the index sync channel; the desktop replies with a `createSessionResponseBroadcast` carrying the `requestId` + new `sessionId`. `VoiceAgent` remembers the `requestId` it sent and `consumePendingCreateSession(requestId:)` matches the response, so **only the device that asked** navigates. `AppState.navigateWhenSessionAvailable` waits for the session row to arrive via index sync, then sets `voiceNavigationRequest`, which the iPhone stack and iPad split view observe to open the session.
- **Tool-call indicator.** `VoiceAgent.currentToolCall` is set when `RealtimeClient.onFunctionCall` fires and cleared by the new `onFunctionResultSent(callId)` hook (so async tools stay lit until they finish). While set, `VoiceOverlay` pulses the outer ring (amber) and shows a per-tool SF Symbol badge in the mic's corner.

## Analytics Events

| Event | Trigger |
| --- | --- |
| `voice_mode_enabled` | User enables voice mode in settings |
| `voice_mode_disabled` | User disables voice mode in settings |
| `voice_session_started` | Voice WebSocket connection established |
| `voice_session_ended` | Voice session ends (with reason and duration category) |
| `voice_prompt_submitted` | Voice agent calls submit_agent_prompt |
| `voice_model_fallback` | gpt-realtime-2 was unavailable; connection fell back to gpt-realtime |
| `voice_voice_mismatch` | Server-reported output voice diverged from the requested voice (drift guardrail) |

## Prerequisites

- OpenAI API key configured in Settings (uses the same key as the OpenAI chat provider)
- Microphone permission granted in System Settings (macOS). The app cannot programmatically request mic access because the audio-input entitlement is intentionally omitted to prevent permission prompts from Claude Agent SDK subprocesses.
- Voice mode enabled in Settings (toggles visibility of the VoiceModeButton)
