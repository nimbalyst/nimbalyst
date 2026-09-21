import type { VoiceStartupTiming } from '../../../shared/voiceStartupTiming';
/**
 * OpenAI Realtime API WebSocket Client
 *
 * Manages WebSocket connection to OpenAI's Realtime API for voice interactions.
 * Handles audio streaming, function calls, and session management.
 */

import WebSocket from 'ws';
import { ipcMain } from 'electron';
import { redactVoiceDiagnostic } from './voiceDiagnostics';
import { AnalyticsService } from '../analytics/AnalyticsService';
import type { RealtimeFunctionTool } from './voiceToolBridge';
import { VoiceBargeInPolicy, buildTurnDetection, type NoiseReductionType, type VadDetectionType } from './voiceBargeInPolicy';
import {
  VoiceToolRegistry,
  type ExtensionVoiceToolResult,
  type VoiceToolCallEvent,
  type VoiceToolHandlers,
  type VoiceToolSchema,
  type VoiceUiContextToolResult,
  type VoiceUiScreenshotToolResult,
} from './engine/voiceToolRegistry';
import { VoiceEngineEventBus } from './engine/voiceEngineEvents';
import { formatVoiceHostMessage } from './engine/voiceHostMessage';
import { buildVoiceAgentInstructions } from './engine/voiceAgentInstructions';
import type {
  VoiceEngineDisconnectReason,
  VoiceEngineEventMap,
  VoiceEngineEventName,
  VoiceEngineRegistrar,
  VoiceEngineTokenUsage,
  VoiceEngineUsage,
} from './engine/voiceEngine';

// The tool layer is engine-independent and lives in engine/voiceToolRegistry.
// Re-exported here because VoiceModeService and mobileVoiceToolHandler have
// always imported these from this module.
export {
  BUILTIN_VOICE_TOOL_NAMES,
  type ExtensionVoiceToolResult,
  type VoiceUiContextToolResult,
  type VoiceUiScreenshotToolResult,
  type VoiceToolCallEvent,
} from './engine/voiceToolRegistry';

interface RealtimeEvent {
  type: string;
  event_id?: string;
  [key: string]: unknown;
}

/** GA Realtime API audio format object (replaces the beta flat "pcm16" string). */
interface AudioFormat {
  type: string;
  rate?: number;
}

/** GA Realtime API session shape (audio config nested under audio.{input,output}). */
interface SessionConfig {
  type: 'realtime';
  output_modalities: string[];
  instructions: string;
  // GPT-5-class reasoning throttle. Lives at the session top level as
  // reasoning.effort (minimal | low | medium | high | xhigh).
  reasoning?: { effort: RealtimeReasoningEffort };
  audio: {
    input: {
      format: AudioFormat;
      transcription?: { model: string };
      turn_detection?: {
        type: string;
        threshold?: number;
        prefix_padding_ms?: number;
        silence_duration_ms?: number;
        eagerness?: string;
        create_response?: boolean;
        interrupt_response?: boolean;
      };
      noise_reduction?: { type: string };
    };
    output: {
      voice: string;
      format: AudioFormat;
    };
  };
  tools?: VoiceToolSchema[];
}

interface CustomPromptConfig {
  prepend?: string;
  append?: string;
}

interface TurnDetectionConfig {
  mode: 'server_vad' | 'push_to_talk';
  // Which detection engine drives turn-taking when mode is not push_to_talk.
  // semantic_vad (default) is model-judged and echo-robust; server_vad is the
  // amplitude fallback the threshold/silence settings apply to.
  detection?: VadDetectionType;
  vadThreshold?: number;
  silenceDuration?: number;
  interruptible?: boolean;
  // Audio-input noise-reduction profile (rides in this settings bag so it
  // doesn't grow the already-wide constructor). 'far_field' default: live
  // desktop metrics showed loud open speakers behave far-field; 'near_field'
  // for close/headset mics; 'off' omits.
  noiseReduction?: NoiseReductionType;
}

// All available OpenAI Realtime API voices
type VoiceId = 'alloy' | 'ash' | 'ballad' | 'coral' | 'echo' | 'sage' | 'shimmer' | 'verse' | 'marin' | 'cedar';

// Selectable OpenAI Realtime speech-to-speech models.
export type RealtimeModel = 'gpt-realtime-2' | 'gpt-realtime';
export type RealtimeReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

/** Default model and the fallback used when the account/region lacks access. */
const PRIMARY_MODEL: RealtimeModel = 'gpt-realtime-2';
const FALLBACK_MODEL: RealtimeModel = 'gpt-realtime';

/**
 * Streaming transcription model for the GA Realtime API. Natively streaming and
 * designed for realtime sessions (replaces the legacy post-hoc whisper-1).
 */
const TRANSCRIPTION_MODEL = 'gpt-realtime-whisper';

/** Reconnect backoff bounds for unexpected socket drops. */
const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 8000;
const MAX_RECONNECT_ATTEMPTS = 5;

export class RealtimeAPIClient implements VoiceEngineRegistrar {
  private ws: WebSocket | null = null;
  private apiKey: string;
  private model: RealtimeModel = PRIMARY_MODEL;
  private reasoningEffort: RealtimeReasoningEffort = 'low';
  // True once we've fallen back from gpt-realtime-2 to gpt-realtime for this
  // client (no account/region access). Prevents an infinite fallback loop.
  private usedModelFallback: boolean = false;
  private sessionId: string | null = null;
  private connected: boolean = false;
  // Engine-neutral event dispatch. The setOnX() methods below are thin
  // single-slot registrations on this bus, so the Live engine can emit the same
  // events without reproducing a wall of callback fields.
  private events = new VoiceEngineEventBus();
  // Tool schemas + execution, shared with any other engine.
  private tools = new VoiceToolRegistry();
  private claudeCodeSessionId: string;
  private workspacePath: string | null;
  private window: Electron.BrowserWindow;
  private sessionContext: string;
  private customPrompt: CustomPromptConfig;
  private turnDetection: TurnDetectionConfig;
  private voice: VoiceId;
  // Preferred spoken language (desktop's configured default). Pins the voice
  // agent's language so it doesn't auto-detect/drift. Empty -> English.
  private language?: string;

  // Inactivity tracking
  private lastActivityTime: number = Date.now();
  private inactivityCheckInterval: NodeJS.Timeout | null = null;
  private readonly INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

  // Token usage tracking
  private inputAudioTokens: number = 0;
  private outputAudioTokens: number = 0;
  private textTokens: number = 0;

  // Current response tracking
  private currentResponseId: string | null = null;
  private hasActiveResponse: boolean = false;
  private hasPendingFunctionCall: boolean = false;
  private isOutputtingAudio: boolean = false;

  // Barge-in / echo instrumentation (echo cancellation round 2, NIM-1314
  // desktop parity). `playbackActive` mirrors the renderer's audible playback
  // state via voice-mode:playback-active; the policy classifies VAD triggers
  // as echo-suspect vs genuine and owns the interrupt decision.
  private bargeInPolicy = new VoiceBargeInPolicy();
  private playbackActive: boolean = false;
  // The conversation item currently streaming (or last streamed) assistant
  // audio. Kept past response.done because renderer playback outlives the
  // response; a tail barge-in must truncate THIS item. Cleared once truncated.
  private currentAssistantItemId: string | null = null;
  // While agent audio is audibly playing, server VAD responses are gated
  // (create_response/interrupt_response=false) so residual echo cannot make
  // the server act on its own voice; the client keeps barge-in control.
  private serverResponsesGated: boolean = false;
  // The gate state the server actually has, plus whether a toggle is waiting
  // for the active response to finish. session.update is never sent while a
  // response is generating -- see flushOrDeferGateUpdate().
  private sentGateState: boolean = false;
  private gateUpdatePending: boolean = false;
  // Responses the user barged in on. Generation runs far ahead of realtime, so
  // the server has usually already emitted audio deltas past the cancel point;
  // those must not be forwarded to the renderer, whose queue has no response
  // identity and would play them in front of the next response's audio.
  private abandonedResponseIds: Set<string> = new Set();
  // Probation timer for an echo-suspect VAD trigger (min-duration heuristic):
  // fires onDeferredInterruptTimeout to decide whether the speech outlived
  // the window (real barge-in) or was an echo blip.
  private deferredBargeInTimer: NodeJS.Timeout | null = null;

  // When true, the inactivity monitor is suspended (e.g. voice is sleeping)
  private listeningPaused: boolean = false;

  // Reconnect / resume state. A dropped socket used to silently end voice mode;
  // we now reconnect with bounded exponential backoff and re-send the identical
  // session config so recovery is inaudible (same voice/model/instructions).
  private intentionalDisconnect: boolean = false;
  private reconnectAttempts: number = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;

  // Deferred (async) function calls: on gpt-realtime-2 a long-running tool call
  // (submit_agent_prompt) stays open until the coding agent finishes, then is
  // resolved with the real summary via sendFunctionCallResult(). On the
  // gpt-realtime fallback this stays empty and the legacy queue + "[INTERNAL:
  // Task complete]" wake is used.
  //
  // Each entry records the agent session the prompt was queued on, because the
  // completion that resolves it must be THAT session's. This used to be a plain
  // FIFO of call ids, which handed a second session's completion back as the
  // first call's return value once voice could observe more than one session.
  private deferredCalls: Array<{ callId: string; sessionId: string }> = [];

  // Tool-call transcript visibility (Issue: voice tool calls were invisible).
  // The 'toolCall' event fires on call start and completion; the renderer
  // persists each to the voice session transcript. callId -> display label, so
  // the completed event can be labeled without re-deriving it.
  private pendingToolCalls: Map<string, { name: string; displayName: string }> = new Map();

  constructor(
    apiKey: string,
    claudeCodeSessionId: string,
    workspacePath: string | null,
    window: Electron.BrowserWindow,
    sessionContext?: string,
    customPrompt?: CustomPromptConfig,
    turnDetection?: TurnDetectionConfig,
    voice?: VoiceId,
    model?: RealtimeModel,
    reasoningEffort?: RealtimeReasoningEffort,
    language?: string,
    private readonly startupTiming?: VoiceStartupTiming,
  ) {
    this.apiKey = apiKey;
    this.claudeCodeSessionId = claudeCodeSessionId;
    this.workspacePath = workspacePath;
    this.window = window;
    this.sessionContext = sessionContext || 'New session with no prior messages.';
    this.customPrompt = customPrompt || {};
    this.turnDetection = turnDetection || {
      mode: 'server_vad',
      vadThreshold: 0.5,
      silenceDuration: 500,
      interruptible: true,
    };
    this.voice = voice || 'alloy';
    this.model = model || PRIMARY_MODEL;
    this.reasoningEffort = reasoningEffort || 'low';
    this.language = language;
    console.log(`[RealtimeAPIClient] Created with voice=${this.voice} model=${this.model} reasoningEffort=${this.reasoningEffort}`);
  }

  /**
   * Whether the active model supports async (deferred) function calling. Only
   * gpt-realtime-2 reliably keeps a pending function call open and resolves it
   * later; the gpt-realtime fallback uses the queue + wake path instead.
   */
  supportsAsyncFunctionCalls(): boolean {
    return this.model === 'gpt-realtime-2';
  }

  /** The model the client is currently connected with (post-fallback). */
  getModel(): RealtimeModel {
    return this.model;
  }

  /** Subscribe to an engine event (VoiceEngine). Returns an unsubscribe function. */
  on<K extends VoiceEngineEventName>(event: K, listener: VoiceEngineEventMap[K]): () => void {
    return this.events.on(event, listener);
  }

  /**
   * VoiceEngineRegistrar: replace the single listener for an event. The
   * setOnX() methods below are named wrappers around this; the application
   * registers through registerVoiceEngine() and never calls them directly.
   */
  setSingle<K extends VoiceEngineEventName>(event: K, listener: VoiceEngineEventMap[K]): void {
    this.events.setSingle(event, listener);
  }

  /** VoiceEngineRegistrar: the shared tool implementations. */
  get toolHandlers(): VoiceToolHandlers {
    return this.tools.handlers;
  }

  // --- Single-slot event registrations -------------------------------------
  // Each replaces the previous listener for that event, which is what the
  // callback fields these used to assign did.

  /** Set callback for received audio */
  setOnAudio(callback: (audioBase64: string) => void): void {
    this.events.setSingle('audio', callback);
  }

  /** Set callback for received text (assistant responses) */
  setOnText(callback: (text: string) => void): void {
    this.events.setSingle('assistantText', callback);
  }

  /** Set callback for user speech transcription (final/complete) */
  setOnUserTranscript(callback: (transcript: string) => void): void {
    this.events.setSingle('userTranscript', callback);
  }

  /** Set callback for user speech transcription delta (streaming/partial) */
  setOnUserTranscriptDelta(callback: (delta: string, itemId: string) => void): void {
    this.events.setSingle('userTranscriptDelta', callback);
  }

  /** Set callback for token usage updates (for live context indicator) */
  setOnTokenUsage(callback: (usage: VoiceEngineUsage) => void): void {
    this.events.setSingle('usage', callback);
  }

  /** Set callback for when user interrupts the assistant */
  setOnInterruption(callback: () => void): void {
    this.events.setSingle('interrupted', callback);
  }

  /** Set callback for when user stops speaking (VAD detected silence) */
  setOnSpeechStopped(callback: () => void): void {
    this.events.setSingle('userSpeechStopped', callback);
  }

  /**
   * Set callback for when the user starts speaking (VAD speech_started).
   * Fired for EVERY trigger, independent of the barge-in interrupt decision
   * (which can defer or suppress onInterruption entirely for echo-suspect
   * triggers) -- the renderer needs it to hold the listen window open for
   * the whole utterance (NIM-1594).
   */
  setOnSpeechStarted(callback: () => void): void {
    this.events.setSingle('userSpeechStarted', callback);
  }

  /** Set callback for when the connection is closed */
  setOnDisconnect(callback: (reason: VoiceEngineDisconnectReason) => void): void {
    this.events.setSingle('disconnected', callback);
  }

  /** Set callback for errors (quota exceeded, rate limits, etc.) */
  setOnError(callback: (error: { type: string; message: string }) => void): void {
    this.events.setSingle('error', callback);
  }

  /**
   * Set callback fired when an unexpected drop triggers a reconnect attempt.
   * Lets the renderer show a transient "reconnecting…" state instead of dying.
   */
  setOnReconnecting(callback: (attempt: number) => void): void {
    this.events.setSingle('reconnecting', callback);
  }

  /**
   * Set callback fired when a reconnect succeeds and the session config has
   * been re-applied, so the renderer can clear the "reconnecting…" state.
   */
  setOnReconnected(callback: () => void): void {
    this.events.setSingle('reconnected', callback);
  }

  /**
   * Set callback fired when the voice agent calls a tool (started + completed),
   * so the renderer can record it in the voice session transcript.
   */
  setOnToolCall(callback: (event: VoiceToolCallEvent) => void): void {
    this.events.setSingle('toolCall', callback);
  }

  // --- Tool handler registrations ------------------------------------------
  // These are not events: each is the single implementation of one voice tool,
  // and the registry executes it. Kept as individual setters so the existing
  // VoiceModeService wiring is unchanged.

  /** Set callback for submitting prompts to Claude Code */
  setOnSubmitPrompt(callback: NonNullable<VoiceToolHandlers['onSubmitPrompt']>): void {
    this.tools.handlers.onSubmitPrompt = callback;
  }

  /** Set callback for stopping the voice session */
  setOnStopSession(callback: () => boolean): void {
    this.tools.handlers.onStopSession = callback;
  }

  /** Set callback for getting session summary */
  setOnGetSessionSummary(callback: () => Promise<{ success: boolean; summary?: string; error?: string }>): void {
    this.tools.handlers.onGetSessionSummary = callback;
  }

  /** Set callback for asking the coding agent questions */
  setOnAskCodingAgent(callback: (question: string) => Promise<{ success: boolean; answer?: string; error?: string }>): void {
    this.tools.handlers.onAskCodingAgent = callback;
  }

  /** Set callback for when the voice agent wants to pause listening */
  setOnPauseListening(callback: () => void): void {
    this.tools.handlers.onPauseListening = callback;
  }

  /** Set callback for responding to an interactive prompt (AskUserQuestion, etc.) */
  setOnRespondToPrompt(callback: (params: { sessionId: string; promptId: string; promptType: string; answer: string }) => Promise<{ success: boolean; error?: string }>): void {
    this.tools.handlers.onRespondToPrompt = callback;
  }

  /** Set callback for listing AI sessions */
  setOnListSessions(callback: (query?: string) => Promise<{ success: boolean; sessions?: Array<{ id: string; title: string; status: string }>; error?: string }>): void {
    this.tools.handlers.onListSessions = callback;
  }

  /** Set callback for navigating to a specific AI session */
  setOnNavigateToSession(callback: (sessionId: string) => Promise<{ success: boolean; title?: string; error?: string }>): void {
    this.tools.handlers.onNavigateToSession = callback;
  }

  /** Set callback for creating a new AI session */
  setOnCreateSession(callback: (title?: string) => Promise<{ success: boolean; sessionId?: string; title?: string; error?: string }>): void {
    this.tools.handlers.onCreateSession = callback;
  }

  /**
   * Set callback for proposing a commit via the AI commit feature.
   * The voice agent calls this when the user says "propose a commit" /
   * "commit with AI" / "smart commit" -- the callback dispatches a prompt
   * to the coding agent so it can generate a commit proposal widget.
   */
  setOnProposeCommit(callback: () => Promise<{ success: boolean; error?: string }>): void {
    this.tools.handlers.onProposeCommit = callback;
  }

  /** Set callback for retrieving a bounded snapshot of renderer-owned UI state. */
  setOnGetUiContext(callback: () => Promise<VoiceUiContextToolResult>): void {
    this.tools.handlers.onGetUiContext = callback;
  }

  /** Set callback for capturing the active Nimbalyst window after user consent. */
  setOnCaptureUiScreenshot(
    callback: (reason: string) => Promise<VoiceUiScreenshotToolResult>,
  ): void {
    this.tools.handlers.onCaptureUiScreenshot = callback;
  }

  /**
   * Provide extension-contributed voice tools (Core hook 1). Must be called
   * before connect() so the tool list is in place when the session is configured.
   * @param schemas Realtime function-tool schemas to append to the session.
   * @param nameMap Realtime-safe name -> namespaced (dotted) name for dispatch.
   */
  setExtensionVoiceTools(schemas: RealtimeFunctionTool[], nameMap: Map<string, string>): void {
    this.tools.setExtensionTools(schemas, nameMap);
  }

  /**
   * Set the generic dispatch callback invoked when the voice agent calls an
   * extension-contributed tool (any tool name the registry does not recognize
   * as built-in).
   */
  setOnExtensionVoiceTool(
    callback: (namespacedName: string, args: Record<string, unknown>) => Promise<ExtensionVoiceToolResult>
  ): void {
    this.tools.handlers.onExtensionVoiceTool = callback;
  }

  /**
   * Build the full list of function tools advertised in the Realtime session
   * config: the built-in tools followed by any extension-contributed voice
   * tools. Exposed (not private) so the tool list can be asserted in tests
   * without opening a WebSocket.
   */
  buildSessionTools(): VoiceToolSchema[] {
    return this.tools.buildToolSchemas();
  }

  /**
   * Connect to OpenAI Realtime API via WebSocket.
   *
   * Defaults to gpt-realtime-2 with automatic one-shot fallback to gpt-realtime
   * when the account/region lacks access (the initial socket fails to open).
   */
  async connect(): Promise<void> {
    this.intentionalDisconnect = false;
    try {
      await this.openSocket();
    } catch (error) {
      // Automatic model fallback: if gpt-realtime-2 isn't available, retry once
      // on gpt-realtime so voice mode still works.
      if (this.model === PRIMARY_MODEL && !this.usedModelFallback) {
        this.usedModelFallback = true;
        this.model = FALLBACK_MODEL;
        console.warn(`[RealtimeAPIClient] ${PRIMARY_MODEL} unavailable, falling back to ${FALLBACK_MODEL}`, { error: redactVoiceDiagnostic(error, this.apiKey) });
        try {
          AnalyticsService.getInstance().sendEvent('voice_model_fallback', {
            from: PRIMARY_MODEL,
            to: FALLBACK_MODEL,
          });
        } catch { /* analytics is best-effort */ }
        await this.openSocket();
        return;
      }
      throw new Error(redactVoiceDiagnostic(error, this.apiKey));
    }
  }

  /**
   * Open a WebSocket to the current model and wire its handlers. Resolves on
   * 'open', rejects if the socket errors/closes before opening (so connect()
   * can apply the model fallback, and reconnect() can retry).
   */
  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `wss://api.openai.com/v1/realtime?model=${this.model}`;
      console.log('[RealtimeAPIClient] Connecting to OpenAI Realtime API', { url });

      // Do NOT send the 'OpenAI-Beta: realtime=v1' header: it selects the retired
      // Beta API shape, which the server now rejects with
      // code=4000 reason=beta_api_shape_disabled. Omitting it selects the GA shape.
      const ws = new WebSocket(url, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
        },
      });
      this.ws = ws;

      let opened = false;
      let settled = false;

      ws.on('open', () => {
        this.startupTiming?.mark('realtime-socket-open');
        opened = true;
        settled = true;
        this.connected = true;
        this.reconnectAttempts = 0;
        this.startInactivityMonitor();
        resolve();
      });

      ws.on('message', (data: WebSocket.Data) => {
        try {
          const event = JSON.parse(data.toString()) as RealtimeEvent;
          this.handleServerEvent(event);
        } catch (error) {
          console.error('[RealtimeAPIClient] Failed to parse server event', { error: redactVoiceDiagnostic(error, this.apiKey) });
        }
      });

      ws.on('error', (error) => {
        console.error('[RealtimeAPIClient] WebSocket error', { error: redactVoiceDiagnostic(error, this.apiKey) });
        this.connected = false;
        if (!opened && !settled) {
          settled = true;
          reject(new Error(redactVoiceDiagnostic(error, this.apiKey)));
        }
        // A post-open error is followed by 'close', which drives reconnect.
      });

      ws.on('close', (code, reason) => {
        this.connected = false;
        this.stopInactivityMonitor();
        if (!opened) {
          if (!settled) {
            settled = true;
            reject(new Error(`Socket closed before open: ${code} ${redactVoiceDiagnostic(String(reason), this.apiKey)}`));
          }
          return;
        }
        this.handleUnexpectedClose(code, redactVoiceDiagnostic(String(reason), this.apiKey));
      });
    });
  }

  /**
   * Handle a socket close that happened after a successful open. Unless the
   * disconnect was intentional (user_stopped / inactivity timeout), schedule a
   * bounded exponential-backoff reconnect that re-applies the identical config.
   */
  private handleUnexpectedClose(code: number, reason: string): void {
    if (this.intentionalDisconnect) {
      return;
    }
    console.warn(`[RealtimeAPIClient] Unexpected socket close (code=${code} reason=${reason}); will attempt reconnect`);
    this.scheduleReconnect();
  }

  /**
   * Reconnect with bounded exponential backoff. On success, session.created
   * fires and updateSession() re-sends the identical voice/model/instructions,
   * so the user hears no change. Token accumulators are instance fields and so
   * survive the reconnect. After MAX_RECONNECT_ATTEMPTS we surface a hard error.
   */
  private scheduleReconnect(): void {
    if (this.intentionalDisconnect) return;

    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.error('[RealtimeAPIClient] Reconnect attempts exhausted; ending voice session');
      this.events.emit('error', {
        type: 'connection_lost',
        message: 'Voice connection was lost and could not be restored.',
      });
      this.events.emit('disconnected', 'error');
      return;
    }

    this.reconnectAttempts++;
    const attempt = this.reconnectAttempts;
    const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1), RECONNECT_MAX_DELAY_MS);
    console.log(`[RealtimeAPIClient] Reconnect attempt ${attempt}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`);
    this.events.emit('reconnecting', attempt);

    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.intentionalDisconnect) return;
      try {
        await this.openSocket();
        // session.created -> updateSession() re-applies the identical config.
        console.log('[RealtimeAPIClient] Reconnected');
        this.events.emit('reconnected');
      } catch (error) {
        console.error('[RealtimeAPIClient] Reconnect attempt failed', { error: redactVoiceDiagnostic(error, this.apiKey) });
        this.scheduleReconnect();
      }
    }, delay);
  }

  /**
   * Handle events from OpenAI Realtime API
   */
  private handleServerEvent(event: RealtimeEvent): void {
    // Update activity timestamp for most events (skip the high-frequency audio deltas)
    if (event.type !== 'response.output_audio.delta' && event.type !== 'response.audio.delta') {
      this.updateActivity();
    }

    switch (event.type) {
      case 'session.created':
        this.sessionId = (event as any).session?.id || null;
        this.updateSession();
        this.injectContext(this.sessionContext);
        break;

      case 'session.updated': {
        const serverVoice = (event as any).session?.audio?.output?.voice as string | undefined;
        console.log(`[RealtimeAPIClient] session.updated: voice=${serverVoice || 'unknown'}`);
        // Guardrail: the server should echo the voice we requested. A mismatch
        // means the output voice diverged from settings -- turn "users say it
        // switches" into a measurable signal and catch regressions from dropping
        // the per-response voice override.
        if (serverVoice && serverVoice !== this.voice) {
          console.warn(`[RealtimeAPIClient] Voice mismatch: requested=${this.voice} server=${serverVoice}`);
          try {
            AnalyticsService.getInstance().sendEvent('voice_voice_mismatch', {
              requested: this.voice,
              server: serverVoice,
              model: this.model,
            });
          } catch { /* analytics is best-effort */ }
        }
        break;
      }

      case 'response.created':
        this.currentResponseId = (event as any).response?.id || null;
        this.hasActiveResponse = true;
        break;

      case 'response.done':
        const response = (event as any).response;
        const usage = response?.usage;
        if (usage) {
          this.trackTokenUsage(usage);
        }
        // Check for failed response with error
        if (response?.status === 'failed' && response?.status_details?.error) {
          const error = response.status_details.error;
          console.error('[RealtimeAPIClient] Response failed:', redactVoiceDiagnostic(error.message, this.apiKey));
          this.events.emit('error', {
            type: redactVoiceDiagnostic(error.type || 'unknown_error', this.apiKey),
            message: redactVoiceDiagnostic(error.message || 'Voice mode encountered an error', this.apiKey),
          });
        }
        // Terminal for this response: no further audio deltas can arrive for
        // it, so stop suppressing its id.
        const doneId = response?.id as string | undefined;
        if (doneId) this.abandonedResponseIds.delete(doneId);
        this.currentResponseId = null;
        this.hasActiveResponse = false;
        this.hasPendingFunctionCall = false;
        this.isOutputtingAudio = false;
        // A gate toggle held back during generation applies now.
        if (this.gateUpdatePending) this.flushOrDeferGateUpdate();
        break;

      // GA event is response.output_audio.delta; the beta name is kept for safety.
      case 'response.output_audio.delta':
      case 'response.audio.delta': {
        // Drop the tail of a response the user already barged in on. The
        // renderer cleared its queue at the interrupt; replaying these late
        // chunks would stitch the abandoned utterance onto the front of the
        // next one, which is heard as the agent's voice changing mid-answer.
        const audioResponseId = (event as any).response_id as string | undefined;
        if (audioResponseId && this.abandonedResponseIds.has(audioResponseId)) {
          break;
        }
        // Received audio chunk from OpenAI
        this.isOutputtingAudio = true;
        // Remember which conversation item is speaking so a barge-in during
        // the (renderer-side) playback tail can truncate it server-side.
        if ((event as any).item_id) {
          this.currentAssistantItemId = (event as any).item_id as string;
        }
        const audioDelta = (event as any).delta as string; // base64-encoded PCM16
        this.events.emit('audio', audioDelta);
        break;
      }

      case 'response.output_audio.done':
      case 'response.audio.done':
        this.isOutputtingAudio = false;
        break;

      // With GA output_modalities=['audio'], the assistant's words arrive as the audio
      // transcript rather than response.output_text.delta. Route both to onText so the
      // on-screen assistant transcript keeps updating.
      case 'response.output_audio_transcript.delta':
      case 'response.output_text.delta':
      case 'response.text.delta':
        const textDelta = (event as any).delta as string;
        if (textDelta) {
          this.events.emit('assistantText', textDelta);
        }
        break;

      case 'response.function_call_arguments.delta':
        this.hasPendingFunctionCall = true;
        break;

      case 'response.function_call_arguments.done':
        this.hasPendingFunctionCall = false;
        const callId = (event as any).call_id as string;
        const name = (event as any).name as string;
        const args = (event as any).arguments as string;
        this.handleFunctionCall(callId, name, args);
        break;

      case 'input_audio_buffer.speech_started': {
        this.updateActivity();
        // Always tell the renderer speech began, BEFORE the barge-in
        // decision -- interrupt may be deferred or suppressed, but the
        // listen window must hold for the whole utterance either way.
        this.events.emit('userSpeechStarted');
        // Route the barge-in decision through the policy seam: it classifies
        // echo-suspect (agent audio still audibly playing in the renderer --
        // residual echo can trip VAD on open speakers, NIM-1314 desktop
        // parity) vs genuine. Genuine triggers interrupt now; echo-suspect
        // ones get a probation window (min-duration heuristic) resolved by a
        // timer in resolveDeferredBargeIn().
        const decision = this.bargeInPolicy.onSpeechStarted(this.playbackActive);
        const m = this.bargeInPolicy.metrics;
        console.log(`[RealtimeAPIClient] [barge-in] speech_started echoSuspect=${decision.echoSuspect} msSincePlayback=${decision.msSincePlaybackStarted ?? 'n/a'} interrupt=${decision.shouldInterrupt} deferMs=${decision.deferInterruptMs ?? 'n/a'} totals=${m.echoSuspectCount}/${m.genuineCount} (echo/genuine)`);
        if (decision.shouldInterrupt) {
          this.performBargeInInterrupt(decision.msSincePlaybackStarted);
        } else if (decision.deferInterruptMs !== null) {
          this.scheduleDeferredBargeIn(decision.deferInterruptMs);
        }
        break;
      }

      case 'input_audio_buffer.speech_stopped': {
        this.updateActivity();
        const durationMs = this.bargeInPolicy.onSpeechStopped();
        console.log(`[RealtimeAPIClient] [barge-in] speech_stopped durationMs=${durationMs ?? 'n/a'}`);
        this.events.emit('userSpeechStopped');
        break;
      }

      case 'conversation.item.input_audio_transcription.delta':
        // Streaming transcription delta - shows partial text while user is speaking
        const delta = (event as any).delta as string;
        const deltaItemId = (event as any).item_id as string;
        if (delta) {
          this.events.emit('userTranscriptDelta', delta, deltaItemId);
        }
        break;

      case 'conversation.item.input_audio_transcription.completed':
        // User's speech has been transcribed (final result)
        const transcript = (event as any).transcript as string;
        console.log('[RealtimeAPIClient] User transcript received:', transcript);
        if (transcript) {
          this.events.emit('userTranscript', transcript);
        }
        break;

      case 'error': {
        const errorEvent = event as any;
        // `response_cancel_not_active` is an expected VAD race: we send
        // response.cancel on speech-start, but the server already finished
        // that response, so it rejects the stray cancel. Harmless -- log at
        // debug so it doesn't masquerade as a real failure in the console.
        if (errorEvent.error?.code === 'response_cancel_not_active') {
          console.debug('[RealtimeAPIClient] Ignoring stale response.cancel (no active response)');
          break;
        }
        console.error('[RealtimeAPIClient] Server error:', redactVoiceDiagnostic(JSON.stringify(errorEvent.error), this.apiKey));
        // Safety valve: an error can mean a response.create we optimistically
        // marked active was actually rejected (no response.created/response.done
        // will follow). Leaving hasActiveResponse stuck true would silently
        // swallow every later createResponse(). Clear it so the session can
        // recover. hasPendingFunctionCall is cleared for the same reason.
        this.hasActiveResponse = false;
        this.hasPendingFunctionCall = false;
        break;
      }

      default:
        break;
    }
  }

  /**
   * Stop playback and cancel the in-flight response after a barge-in decision
   * (immediate genuine trigger, or a deferred echo-suspect one whose speech
   * outlived the probation window).
   */
  private performBargeInInterrupt(msSincePlaybackStarted: number | null): void {
    // Tell the server how much audio was actually heard before cancelling,
    // so the model's context matches reality.
    if (msSincePlaybackStarted !== null) {
      this.truncatePlayedAudio(msSincePlaybackStarted);
    }
    // Abandon this response's audio regardless of whether the cancel below
    // actually goes out (it is deliberately skipped while function-call args
    // stream, and is a no-op once response.done landed). The renderer stops
    // playback either way, so any further audio for this response is stale.
    if (this.currentResponseId) {
      // Safety valve: the set is drained by response.done, but never let a
      // missing terminal event grow it without bound.
      if (this.abandonedResponseIds.size > 16) this.abandonedResponseIds.clear();
      this.abandonedResponseIds.add(this.currentResponseId);
    }
    this.cancelCurrentResponse();
    this.events.emit('interrupted');
  }

  /**
   * Echo-suspect trigger: playback keeps going; after the probation window
   * the policy decides whether the speech persisted (interrupt late) or was
   * an echo blip that already ended (suppress -- playback never hiccuped).
   */
  private scheduleDeferredBargeIn(deferMs: number): void {
    if (this.deferredBargeInTimer) clearTimeout(this.deferredBargeInTimer);
    this.deferredBargeInTimer = setTimeout(() => {
      this.deferredBargeInTimer = null;
      this.resolveDeferredBargeIn();
    }, deferMs);
  }

  private resolveDeferredBargeIn(): void {
    const decision = this.bargeInPolicy.onDeferredInterruptTimeout(this.playbackActive);
    const m = this.bargeInPolicy.metrics;
    console.log(`[RealtimeAPIClient] [barge-in] deferred ${decision.shouldInterrupt ? 'fired' : 'suppressed'} playbackActive=${this.playbackActive} msSincePlayback=${decision.msSincePlaybackStarted ?? 'n/a'} suppressed=${m.suppressedEchoCount}`);
    if (decision.shouldInterrupt) {
      this.performBargeInInterrupt(decision.msSincePlaybackStarted);
    }
  }

  private cancelDeferredBargeInTimer(): void {
    if (this.deferredBargeInTimer) {
      clearTimeout(this.deferredBargeInTimer);
      this.deferredBargeInTimer = null;
    }
  }

  /**
   * Update session configuration
   */
  private updateSession(): void {
    if (!this.ws || !this.connected) {
      console.error('[RealtimeAPIClient] Cannot update session - not connected');
      return;
    }

    const instructions = buildVoiceAgentInstructions({
      customPrompt: this.customPrompt,
      language: this.language,
      supportsAsyncFunctionCalls: this.supportsAsyncFunctionCalls(),
    });

    // Build turn detection config based on settings
    // 'push_to_talk' mode uses type: 'none' which disables automatic turn detection
    const turnDetectionConfig = this.turnDetection.mode === 'push_to_talk'
      ? undefined // No automatic turn detection - user must manually commit audio
      : buildTurnDetection({
          detection: this.turnDetection.detection,
          vadThreshold: this.turnDetection.vadThreshold,
          silenceDurationMs: this.turnDetection.silenceDuration,
          allowServerResponses: !this.serverResponsesGated,
        });

    // Input noise reduction (echo round 2): 'far_field' by default (loud open
    // speakers are the echo-prone case); 'off' omits the config entirely.
    const noiseReduction = this.turnDetection.noiseReduction ?? 'far_field';

    // GA Realtime API session shape: audio config is nested under audio.{input,output}
    // with format as an object ({type,rate}), not the flat beta fields. PCM16 @ 24kHz
    // matches what the renderer audio pipeline produces/consumes.
    const config: SessionConfig = {
      type: 'realtime',
      output_modalities: ['audio'],
      instructions,
      // GPT-5-class reasoning throttle (gpt-realtime-2). The gpt-realtime
      // fallback ignores an unknown field, so it's safe to always include.
      reasoning: { effort: this.reasoningEffort },
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24000 },
          // Streaming transcription (replaces post-hoc whisper-1) -- faster,
          // more accurate partial captions, still delivered via
          // conversation.item.input_audio_transcription.{delta,completed}.
          transcription: { model: TRANSCRIPTION_MODEL },
          ...(turnDetectionConfig ? { turn_detection: turnDetectionConfig } : {}),
          ...(noiseReduction !== 'off' ? { noise_reduction: { type: noiseReduction } } : {}),
        },
        output: {
          voice: this.voice,
          format: { type: 'audio/pcm', rate: 24000 },
        },
      },
      tools: this.buildSessionTools(),
    };

    const event = {
      type: 'session.update',
      session: config,
    };

    console.log(`[RealtimeAPIClient] session.update: voice=${config.audio.output.voice} model=${this.model} reasoning=${this.reasoningEffort} transcription=${TRANSCRIPTION_MODEL}`);
    this.ws.send(JSON.stringify(event));
    // This full update carries turn_detection too, so the server's gate state
    // is now whatever we just sent (matters after a reconnect re-applies it).
    this.sentGateState = this.serverResponsesGated;
    this.gateUpdatePending = false;
  }

  /**
   * Send audio chunk to OpenAI
   * @param audioBase64 Base64-encoded PCM16 audio data
   */
  sendAudio(audioBase64: string): void {
    if (!this.ws || !this.connected) {
      console.error('[RealtimeAPIClient] Cannot send audio - not connected');
      return;
    }

    // Audio is flowing again -- clear paused state
    if (this.listeningPaused) {
      this.listeningPaused = false;
    }

    const event = {
      type: 'input_audio_buffer.append',
      audio: audioBase64,
    };

    this.ws.send(JSON.stringify(event));
  }

  /** VoiceEngine: append captured microphone audio. */
  appendAudio(audioBase64: string): void {
    this.sendAudio(audioBase64);
  }

  /**
   * VoiceEngine: the user finished their turn. On Realtime this commits the
   * input audio buffer, which is what makes push-to-talk produce an answer.
   */
  endUserTurn(): void {
    this.commitAudio();
  }

  /**
   * Commit the audio buffer to trigger processing
   */
  commitAudio(): void {
    if (!this.ws || !this.connected) {
      console.error('[RealtimeAPIClient] Cannot commit audio - not connected');
      return;
    }

    const event = {
      type: 'input_audio_buffer.commit',
    };

    this.ws.send(JSON.stringify(event));
  }

  /**
   * Inject a context message into the conversation without triggering a response.
   * Used for silent notifications like session switches and file changes.
   */
  injectContext(text: string): boolean {
    if (!this.ws || !this.connected) {
      return false;
    }

    try {
      const event = {
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: formatVoiceHostMessage('observation', text),
            },
          ],
        },
      };

      this.ws.send(JSON.stringify(event));
      // No createResponse() -- this is silent context injection
      return true;
    } catch (error) {
      console.error('[RealtimeAPIClient] Failed to inject context:', redactVoiceDiagnostic(error, this.apiKey));
      return false;
    }
  }

  /**
   * Inject an in-memory screenshot into the Realtime conversation without
   * triggering a response. The subsequent function-call output triggers the
   * response, so the model sees the image before it interprets the tool result.
   */
  injectImage(imageDataUrl: string, description: string): boolean {
    if (!this.ws || !this.connected) {
      return false;
    }
    if (!/^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(imageDataUrl)) {
      return false;
    }

    try {
      this.ws.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: `[INTERNAL: Current Nimbalyst UI screenshot captured for: ${description}]`,
            },
            {
              type: 'input_image',
              image_url: imageDataUrl,
              detail: 'high',
            },
          ],
        },
      }));
      return true;
    } catch (error) {
      console.error('[RealtimeAPIClient] Failed to inject UI screenshot:', redactVoiceDiagnostic(error, this.apiKey));
      return false;
    }
  }

  /**
   * Send a text message from the user to the assistant
   * This is used to notify the voice assistant when the coding agent completes
   * Returns true if message was sent successfully, false otherwise
   */
  sendHostAnnouncement(text: string): boolean {
    if (!this.ws || !this.connected) {
      console.error('[RealtimeAPIClient] Cannot send user message - WebSocket not connected');
      return false;
    }

    this.events.emit('hostAnnouncement');

    // Resume from paused state -- activity is happening again
    this.listeningPaused = false;
    this.updateActivity();

    try {
      const event = {
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: formatVoiceHostMessage('announcement', text),
            },
          ],
        },
      };

      this.ws.send(JSON.stringify(event));

      // Trigger a response from the assistant
      this.createResponse();

      return true;
    } catch (error) {
      console.error('[RealtimeAPIClient] Failed to send user message:', redactVoiceDiagnostic(error, this.apiKey));
      return false;
    }
  }

  /**
   * Whether there is an open async (deferred) function call awaiting work
   * submitted to this agent session. VoiceModeService checks this on
   * agent-task-complete to decide between resolving the open call
   * (gpt-realtime-2) and injecting a wake message.
   */
  hasDeferredCallFor(sessionId: string): boolean {
    return this.deferredCalls.some((call) => call.sessionId === sessionId);
  }

  /**
   * Resolve the open async function call for THIS agent session with the coding
   * agent's result. Delivers the summary as the function_call_output (which
   * triggers the agent to speak it) instead of a synthetic success + injected
   * wake message. Returns false when that session has no open call -- the
   * completion then goes down the announcement path rather than being handed to
   * whichever call happens to be open.
   */
  resolveDeferredCallFor(
    sessionId: string,
    result: { success: boolean; summary?: string; error?: string },
  ): boolean {
    const index = this.deferredCalls.findIndex((call) => call.sessionId === sessionId);
    if (index === -1) return false;
    const [call] = this.deferredCalls.splice(index, 1);
    console.log(`[RealtimeAPIClient] Resolving deferred call ${call.callId} for session ${sessionId}`);
    this.sendFunctionCallResult(call.callId, result);
    return true;
  }

  /**
   * Handle a function call from the model: announce it, run it through the
   * shared registry, and deliver whatever the registry returns. A deferred
   * outcome means the call stays open until resolveDeferredCallFor() supplies the
   * coding agent's real result.
   */
  private async handleFunctionCall(callId: string, name: string, argsJson: string): Promise<void> {
    // Record the call so it shows up in the voice session transcript. The
    // matching 'completed' event is emitted from sendFunctionCallResult().
    const displayName = this.tools.displayNameFor(name);
    this.pendingToolCalls.set(callId, { name, displayName });
    let parsedArgs: Record<string, unknown> = {};
    try {
      parsedArgs = argsJson ? JSON.parse(argsJson) : {};
    } catch {
      parsedArgs = {};
    }
    this.events.emit('toolCall', { phase: 'started', callId, name, displayName, args: parsedArgs });

    const outcome = await this.tools.dispatch(callId, name, argsJson, {
      sessionId: this.sessionId || '',
      supportsDeferredCalls: this.supportsAsyncFunctionCalls(),
      injectImage: (imageDataUrl, description) => this.injectImage(imageDataUrl, description),
      setListeningPaused: (paused) => {
        this.listeningPaused = paused;
      },
    });

    if (outcome.deferred === true) {
      // Async (deferred) function calling: hold the call id until the coding
      // agent finishes (voice-mode:agent-task-complete). Without a known target
      // session there is no completion that can be proven to belong to this
      // call, so it is answered now instead of left open indefinitely.
      if (outcome.submission) {
        this.deferredCalls.push({ callId, sessionId: outcome.submission.sessionId });
        return;
      }
      console.warn('[RealtimeAPIClient] Deferred call has no target session; answering it now');
      this.sendFunctionCallResult(callId, {
        success: true,
        message: 'Task queued. You will be notified when it completes.',
      });
      return;
    }
    this.sendFunctionCallResult(callId, outcome.result);
  }

  /**
   * Send function call result back to OpenAI
   */
  private sendFunctionCallResult(callId: string, result: unknown): void {
    if (!this.ws || !this.connected) {
      console.error('[RealtimeAPIClient] Cannot send function result - not connected');
      return;
    }

    const event = {
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: JSON.stringify(result),
      },
    };

    this.ws.send(JSON.stringify(event));

    // Emit the matching 'completed' tool-call event for transcript visibility.
    const pending = this.pendingToolCalls.get(callId);
    if (pending) {
      this.pendingToolCalls.delete(callId);
      const r = (result ?? {}) as Record<string, unknown>;
      const success = typeof r.success === 'boolean' ? r.success : !r.error;
      const summary =
        (typeof r.summary === 'string' && r.summary) ||
        (typeof r.answer === 'string' && r.answer) ||
        (typeof r.message === 'string' && r.message) ||
        (typeof r.error === 'string' && r.error) ||
        undefined;
      this.events.emit('toolCall', {
        phase: 'completed',
        callId,
        name: pending.name,
        displayName: pending.displayName,
        success,
        summary: summary || undefined,
      });
    }

    // A function-call result ALWAYS warrants a fresh response so the agent can
    // relay the outcome (e.g. confirm a created session). The response that
    // emitted the function call has already completed server-side -- a response
    // cannot emit a tool call and keep streaming audio -- but its response.done
    // can lag response.function_call_arguments.done by a frame, and on fast
    // (better-sqlite3-backed) tool callbacks the result is sent before that
    // done is processed. In that window hasActiveResponse is still
    // optimistically true, so the overlap guard in createResponse() would
    // silently swallow the follow-up response and the tool would feel broken
    // ("create a new session" did nothing). Clear the flag here so the result
    // always produces a spoken response. The overlap guard still protects the
    // genuine case (two non-function createResponse() calls racing mid-turn).
    this.hasActiveResponse = false;
    this.createResponse();
  }

  /**
   * Request the assistant to generate a response.
   *
   * Voice is set once in session.update and intentionally NOT re-asserted here.
   * gpt-realtime-2 renders a consistent voice for the whole session; passing a
   * voice on response.create after audio has started is a no-op at best and can
   * trigger re-evaluation at worst. The session.updated mismatch guardrail
   * catches any divergence.
   *
   * Active-response guard: createResponse() is called from several async paths
   * (tool results, wake/task-complete messages, interactive-prompt injection).
   * If one fires while a response is already generating, the server runs two
   * overlapping responses -- two concurrent audio renderings that, under the
   * expressive voices (marin/cedar), sound like the voice "switching" mid-turn.
   * Skip if a response is already active; hasActiveResponse is set optimistically
   * on send (and on response.created) and cleared on response.done / cancel.
   */
  private createResponse(): void {
    if (!this.ws || !this.connected) {
      console.error('[RealtimeAPIClient] Cannot create response - not connected');
      return;
    }

    if (this.hasActiveResponse) {
      console.log('[RealtimeAPIClient] Skipping response.create - a response is already active (would overlap)');
      return;
    }

    const event = {
      type: 'response.create',
      response: {
        output_modalities: ['audio'],
      },
    };

    this.ws.send(JSON.stringify(event));
    // Optimistically mark active so a rapid second call (before the server's
    // response.created round-trips) cannot create an overlapping response.
    this.hasActiveResponse = true;
  }

  /**
   * Renderer-reported audible playback state (voice-mode:playback-active).
   * Drives the barge-in policy's playback clock and gates server VAD
   * responses while the agent is audibly speaking (NIM-1314 lever 4).
   */
  setPlaybackActive(active: boolean): void {
    if (active === this.playbackActive) return;
    this.playbackActive = active;
    if (active) {
      this.bargeInPolicy.notePlaybackStarted();
    } else {
      this.bargeInPolicy.notePlaybackStopped();
    }
    this.setServerResponsesGated(active);
  }

  /**
   * Gate or un-gate server VAD responses while the agent's audio plays.
   * No-ops in push_to_talk mode (no turn detection) and when unchanged.
   */
  private setServerResponsesGated(gated: boolean): void {
    if (gated === this.serverResponsesGated) return;
    this.serverResponsesGated = gated;
    this.flushOrDeferGateUpdate();
  }

  /**
   * Apply the desired gate state, but NEVER while a response is generating.
   *
   * Playback starts a few hundred ms into a turn, so gating on playback-active
   * used to push a session.update into the middle of the model's audio render.
   * Mutating the session mid-generation perturbs the render, and the second
   * half of a long answer comes back in a noticeably different register --
   * the "the voice changes partway through" report. Deferring costs nothing:
   * while a response is active the server cannot start another one, which is
   * the only thing the gate prevents. response.done flushes whatever is
   * pending, and a toggle that flips back before then collapses to no update
   * at all (sentGateState tracks what the server actually has).
   */
  private flushOrDeferGateUpdate(): void {
    if (!this.ws || !this.connected || this.turnDetection.mode === 'push_to_talk') return;
    if (this.hasActiveResponse) {
      this.gateUpdatePending = true;
      return;
    }
    this.gateUpdatePending = false;
    if (this.serverResponsesGated === this.sentGateState) return;
    const gated = this.serverResponsesGated;
    this.sentGateState = gated;
    this.ws.send(JSON.stringify({
      type: 'session.update',
      session: {
        type: 'realtime',
        audio: {
          input: {
            turn_detection: buildTurnDetection({
              detection: this.turnDetection.detection,
              vadThreshold: this.turnDetection.vadThreshold,
              silenceDurationMs: this.turnDetection.silenceDuration,
              allowServerResponses: !gated,
            }),
          },
        },
      },
    }));
  }

  /**
   * Tell the server how much of the current assistant item's audio the user
   * actually heard before a barge-in, so the model's context matches reality.
   * Clears the item id so the same item is never truncated twice.
   */
  private truncatePlayedAudio(audioEndMs: number): void {
    if (!this.ws || !this.connected || !this.currentAssistantItemId) return;
    const itemId = this.currentAssistantItemId;
    this.currentAssistantItemId = null;
    this.ws.send(JSON.stringify({
      type: 'conversation.item.truncate',
      item_id: itemId,
      content_index: 0,
      audio_end_ms: Math.max(0, Math.round(audioEndMs)),
    }));
  }

  /**
   * Cancel the current response (used when user interrupts)
   */
  private cancelCurrentResponse(): void {
    if (!this.ws || !this.connected || !this.hasActiveResponse) {
      return;
    }

    // Don't cancel responses that are generating function call arguments.
    // Cancelling mid-stream truncates the JSON args, causing parse failures
    // and making the voice agent fall back to ask_coding_agent instead of
    // using the intended tool (e.g. respond_to_interactive_prompt).
    if (this.hasPendingFunctionCall) {
      console.log('[RealtimeAPIClient] Skipping cancel - function call in progress');
      return;
    }


    const event = {
      type: 'response.cancel',
    };

    this.ws.send(JSON.stringify(event));
    this.hasActiveResponse = false;
  }

  /**
   * Update last activity timestamp
   */
  private updateActivity(): void {
    this.lastActivityTime = Date.now();
  }

  /**
   * Start monitoring for inactivity
   */
  private startInactivityMonitor(): void {
    // Check every 30 seconds
    this.inactivityCheckInterval = setInterval(() => {
      // Don't disconnect while listening is paused -- user explicitly asked to sleep
      if (this.listeningPaused) return;

      const inactiveMs = Date.now() - this.lastActivityTime;

      if (inactiveMs >= this.INACTIVITY_TIMEOUT_MS) {
        console.log('[RealtimeAPIClient] Session inactive for 5 minutes, disconnecting to save tokens');
        this.disconnect('timeout');
      }
    }, 30000); // Check every 30 seconds
  }

  /**
   * Stop inactivity monitor
   */
  private stopInactivityMonitor(): void {
    if (this.inactivityCheckInterval) {
      clearInterval(this.inactivityCheckInterval);
      this.inactivityCheckInterval = null;
    }
  }

  /**
   * Track token usage from response events
   */
  private trackTokenUsage(usage: any): void {
    // OpenAI Realtime API usage format:
    // - input_tokens: text input tokens
    // - output_tokens: text output tokens
    // - input_token_details.audio: audio input tokens (1 token per 100ms)
    // - output_token_details.audio: audio output tokens (1 token per 50ms)

    const inputAudio = usage.input_token_details?.audio || 0;
    const outputAudio = usage.output_token_details?.audio || 0;
    const inputText = usage.input_tokens || 0;
    const outputText = usage.output_tokens || 0;

    this.inputAudioTokens += inputAudio;
    this.outputAudioTokens += outputAudio;
    this.textTokens += inputText + outputText;

    const totalTokens = this.inputAudioTokens + this.outputAudioTokens + this.textTokens;

    console.log('[RealtimeAPIClient] Token usage update', {
      thisResponse: {
        inputAudio,
        outputAudio,
        inputText,
        outputText,
        total: inputAudio + outputAudio + inputText + outputText
      },
      sessionTotal: {
        inputAudio: this.inputAudioTokens,
        outputAudio: this.outputAudioTokens,
        text: this.textTokens,
        total: totalTokens
      }
    });

    // Notify listener of updated token usage
    this.events.emit('usage', {
      inputAudio: this.inputAudioTokens,
      outputAudio: this.outputAudioTokens,
      text: this.textTokens,
      total: totalTokens,
    });
  }

  /**
   * Get current token usage statistics
   */
  getTokenUsage(): VoiceEngineTokenUsage {
    return {
      inputAudio: this.inputAudioTokens,
      outputAudio: this.outputAudioTokens,
      text: this.textTokens,
      total: this.inputAudioTokens + this.outputAudioTokens + this.textTokens,
    };
  }

  /**
   * VoiceEngine: engine-normalized session usage. Realtime fills only the token
   * fields -- duration, context occupancy, backend usage, and the finalization
   * flags stay undefined because this engine genuinely does not report them.
   */
  getUsage(): VoiceEngineUsage {
    return this.getTokenUsage();
  }

  /**
   * Disconnect from OpenAI Realtime API
   * @param reason Optional reason for disconnect (default: 'user_stopped')
   */
  disconnect(reason: VoiceEngineDisconnectReason = 'user_stopped'): void {
    const m = this.bargeInPolicy.metrics;
    if (m.speechStartedCount > 0) {
      console.log(`[RealtimeAPIClient] [barge-in] session summary: speechStarted=${m.speechStartedCount} echoSuspect=${m.echoSuspectCount} genuine=${m.genuineCount} interrupts=${m.interruptCount} suppressedEcho=${m.suppressedEchoCount}`);
    }
    this.bargeInPolicy.resetSession();
    this.cancelDeferredBargeInTimer();
    // Mark intentional BEFORE closing so the close handler doesn't reconnect.
    this.intentionalDisconnect = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.deferredCalls = [];

    if (this.ws) {
      this.stopInactivityMonitor();

      // Call disconnect callback before closing
      this.events.emit('disconnected', reason);

      this.ws.close();
      this.ws = null;
      this.connected = false;
      this.sessionId = null;
      this.currentResponseId = null;
      this.hasActiveResponse = false;
      this.currentAssistantItemId = null;
      this.serverResponsesGated = false;
      this.sentGateState = false;
      this.gateUpdatePending = false;
      this.abandonedResponseIds.clear();
      this.playbackActive = false;
    }
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Set the listening paused state.
   * When paused, the inactivity monitor won't disconnect the WebSocket.
   */
  setListeningPaused(paused: boolean): void {
    this.listeningPaused = paused;
    if (!paused) {
      this.updateActivity();
    }
  }
}
