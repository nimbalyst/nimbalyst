---
planStatus:
  planId: plan-mobile-voice-control-system
  title: Mobile Voice Control System for Desktop Agents
  status: in-development
  planType: feature
  priority: high
  owner: ghinkle
  stakeholders:
    - ghinkle
  tags:
    - voice-mode
    - mobile-sync
    - capacitor
    - claude-code
  created: "2026-01-17"
  updated: "2026-07-01T00:00:00.000Z"
  progress: 58
  startDate: "2026-01-17"
---

# Mobile Voice Control System for Desktop Agents

> **Status as of 2026-07-01:** Largely superseded by the native iOS voice agent ([native-ios-voice-mode.md](native-ios-voice-mode.md)), which is the shipped voice surface on mobile — voice-to-voice with cross-session tools rather than the transcribe-and-queue flow this plan describes. Phase 1 (capture, session selector, pending command validation) shipped; the remaining Phase 2-4 items (TTS summaries, desktop voice-control indicator, offline transcription, shortcuts, background mode) should be re-scoped against the native agent before any further work.

## Implementation Progress

### Phase 1: Foundation (Core Infrastructure)
- [x] Create VoiceCaptureService for iOS audio capture and transcription
- [x] Create RealtimeAPIClient for mobile (adapted from desktop)
- [x] Add microphone permissions to Info.plist
- [x] Create VoiceSessionSelector screen (session list for voice control)
- [x] Create VoiceControlScreen with recording UI and pending command validation
- [x] Extend QueuedPrompt type with voice metadata
- [x] Add voice button to project list screen
- [ ] Add OpenAI API key configuration to settings
- [ ] Test voice command routing through sync to desktop

### Phase 2: Enhanced Experience
- [ ] Add iOS TTS for agent completion summaries
- [x] Add haptic feedback for voice events (implemented in VoiceControlScreen)
- [ ] Add voice control indicator to desktop AgentSessionHeader
- [ ] Add voice-aware context to prompt construction

## Overview

Enable users to control their desktop AI coding sessions via voice from their iPhone/iPad. The system extends the existing voice mode architecture to the Capacitor mobile app, allowing voice commands to be routed through the sync infrastructure to execute on any "open" session on the desktop.

This creates a powerful workflow where users can be away from their desk but still interact with Claude Code running on their desktop machine via natural voice commands from their phone.

## Current Architecture Summary

### Desktop Voice Mode (Existing)

The desktop app has a fully functional voice mode implementation:

1. **VoiceModeService** - Main process orchestrator managing OpenAI Realtime API WebSocket connections
2. **RealtimeAPIClient** - WebSocket client handling audio streaming (24kHz PCM16)
3. **VoiceModeButton** - Renderer component managing audio capture/playback lifecycle
4. **PendingVoiceCommand** - UI for editing transcribed prompts before submission
5. **Queued Prompts System** - Same queue used by mobile sync for sequential prompt processing

### Mobile Sync (Existing)

The mobile app already has robust infrastructure for:

1. **CollabV3Sync** - WebSocket-based real-time sync with E2E encryption
2. **Session Control Messages** - Mobile can send cancel, question responses to desktop
3. **Queued Prompts** - Mobile can queue text prompts that desktop executes
4. **Device Presence** - Track which devices are connected and their activity state
5. **Push Notifications** - Desktop notifies mobile when agent completes

### Key Insight

The existing `queuedPrompts` system already allows mobile-to-desktop command routing. Voice mode on mobile needs to:
1. Capture and transcribe voice locally (or via API)
2. Convert transcription to text prompt
3. Route through existing sync infrastructure
4. Receive completion notifications

## Proposed Architecture

### Option A: Transcription-Only on Mobile (Recommended)

Mobile handles only audio capture and transcription. All Claude Code execution happens on desktop.

```
┌─ MOBILE ─────────────────────────────────────────┐
│                                                   │
│  Microphone → AudioCapture (24kHz) → OpenAI API  │
│                       │                           │
│                       ▼                           │
│              Transcription (text)                 │
│                       │                           │
│                       ▼                           │
│           PendingVoiceCommand UI                  │
│          (edit before send option)                │
│                       │                           │
│                       ▼                           │
│         CollabV3Sync.queuePrompt()               │
│                                                   │
└─────────────────────────────────────────────────┘
                        │
                        ▼ (index_broadcast with queuedPrompts)
┌─ DESKTOP ────────────────────────────────────────┐
│                                                   │
│  Existing queue processing in AgenticPanel       │
│           (no changes needed)                     │
│                       │                           │
│                       ▼                           │
│              Claude Code executes                 │
│                       │                           │
│                       ▼                           │
│         isExecuting state synced back            │
│                       │                           │
│                       ▼                           │
│    Push notification on completion               │
│                                                   │
└─────────────────────────────────────────────────┘
```

**Pros:**
- Minimal changes to existing infrastructure
- Uses proven mobile sync path
- Desktop handles all heavy lifting
- Works with any open session

**Cons:**
- No audio response on mobile (text only)
- Requires network connectivity for transcription
- Latency: transcription → sync → execute → sync back

### Option B: Full Voice Agent on Mobile

Run OpenAI Realtime API connection from mobile, proxy tool calls to desktop.

**Pros:**
- Rich audio back-and-forth experience
- Voice agent speaks responses aloud

**Cons:**
- Complex: need to proxy `submit_agent_prompt` tool to desktop
- Higher battery/data usage on mobile
- More state to synchronize
- Voice agent session state diverges from desktop

### Recommendation: Hybrid Approach

Start with **Option A** (transcription-only), then add **audio responses** via a new `voice_response` sync message type:

1. Mobile sends voice command as queued prompt
2. Desktop executes via Claude Code
3. Desktop uses `voice_agent_speak` MCP tool to send summary
4. Summary text sent to mobile via sync
5. Mobile uses local TTS (iOS Speech Synthesis) to speak response

This gives the voice experience without running Realtime API on mobile.

## Detailed Design

### Phase 1: Multi-Session Voice Control UI

Before implementing voice on mobile, users need to select which session to control.

#### 1.1 Session Selection Screen

New screen showing all "controllable" sessions from all projects:

```
┌─────────────────────────────────────────┐
│  Voice Control                     ← ×  │
├─────────────────────────────────────────┤
│                                         │
│  Select a session to control:           │
│                                         │
│  ┌─────────────────────────────────┐   │
│  │ 🤖 Fix auth bug                 │   │
│  │ nimbalyst-editor · Active       │   │
│  │ Last: "Fixing the login flow"   │   │
│  └─────────────────────────────────┘   │
│                                         │
│  ┌─────────────────────────────────┐   │
│  │ 🤖 Add dark mode                │   │
│  │ nimbalyst-editor · Idle         │   │
│  │ Last: "Theme system ready"      │   │
│  └─────────────────────────────────┘   │
│                                         │
│  ┌─────────────────────────────────┐   │
│  │ 🤖 Refactor database layer      │   │
│  │ client-project · Executing      │   │
│  │ "Running migrations..."         │   │
│  └─────────────────────────────────┘   │
│                                         │
└─────────────────────────────────────────┘
```

- Shows sessions from ALL synced projects
- Displays execution state (Active, Idle, Executing)
- Shows recent activity summary
- Filter to agent-mode sessions only

#### 1.2 Voice Control Mode

After selecting a session, enter voice control mode. The UI focuses on **command validation** rather than live transcription - once the voice agent processes speech, it presents the command for user review before sending.

```
┌─────────────────────────────────────────┐
│  Fix auth bug                      ← ×  │
│  nimbalyst-editor                       │
├─────────────────────────────────────────┤
│                                         │
│         ┌─────────────────┐             │
│         │                 │             │
│         │       🎤        │             │
│         │   Recording...  │             │
│         │                 │             │
│         └─────────────────┘             │
│                                         │
│  Status: Desktop connected              │
│                                         │
└─────────────────────────────────────────┘
```

After voice input is processed, show pending command validation:

```
┌─────────────────────────────────────────┐
│  Fix auth bug                      ← ×  │
│  nimbalyst-editor                       │
├─────────────────────────────────────────┤
│                                         │
│  Your command:                          │
│  ┌─────────────────────────────────┐   │
│  │ Add input validation to the     │   │
│  │ login form                      │   │
│  └─────────────────────────────────┘   │
│                [Edit]                   │
│                                         │
│  ┌─────────┐          ┌───────────┐    │
│  │ Cancel  │          │ Send Now  │    │
│  └─────────┘          └───────────┘    │
│                                         │
│  Auto-sending in 3s...                  │
│                                         │
└─────────────────────────────────────────┘
```

Components:
- Session context header
- Simple recording indicator (no live transcription)
- Pending command validation UI (editable text, countdown, cancel/send)
- Desktop connection status indicator

### Phase 2: Mobile Voice Capture

#### 2.1 Audio Capture Service

Create `packages/capacitor/src/services/VoiceCaptureService.ts`:

```typescript
interface VoiceCaptureService {
  // Start capturing audio
  startCapture(options: CaptureOptions): Promise<void>;

  // Stop capture and get final transcription
  // Returns the complete transcribed text for validation
  stopCapture(): Promise<string>;

  // Check if currently recording
  isRecording(): boolean;

  // Event emitters
  onTranscriptComplete(callback: (text: string) => void): void;
  onError(callback: (error: Error) => void): void;
}

interface CaptureOptions {
  // Use OpenAI Realtime API or native iOS speech recognition
  transcriptionProvider: 'openai-realtime' | 'ios-speech';
  // VAD settings - auto-stop after silence
  silenceThresholdMs?: number;
}
```

Note: No live transcription streaming - the UI just shows a recording indicator while capturing, then displays the final transcription for validation.

**Implementation Options:**

1. **OpenAI Realtime API** (Recommended) - Same API as desktop voice mode
   - Pros: Consistent with desktop, streaming transcription, high quality, same codebase
   - Cons: Network required, API costs, WebSocket connection management
   - Note: We would use it for transcription only, not full voice agent

2. **OpenAI Whisper API** - Batch transcription API
   - Pros: Simpler than Realtime, high quality
   - Cons: Higher latency (batch vs streaming), separate API from desktop

3. **iOS Speech Recognition** - Use native SFSpeechRecognizer
   - Pros: Works offline, no API cost, lower latency
   - Cons: Quality varies, iOS only

4. **Hybrid** - iOS for streaming preview, OpenAI for final transcription

**Recommendation:** Use OpenAI Realtime API for consistency with desktop. We can share code/patterns from `RealtimeAPIClient.ts` and get the same streaming transcription experience.

#### 2.2 Microphone Permissions

Use Capacitor's native permissions API:

```typescript
import { Microphone } from '@capacitor-community/microphone';

// Request permission
const status = await Microphone.requestPermission();
if (status.granted) {
  await voiceCaptureService.startCapture({ ... });
}
```

Add to `Info.plist`:
```xml
<key>NSMicrophoneUsageDescription</key>
<string>Nimbalyst needs microphone access to capture voice commands for your AI coding assistant.</string>
<key>NSSpeechRecognitionUsageDescription</key>
<string>Nimbalyst uses speech recognition to transcribe your voice commands.</string>
```

### Phase 3: Voice Command Routing

#### 3.1 Enhanced QueuedPrompt Structure

Extend the existing queued prompt to include voice metadata:

```typescript
interface QueuedPrompt {
  id: string;
  prompt: string;
  timestamp: number;

  // New: voice-specific metadata
  source?: 'keyboard' | 'voice';
  voiceMetadata?: {
    duration: number;           // Audio duration in seconds
    confidence: number;         // Transcription confidence
    originalTranscript: string; // Before user edits
  };
}
```

#### 3.2 Send Voice Command

In CollabV3SyncContext, add voice-aware prompt queueing:

```typescript
async function queueVoiceCommand(
  sessionId: string,
  transcript: string,
  metadata: VoiceMetadata
): Promise<void> {
  const prompt: QueuedPrompt = {
    id: crypto.randomUUID(),
    prompt: transcript,
    timestamp: Date.now(),
    source: 'voice',
    voiceMetadata: metadata
  };

  // Uses existing sync infrastructure
  await syncProvider.updateSessionMetadata(sessionId, {
    queuedPrompts: [...existing, prompt]
  });
}
```

### Phase 4: Response Feedback on Mobile

#### 4.1 Text Response Display

Already supported - session messages sync in real-time. Mobile shows agent responses as they stream.

#### 4.2 Audio Response (TTS)

Add iOS text-to-speech for agent completion summaries:

```typescript
import { TextToSpeech } from '@capacitor-community/text-to-speech';

// When agent task completes and voiceFeedbackEnabled
async function speakAgentResponse(summary: string): Promise<void> {
  await TextToSpeech.speak({
    text: summary,
    lang: 'en-US',
    rate: 1.0,
    pitch: 1.0,
    volume: 1.0,
    category: 'playback' // Allow background playback
  });
}
```

#### 4.3 Haptic Feedback

Use iOS haptics for key events:

```typescript
import { Haptics, ImpactStyle } from '@capacitor/haptics';

// Command sent
await Haptics.impact({ style: ImpactStyle.Medium });

// Agent completed
await Haptics.notification({ type: 'SUCCESS' });

// Error occurred
await Haptics.notification({ type: 'ERROR' });
```

### Phase 5: Desktop Awareness

#### 5.1 Voice Control Indicator

Show when mobile is controlling a session via voice:

```
┌─────────────────────────────────────────────┐
│ Fix auth bug                    📱🎤 Voice  │
├─────────────────────────────────────────────┤
```

Add to AgentSessionHeader when:
- Session has `isControlledByVoice: true` in metadata
- Or source of last queued prompt was 'voice'

#### 5.2 Voice Command Context

When processing a voice command, pass context to Claude Code:

```typescript
// In prompt construction
if (queuedPrompt.source === 'voice') {
  systemContext += `
Note: This command was given via voice from the user's mobile device.
Keep responses concise as they may be read aloud.
If you need clarification, ask simple yes/no questions when possible.
`;
}
```

### Phase 6: Advanced Features

#### 6.1 Voice Agent Proxy (Future)

Full bidirectional voice with desktop voice agent:

```
Mobile                    Desktop
  │                          │
  │── audio chunks ────────→ │ → OpenAI Realtime
  │                          │
  │←── audio response ────── │ ← OpenAI Realtime
  │                          │
  │←── tool_call events ──── │
  │                          │
  │── tool_result ─────────→ │
```

Would require new sync message types:
- `voice_audio_chunk` - Forward audio to desktop
- `voice_audio_response` - Return audio from desktop
- `voice_tool_call` - Tool call notification
- `voice_tool_result` - Tool result response

#### 6.2 Multi-Session Voice Control

"Switch to the dark mode session" voice command that routes to session selector.

Voice commands:
- "Switch to [session name]"
- "What sessions are running?"
- "Check status of [session name]"
- "Cancel current task"

#### 6.3 Voice Shortcuts

Quick voice commands that don't need full Claude processing:
- "Status" → Read current agent state
- "Cancel" → Abort current execution
- "Resume" → Resume paused session
- "Approve" → Approve pending file changes

## Implementation Phases

### Phase 1: Foundation (Core Infrastructure)

1. Voice capture service for iOS
2. Session selection screen for voice control
3. Voice command UI with transcription display
4. Route voice commands through existing sync
5. Basic text response display

### Phase 2: Enhanced Experience

1. iOS TTS for agent responses
2. Haptic feedback
3. Voice control indicator on desktop
4. Voice-aware prompt context

### Phase 3: Polish and Optimization

1. Offline transcription via iOS Speech
2. Voice shortcuts for common actions
3. Background voice mode (audio session)
4. Battery optimization

### Phase 4: Advanced (Future)

1. Full voice agent proxy
2. Multi-session voice routing
3. Custom wake word ("Hey Nimbalyst")

## Technical Considerations

### Battery Life

Voice capture is power-intensive. Mitigations:
- Auto-stop after configurable silence duration
- Screen-off handling (pause capture)
- Visual indicator of active capture
- Session time limits

### Network Reliability

Voice commands should handle network issues:
- Queue commands locally if sync disconnected
- Retry transcription on failure
- Clear feedback when command is pending vs sent

### Privacy

All voice data handling:
- Audio never stored persistently
- Transcription uses existing E2E encryption
- Voice metadata (duration, etc.) is also encrypted
- No audio sent to Nimbalyst servers

### Permissions

Required iOS permissions:
- Microphone (NSMicrophoneUsageDescription)
- Speech Recognition (NSSpeechRecognitionUsageDescription)
- Push Notifications (for completion alerts)

## Open Questions

1. **Transcription Provider**: OpenAI Realtime API (consistent with desktop) vs iOS native (offline capable)? Recommendation is Realtime API for code sharing.

2. **Always-On Mode**: Should we support a "wake word" mode where the app listens continuously? Significant battery implications.

3. **Audio Responses**: How verbose should TTS responses be? Should we summarize or read full responses?

4. **Multi-Session UX**: How do users switch between sessions mid-voice-command? Explicit UI or voice command?

5. **Background Mode**: Should voice control work when app is backgrounded? Requires AVAudioSession configuration.

## Success Metrics

- Voice command transcription accuracy > 95%
- Command-to-execution latency < 3 seconds
- User satisfaction with voice control flow
- Battery impact < 5% per 10 minutes of voice use
- Zero audio data leakage (privacy audit)

## Dependencies

### New Capacitor Plugins

```json
{
  "@capacitor-community/microphone": "^0.1.0",
  "@capacitor-community/text-to-speech": "^3.0.0"
}
```

### API Requirements

- OpenAI API key on mobile (for Realtime API transcription)
- OR iOS 15+ for native speech recognition (fallback/offline mode)

### Desktop Requirements

- No changes to Claude Code integration
- No changes to sync protocol (uses existing queuedPrompts)
- Minor UI updates for voice control indicator

## Related Documentation

- [Voice Mode Architecture](../../design/VoiceMode/openai-voice-mode-integration.md)
- [Mobile Sync Architecture](../../docs/MOBILE_SYNC.md)
- [Queued Prompts System](../../packages/electron/CLAUDE.md#queued-prompts)
