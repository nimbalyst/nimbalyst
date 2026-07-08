---
planStatus:
  planId: plan-unified-voice-mode-architecture
  title: Unified Cross-Platform Voice Mode Architecture
  status: draft
  planType: system-design
  priority: high
  owner: ghinkle
  stakeholders: []
  tags:
    - voice-mode
    - cross-platform
    - ios
    - electron
    - openai-realtime
    - context-system
  created: "2026-02-19"
  updated: "2026-07-01T00:00:00.000Z"
  progress: 15
---
# Unified Cross-Platform Voice Mode Architecture

> **Status as of 2026-07-01:** The iOS reference implementation this plan points at is shipped (floating overlay, pending prompt card, `list_sessions`/`switch_session`, VPIO echo cancellation), and desktop already has `list_sessions`/`navigate_to_session` voice tools plus the memory-grounding context path. The convergence work itself — project-level desktop agent, floating desktop overlay, desktop pending prompt card, voice transcript persistence/reuse — has not started. Echo cancellation round 2 (NIM-1314) is planned and takes priority over convergence.

## Problem Statement

Voice mode exists in two separate implementations with divergent designs:

- **Electron (desktop):** Session-scoped voice agent embedded in the chat panel. Tied to a single AI session. Has transcription display, settings UI, token tracking. Uses Web Audio API.
- **iOS (native):** Project-scoped voice agent with floating overlay. Cross-session awareness via tools. Voice-to-voice only (no transcription). Uses AudioToolbox/AVAudioEngine with VoiceProcessingIO for echo cancellation.

The iOS native design is better. The voice agent should be a **project-level entity** that operates across sessions, not locked to one. The desktop implementation needs to converge toward this model.

Beyond unification, the voice agent needs a richer context system so it can be genuinely useful -- knowing what you're working on, what sessions are active, what just happened, and having tools to navigate the workspace.

## Design Principles

1. **Project-level agent, not session-level.** The voice agent lives above any single session. It can see all sessions, route prompts, switch focus.
2. **Push-to-activate with idle timeout.** Tap/click to start. Auto-idle after silence. Reactivate when an AI session has something to report.
3. **Voice-to-voice primary.** The core interaction is spoken. No live transcription display. Transcripts are captured silently for context injection into future voice sessions and debugging.
4. **iOS native design as the reference.** The floating overlay, pending prompt card, and state machine from the iOS implementation become the canonical UX. Desktop adapts to match.
5. **Context injection + tools.** The agent gets a compact context snapshot at activation and on-demand tools for deeper queries.

## Architecture

### Voice Agent Lifecycle

```
                    Project Level
    ┌──────────────────────────────────────────┐
    │            VoiceAgent                     │
    │                                           │
    │  State: disconnected | connecting |       │
    │         listening | processing |          │
    │         speaking | idle                   │
    │                                           │
    │  Context:                                 │
    │    - Recent sessions (last 5)             │
    │    - Active session overview              │
    │    - Recently opened files                │
    │                                           │
    │  Tools:                                   │
    │    - submit_prompt(session, text)          │
    │    - list_sessions()                       │
    │    - get_session_overview(session)         │
    │    - open_session(session)                 │
    │    - open_file(path)                       │
    │    - stop_voice()                          │
    │                                           │
    └──────────┬───────────────────────────────┘
               │
    ┌──────────▼───────────────────────────────┐
    │         OpenAI Realtime API               │
    │         gpt-realtime via WebSocket        │
    └──────────────────────────────────────────┘
```

### State Machine

```
disconnected ──activate()──> connecting ──session.updated──> listening
listening ──VAD speech end──> processing
processing ──agent response──> speaking
speaking ──response complete──> listening
listening ──idle timeout (30s)──> idle
idle ──session completion notify──> speaking (announcement) ──> listening
idle ──user activates──> listening
any ──deactivate()──> disconnected
```

### Activation and Idle Behavior

**Push to start:** User taps a button (iOS floating overlay, desktop voice button). Opens WebSocket, starts capture.

**Idle timeout:** After configurable silence (default 10s desktop, 30s iOS), the agent enters idle state. WebSocket stays open but capture pauses. **Silence is measured from the last activity -- either user speech OR assistant response completion.** The timer resets when:
1. User speaks (transcript delta or completion)
2. Assistant responds (text delta resets during response, token-usage resets after response completes)
3. Assistant wakes from sleep to announce a result

The agent can be re-woken by:
1. User taps the button again
2. An AI session completes a turn (auto-announce results, then listen for follow-up)

**Deactivate:** Long-press (iOS) or explicit stop (desktop) fully disconnects. WebSocket closes.

## Context System

The voice agent needs enough context to be useful without blowing up the instruction limit. `gpt-realtime` crashes on long instructions, so context must be compact.

### Injected Context (at activation and refresh)

A compact snapshot injected as the system prompt. Updated when the user switches sessions or a session completes.

```
You are a voice assistant for the Nimbalyst coding workspace.
You help the user manage their coding sessions and workspace.

Project: {projectName}

Recent sessions:
- "Fix auth bug" (idle, 12 messages)
- "Add dark mode" (executing, 8 messages)
- "Refactor DB layer" (idle, 23 messages)

Currently viewing: "Fix auth bug"
Last user prompt: "Add input validation to the login form"
Files edited: LoginForm.tsx, validation.ts, auth.test.ts
Last AI response summary: "Added Zod validation schema to LoginForm..."

Keep responses brief and conversational. Never read code verbatim.
```

**What gets injected:**
- Project name
- Last 5 sessions: title, status (idle/executing/queued), message count
- Currently viewed session: title, last user prompt, up to 5 file names edited, truncated summary of AI's last response (first 200 chars)

**When it refreshes:**
- On activation (fresh snapshot)
- When user switches to a different session (via UI or voice command)
- When a session completes (updated status + completion summary)

### Tools (on-demand)

For deeper queries the agent can call tools. These avoid putting everything in the instructions.

| Tool | Description | Returns |
| --- | --- | --- |
| `submit_prompt` | Queue a prompt to a session. Shows pending confirmation card (5s countdown). User can cancel or send immediately. | Confirmation status |
| `list_sessions` | All sessions in the project with title, status, message count, last activity time | Session list |
| `get_session_overview` | Detailed view of a session: last 3 user prompts, file names edited (up to 10), AI's last response summary (500 chars), execution status | Session overview |
| `open_session` | Switch the UI to display a different session | Success/failure |
| `open_file` | Open a file in the editor | Success/failure |
| `stop_voice` | End the voice conversation | -- |

**`submit_prompt`**** flow (unchanged from iOS):**
1. Voice agent calls `submit_prompt` with session ID and prompt text
2. Pending prompt card appears with countdown (5s default)
3. Voice agent speaks confirmation while card is visible
4. Auto-submit on countdown expiry, or user can cancel/send now
5. If cancelled, voice agent is informed via conversation item

### Context Data Sources

**Electron:**
- Sessions from PGLite database (session list, message history, file edits)
- Currently active tab/session from Jotai atoms
- File edit tracking from existing `filesEdited` session metadata

**iOS:**
- Sessions from GRDB (synced from desktop)
- Currently selected session from AppState
- File edits from synced session metadata

Both platforms query the same logical data, just from their respective storage layers.

## Platform Convergence

### What iOS Already Has (reference implementation)

- Project-scoped VoiceAgent with state machine
- Floating VoiceOverlay with state indicators (listening/processing/speaking/idle)
- PendingPromptCard with countdown, cancel, send now
- VoiceProcessingIO capture with AVAudioEngine playback
- 3 active tools: submit_prompt, ask_coding_agent, stop_voice
- Session completion auto-announce via metadata_broadcast
- Voice settings in SettingsView (API key, voice, idle timeout)

### What Desktop Needs to Change

The desktop voice mode is currently session-scoped and embedded in the chat UI. Changes needed:

**1. Lift voice agent to project level**
- VoiceModeService currently creates one voice session per AI session
- Change to one voice agent per workspace window
- Voice agent persists across session switches
- Move voice state from session atoms to workspace-level atoms

**2. Replace UI with iOS-equivalent design**
- Remove inline VoiceTranscriptionDisplay from live UI (voice-to-voice only, matching iOS)
- Keep OpenAI's `input_audio_transcription` (whisper-1) running -- capture transcripts silently for context and debugging
- Add floating voice indicator (equivalent to VoiceOverlay)
- Add pending prompt card (equivalent to PendingPromptCard)
- Voice button moves from session header to a persistent location (bottom bar or floating)

**3. Add context injection**
- Build context snapshot from PGLite session data
- Inject at activation, refresh on session switch and completion
- Keep instructions compact (same format as iOS)

**4. Add navigation tools**
- `open_session`: Switch active tab to a session
- `open_file`: Open a file in the editor
- `list_sessions`: Query all sessions from PGLite

**5. Add session completion auto-announce**
- Desktop VoiceModeService subscribes to session completion events
- When voice is idle and a session completes, auto-activate and announce
- Same flow as iOS: inject internal message, voice agent speaks, return to listening

### What iOS Needs

- Add `open_session` and `open_file` tools (navigate in the mobile app)
- Richer context injection (currently minimal instructions)
- Re-enable `list_sessions` and `get_session_overview` tools (disabled due to instruction size concerns -- now handled via tools, not instructions)

## Pending Prompt Card (Cross-Platform)

The pending prompt card is the only text UI in voice mode. Identical behavior on both platforms:

```
┌─────────────────────────────────────┐
│  Sending to: Fix auth bug           │
│                                     │
│  "Add input validation to the       │
│   login form"                       │
│                                     │
│  ●●●○○  3s                          │
│                                     │
│  [Cancel]              [Send Now]   │
└─────────────────────────────────────┘
```

- Appears when voice agent calls `submit_prompt`
- Shows target session name, prompt text, countdown
- Cancel discards and informs voice agent
- Send Now submits immediately
- Auto-submits on countdown expiry (default 5s, configurable)

## Audio Pipeline (Per-Platform)

No changes to the audio approach per platform -- each uses what works best natively:

**iOS:** VoiceProcessingIO (capture with echo cancellation, bus 0 disabled) + AVAudioEngine (playback). `.voiceChat` audio session mode. 48kHz hardware -> 24kHz resampled for OpenAI.

**Desktop:** Web Audio API capture + scheduled playback (existing). No echo cancellation needed (typically headphone usage). 24kHz PCM16 direct.

## Implementation Phases

### Phase 1: Desktop Voice Agent Lift to Project Level

- [ ] Decouple VoiceModeService from individual AI sessions
- [ ] One voice agent per workspace window, persists across session switches
- [ ] Move voice state atoms from session-scoped to workspace-scoped
- [ ] Voice agent tracks "focused session" independently of which tab is active
- [ ] Update IPC handlers to route prompts to the focused session (not "current" session)

### Phase 2: Context Injection System

- [ ] Build context snapshot builder (shared logic, platform-specific data access)
  - Recent sessions: title, status, message count
  - Active session: last prompt, files edited, last AI response summary
- [ ] Inject context as system prompt at activation
- [ ] Refresh context on session switch, session completion, and periodic interval
- [ ] Keep total instruction size under 2KB (gpt-realtime safe limit)

### Phase 3: Voice Navigation Tools

- [ ] Desktop: `open_session` tool (switch active tab)
- [ ] Desktop: `open_file` tool (open file in editor)
- [ ] Desktop: `list_sessions` tool (query PGLite)
- [ ] Desktop: `get_session_overview` tool (detailed session info)
- [ ] iOS: `open_session` tool (switch selected session in app)
- [ ] iOS: `open_file` tool (navigate to file -- limited on mobile, may just switch to session that edited it)
- [ ] iOS: Re-enable `list_sessions` and `get_session_overview`

### Phase 4: Desktop UI Convergence

- [ ] Remove VoiceTranscriptionDisplay from live UI (no live text during voice conversations)
- [ ] Floating voice indicator (persistent, not session-tied)
- [ ] Pending prompt card (slides up from voice button, matches iOS design)
- [ ] Session completion auto-announce (idle -> speaking -> listening cycle)
- [ ] Voice mode button in persistent location (not session header)

### Phase 5: Voice Transcript Capture and Context

- [ ] Accumulate transcript entries (user speech + assistant text) in memory during voice session
- [ ] On disconnect, persist full transcript to PGLite as a voice session record (workspace-scoped, timestamped)
- [ ] When building context snapshot for a new voice session, include summary of last voice conversation (e.g., "Previous voice session (2h ago): discussed auth bug fix, asked about DB migrations")
- [ ] Keep `input_audio_transcription` (whisper-1) config in place -- the cost is already paid, capture the data
- [ ] Optional: expose voice transcript history in a debug/settings view for after-the-fact review

### Phase 6: Polish and Testing

- [ ] E2E context injection testing (verify compact format, no gpt-realtime crashes)
- [ ] Cross-session navigation testing (voice commands to switch sessions, open files)
- [ ] Idle timeout and auto-reactivation testing
- [ ] Analytics events for unified voice mode
- [ ] Settings sync between platforms (voice preference, idle timeout)

## Open Questions

1. **~~Transcription on desktop:~~** **Resolved.** Remove live transcription display. Keep whisper-1 running silently to capture transcripts for context injection into future voice sessions and for debugging. The cost is already paid -- the data should be captured, just not shown live.
2. **Context refresh frequency:** How often should the injected context refresh while actively conversing? Too frequent risks gpt-realtime instability; too infrequent means stale data.
3. **File navigation on mobile:** `open_file` on iOS is limited since there's no file editor. Should it switch to the session that last edited that file? Or skip entirely on mobile?
4. **Multi-window desktop:** If multiple workspace windows are open, does each get its own voice agent? (Likely yes -- one per workspace.)
5. **Token budget for context:** The 2KB instruction limit is conservative. Worth testing larger context snapshots to find the actual crash threshold.
6. **Voice transcript storage format:** What schema for persisted voice transcripts? Minimal: `{id, workspacePath, timestamp, entries: [{role, text, timestamp}], durationMs}`. Could also store token usage alongside.

## Related Documents

All prior voice mode design work is consolidated in `design/VoiceMode/`:

| Document | Status | Relevance |
| --- | --- | --- |
| [native-ios-voice-mode.md](./native-ios-voice-mode.md) | in-development | Reference implementation for project-level voice agent |
| [openai-voice-mode-integration.md](./openai-voice-mode-integration.md) | in-development | Desktop implementation (to be refactored) |
| [mobile-voice-control-system.md](./mobile-voice-control-system.md) | in-development | Capacitor mobile voice (partially superseded by native iOS) |
| [memory-subsystem-research.md](./memory-subsystem-research.md) | draft | Context/memory research (feeds into Phase 2 context system) |
| [voice-mode-analytics.md](./voice-mode-analytics.md) | completed | Analytics events (extend for unified mode) |
| [voice-command-submit-delay.md](./voice-command-submit-delay.md) | completed | Pending prompt card design (desktop, adapt to unified) |
| [local-wake-word-detection.md](./local-wake-word-detection.md) | draft | Future: hands-free activation |
| [voice-project-summary.md](./voice-project-summary.md) | -- | Project context summary |
| [Voice-Mode-Architecture.excalidraw](./Voice-Mode-Architecture.excalidraw) | -- | Architecture diagram |
| [pending-voice-command.mockup.html](./pending-voice-command.mockup.html) | -- | Desktop pending command mockup |
| [native-ios-voice-mode.mockup.html](./native-ios-voice-mode.mockup.html) | -- | iOS voice mode mockup |
