---
planStatus:
  planId: plan-openai-voice-mode-integration
  title: OpenAI Advanced Voice Mode Integration
  status: in-development
  planType: feature
  priority: medium
  owner: ghinkle
  stakeholders: []
  tags:
    - voice-interface
    - openai
    - ai-integration
    - electron
  created: "2026-01-10"
  updated: "2026-07-01T00:00:00.000Z"
  progress: 80
  startDate: "2026-01-10"
---
# OpenAI Advanced Voice Mode Integration

> **Status as of 2026-07-01:** Desktop voice mode is shipped and in daily use, well past this plan's snapshot — including extension voice tools, backend-module voice tools, memory grounding, and the brainstorm-loop tools (NIM-922); see [docs/VOICE_MODE.md](../../docs/VOICE_MODE.md) for the as-built architecture. Still open from this plan: context summarization before truncation, usage cost tracking/warnings UI, and session-switch / multi-window edge cases. Echo cancellation round 2 is planned (NIM-1314).

## Implementation Progress (Electron)

### Phase 1: Research & Proof of Concept ✅
- [x] Create basic WebSocket connection to OpenAI Realtime API
- [x] Implement audio capture from microphone (24kHz PCM16)
- [x] Implement audio playback of OpenAI responses
- [x] Add voice mode settings UI and configuration
- [x] Test basic voice conversation (no Claude Code integration)
- [x] Fix audio overlap bugs (multiple voices playing simultaneously)
- [x] Implement interruption handling (user can interrupt assistant)

### Phase 2: VoiceModeService Core ✅
- [x] Create VoiceModeService class in main process (`VoiceModeService.ts`)
- [x] Create RealtimeAPIClient for WebSocket management (`RealtimeAPIClient.ts`)
- [x] Implement WebSocket connection lifecycle management
- [x] Add connection state tracking (connected, listening, speaking)
- [x] Implement audio buffer processing (float32 to PCM16 conversion)
- [x] Add IPC handlers for renderer communication
- [x] Integrate with AIService for OpenAI API key management
- [x] Add inactivity timeout (5 minutes auto-disconnect)
- [x] Implement token usage tracking and logging

### Phase 3: Claude Code Integration ✅
- [x] Define tool schema (submit_agent_prompt)
- [x] Implement submit_agent_prompt tool handler
- [x] Integrate with queuing system for sequential prompt processing
- [x] Implement completion event detection and notification
- [x] Create voice_agent_speak MCP tool for coding agent → voice agent communication
- [x] Implement unified agent persona (voice agent speaks as coding agent)
- [x] Test end-to-end: voice command → Claude Code execution → voice response

### Phase 4: Response Filtering ✅
- [x] Design and implement response summarization logic
- [x] Extract completion summaries from coding agent responses
- [x] Create voice-friendly completion notifications
- [x] Implement system prompt for voice assistant (unified persona)

### Phase 5: UI Integration ✅
- [x] Add voice mode toggle button to UI (ChatHeader)
- [x] Implement voice mode indicator (visual states)
- [x] Display live transcription of user speech
- [x] Link voice-initiated sessions to AI session list
- [x] Add voice mode settings panel (voice selection, transcription toggle)
- [x] Add voice mode enable/disable in global settings

### Phase 6: Context & Polish 🚧
- [x] Implement conversation context management (session name, message counts)
- [x] Pass workspace/file context to Claude Code
- [x] Handle errors gracefully with voice feedback
- [x] Implement response cancellation and audio clearing on interrupt
- [x] Add voice mode settings (voice selection, turn detection, VAD threshold, etc.)
- [x] Add all 10 OpenAI voices with preview functionality
- [x] Group voices by gender in settings dropdown
- [x] Migrate voice settings to Jotai atoms for reactive updates
- [x] Add PostHog analytics (voice_mode_enabled/disabled)
- [x] Fix transcription display visibility (CSS variable fixes)
- [x] Fix duplicate text in transcription (IPC listener cleanup)
- [x] Move transcription display to dedicated inline panel (not floating overlay)
- [x] Add streaming transcription delta support (live partial transcription)
- [x] Disable help tooltip when voice mode is active
- [ ] Add conversation reset functionality
- [ ] Handle edge cases (session switching, multiple windows)

### Phase 7: Token Tracking & Context Management 🚧
- [x] Implement token usage tracking in RealtimeAPIClient
- [x] Add IPC event for real-time token usage updates (voice-mode:token-usage)
- [x] Create VoiceContextIndicator component (live progress bar)
- [x] Show token count next to voice button when active
- [x] Return final token usage from disconnect IPC call
- [x] Persist voice token usage to session metadata JSONB on disconnect
- [ ] Add context summarization before truncation (per OpenAI cookbook)
- [ ] Implement memory system for voice context efficiency and relevance?
- [ ] Add usage cost tracking/warnings UI

## Actual Implementation

### Core Files (Production)
- **`RealtimeAPIClient.ts`** - WebSocket client for OpenAI Realtime API
- **`VoiceModeService.ts`** - Main service managing voice sessions
- **`VoiceModeSettingsHandler.ts`** - IPC handlers for voice mode settings
- **`audioCapture.ts`** - Microphone capture (PCM16, 24kHz)
- **`audioPlayback.ts`** - Audio playback with scheduled buffer management
- **`VoiceModeButton.tsx`** - UI component for voice mode toggle
- **`VoiceModePanel.tsx`** - Settings panel for voice configuration
- **`VoiceTranscriptionDisplay.tsx`** - Live transcription panel (user speech + AI responses)
- **`VoiceContextIndicator.tsx`** - Token usage progress bar (debug/development)
- **`appSettings.ts`** - Jotai atoms for voice mode settings (reactive updates)

### Key Implementation Details

**Tool Integration:**
- Voice agent has `submit_agent_prompt` tool to queue coding tasks
- Coding agent has `voice_agent_speak` MCP tool to send spoken messages back
- Tools are dynamically exposed based on voice mode state

**Audio Pipeline:**
- Microphone → Float32 → PCM16 → Base64 → WebSocket → OpenAI
- OpenAI → Base64 → PCM16 → Web Audio API → Speakers
- Scheduled audio playback prevents overlapping voices
- Interruption stops all scheduled audio sources immediately

**Session Management:**
- Voice mode is session-scoped (one voice session per AI session)
- Global singleton for audio instances (only one active at a time)
- 5-minute inactivity timeout auto-disconnects to save tokens
- Token usage tracked per session (input/output audio + text)
- Voice token usage persisted to session `metadata.voiceTokenUsage` JSONB field

**Transcription & Context:**
- Live transcription via `conversation.item.input_audio_transcription.delta` events
- Final transcription via `conversation.item.input_audio_transcription.completed`
- Transcription panel shows both user speech (YOU) and AI responses (AI)
- Context window: ~28k tokens effective (128k documented, but quality degrades)
- Auto-truncation: OpenAI drops oldest messages when limit reached (no summarization)

**Voice Settings (Jotai atoms for reactive updates):**
- Voice selection (10 voices grouped by male/female/neutral)
- Turn detection mode (server_vad vs push_to_talk)
- VAD threshold (0.0-1.0)
- Silence duration (ms before speech end detected)
- Interruptibility toggle
- Show transcription toggle
- Custom prompts for voice agent and coding agent

**Unified Agent Persona:**
- Voice agent speaks in first person as the coding agent
- "I'll work on that" instead of "The coding agent will work on that"
- Internal completion messages formatted as `[INTERNAL: ...]`
- Reduces user confusion about separate agents

## Overview

Integrate OpenAI's Advanced Voice Mode API as a voice-controlled interface layer for Claude Code within Nimbalyst. The voice assistant will act as an intelligent intermediary that:
1. Accepts voice commands from users
2. Translates them into Claude Code prompts
3. Receives responses from Claude Code
4. Summarizes and explains results back to the user via voice

## Goals

- Provide hands-free interaction with Claude Code
- Enable natural language voice control for development tasks
- Create an intelligent translation layer between voice commands and Claude Code operations
- Maintain context across voice interactions
- Deliver concise, spoken summaries of Claude Code's actions

## Architecture

### High-Level Flow

```
User Voice Input
    ↓
OpenAI Advanced Voice Mode (with tools)
    ↓
Tool: submit_claude_code_prompt(prompt: string)
    ↓
Claude Code SDK / AIService
    ↓
Claude Code executes task
    ↓
Response subset extracted
    ↓
OpenAI Voice Mode summarizes
    ↓
User receives voice response
```

### Detailed Event Flow

**Scenario 1: Simple Task Completion**

```
1. User speaks: "Add a function to calculate fibonacci numbers"
2. OpenAI Voice → calls submit_claude_code_prompt("Add a function to calculate fibonacci numbers")
3. VoiceModeService → creates Claude Code session, returns sessionId
4. Claude Code → starts working (emits session:tool-use events as it works)
5. VoiceModeService → optionally narrates: "Claude Code is working on it..."
6. Claude Code → emits session:complete event with summary
7. VoiceModeService → injects message: "Claude Code finished. Created fibonacci.ts with the function."
8. OpenAI Voice → "I've added the fibonacci function. Claude created a new file called fibonacci.ts with the implementation."
```

**Scenario 2: Claude Code Needs Clarification**

```
1. User speaks: "Add authentication to the app"
2. OpenAI Voice → calls submit_claude_code_prompt("Add authentication")
3. VoiceModeService → creates session
4. Claude Code → uses AskUserQuestion tool
5. Claude Code → emits session:user-input-required event
   Payload: { question: "Which method?", options: ["OAuth2", "JWT", "Sessions"] }
6. VoiceModeService → injects message: "Claude needs input: Which auth method?"
7. OpenAI Voice → asks user naturally: "Which authentication method would you prefer? OAuth2, JWT, or session-based?"
8. User speaks: "Let's use JWT"
9. OpenAI Voice → calls answer_claude_code_question(sessionId, "JWT")
10. VoiceModeService → forwards answer to Claude Code session
11. Claude Code → continues working with JWT
12. Claude Code → emits session:complete
13. VoiceModeService → injects completion message
14. OpenAI Voice → "Done! I've added JWT authentication with login and token validation."
```

**Scenario 3: Long-Running Task with Progress Updates**

```
1. User speaks: "Run the test suite"
2. OpenAI Voice → calls submit_claude_code_prompt("Run tests")
3. VoiceModeService → creates session
4. Claude Code → uses Bash tool (emits session:tool-use: "Running npm test")
5. VoiceModeService → injects: "Running tests now..."
6. OpenAI Voice → "Running the tests now, this might take a moment."
7. [30 seconds pass]
8. Claude Code → emits session:complete with test results
9. VoiceModeService → injects: "Tests complete. 47 passed, 2 failed in the auth module."
10. OpenAI Voice → "The tests are done. 47 tests passed, but there are 2 failures in the authentication module. Would you like me to investigate those failures?"
```

### Components

#### 1. Voice Mode Service (`packages/electron/src/main/services/voice/VoiceModeService.ts`)

New service responsible for:
- Managing OpenAI Advanced Voice Mode WebSocket/API connection
- Handling audio streaming (input/output)
- Managing conversation state
- Coordinating with AIService

#### 2. Voice Mode Tools

Custom function calling tools exposed to OpenAI's voice mode:

**`submit_claude_code_prompt`**
```typescript
{
  name: "submit_claude_code_prompt",
  description: "Submit a prompt to Claude Code to perform development tasks. This is async - Claude Code will send updates as it works. You'll receive notification when it completes or needs user input.",
  parameters: {
    prompt: string,        // The prompt to send to Claude Code
    workspacePath?: string // Optional workspace path
  }
}
```

**`get_claude_code_status`**
```typescript
{
  name: "get_claude_code_status",
  description: "Check if Claude Code is currently processing a task",
  parameters: {}
}
```

#### 2b. Claude Code Event Subscriptions

The VoiceModeService subscribes to AIService events to track session state:

**Events to monitor:**
- `session:message` - New message from Claude Code (streaming chunks)
- `session:complete` - Claude Code finished its turn
- `session:error` - Claude Code encountered an error
- `session:user-input-required` - Claude Code needs user clarification (AskUserQuestion tool usage)
- `session:tool-use` - Claude Code is using a tool (for progress updates)

**Notification Strategy:**

When voice mode calls `submit_claude_code_prompt`:
1. Function returns immediately with session ID
2. VoiceModeService subscribes to that session's events
3. As events arrive, VoiceModeService sends updates back to OpenAI Realtime API
4. OpenAI voice assistant narrates progress and final results

**How updates reach the voice assistant:**

Use OpenAI's conversation item API to inject server-side messages:

```typescript
// When Claude Code completes
websocket.send({
  type: "conversation.item.create",
  item: {
    type: "message",
    role: "user", // Pretend user is providing update
    content: [{
      type: "input_text",
      text: "Claude Code has finished. It edited 3 files and ran the tests successfully. The build passed."
    }]
  }
});

// Trigger assistant response
websocket.send({
  type: "response.create"
});
```

This makes the voice assistant aware of completion and able to respond naturally.

**Handling AskUserQuestion:**

When Claude Code uses the AskUserQuestion tool (needs clarification):

1. VoiceModeService detects `session:user-input-required` event
2. Extract question and options from the event payload
3. Inject into voice conversation:

```typescript
websocket.send({
  type: "conversation.item.create",
  item: {
    type: "message",
    role: "user",
    content: [{
      type: "input_text",
      text: "Claude Code needs your input: Which authentication method should we use? Options: 1) OAuth2, 2) JWT, 3) Session cookies"
    }]
  }
});
websocket.send({ type: "response.create" });
```

4. Voice assistant asks user the question naturally
5. User responds via voice
6. Voice assistant calls a new tool: `answer_claude_code_question`
7. VoiceModeService forwards answer back to Claude Code session
8. Claude Code continues working

**Additional tool needed:**

```typescript
{
  name: "answer_claude_code_question",
  description: "Provide an answer to a question Claude Code asked",
  parameters: {
    sessionId: string,
    answer: string // The user's response
  }
}
```

#### 3. Response Filtering & Summarization

Implement intelligent filtering to:
- Extract key information from Claude Code's verbose output
- Identify completed actions (files edited, tests run, etc.)
- Filter out technical details unnecessary for voice
- Format information suitable for spoken delivery

#### 4. UI Components

**Voice Mode Indicator**
- Visual indicator showing voice mode is active/listening
- Display transcription of user's voice input
- Show voice assistant's thinking/processing state

**Voice Mode Panel** (optional)
- Conversation history
- Manual prompt override
- Voice settings (enable/disable, audio device selection)


### Memory System Design

Voice sessions have limited context windows (~28k effective tokens) and OpenAI auto-truncates oldest messages without summarization. To maintain context across short voice sessions, we need a memory system.

**Architecture:**
- Voice sessions are short-lived (context ages out)
- Voice agent has tools to query external sources rather than maintaining large context
- Memory could store concise concepts and facts that we then filter in the app before sending to the voice mode agent

**Proposed Tools for Voice Agent:**
1. `ask_coding_agent` - Query the coding agent for information (existing)
2. `query_memory` - Retrieve stored facts/context from memory system (future)
3. `save_to_memory` - Explicitly save important information (future)
  1. Coding agent categorizes by context?

**Context Summarization Strategy (per OpenAI Cookbook):**
1. Monitor token count after each response (`response.done` event)
2. When approaching threshold (~2k tokens for quality, not 28k limit):
  - Summarize older conversation turns
  - Delete old items from Realtime session (server-side)
  - Keep summary as SYSTEM message + last 2 turns
3. Store summaries in memory system for retrieval in future sessions

**Key Insight:** Quality degrades well before the 28k limit is hit. Summarize early.

**SYSTEM vs ASSISTANT for summaries:** Use SYSTEM messages for summaries. ASSISTANT messages can cause the model to mistakenly switch from audio to text responses during extended conversations.

**References:**
- [Context Summarization with Realtime API | OpenAI Cookbook](https://cookbook.openai.com/examples/context_summarization_with_realtime_api)
- [GitHub Notebook](https://github.com/openai/openai-cookbook/blob/main/examples/Context_summarization_with_realtime_api.ipynb) 




## Implementation Phases

### Phase 1: OpenAI Advanced Voice Mode Research & Setup

**Tasks:**
- Research OpenAI's Advanced Voice Mode API documentation
- Understand WebSocket/streaming requirements
- Identify audio format requirements (sample rate, encoding)
- Test basic voice mode connection and audio streaming
- Understand function calling capabilities in voice mode

**Deliverables:**
- Working proof-of-concept connecting to OpenAI Voice Mode
- Documentation of API requirements and capabilities
- Audio pipeline implementation (microphone input → OpenAI)

### Phase 2: VoiceModeService Implementation

**Tasks:**
- Create `VoiceModeService` in electron main process
- Implement WebSocket connection management
- Handle audio streaming (capture from microphone)
- Implement audio playback (OpenAI voice responses)
- Add connection state management (connected, listening, thinking, speaking)
- Integrate with existing AIService for API key management

**Deliverables:**
- Functional VoiceModeService
- IPC handlers for renderer process communication
- Basic voice conversation capability

### Phase 3: Claude Code Tool Integration & Event Handling

**Tasks:**
- Define `submit_claude_code_prompt` and `answer_claude_code_question` tool schemas
- Implement tool handler that calls AIService.sendMessage()
- Subscribe to AIService events for the created session:
  - `session:message` - Stream Claude Code's responses
  - `session:complete` - Detect when Claude finishes
  - `session:error` - Handle errors
  - `session:user-input-required` - Detect AskUserQuestion usage
  - `session:tool-use` - Track progress (optional)
- Implement event-to-voice translation:
  - Convert session events to OpenAI conversation items
  - Use `conversation.item.create` to inject updates
  - Trigger `response.create` to make voice assistant respond
- Implement `answer_claude_code_question` tool handler to forward answers back to Claude
- Add error handling for Claude Code failures

**Deliverables:**
- Voice assistant can successfully invoke Claude Code
- Prompts from voice mode create AI sessions
- Voice assistant receives real-time updates as Claude works
- Voice assistant can ask clarifying questions on Claude's behalf
- User answers reach Claude Code and work continues

### Phase 4: Response Filtering & Summarization

**Tasks:**
- Design response extraction strategy (what to tell user via voice)
- Implement parser for Claude Code's structured responses
- Extract action summaries (files changed, commands run)
- Filter out tool use details, code diffs (keep for UI display)
- Create concise spoken summaries

**System Prompt for Voice Assistant:**
```
You are a voice interface for Claude Code, an AI coding assistant.
When the user asks you to perform coding tasks:
1. Use the submit_claude_code_prompt tool to send the request to Claude Code
2. Wait for the response
3. Summarize what Claude Code did in 1-2 sentences
4. Ask if the user wants to know more details

Keep responses concise and natural for voice. Don't read out code or long technical details.
```

**Deliverables:**
- Response parsing logic
- Spoken summary generation
- System prompt for voice assistant

### Phase 5: UI Integration

**Tasks:**
- Add voice mode toggle to Nimbalyst UI
- Implement voice mode indicator (listening/thinking/speaking states)
- Show live transcription of user speech
- Display voice assistant responses in UI
- Link voice-initiated AI sessions to session list
- Add settings for voice mode (enable/disable, model selection)

**Deliverables:**
- Voice mode UI components
- Settings integration
- Visual feedback during voice interaction

### Phase 6: Context & State Management

**Tasks:**
- Maintain conversation context across voice interactions
- Track which workspace/files are in focus
- Pass relevant context to Claude Code (open files, recent changes)
- Implement conversation reset/new session
- Handle multi-turn conversations

**Deliverables:**
- Stateful voice conversations
- Context-aware prompting
- Conversation management

### Phase 7: Capacitor (Mobile) Integration

**Architecture Decision: Where Does Voice Processing Happen?**

Two possible approaches:

**Option A: Mobile-Direct (Voice on iOS/Android device)**
- iOS/Android app connects directly to OpenAI Realtime API
- Voice processing happens on mobile device
- Mobile app communicates with Electron via CollabV3 sync
- Mobile sends Claude Code prompts to Electron
- Electron sends back completion notifications

**Option B: Mobile-Remote (Voice on Electron desktop)**
- iOS/Android app streams audio to Electron desktop
- Electron handles all OpenAI Realtime API communication
- Mobile app is just audio capture/playback device
- Requires real-time audio streaming between mobile and desktop

**Recommended: Option A (Mobile-Direct)**

Mobile devices have better audio APIs and direct access to microphone/speaker hardware. Keep voice processing local to the device.

**Implementation Tasks:**

1. **Capacitor Audio Capture Plugin**
  - Use native iOS `AVAudioEngine` / Android `AudioRecord`
  - Capture PCM16 at 24kHz
  - Convert to base64 for WebSocket transmission

2. **Mobile VoiceModeService** (`packages/capacitor/src/services/VoiceModeService.ts`)
  - Similar to Electron version but uses Capacitor APIs
  - WebSocket connection to OpenAI Realtime API
  - Implement same tool calling interface

3. **Cross-Device Communication via CollabV3**

   When mobile voice mode wants to invoke Claude Code on desktop:

```typescript
   // Mobile sends via CollabV3
   {
     type: "voice-command",
     sessionId: "mobile-voice-session-123",
     prompt: "Add a fibonacci function",
     workspacePath: "/path/to/project"
   }
```

   Desktop Electron receives via CollabV3 sync:
  - Creates Claude Code session
  - Subscribes to session events
  - Sends completion notification back via CollabV3

```typescript
   // Desktop sends back via CollabV3
   {
     type: "voice-command-complete",
     sessionId: "mobile-voice-session-123",
     summary: "Created fibonacci.ts with the function",
     desktopSessionId: "claude-session-456"
   }
```

   Mobile receives completion and narrates via voice.

4. **UI Components**
  - Voice mode button in mobile app header
  - Visual feedback for listening/thinking/speaking states
  - Transcription display
  - Link to desktop session (tap to view full Claude Code output on desktop)

5. **Mobile-Specific Considerations**
  - **Background audio**: Keep voice mode active when app backgrounded
  - **Permissions**: Request microphone permissions appropriately
  - **Battery**: Monitor power usage, warn if excessive
  - **Network**: Handle offline/poor connection gracefully
  - **AirPods/Bluetooth**: Support wireless audio devices

**Alternative: Hybrid Approach**

Use **WebRTC** instead of WebSocket for mobile:
- OpenAI Realtime API supports WebRTC (designed for browser clients)
- WebRTC handles audio capture/encoding automatically
- Better suited for mobile browsers/web views
- Built-in echo cancellation and noise suppression

```typescript
// Mobile uses WebRTC instead of WebSocket
const pc = new RTCPeerConnection();
// OpenAI provides ephemeral token for WebRTC connection
// Audio automatically routed through WebRTC media streams
```

**Deliverables:**
- Mobile app can initiate voice commands
- Voice commands trigger Claude Code on connected desktop
- User receives voice feedback on mobile
- Link to view full output on desktop
- Works with AirPods and other Bluetooth devices

## Technical Considerations

### Audio Requirements

- **Input**: Capture microphone audio at 24kHz sample rate, PCM16 format, mono
- **Output**: Receive and play base64-encoded PCM16 audio at 24kHz from OpenAI
- **Electron audio APIs**: Use `navigator.mediaDevices.getUserMedia` in renderer for capture
- **Audio Processing**: Convert float32 audio from browser APIs to PCM16, then base64 encode
- **Buffering**: Send audio in chunks (max 15MB each) via `input_audio_buffer.append` events

### OpenAI API Requirements

- API key management (reuse existing AIService patterns)
- WebSocket connection lifecycle
- Handle reconnection on failures
- Rate limiting and quota management

### Performance

- Audio streaming must be low-latency
- Don't block UI during voice processing
- Handle Claude Code's async nature (long-running tasks)
- Provide feedback while Claude Code is working

### Privacy & Security

- Audio data only sent to OpenAI (not stored locally by default)
- API keys stored securely
- Option to disable voice mode entirely
- Clear indication when microphone is active

## API Research Findings

### API Availability
OpenAI's Realtime API (Advanced Voice Mode for developers) is now **generally available** to all paid developers. The latest model `gpt-realtime` was released with production-grade improvements for reliability, low latency, and high quality voice agents.

### Audio Format Requirements

**For WebSocket connections:**
- **Format**: PCM16 (16-bit PCM audio)
- **Sample Rate**: 24 kHz
- **Channels**: Mono (single channel)
- **Byte Order**: Little-endian
- **Encoding**: Base64-encoded chunks sent via WebSocket
- **Alternative formats**: g711_ulaw or g711_alaw
- **Max chunk size**: 15 MB per chunk

### Connection Methods

Three supported interfaces:
1. **WebSocket**: Best for server-side applications with consistent low-latency connections (recommended for Electron)
2. **WebRTC**: Ideal for browser/client-side interactions
3. **SIP**: For VoIP telephony connections

**WebSocket endpoint:**
```
wss://api.openai.com/v1/realtime?model=gpt-realtime
```

### Function Calling Support

The Realtime API has full function calling support with specific events:

**Server Events:**
- `response.function_call_arguments.delta` - Streaming function call arguments
- `response.function_call_arguments.done` - Function call arguments complete

**Configuration:**
- Tools defined in session configuration or per-response
- Standard JSON schema format for function definitions
- Session can be updated with `session.update` client event

### Event System

**Client Events:**
- `session.update` - Update session configuration (tools, instructions, etc.)
- `input_audio_buffer.append` - Send base64-encoded audio chunks
- `input_audio_buffer.commit` - Commit audio buffer for processing
- `response.create` - Request model to generate response

**Server Events:**
- `session.created` - Session ready
- `response.audio.delta` - Streaming audio output
- `response.audio.done` - Audio output complete
- `response.text.delta` - Streaming text output
- `response.function_call_arguments.*` - Function calling events

### Pricing (2026)

**Audio Costs:**
- Audio Input: $0.06 per minute
- Audio Output: $0.24 per minute

**Token Costs (in addition to audio):**
- Text Input: $5 per 1M tokens
- Text Output: $20 per 1M tokens

**Cost Formula:**
```
Total = (Audio in minutes × $0.06) + (Audio out minutes × $0.24) +
        (Input tokens ÷ 1M × $5) + (Output tokens ÷ 1M × $20)
```

**Example:** 4 minutes user speech + 1 minute AI speech + 1,500 input tokens + 600 output tokens ≈ $0.50 per call

### Voice Options

The `gpt-realtime` model includes:
- Two new voices: **Marin** and **Cedar**
- Support for voice instructions (e.g., "speak quickly and professionally", "speak empathetically in a French accent")
- Higher quality, more natural-sounding speech

### Session Management

- Maximum session duration: 60 minutes
- Supports Voice Activity Detection (VAD)
- Interruption handling built-in
- Push-to-talk support

## Mobile Integration Trade-offs

### WebSocket vs WebRTC for Mobile

| Aspect | WebSocket (Electron approach) | WebRTC (Mobile-optimized) |
| --- | --- | --- |
| **Audio Handling** | Manual PCM16 encoding | Automatic encoding/decoding |
| **Noise Suppression** | Must implement manually | Built-in |
| **Echo Cancellation** | Must implement manually | Built-in |
| **Complexity** | Higher (manual audio pipeline) | Lower (browser handles audio) |
| **Battery Impact** | Potentially higher | Optimized by browser |
| **Network Efficiency** | WebSocket overhead | Optimized for real-time media |
| **Browser Support** | Requires native code | Works in web views |
| **Recommendation** | Use for Electron | Use for Capacitor mobile |

### Mobile-Specific UX Considerations

**Voice Mode Activation:**
- **Push-to-talk**: Hold button to speak (most battery-efficient)
- **Tap-to-toggle**: Tap once to start, tap again to stop
- **Voice Activity Detection**: OpenAI handles detection (easiest UX)

**Recommended for mobile:** Tap-to-toggle with VAD (hands-free while active)

**Background Audio:**
iOS requires specific entitlements to keep audio sessions active:
```xml
<!-- Info.plist -->
<key>UIBackgroundModes</key>
<array>
  <string>audio</string>
</array>
```

This allows voice mode to continue working when:
- App is minimized
- Screen is locked
- User switches to another app

**Cross-Device Session Linking:**

Mobile displays minimal info, desktop shows full details:
```
[Mobile View]
🎤 "Add fibonacci function"
✓ Claude Code finished
→ Tap to view on desktop

[Desktop View]
Full AI session with:
- Complete transcript
- Files changed
- Diffs
- Tool usage
```

## Open Questions

1. **~~Wake Word~~**~~: Should we support push-to-talk, always-on listening, or wake word activation?~~ **RESOLVED:** Settings support both VAD and push-to-talk modes
2. **~~Voice Selection~~**~~: Should voice selection (Marin vs Cedar) be a user setting?~~ **RESOLVED:** All 10 voices available in settings with preview
3. **Session Duration**: How to handle 60-minute session limit for long coding sessions?
4. **Cost Controls**: Should we add usage warnings/limits for voice mode to control API costs?
5. **Mobile WebRTC vs WebSocket**: Start with WebRTC for mobile or use consistent WebSocket approach?
6. **Offline Desktop**: What happens if desktop is offline when mobile sends voice command?
7. **Multi-Desktop**: If user has multiple desktops, which one receives the voice command?
8. **Memory System**: How should memory be structured? Per-project? Per-user? What granularity?
9. **Context Summarization**: When to trigger summarization? 2k tokens (quality) or closer to 28k (limit)?
10. **Voice Session Persistence**: Should we track individual voice sessions separately, or just aggregate tokens per coding session?

## Success Criteria

- User can activate voice mode and give verbal commands
- Voice commands successfully trigger Claude Code operations
- User receives clear, concise voice feedback about what Claude Code did
- Full Claude Code output remains visible in UI
- Voice mode handles errors gracefully
- Audio quality is clear and low-latency

## Future Enhancements

- Support for voice interruption (stop Claude Code mid-task)
- Voice-controlled navigation (open files, switch tabs)
- Voice annotations (dictate comments, documentation)
- Multi-language support
- Offline voice mode (local speech-to-text)

## References

### OpenAI Documentation
- [Introducing the Realtime API](https://openai.com/index/introducing-the-realtime-api/)
- [Introducing gpt-realtime](https://openai.com/index/introducing-gpt-realtime/)
- [Realtime API Guide](https://platform.openai.com/docs/guides/realtime)
- [Realtime API with WebSocket](https://platform.openai.com/docs/guides/realtime-websocket)
- [Realtime API Reference](https://platform.openai.com/docs/api-reference/realtime)
- [Client Events Reference](https://platform.openai.com/docs/api-reference/realtime-client-events)
- [Server Events Reference](https://platform.openai.com/docs/api-reference/realtime-server-events)
- [Voice Agents Guide](https://platform.openai.com/docs/guides/voice-agents)
- [Realtime Conversations Guide](https://platform.openai.com/docs/guides/realtime-conversations)
- [Pricing](https://platform.openai.com/docs/pricing)

### Technical Resources
- Claude Code SDK documentation
- Electron audio APIs
- WebSocket audio streaming patterns
