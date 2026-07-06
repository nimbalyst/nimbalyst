---
planStatus:
  planId: plan-native-ios-voice-mode
  title: Native iOS Voice Mode Agent
  status: in-development
  startDate: "2026-02-15"
  planType: feature
  priority: high
  owner: ghinkle
  stakeholders: []
  tags:
    - mobile
    - ios
    - voice
    - openai-realtime
    - swift
  created: "2026-02-15"
  updated: "2026-07-01T00:00:00.000Z"
  progress: 90
---
# Native iOS Voice Mode Agent

> **Status as of 2026-07-01:** Shipped and in use: project-scoped voice agent with the floating `VoiceOverlay`, the pending prompt card (`PendingPromptCard.swift`), cross-session tools including `list_sessions`/`switch_session`, and VoiceProcessingIO-based echo cancellation (`AudioPipeline.swift`, VPIO bus 0 render reference). Still open: the tool-integration test pass and context-injection polish. Echo cancellation round 2 (self-interruption hardening, NIM-1314) is the active follow-up.

## Problem Statement

The mobile app needs a voice mode that works as an overarching conversational agent, not just a per-session add-on embedded in the web transcript. Voice mode should:

- Work across all AI sessions in a project (not locked to one session)
- Support a push-to-activate flow: user activates, converses, then voice mode goes idle after a timeout
- Automatically reactivate when a coding agent finishes a turn to announce results and listen for follow-up
- Show clear indicators on both session list and session detail screens
- Run entirely in native Swift (no web view dependency for voice)

The interaction model is **voice-to-voice only** -- no transcription display. The user speaks, the agent speaks back. The only text UI is a pending prompt card shown briefly when the voice agent is about to submit a prompt to a coding session, giving the user a few seconds to cancel.

## Architecture

```
                    ┌─────────────────────────────────┐
                    │     OpenAI Realtime API          │
                    │  (gpt-realtime)                  │
                    │  WebSocket: wss://api.openai.com │
                    │  Auth: subprotocol               │
                    └──────────┬──────────────────────┘
                               │ Audio + Tools
                    ┌──────────▼──────────────────────┐
                    │     VoiceAgent (Swift)            │
                    │                                   │
                    │  - URLSessionWebSocketTask        │
                    │  - AudioToolbox RemoteIO (capture)│
                    │  - AVAudioEngine (playback)       │
                    │  - Tool dispatch:                 │
                    │    - submit_agent_prompt(prompt)   │
                    │    - ask_coding_agent(question)    │
                    │    - stop_voice_session()          │
                    └──────────┬──────────────────────┘
                               │
              ┌────────────────┼────────────────────┐
              │                │                    │
    ┌─────────▼──────┐ ┌──────▼───────┐ ┌──────────▼──────┐
    │  SyncManager   │ │  AppState    │ │  SwiftUI Views  │
    │  (send prompts │ │  (voice      │ │  (indicators,   │
    │   via existing │ │   state,     │ │   pending       │
    │   WebSocket)   │ │   active     │ │   prompt card)  │
    │                │ │   session)   │ │                 │
    └────────────────┘ └──────────────┘ └─────────────────┘
```

### Key Design Decisions

**Voice-to-voice, no transcription.** The entire interaction is spoken. No live transcription text is displayed. The only text element is the pending prompt confirmation card when the voice agent wants to submit work to a coding session.

**Project-scoped, not session-scoped.** The voice agent knows about all sessions in the current project. It can route prompts to specific sessions, switch the UI to show a different session, or create new sessions. This matches how a developer naturally works: "Check on my refactor session" or "Start a new task to fix the login bug."

**Native audio pipeline.** Uses `AVAudioEngine` for microphone capture and `AVAudioPlayerNode` for playback, rather than Web Audio API through a web view. This gives proper background audio support, audio session management, and integration with iOS audio routing (AirPods, speaker, etc.).

**Push-to-activate with idle timeout.** User taps a button to start voice mode. The OpenAI Realtime connection stays open. After the conversation goes silent for a configurable timeout (default 30s), voice mode enters an "idle" state where it keeps the connection alive but stops actively listening. It reactivates when:
1. A coding agent finishes a turn (announced via `metadata_broadcast` with `isExecuting: false`)
2. The user taps the activate button again

**OpenAI API key requirement.** The user must provide their own OpenAI API key for voice mode (same as desktop). The key is stored in iOS Keychain alongside the pairing seed.

## Components

### 1. `VoiceAgent.swift` - Core Orchestrator

The main voice mode manager. One instance per project, owned by `AppState`.

```swift
@Observable
class VoiceAgent {
    enum State {
        case disconnected           // Voice mode off
        case connecting             // Establishing OpenAI WebSocket
        case listening              // Actively listening for user speech
        case processing             // Voice agent is thinking / calling tools
        case speaking               // Voice agent is speaking response
        case idle                   // Connected but timed out, waiting for reactivation
    }

    var state: State = .disconnected
    var activeSessionId: String?    // Session voice agent is focused on
    var pendingPrompt: PendingPrompt? // Prompt awaiting user confirmation

    struct PendingPrompt {
        let sessionId: String
        let sessionTitle: String
        let prompt: String
        let submittedAt: Date         // When countdown started
        let delay: TimeInterval       // How long before auto-submit (default 5s)
    }

    // Configuration
    var voice: String = "sage"      // OpenAI voice
    var idleTimeout: TimeInterval = 30  // Seconds of silence before idle
    var apiKey: String              // OpenAI API key from Keychain

    func activate()                 // Start or resume listening
    func deactivate()               // Stop voice mode entirely
    func cancelPendingPrompt()      // User cancels the pending prompt
    func confirmPendingPrompt()     // User confirms immediately (skip countdown)
    func onSessionCompleted(sessionId: String, summary: String)  // Coding agent finished
}
```

**State transitions:**
```
disconnected ──activate()──> connecting ──connected──> listening
listening ──silence detected──> processing (voice agent thinking)
processing ──agent responds──> speaking
speaking ──response complete──> listening (waiting for user)
listening ──idle timeout──> idle
idle ──agent completion notify──> speaking (announcement) ──> listening
idle ──user taps activate──> listening
any ──deactivate()──> disconnected
```

### 2. `RealtimeClient.swift` - OpenAI WebSocket Client

Handles the OpenAI Realtime API WebSocket protocol. Adapted from the desktop `RealtimeAPIClient.ts`.

- `URLSessionWebSocketTask` for WebSocket connection
- Sends/receives JSON events per the OpenAI Realtime API spec
- PCM16 audio encoding/decoding (24kHz, mono, little-endian)
- Server-side VAD (Voice Activity Detection) for turn detection
- Tool call dispatching back to `VoiceAgent`
- Token usage tracking

### 3. `AudioPipeline.swift` - Native Audio Capture & Playback

**Capture (AudioToolbox RemoteIO):**
- `kAudioUnitSubType_RemoteIO` audio unit at 48kHz (iPhone hardware native rate)
- `AVAudioConverter` resamples 48kHz -> 24kHz PCM16 mono (OpenAI format)
- Accumulates into 100ms (2400 frame) chunks before sending as base64
- Note: VoiceProcessingIO (with AEC) was tried first but delivered silence. May work now that other bugs are fixed - worth retesting for speaker echo cancellation.

**Playback (AVAudioEngine):**
- `AVAudioPlayerNode` attached to `AVAudioEngine`
- Decodes base64 PCM16 from OpenAI, converts Int16 -> Float32 for `AVAudioPCMBuffer`
- Schedules buffers for gapless playback
- Supports interruption (stop current playback when user starts speaking / barge-in)

**Audio Session:**
- Category: `.playAndRecord`, mode: `.default`, options: `[.defaultToSpeaker, .allowBluetoothA2DP]`
- Preferred sample rate: 48kHz, IO buffer duration: 20ms
- Handles interruptions (phone calls, other apps)
- Deactivates on voice mode stop
- AirPods/Bluetooth routing works correctly

### 4. Voice Agent Tools

The voice agent has tools that operate at the project level:

| Tool | Description |
| --- | --- |
| `submit_prompt` | Send a prompt to a specific session (or the active one). Does NOT send immediately -- sets `pendingPrompt` on `VoiceAgent`, which shows a confirmation card. After the countdown (default 5s), sends via `SyncManager.sendPrompt()`. User can cancel or confirm early. |
| `ask_coding_agent` | Ask a question about the project. Sends as a prompt and waits for response. |
| `list_sessions` | Return all sessions in the current project with status (executing, idle, queued). |
| `switch_session` | Change the UI to display a different session. Updates `AppState.selectedSessionId`. |
| `get_session_summary` | Get recent activity summary for a session (message count, last topic, status). |
| `stop_voice_session` | End the voice conversation. |

**`submit_prompt` flow:**
1. Voice agent calls `submit_prompt` tool with session ID and prompt text
2. `VoiceAgent` sets `pendingPrompt` (triggers UI card) and returns tool result "Prompt queued, waiting for user confirmation"
3. Voice agent says something like "Sending that to your auth session" while card is visible
4. After countdown (5s default), prompt is auto-submitted via `SyncManager.sendPrompt()`
5. If user taps "Cancel" on the card, prompt is discarded and voice agent is informed via a conversation item
6. If user taps "Send Now", prompt is submitted immediately

**Context provided to voice agent:**

Instructions must be kept compact to avoid `gpt-realtime` server errors. Do NOT enumerate sessions in instructions - use the `list_sessions` tool instead.

```
You are a voice assistant on a mobile device for the Nimbalyst coding workspace.
You relay requests between the user and coding agents on their desktop.

Tools:
- submit_agent_prompt: Queue a coding task for the desktop agent
- ask_coding_agent: Ask the coding agent a question
- stop_voice_session: End the conversation

Keep responses brief and conversational. Never read code verbatim.
Project: {projectName}
The user is viewing session: "{sessionTitle}"
```

### 5. UI Components

#### `VoiceOverlay.swift` - Floating Voice Indicator

A minimal SwiftUI overlay shown when voice mode is active. Displayed on top of both session list and session detail views. Since the interaction is voice-to-voice, this is primarily a **state indicator**, not a text display.

**States:**
- **Listening:** Pulsing microphone icon with subtle audio level ring animation
- **Processing:** Thinking indicator (animated dots)
- **Speaking:** Speaker icon with waveform ring animation
- **Idle:** Dimmed microphone icon with "Tap to resume" label

**Layout:**
- Floating circular button at bottom-center of screen (above safe area)
- No text content (voice-to-voice, not transcription)
- Tap to activate/resume from idle
- Long-press to deactivate voice mode entirely
- Expands slightly during speaking/listening with animated ring

#### `PendingPromptCard.swift` - Prompt Confirmation

Appears when the voice agent is about to submit a prompt to a coding session. This is the **only text UI** in voice mode.

**Layout:**
- Card slides up from above the voice button
- Shows: session name, prompt text, countdown timer
- Two buttons: "Cancel" and "Send Now"
- Auto-dismisses and sends when countdown reaches zero
- Subtle haptic on appear

**Content:**
```
┌─────────────────────────────────┐
│  Sending to: Fix login auth flow│
│                                 │
│  "Add a unit test for the       │
│   token refresh fix"            │
│                                 │
│  ●●●○○  3s                      │
│                                 │
│  [Cancel]           [Send Now]  │
└─────────────────────────────────┘
```

#### Session List Indicators

On `SessionListView`, show voice mode status:
- Microphone icon next to the project header when voice mode is active
- Per-session indicator if voice agent is focused on that session (small mic badge)

#### Session Detail Indicators

On `SessionDetailView`, show:
- Voice mode active indicator in the navigation bar (mic icon with pulsing dot)

### 6. Completion Notification Flow

When a coding agent finishes a turn:

1. `SyncManager` receives `metadata_broadcast` with `isExecuting: false`
2. `SyncManager` also receives the final `message_broadcast` with the agent's response
3. `AppState` notifies `VoiceAgent.onSessionCompleted(sessionId, summary)`
4. If voice mode is in `idle` state:
   a. `VoiceAgent` transitions to `speaking`
   b. Sends an internal message to OpenAI: `[INTERNAL: Session "{title}" completed: {last assistant message summary}]`
   c. Voice agent speaks a brief announcement
   d. Transitions to `listening` with idle timeout
   e. User can give follow-up instructions or stay silent to return to `idle`
5. If voice mode is in `listening` state (user actively talking): queue the notification

### 7. Settings & Configuration

Add voice mode settings to `SettingsView.swift`:

- **OpenAI API Key** - SecureField, stored in Keychain
- **Voice Selection** - Picker with preview (alloy, ash, ballad, cedar, coral, echo, fable, marin, onyx, sage, shimmer, verse). "cedar" and "marin" recommended for best quality with gpt-realtime.
- **Idle Timeout** - Stepper (10s - 120s, default 30s)
- **Auto-announce completions** - Toggle (default on)
- **Prompt confirmation delay** - Stepper (1s - 10s, default 5s)
- **Voice sensitivity** - Slider for VAD threshold

Settings stored via `UserDefaults` (non-sensitive) and `KeychainManager` (API key).

## Implementation Phases

### Phase 1: Audio Pipeline & OpenAI Connection

- [x] `AudioPipeline.swift` - AudioToolbox RemoteIO capture + AVAudioEngine playback
  - Microphone permission request
  - 48kHz RemoteIO capture -> AVAudioConverter -> 24kHz PCM16 mono
  - 100ms chunk accumulation and base64 encoding for WebSocket
  - PCM16 buffer decoding (Int16->Float32) and playback via AVAudioPlayerNode
  - AVAudioSession configuration (.playAndRecord, .default, defaultToSpeaker)
  - Audio interruption handling
- [x] `RealtimeClient.swift` - OpenAI Realtime API WebSocket
  - URLSessionWebSocketTask with subprotocol auth
  - Model: `gpt-realtime` (GA model, not preview)
  - Session configuration (voice, VAD, tools, compact instructions)
  - `onSessionReady` callback: capture starts only after `session.updated`
  - Audio event sending/receiving with first-chunk validation logging
  - Tool call dispatching with function_call_output + response.create
  - Token usage tracking (`audio_tokens` key, not `audio`)
- [x] OpenAI API key storage in KeychainManager
- [x] Unit tests: PCM16 encoding, base64 sizing, endianness, downsampling
- [x] Standalone test script: `test-realtime-audio.swift` (440Hz sine wave -> OpenAI)

### Phase 2: Voice Agent Core

- [x] `VoiceAgent.swift` - State machine and orchestration
  - State transitions (disconnected -> connecting -> listening -> processing -> speaking -> idle)
  - Tool implementations (submit_prompt with pending confirmation, list_sessions, switch_session, get_session_summary, stop)
  - Pending prompt lifecycle (countdown, cancel, confirm)
  - Session context generation from GRDB
  - Idle timeout management
  - Completion notification handling
- [x] Integration with `SyncManager` for prompt routing
- [x] Integration with `AppState` for session switching
- [x] Wire `metadata_broadcast` (isExecuting transitions) to voice agent notifications
- [ ] Unit tests: state transitions, tool dispatch, pending prompt flow

### Phase 3: UI

- [x] `VoiceOverlay.swift` - Floating voice indicator button
  - Listening / processing / speaking / idle visual states
  - Animated ring for audio activity
  - Tap to activate, long-press to deactivate
- [x] `PendingPromptCard.swift` - Prompt confirmation card
  - Session name, prompt text, countdown progress
  - Cancel and Send Now buttons
  - Auto-submit on countdown expiry
  - Slide-up animation, haptic feedback
- [x] Voice mode indicators on `SessionListView`
- [x] Voice mode indicators on `SessionDetailView`
- [x] Voice settings section in `SettingsView`
- [x] API key entry flow (first-time setup)

### Phase 4: Polish & Echo Cancellation

- [ ] **Echo cancellation for speaker mode** (highest priority remaining issue)
  - Retry VoiceProcessingIO now that session timing and other bugs are fixed
  - If VoiceProcessingIO still delivers silence, investigate software AEC or audio route detection
  - Currently only works properly with AirPods/headphones
- [ ] Voice settings sync validation (map unsupported voices to `alloy`)
- [ ] Re-enable additional tools (list_sessions, switch_session, get_session_summary) - test one at a time
- [ ] Haptic feedback on state transitions
- [ ] Background audio session (keep voice mode running when app backgrounded briefly)
- [ ] Battery optimization (disconnect WebSocket when truly idle for >5 min)
- [ ] Error handling and recovery (network loss, API errors, server_error retry)
- [ ] Analytics events (voice_session_started, voice_session_ended, voice_prompt_submitted)
- [ ] Clean up debug logging (capture frame counts, peak values, raw JSON usage)

## Data Model Changes

### New: Voice Mode Settings in UserDefaults

```swift
struct VoiceModeSettings: Codable {
    var voice: String = "sage"
    var idleTimeout: TimeInterval = 30
    var autoAnnounceCompletions: Bool = true
    var vadThreshold: Double = 0.5
    var silenceDuration: Int = 500  // ms
    var promptConfirmationDelay: TimeInterval = 5  // seconds
}
```

### New: OpenAI API Key in Keychain

Add to `KeychainManager`:
- Key: `openai_api_key`
- Stored alongside existing pairing credentials

### No Database Schema Changes

Voice mode is ephemeral - no SQLite tables needed. Session context is read from existing tables. Prompts sent via voice flow through the existing `SyncManager.sendPrompt()` path.

## Wire Protocol

No sync server changes needed. Voice mode operates entirely on the client side:
- Prompts sent via existing `IndexUpdateMessage` (same as ComposeBar)
- Session metadata read from existing GRDB tables
- Completion notifications derived from existing `metadata_broadcast` events

The only new external connection is the OpenAI Realtime API WebSocket, which is a direct client-to-OpenAI connection (no proxy through the sync server).

## Implementation Lessons (Phase 1-3 Debugging)

Getting audio working end-to-end required 40+ deploy-test cycles. The following documents every hard-won lesson.

### Model Selection: `gpt-realtime` not `gpt-4o-realtime-preview`

- `gpt-4o-realtime-preview` defaults to **text-only responses** when tools are present. Even with `modalities: ["text", "audio"]`, it prefers text output for tool-aware sessions.
- `gpt-realtime` (the GA model) correctly responds with audio even when tools are configured.
- **The `gpt-realtime` model crashes with a server_error if the instructions string is too long.** No useful error message - just `status=failed` mid-audio-generation. Keep instructions concise. Do NOT dump session lists into instructions; use a tool for that instead.

### WebSocket Authentication: Subprotocol, not Headers

The iOS `URLSessionWebSocketTask` connects using subprotocol-based auth (matching the Capacitor/browser approach), not HTTP header auth:
```swift
let protocols = ["realtime", "openai-insecure-api-key.\(apiKey)", "openai-beta.realtime-v1"]
let wsTask = session.webSocketTask(with: url, protocols: protocols)
```

### Audio Capture: RemoteIO at 48kHz, Resampled to 24kHz

- **VoiceProcessingIO delivered near-silence** on iOS at all sample rates tested (24kHz, 44.1kHz, 48kHz). Peak levels were 0-85 (essentially silence). This was tested early when other bugs were also present, so it may work now that session timing is fixed. Worth retesting as it provides hardware echo cancellation which RemoteIO lacks.
- **RemoteIO works** but has no echo cancellation. Peaks of 1000+ during speech. Uses 48kHz (iPhone hardware native rate) with AVAudioConverter resampling to 24kHz for OpenAI.
- **Without echo cancellation, speaker playback creates a feedback loop** where the mic picks up the agent's audio response, VAD triggers, and the agent keeps responding to itself. AirPods work fine because they have hardware AEC. The speaker path needs a fix - either:
  1. Retry VoiceProcessingIO now that other bugs are fixed
  2. Software-level echo cancellation
  3. Mute capture during playback (bad: kills barge-in)

### Session Timing: Wait for `session.updated`

Audio sent before `session.updated` is acknowledged is silently dropped by OpenAI. Capture must start AFTER `session.updated`, not on `session.created`:
```swift
client.onSessionReady = { // fired on session.updated
    try self.audioPipeline.startCapture()
}
```

### Token Usage JSON Key: `audio_tokens` not `audio`

OpenAI returns `input_token_details.audio_tokens` and `output_token_details.audio_tokens`. The key is `audio_tokens`, NOT `audio`. This parsing bug caused `audio_in=0` to show for 40+ debugging attempts, completely masking whether audio was actually working.

### Instructions: Keep Compact

The original `buildInstructions()` iterated over ALL synced sessions (965+) and dumped them into the instructions string. This caused `gpt-realtime` to crash with server errors during audio generation. The fix is:
- Keep instructions short and focused (architecture, tool descriptions, current session title)
- Use `list_sessions` as a tool the model calls on demand
- Never enumerate sessions in instructions

### Tool Names: Match Capacitor

The working Capacitor implementation uses `submit_agent_prompt`, `ask_coding_agent`, `stop_voice_session`. The iOS implementation initially used different names (`submit_prompt`). Tool names should match across platforms for consistency.

### Standalone Test Script

`packages/ios/test-realtime-audio.swift` is a macOS script that generates a 440Hz sine wave and sends it to the OpenAI Realtime API. Run with:
```
OPENAI_API_KEY=sk-xxx swift packages/ios/test-realtime-audio.swift
```
This confirmed the PCM16 format is correct (OpenAI responded "I hear a tone" with `audio_tokens: 20`) without requiring an iOS device deploy.

## Remaining Work

### Echo Cancellation (Speaker Mode)

The most important remaining issue. Without echo cancellation, voice mode only works properly with AirPods/headphones. Options:
1. **Retry VoiceProcessingIO** - It delivered silence during early debugging, but multiple other bugs were present at the time (wrong session timing, wrong token parsing). It may work now and would provide hardware AEC.
2. **Software AEC** - Implement acoustic echo cancellation in the audio pipeline. Complex but gives full control.
3. **Audio route detection** - Detect when using speaker vs headphones and adjust behavior (e.g., lower playback volume, increase VAD threshold when on speaker).

### Voice Settings Sync

Desktop settings sync a voice preference (e.g., `coral`) but `gpt-realtime` may not support all voices from `gpt-4o-realtime-preview`. Currently hardcoded to `alloy`. Need to either validate the synced voice against supported voices or let the user pick from a `gpt-realtime`-compatible list.

### Additional Tools

The Capacitor implementation has 3 tools. The native implementation has 6 defined but only 3 active. The additional tools (`list_sessions`, `switch_session`, `get_session_summary`) should be re-enabled once verified they don't cause issues with the session config size.

## Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| AVAudioEngine complexity on iOS | Well-documented Apple API. Can use simpler AVAudioRecorder as fallback, but AVAudioEngine is preferred for low latency. |
| Battery drain from always-on WebSocket | Idle timeout disconnects after configurable period. Background mode only keeps alive briefly. |
| OpenAI API costs | Per-minute audio pricing. Idle timeout minimizes cost. Clear cost indication in settings. |
| Audio routing complexity (AirPods, speaker) | Use `.voiceChat` audio mode which handles routing automatically. |
| Background audio interruptions | Register for AVAudioSession interruption notifications, pause/resume gracefully. |
| Concurrent audio with transcript web view | Web view has no audio - transcript is text-only on mobile. No conflict. |

## UI Mockup

![Voice Mode UI States](screenshot.png){mockup:nimbalyst-local/mockups/native-ios-voice-mode.mockup.html}

Shows:
1. **Session List** - Voice idle indicator (minimized mic dot), mic badge on focused session, "Voice" pill in nav bar
2. **Session Detail (Listening)** - Floating mic button with animated ring, voice indicator in nav bar
3. **Session Detail (Speaking)** - Green animated speaker button, pending prompt card sliding up
4. **Voice Button States** - All four states in isolation (listening, processing, speaking, idle)
5. **Pending Prompt Card** - The only text UI, showing prompt to be sent with countdown and cancel/send buttons

## Success Criteria

- Voice mode activates with a single tap and immediately starts listening
- User can converse naturally via voice-to-voice - ask questions, give coding tasks, get status updates
- When the voice agent wants to submit a prompt, a confirmation card appears with the prompt text and a countdown
- User can cancel or send the pending prompt immediately
- Voice agent correctly routes prompts to the right session
- When a coding task completes, voice mode automatically announces the result via speech
- After the announcement, user can give follow-up instructions via voice
- Voice mode indicators are clearly visible on session list and detail screens
- Audio works correctly with AirPods, speaker, and earpiece
- Idle timeout prevents unnecessary API costs
- Deactivation is instant and clean (no lingering audio)
