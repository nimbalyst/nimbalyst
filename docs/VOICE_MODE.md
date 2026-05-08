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
                    │                     API (GPT-4o)     │
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
6. OpenAI VAD detects speech end, transcribes (Whisper), generates response
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
     │  i. VoiceModeService receives completion, calls poc.sendUserMessage() with [INTERNAL: Task complete...]
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
| `voice-mode:error` | Error (quota, rate limit, connection failure) |
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
| `submit_agent_prompt` | Queue a coding task for the coding agent |
| `ask_coding_agent` | Send a synchronous question to the coding agent (60s timeout) |
| `respond_to_interactive_prompt` | Answer a pending AskUserQuestion, ExitPlanMode, or GitCommitProposal |
| `stop_voice_session` | End the voice session |
| `pause_listening` | Put the mic to sleep (WebSocket stays connected) |
| `get_session_summary` | Get a summary of the linked coding session |
| `list_sessions` | List recent AI sessions in the workspace |
| `navigate_to_session` | Switch the UI to a specific AI session |
| `create_session` | Create a new coding session and switch to it. The voice agent's linked session updates automatically via `voiceModeListeners.syncLinkedSession`. |
| `propose_commit` | Trigger the "Commit with AI" feature. Sends `voice-mode:propose-commit` to the renderer, which runs the same logic as the Smart Commit button in `GitOperationsPanel`: pre-fetches files via `git:get-commit-context`, then dispatches an `ai:sendMessage` with the canonical `Use the developer_git_commit_proposal tool to create a commit.` prefix so the `CommitRequestCard` widget appears in the transcript. The resulting `git_commit_proposal_request` interactive prompt flows back to the voice agent through the existing interactive-prompt forwarding for verbal approve/reject. |

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

## Session Persistence

Voice mode maintains two separate but linked sessions in the database:

### Voice Session (ai_sessions)

- Created with ID format `voice-{timestamp}-{random}` and provider `openai-realtime`
- Transcript entries stored in `ai_agent_messages` incrementally as they arrive
- Metadata (linked coding session ID, token usage, duration) stored in the session's metadata JSONB field
- Sessions can be **resumed**: if a voice session for the same workspace was updated within the last 10 minutes (`VOICE_SESSION_TIMEOUT_MS`), new transcript entries append to it instead of creating a new session
- Diagnostic entries (file changes, state transitions) are written with `[system]` prefix and `diag-` ID prefix

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

## Settings

Voice mode settings are stored in `nimbalyst-settings` electron-store (not `ai-settings`) under the `voiceMode` key.

| Setting | Type | Default | Purpose |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `false` | Show/hide the voice mode button |
| `voice` | `VoiceId` | `'alloy'` | OpenAI Realtime voice (alloy, ash, ballad, coral, echo, sage, shimmer, verse, marin, cedar) |
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

## Analytics Events

| Event | Trigger |
| --- | --- |
| `voice_mode_enabled` | User enables voice mode in settings |
| `voice_mode_disabled` | User disables voice mode in settings |
| `voice_session_started` | Voice WebSocket connection established |
| `voice_session_ended` | Voice session ends (with reason and duration category) |
| `voice_prompt_submitted` | Voice agent calls submit_agent_prompt |

## Prerequisites

- OpenAI API key configured in Settings (uses the same key as the OpenAI chat provider)
- Microphone permission granted in System Settings (macOS). The app cannot programmatically request mic access because the audio-input entitlement is intentionally omitted to prevent permission prompts from Claude Agent SDK subprocesses.
- Voice mode enabled in Settings (toggles visibility of the VoiceModeButton)
