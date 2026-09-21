/**
 * Voice mode state atoms
 *
 * Workspace-scoped atoms (not per-session) since only one voice session
 * can be active at a time. Updated by centralized voiceModeListeners.ts,
 * never by components directly.
 */

import { atom } from 'jotai';

// =========================================================================
// Voice Listen State
// =========================================================================

/**
 * Three-state listening model:
 * - 'off': voice mode not active
 * - 'listening': active, mic sending audio, listen window timer running
 * - 'sleeping': active (WebSocket connected), mic paused, waiting for wake event
 */
export type VoiceListenState = 'off' | 'listening' | 'sleeping';

/**
 * Current listen state for the voice session.
 * Managed by voiceModeListeners.ts, read by VoiceModeButton for icon/gating.
 */
export const voiceListenStateAtom = atom<VoiceListenState>('off');

// =========================================================================
// Pending Voice Command (existing)
// =========================================================================

/**
 * Represents a pending voice command awaiting submission.
 */
export interface PendingVoiceCommand {
  /** Unique ID for this pending command */
  id: string;
  /** The command text (can be edited) */
  prompt: string;
  /** Target AI session ID */
  sessionId: string;
  /** Timestamp when the command was created */
  createdAt: number;
  /** Configured delay in milliseconds */
  delayMs: number;
  /** Workspace path for the command */
  workspacePath: string;
  /** Custom coding agent prompt settings */
  codingAgentPrompt?: {
    prepend?: string;
    append?: string;
  };
}

/**
 * Atom storing the current pending voice command.
 * Null when no voice command is pending.
 */
export const pendingVoiceCommandAtom = atom<PendingVoiceCommand | null>(null);

// =========================================================================
// Voice Transcript Capture
// =========================================================================

/**
 * A single entry in the voice conversation transcript.
 */
export interface VoiceTranscriptEntry {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp: number;
}

/**
 * Which speech transport produced a usage report. Realtime is billed per
 * token; Live is billed per second.
 */
export type VoiceEngineId = 'realtime' | 'live';

/**
 * Usage reported by the delegated controller for one response. Kept as its own
 * list and never folded into voice duration -- the controller's cost is a
 * separate line item. `usage` is the backend model's own usage block and stays
 * opaque here.
 */
export interface VoiceBackendUsageEntry {
  responseId: string;
  /** null when the response was not part of a delegation -- an observation, not an unreported field. */
  delegationId: string | null;
  usage: Readonly<Record<string, unknown>>;
}

/**
 * Usage for the current voice session, engine-normalized. Mirrors
 * `VoiceEngineUsage` in main (services/voice/engine/voiceEngine.ts); the
 * listeners pass it through untouched.
 *
 * Every field is optional and `undefined` means "this engine does not report
 * this", which is NOT the same as zero. Zero is a real measurement. Anything
 * consuming this must render absence as absence -- a confident 0 or 0% for
 * something we never measured is the failure this shape exists to end.
 *
 * The name is historical: it carried only token counters when Realtime was the
 * only engine.
 */
export interface VoiceTokenUsage {
  /** Realtime token counters. Live leaves all four undefined. */
  inputAudio?: number;
  outputAudio?: number;
  text?: number;
  total?: number;
  /** Cumulative paid seconds. Live only; a running total, never a sum of snapshots. */
  durationSeconds?: number;
  /** Model context occupancy, 0..1, as reported by the engine. Live only. */
  contextUsageRatio?: number;
  /** Per-response controller usage. Live only. */
  backend?: readonly VoiceBackendUsageEntry[];
  /** True once the engine delivered authoritative end-of-session usage. Live only. */
  finalized?: boolean;
  /** True when the transport died before final usage arrived, so figures are a floor. Live only. */
  finalizationMissing?: boolean;
  /** Engine that produced this report. Absent on reports written before engine selection existed. */
  engine?: VoiceEngineId;
}

/**
 * The session ID that currently has an active voice connection.
 * Null when no voice session is active.
 */
export const voiceActiveSessionIdAtom = atom<string | null>(null);

/**
 * Accumulated transcript entries for the current voice session.
 * Reset when voice session ends (after persisting).
 */
export const voiceTranscriptEntriesAtom = atom<VoiceTranscriptEntry[]>([]);

/**
 * Live partial transcription text while the user is speaking.
 * Cleared when user finishes speaking (transcript-complete).
 */
export const voiceCurrentUserTextAtom = atom<string>('');

/**
 * Live usage for the active voice session (tokens on Realtime, duration and
 * context occupancy on Live). Null when no voice session is active.
 */
export const voiceTokenUsageAtom = atom<VoiceTokenUsage | null>(null);

/**
 * Timestamp when the current voice session started.
 * Used to compute session duration on persist.
 */
export const voiceSessionStartTimeAtom = atom<number | null>(null);

/**
 * Workspace path for the current voice session.
 * Stored at activation so the persist function can access it.
 */
export const voiceWorkspacePathAtom = atom<string | null>(null);

// =========================================================================
// Voice Editor Context
// =========================================================================

/**
 * The database session ID for the current voice session.
 * Generated at activation time and used as the ai_sessions.id.
 * This is separate from voiceActiveSessionIdAtom which tracks the
 * linked coding session. Reset to null when voice session ends.
 */
export const voiceDbSessionIdAtom = atom<string | null>(null);

/**
 * The file path last reported to the voice agent.
 * Set by voiceModeListeners when a file change is sent to main process.
 * Used to deduplicate -- only send IPC when the file actually changes.
 * Reset to null when voice session ends.
 */
export const voiceLastReportedFileAtom = atom<string | null>(null);

// =========================================================================
// Voice Error State
// =========================================================================

/**
 * Current voice mode error, if any. Set by centralized listeners on
 * voice-mode:error events. Cleared when voice session starts or ends.
 */
export const voiceErrorAtom = atom<{ type: string; message: string } | null>(null);

/**
 * Transient reconnect state. True while the voice WebSocket dropped
 * unexpectedly and is being re-established with backoff. Set by centralized
 * listeners on voice-mode:reconnecting, cleared on voice-mode:reconnected,
 * session start, or session end. A hard voiceErrorAtom is only set after
 * reconnect attempts are exhausted.
 */
export const voiceReconnectingAtom = atom<boolean>(false);

/**
 * Latest `voice-mode:preview-audio` event from main.
 *
 * Request-atom shape: each event bumps `version` and replaces `payload`.
 * The Settings > Voice Mode panel uses this to play the preview audio
 * returned by `voice-mode:preview-voice` invocations. Consumers must apply
 * the skip-initial-mount idiom so the side effect only fires on real bumps.
 */
export interface VoiceModePreviewAudio {
  version: number;
  payload: { voiceId: string; audioBase64: string; format: string };
}

export const voiceModePreviewAudioAtom = atom<VoiceModePreviewAudio | null>(null);

// =========================================================================
// Voice Callbacks (registered by components, invoked by centralized listeners)
// =========================================================================
// These allow the centralized listeners to trigger component-specific side
// effects (audio playback, pending command UI) without the component subscribing
// to IPC directly.

/** Callback for playing received audio. Set by VoiceModeButton on mount. */
let _onAudioReceived: ((audioBase64: string) => boolean) | null = null;
/** Callback for stopping audio playback (interruption). Set by VoiceModeButton. */
let _onInterruptAudio: (() => void) | null = null;
/**
 * Callback for handling submit-prompt events. Set by VoiceModeButton.
 *
 * It answers whether the prompt was actually queued, because main waits on that
 * before the voice agent is told the task was accepted -- a fire-and-forget
 * send reported "accepted" for prompts that were deduplicated or failed.
 */
export interface VoiceSubmitPromptPayload {
  sessionId: string;
  workspacePath: string | null;
  prompt: string;
  codingAgentPrompt?: { prepend?: string; append?: string };
}
export interface VoiceSubmitPromptAck {
  queued: boolean;
  error?: string;
}
let _onSubmitPrompt:
  | ((payload: VoiceSubmitPromptPayload) => Promise<VoiceSubmitPromptAck>)
  | null = null;
/** Callback for handling agent task completion. Set by VoiceModeButton. */
let _onAgentTaskComplete: ((data: { sessionId: string; isComplete: boolean; content?: string }) => void) | null = null;
/** Callback when voice session is programmatically stopped. Set by VoiceModeButton. */
let _onVoiceStopped: (() => void) | null = null;
/** Callback when voice agent response is done (token-usage received). Set by VoiceModeButton.
 * `wokeFromSleep` is true when the listen state was 'sleeping' at turn end (e.g. the
 * agent's turn was a function-call only, no audio) and the mic has just been woken. */
let _onResponseDone: ((wokeFromSleep: boolean) => void) | null = null;
/** Synchronous query: is the voice agent's audio still playing through the user's speakers?
 * Used by the post-turn timer logic to defer the 15s listen window until audible end-of-turn,
 * not server end-of-turn (long responses can stream into a queue that plays for many more seconds). */
let _voiceAudioActiveQuery: (() => boolean) | null = null;

/**
 * Hand assistant audio to playback. Returns whether it was actually queued for
 * the speakers: a registered callback is not the same thing as an audible
 * pipeline, and bytes that reached nothing are not evidence that anything was
 * heard. See noteAnnouncementAudio in voiceModeListeners.ts.
 */
export function registerVoiceAudioCallback(cb: ((audioBase64: string) => boolean) | null): void {
  _onAudioReceived = cb;
}
export function registerVoiceInterruptCallback(cb: (() => void) | null): void {
  _onInterruptAudio = cb;
}
export function registerVoiceSubmitPromptCallback(
  cb: ((payload: VoiceSubmitPromptPayload) => Promise<VoiceSubmitPromptAck>) | null,
): void {
  _onSubmitPrompt = cb;
}
export function registerVoiceAgentTaskCompleteCallback(cb: ((data: { sessionId: string; isComplete: boolean; content?: string; lastTextSection?: string; error?: string }) => void) | null): void {
  _onAgentTaskComplete = cb;
}
export function registerVoiceStoppedCallback(cb: (() => void) | null): void {
  _onVoiceStopped = cb;
}
export function registerVoiceResponseDoneCallback(cb: ((wokeFromSleep: boolean) => void) | null): void {
  _onResponseDone = cb;
}
export function registerVoiceAudioActiveQuery(query: (() => boolean) | null): void {
  _voiceAudioActiveQuery = query;
}

// Getters for centralized listeners to invoke
export function getVoiceAudioCallback() { return _onAudioReceived; }
export function getVoiceInterruptCallback() { return _onInterruptAudio; }
export function getVoiceSubmitPromptCallback() { return _onSubmitPrompt; }
export function getVoiceAgentTaskCompleteCallback() { return _onAgentTaskComplete; }
export function getVoiceStoppedCallback() { return _onVoiceStopped; }
export function getVoiceResponseDoneCallback() { return _onResponseDone; }
export function getVoiceAudioActiveQuery() { return _voiceAudioActiveQuery; }
