/**
 * OpenAI Realtime API WebSocket Client
 *
 * Manages WebSocket connection to OpenAI's Realtime API for voice interactions.
 * Handles audio streaming, function calls, and session management.
 */

import WebSocket from 'ws';
import { ipcMain } from 'electron';
import { AnalyticsService } from '../analytics/AnalyticsService';
import type { RealtimeFunctionTool } from './voiceToolBridge';
import { VoiceBargeInPolicy, buildTurnDetection, type NoiseReductionType, type VadDetectionType } from './voiceBargeInPolicy';

interface RealtimeEvent {
  type: string;
  event_id?: string;
  [key: string]: unknown;
}

/**
 * Names of the built-in voice tools handled by the fixed switch in
 * handleFunctionCall(). Extension-contributed voice tools whose sanitized name
 * collides with one of these are skipped so a built-in is never shadowed.
 */
export const BUILTIN_VOICE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'submit_agent_prompt',
  'stop_voice_session',
  'get_session_summary',
  'ask_coding_agent',
  'pause_listening',
  'respond_to_interactive_prompt',
  'list_sessions',
  'navigate_to_session',
  'create_session',
  'propose_commit',
]);

/**
 * Result shape returned by the generic extension-voice-tool dispatch callback.
 */
export interface ExtensionVoiceToolResult {
  success: boolean;
  message?: string;
  data?: unknown;
  error?: string;
}

/**
 * A function/tool call the voice agent made. Emitted so the renderer can write
 * it to the voice session transcript (otherwise tool calls are invisible).
 * Sent twice per call: once when started, once when the result is returned.
 */
export type VoiceToolCallEvent =
  | {
      phase: 'started';
      callId: string;
      name: string;
      displayName: string;
      args: Record<string, unknown>;
    }
  | {
      phase: 'completed';
      callId: string;
      name: string;
      displayName: string;
      success: boolean;
      summary?: string;
    };

/** Human-friendly labels for the built-in voice tools (for transcript display). */
const BUILTIN_VOICE_TOOL_DISPLAY_NAMES: Record<string, string> = {
  submit_agent_prompt: 'Send task to coding agent',
  ask_coding_agent: 'Ask coding agent',
  get_session_summary: 'Get session summary',
  list_sessions: 'List sessions',
  navigate_to_session: 'Switch session',
  create_session: 'Create session',
  propose_commit: 'Propose commit',
  respond_to_interactive_prompt: 'Answer prompt',
  pause_listening: 'Pause listening',
  stop_voice_session: 'Stop voice session',
};

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
  tools?: Array<{
    type: string;
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }>;
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

export class RealtimeAPIClient {
  private ws: WebSocket | null = null;
  private apiKey: string;
  private model: RealtimeModel = PRIMARY_MODEL;
  private reasoningEffort: RealtimeReasoningEffort = 'low';
  // True once we've fallen back from gpt-realtime-2 to gpt-realtime for this
  // client (no account/region access). Prevents an infinite fallback loop.
  private usedModelFallback: boolean = false;
  private sessionId: string | null = null;
  private connected: boolean = false;
  private onAudioCallback: ((audioBase64: string) => void) | null = null;
  private onTextCallback: ((text: string) => void) | null = null;
  private onUserTranscriptCallback: ((transcript: string) => void) | null = null;
  private onUserTranscriptDeltaCallback: ((delta: string, itemId: string) => void) | null = null;
  private onTokenUsageCallback: ((usage: { inputAudio: number; outputAudio: number; text: number; total: number }) => void) | null = null;
  private onSubmitPromptCallback: ((prompt: string) => Promise<void>) | null = null;
  private onInterruptionCallback: (() => void) | null = null;
  private onDisconnectCallback: ((reason: 'timeout' | 'error' | 'user_stopped') => void) | null = null;
  private onErrorCallback: ((error: { type: string; message: string }) => void) | null = null;
  private onStopSessionCallback: (() => boolean) | null = null;
  private onGetSessionSummaryCallback: (() => Promise<{ success: boolean; summary?: string; error?: string }>) | null = null;
  private onAskCodingAgentCallback: ((question: string) => Promise<{ success: boolean; answer?: string; error?: string }>) | null = null;
  private onPauseListeningCallback: (() => void) | null = null;
  private onSpeechStoppedCallback: (() => void) | null = null;
  private onSpeechStartedCallback: (() => void) | null = null;
  private onRespondToPromptCallback: ((params: { sessionId: string; promptId: string; promptType: string; answer: string }) => Promise<{ success: boolean; error?: string }>) | null = null;
  private onListSessionsCallback: ((query?: string) => Promise<{ success: boolean; sessions?: Array<{ id: string; title: string; status: string }>; error?: string }>) | null = null;
  private onNavigateToSessionCallback: ((sessionId: string) => Promise<{ success: boolean; title?: string; error?: string }>) | null = null;
  private onCreateSessionCallback: ((title?: string) => Promise<{ success: boolean; sessionId?: string; title?: string; error?: string }>) | null = null;
  private onProposeCommitCallback: (() => Promise<{ success: boolean; error?: string }>) | null = null;
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
  private onReconnectingCallback: ((attempt: number) => void) | null = null;
  private onReconnectedCallback: (() => void) | null = null;

  // Deferred (async) function calls: on gpt-realtime-2 a long-running tool call
  // (submit_agent_prompt) stays open until the coding agent finishes, then is
  // resolved with the real summary via sendFunctionCallResult(). FIFO of open
  // call IDs awaiting an agent-task-complete. On the gpt-realtime fallback this
  // stays empty and the legacy queue + "[INTERNAL: Task complete]" wake is used.
  private deferredCallIds: string[] = [];

  // Extension-contributed voice tools (Core hook 1). Schemas are appended to the
  // session tool list; nameMap maps the realtime-safe name back to the original
  // namespaced (dotted) name for dispatch through the extension execution path.
  private extensionVoiceTools: RealtimeFunctionTool[] = [];
  private extensionVoiceToolNameMap: Map<string, string> = new Map();
  private onExtensionVoiceToolCallback:
    | ((namespacedName: string, args: Record<string, unknown>) => Promise<ExtensionVoiceToolResult>)
    | null = null;

  // Tool-call transcript visibility (Issue: voice tool calls were invisible).
  // Fired on call start and completion; the renderer persists each to the voice
  // session transcript. callId -> display label, so the completed event can be
  // labeled without re-deriving it.
  private onToolCallCallback: ((event: VoiceToolCallEvent) => void) | null = null;
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
    language?: string
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

  /**
   * Set callback for received audio
   */
  setOnAudio(callback: (audioBase64: string) => void): void {
    this.onAudioCallback = callback;
  }

  /**
   * Set callback for received text (assistant responses)
   */
  setOnText(callback: (text: string) => void): void {
    this.onTextCallback = callback;
  }

  /**
   * Set callback for user speech transcription (final/complete)
   */
  setOnUserTranscript(callback: (transcript: string) => void): void {
    this.onUserTranscriptCallback = callback;
  }

  /**
   * Set callback for user speech transcription delta (streaming/partial)
   */
  setOnUserTranscriptDelta(callback: (delta: string, itemId: string) => void): void {
    this.onUserTranscriptDeltaCallback = callback;
  }

  /**
   * Set callback for token usage updates (for live context indicator)
   */
  setOnTokenUsage(callback: (usage: { inputAudio: number; outputAudio: number; text: number; total: number }) => void): void {
    this.onTokenUsageCallback = callback;
  }

  /**
   * Set callback for submitting prompts to Claude Code
   */
  setOnSubmitPrompt(callback: (prompt: string) => Promise<void>): void {
    this.onSubmitPromptCallback = callback;
  }

  /**
   * Set callback for when user interrupts the assistant
   */
  setOnInterruption(callback: () => void): void {
    this.onInterruptionCallback = callback;
  }

  /**
   * Set callback for when user stops speaking (VAD detected silence)
   */
  setOnSpeechStopped(callback: () => void): void {
    this.onSpeechStoppedCallback = callback;
  }

  /**
   * Set callback for when the user starts speaking (VAD speech_started).
   * Fired for EVERY trigger, independent of the barge-in interrupt decision
   * (which can defer or suppress onInterruption entirely for echo-suspect
   * triggers) -- the renderer needs it to hold the listen window open for
   * the whole utterance (NIM-1594).
   */
  setOnSpeechStarted(callback: () => void): void {
    this.onSpeechStartedCallback = callback;
  }

  /**
   * Set callback for when the connection is closed
   */
  setOnDisconnect(callback: (reason: 'timeout' | 'error' | 'user_stopped') => void): void {
    this.onDisconnectCallback = callback;
  }

  /**
   * Set callback for errors (quota exceeded, rate limits, etc.)
   */
  setOnError(callback: (error: { type: string; message: string }) => void): void {
    this.onErrorCallback = callback;
  }

  /**
   * Set callback fired when an unexpected drop triggers a reconnect attempt.
   * Lets the renderer show a transient "reconnecting…" state instead of dying.
   */
  setOnReconnecting(callback: (attempt: number) => void): void {
    this.onReconnectingCallback = callback;
  }

  /**
   * Set callback fired when a reconnect succeeds and the session config has
   * been re-applied, so the renderer can clear the "reconnecting…" state.
   */
  setOnReconnected(callback: () => void): void {
    this.onReconnectedCallback = callback;
  }

  /**
   * Set callback for stopping the voice session
   */
  setOnStopSession(callback: () => boolean): void {
    this.onStopSessionCallback = callback;
  }

  /**
   * Set callback for getting session summary
   */
  setOnGetSessionSummary(callback: () => Promise<{ success: boolean; summary?: string; error?: string }>): void {
    this.onGetSessionSummaryCallback = callback;
  }

  /**
   * Set callback for asking the coding agent questions
   */
  setOnAskCodingAgent(callback: (question: string) => Promise<{ success: boolean; answer?: string; error?: string }>): void {
    this.onAskCodingAgentCallback = callback;
  }

  /**
   * Set callback for when the voice agent wants to pause listening
   */
  setOnPauseListening(callback: () => void): void {
    this.onPauseListeningCallback = callback;
  }

  /**
   * Set callback for responding to an interactive prompt (AskUserQuestion, etc.)
   */
  setOnRespondToPrompt(callback: (params: { sessionId: string; promptId: string; promptType: string; answer: string }) => Promise<{ success: boolean; error?: string }>): void {
    this.onRespondToPromptCallback = callback;
  }

  /**
   * Set callback for listing AI sessions
   */
  setOnListSessions(callback: (query?: string) => Promise<{ success: boolean; sessions?: Array<{ id: string; title: string; status: string }>; error?: string }>): void {
    this.onListSessionsCallback = callback;
  }

  /**
   * Set callback for navigating to a specific AI session
   */
  setOnNavigateToSession(callback: (sessionId: string) => Promise<{ success: boolean; title?: string; error?: string }>): void {
    this.onNavigateToSessionCallback = callback;
  }

  /**
   * Set callback for creating a new AI session
   */
  setOnCreateSession(callback: (title?: string) => Promise<{ success: boolean; sessionId?: string; title?: string; error?: string }>): void {
    this.onCreateSessionCallback = callback;
  }

  /**
   * Set callback for proposing a commit via the AI commit feature.
   * The voice agent calls this when the user says "propose a commit" /
   * "commit with AI" / "smart commit" -- the callback dispatches a prompt
   * to the coding agent so it can generate a commit proposal widget.
   */
  setOnProposeCommit(callback: () => Promise<{ success: boolean; error?: string }>): void {
    this.onProposeCommitCallback = callback;
  }

  /**
   * Provide extension-contributed voice tools (Core hook 1). Must be called
   * before connect() so the tool list is in place when the session is configured.
   * @param schemas Realtime function-tool schemas to append to the session.
   * @param nameMap Realtime-safe name -> namespaced (dotted) name for dispatch.
   */
  setExtensionVoiceTools(schemas: RealtimeFunctionTool[], nameMap: Map<string, string>): void {
    this.extensionVoiceTools = schemas;
    this.extensionVoiceToolNameMap = nameMap;
  }

  /**
   * Set the generic dispatch callback invoked when the voice agent calls an
   * extension-contributed tool (any tool name not handled by the built-in
   * switch in handleFunctionCall()).
   */
  setOnExtensionVoiceTool(
    callback: (namespacedName: string, args: Record<string, unknown>) => Promise<ExtensionVoiceToolResult>
  ): void {
    this.onExtensionVoiceToolCallback = callback;
  }

  /**
   * Set callback fired when the voice agent calls a tool (started + completed),
   * so the renderer can record it in the voice session transcript.
   */
  setOnToolCall(callback: (event: VoiceToolCallEvent) => void): void {
    this.onToolCallCallback = callback;
  }

  /** Resolve a display label for a tool call (built-in label or namespaced name). */
  private toolDisplayName(name: string): string {
    if (BUILTIN_VOICE_TOOL_DISPLAY_NAMES[name]) {
      return BUILTIN_VOICE_TOOL_DISPLAY_NAMES[name];
    }
    // Extension tool: prefer the original namespaced (dotted) name if known.
    return this.extensionVoiceToolNameMap.get(name) ?? name;
  }

  /**
   * Build the full list of function tools advertised in the Realtime session
   * config: the built-in tools followed by any extension-contributed voice
   * tools. Exposed (not private) so the tool list can be asserted in tests
   * without opening a WebSocket.
   */
  buildSessionTools(): NonNullable<SessionConfig['tools']> {
    return [...this.buildBuiltinTools(), ...this.extensionVoiceTools];
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
        console.warn(`[RealtimeAPIClient] ${PRIMARY_MODEL} unavailable, falling back to ${FALLBACK_MODEL}`, { error });
        try {
          AnalyticsService.getInstance().sendEvent('voice_model_fallback', {
            from: PRIMARY_MODEL,
            to: FALLBACK_MODEL,
          });
        } catch { /* analytics is best-effort */ }
        await this.openSocket();
        return;
      }
      throw error;
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
          console.error('[RealtimeAPIClient] Failed to parse server event', { error });
        }
      });

      ws.on('error', (error) => {
        console.error('[RealtimeAPIClient] WebSocket error', { error });
        this.connected = false;
        if (!opened && !settled) {
          settled = true;
          reject(error);
        }
        // A post-open error is followed by 'close', which drives reconnect.
      });

      ws.on('close', (code, reason) => {
        this.connected = false;
        this.stopInactivityMonitor();
        if (!opened) {
          if (!settled) {
            settled = true;
            reject(new Error(`Socket closed before open: ${code} ${String(reason)}`));
          }
          return;
        }
        this.handleUnexpectedClose(code, String(reason));
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
      if (this.onErrorCallback) {
        this.onErrorCallback({
          type: 'connection_lost',
          message: 'Voice connection was lost and could not be restored.',
        });
      }
      if (this.onDisconnectCallback) {
        this.onDisconnectCallback('error');
      }
      return;
    }

    this.reconnectAttempts++;
    const attempt = this.reconnectAttempts;
    const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1), RECONNECT_MAX_DELAY_MS);
    console.log(`[RealtimeAPIClient] Reconnect attempt ${attempt}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`);
    if (this.onReconnectingCallback) {
      this.onReconnectingCallback(attempt);
    }

    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.intentionalDisconnect) return;
      try {
        await this.openSocket();
        // session.created -> updateSession() re-applies the identical config.
        console.log('[RealtimeAPIClient] Reconnected');
        if (this.onReconnectedCallback) {
          this.onReconnectedCallback();
        }
      } catch (error) {
        console.error('[RealtimeAPIClient] Reconnect attempt failed', { error });
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
          console.error('[RealtimeAPIClient] Response failed:', error.type, error.message);
          if (this.onErrorCallback) {
            this.onErrorCallback({
              type: error.type || 'unknown_error',
              message: error.message || 'Voice mode encountered an error',
            });
          }
        }
        this.currentResponseId = null;
        this.hasActiveResponse = false;
        this.hasPendingFunctionCall = false;
        this.isOutputtingAudio = false;
        break;

      // GA event is response.output_audio.delta; the beta name is kept for safety.
      case 'response.output_audio.delta':
      case 'response.audio.delta':
        // Received audio chunk from OpenAI
        this.isOutputtingAudio = true;
        // Remember which conversation item is speaking so a barge-in during
        // the (renderer-side) playback tail can truncate it server-side.
        if ((event as any).item_id) {
          this.currentAssistantItemId = (event as any).item_id as string;
        }
        const audioDelta = (event as any).delta as string; // base64-encoded PCM16
        this.handleAudioDelta(audioDelta);
        if (this.onAudioCallback) {
          this.onAudioCallback(audioDelta);
        }
        break;

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
        if (textDelta && this.onTextCallback) {
          this.onTextCallback(textDelta);
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
        if (this.onSpeechStartedCallback) {
          this.onSpeechStartedCallback();
        }
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
        if (this.onSpeechStoppedCallback) {
          this.onSpeechStoppedCallback();
        }
        break;
      }

      case 'conversation.item.input_audio_transcription.delta':
        // Streaming transcription delta - shows partial text while user is speaking
        const delta = (event as any).delta as string;
        const deltaItemId = (event as any).item_id as string;
        if (delta && this.onUserTranscriptDeltaCallback) {
          this.onUserTranscriptDeltaCallback(delta, deltaItemId);
        }
        break;

      case 'conversation.item.input_audio_transcription.completed':
        // User's speech has been transcribed (final result)
        const transcript = (event as any).transcript as string;
        console.log('[RealtimeAPIClient] User transcript received:', transcript);
        if (transcript && this.onUserTranscriptCallback) {
          this.onUserTranscriptCallback(transcript);
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
        console.error('[RealtimeAPIClient] Server error:', JSON.stringify(errorEvent.error, null, 2));
        console.error('[RealtimeAPIClient] Full error event:', JSON.stringify(errorEvent, null, 2));
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
    this.cancelCurrentResponse();
    if (this.onInterruptionCallback) {
      this.onInterruptionCallback();
    }
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

    // Build instructions with optional custom prepend/append
    const baseInstructions = `You are a voice assistant that serves as the conversational interface between the user and a coding agent (Claude).

Architecture:
- You handle voice interaction with the user
- A separate coding agent (Claude) handles all coding tasks, file searches, and technical work
- You relay requests to the coding agent and summarize its responses for voice

Session: ${this.sessionContext}

RESPONSE STYLE (critical): This is a spoken conversation. Be extremely brief -- one short sentence by default, often just a few words. Never use more than one sentence unless the user explicitly asks for detail ("explain", "tell me more", "why"). Answer or act, then STOP. No preamble, no recap, no previewing what you're about to do, no caveats, no filler ("Sure!", "Got it", "Great question"). Never read code or file paths aloud.

IMPORTANT: Your knowledge of this codebase is limited to the session context above. You do NOT have current knowledge of this project's code, files, implementation details, or recent changes. Do not assume you know how features work -- look it up. If project-knowledge or memory tools are listed below, prefer them for that lookup; otherwise ask the coding agent.

Tools:
- submit_agent_prompt: Send a coding task to the coding agent.
- ask_coding_agent: Ask the coding agent a question about the project.
- create_session: Start a brand new coding session. Future commands will target it.
- list_sessions: List recent coding sessions in this workspace.
- navigate_to_session: Switch to a specific existing coding session.
- propose_commit: Trigger the AI commit feature when the user says "propose a commit", "commit with AI", or "smart commit". The proposal arrives as an [INTERACTIVE PROMPT].
- respond_to_interactive_prompt: Answer a pending interactive prompt from the coding agent.
- pause_listening: Put the microphone to sleep.
- stop_voice_session: End the voice session entirely.
- get_session_summary: Get a summary of what's been discussed.

Guidelines:
- Be terse (see RESPONSE STYLE above). One short sentence per response by default; no filler, no acknowledgments, no explanations unless the user asks.
- When the user says "shut up", "stop talking", "be quiet", "stop listening", "shh", or anything similar: IMMEDIATELY call pause_listening. Say ABSOLUTELY NOTHING before or after calling the tool -- not "ok", not "pausing", not any acknowledgment at all. Do not describe what will happen with the mic. Just call the tool silently.
- For coding tasks: use submit_agent_prompt, say what you did in ~5 words (e.g. "Submitted."), then STOP. Do NOT say anything about waiting, timing out, or checking back. The microphone will go dormant automatically. You will be woken up with an "[INTERNAL: Task complete...]" message when the coding agent finishes. There is NO timeout -- tasks can take minutes. You do NOT need to monitor, wait, or follow up.
- submit_agent_prompt is not an approval gate: it queues on screen and auto-sends after a short countdown the user controls. Never ask the user to approve or confirm first ("if you approve", "should I send it?"). Only "[INTERACTIVE PROMPT: ...]" messages wait for a spoken yes/no.
- For questions about this project (how it works, what was decided, what is in flight): if project-knowledge or memory tools (e.g. search_project_knowledge, recall) are listed in your tools, call them FIRST -- they answer in under a second. Only fall back to ask_coding_agent when memory returns nothing or the question needs live code inspection (reading current files, running something). When you do use ask_coding_agent, summarize the result conversationally for the user.
- Only answer directly for truly general knowledge questions unrelated to this project.
- Brainstorming and planning: you can be a design partner, not just a relay. Talk an idea through, push back, and when it is fleshed out kick off a written plan with submit_agent_prompt phrased as "/design <the idea>". To start implementation against an approved plan, use submit_agent_prompt phrased as "/implement <plan>". If extra grounding or plan-reading tools are listed in your context above, prefer them for pulling design docs and reading plans back; otherwise fall back to ask_coding_agent.
- For "[INTERNAL: Task complete. Result: ...]" messages: briefly relay the result to the user. Do NOT say "I finished that task" -- just state the result.
- For "[INTERNAL: User is now viewing ...]" messages: do NOT announce this. Silently note it for context.
- For "[INTERACTIVE PROMPT: ...]" messages: the coding agent needs user input. Read the question and option labels aloud BRIEFLY -- just the question and option labels, not descriptions. Then WAIT for the user to clearly state their choice. Do NOT call respond_to_interactive_prompt until you hear a clear, deliberate answer from the user. If you hear garbled audio, silence, or unclear speech, ask "Which option?" -- do NOT guess or pick the first option. The user's microphone may pick up echo from your own speech -- ignore any "response" that arrives while you are still speaking or immediately after.
- When summarizing coding agent responses: be concise, paraphrase for speech. Never read code or file paths verbatim.
- NEVER say the coding agent "didn't respond", "timed out", or "isn't responding". Tasks take as long as they take.

CRITICAL - Passing through user requests:
When the user says "ask the coding agent..." or "tell the coding agent..." or similar, you MUST pass their request VERBATIM to the coding agent. Do NOT rephrase, interpret, or add your own context. Examples:
- User: "Ask the coding agent for a random number" -> Pass exactly: "Give me a random number"
- User: "Tell the coding agent HMR is not the problem" -> Pass exactly: "HMR is not the problem"
- User: "Ask Claude what file handles voice mode" -> Pass exactly: "What file handles voice mode?"
Your job is to be a voice relay, not to interpret or improve the user's requests.`;

    // On gpt-realtime-2, submit_agent_prompt is an async (deferred) call: the
    // tool result IS the completion summary and arrives only when the coding
    // agent finishes. Tell the agent so it doesn't expect a separate
    // "[INTERNAL: Task complete]" message on this model.
    const asyncToolNote = this.supportsAsyncFunctionCalls()
      ? `\n\nNOTE on submit_agent_prompt: this is an asynchronous tool. The call stays open and returns its result ONLY when the coding agent finishes (which can take minutes). You will receive the summary as the tool's result, not as a separate "[INTERNAL: Task complete]" message. After calling it, acknowledge in ~5 words (e.g. "On it.") then STOP and wait silently -- the mic sleeps automatically. When the tool result arrives, briefly relay it to the user.`
      : '';

    // Apply custom prepend/append if configured
    let instructions = baseInstructions + asyncToolNote;
    if (this.customPrompt.prepend) {
      instructions = this.customPrompt.prepend + '\n\n' + instructions;
    }
    if (this.customPrompt.append) {
      instructions = instructions + '\n\n' + this.customPrompt.append;
    }

    // Pin the spoken language to the desktop's configured default so the voice
    // agent never auto-detects/drifts into a different language at startup.
    // Appended last so it takes precedence over any custom prompt text.
    const effectiveLanguage = this.language?.trim() || 'English';
    instructions = instructions + `\n\nLANGUAGE: Always speak to the user in ${effectiveLanguage}, regardless of the language the user speaks in. Begin and conduct the entire conversation in ${effectiveLanguage}.`;

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
  }

  /**
   * Built-in voice tool schemas advertised on every session. Extension-
   * contributed voice tools are appended in buildSessionTools().
   */
  private buildBuiltinTools(): NonNullable<SessionConfig['tools']> {
    return [
        {
          type: 'function',
          name: 'submit_agent_prompt',
          description: 'Queue a coding task for yourself to process. Use this when the user asks you to write code, fix bugs, refactor, or perform any coding task. The task is queued and sends automatically after a brief on-screen countdown the user controls -- do NOT ask the user to approve or confirm before calling this. You will be notified when it completes.',
          parameters: {
            type: 'object',
            properties: {
              prompt: {
                type: 'string',
                description: 'The coding task to queue for yourself. Be specific and include all relevant context from the conversation. IMPORTANT: End your prompt with "When done, provide a clear 1-sentence summary of what was changed or fixed." This ensures you get a useful summary to relay to the user.',
              },
            },
            required: ['prompt'],
          },
        },
        {
          type: 'function',
          name: 'stop_voice_session',
          description: 'End the current voice mode session. Use this when the user says goodbye, wants to stop talking, or the conversation is complete. This will disconnect from voice mode.',
          parameters: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          type: 'function',
          name: 'get_session_summary',
          description: 'Get a summary of the current AI session. Returns information about the session name, message counts, duration, and recent topics discussed. Use this when the user asks about what has been discussed or wants a recap.',
          parameters: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          type: 'function',
          name: 'ask_coding_agent',
          description: 'Send a message to the coding agent. IMPORTANT: When the user says "ask the coding agent X" or "tell the coding agent Y", pass their message VERBATIM - do not rephrase or interpret it. The coding agent can search files, read code, look up documentation, run web searches, or answer questions. You are a voice relay - pass through what the user says exactly.',
          parameters: {
            type: 'object',
            properties: {
              question: {
                type: 'string',
                description: 'The message to send to the coding agent. PASS VERBATIM what the user said - do not rephrase, interpret, or add context. If user says "ask coding agent for a random number", send "give me a random number". If user says "tell coding agent HMR is not the problem", send "HMR is not the problem".',
              },
            },
            required: ['question'],
          },
        },
        {
          type: 'function',
          name: 'pause_listening',
          description: 'Pause listening for voice input. The voice session stays active but the microphone goes to sleep. Use when the user says to stop listening, go to sleep, be quiet, or pause. The mic will reactivate automatically when a coding task completes or another event requires your attention. Do NOT tell the user the mic will reactivate when they speak -- they cannot trigger it by speaking while paused.',
          parameters: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          type: 'function',
          name: 'respond_to_interactive_prompt',
          description: 'Respond to an interactive prompt from the coding agent (e.g. AskUserQuestion, ExitPlanMode, GitCommitProposal). When you receive an "[INTERACTIVE PROMPT: ...]" message, read the question and options to the user, listen for their answer, then call this tool with their response. For AskUserQuestion: set answer to the option label the user chose (or their free-text answer). For ExitPlanMode: set answer to "approve" or "reject". For GitCommitProposal: set answer to "approve" or "reject".',
          parameters: {
            type: 'object',
            properties: {
              promptId: {
                type: 'string',
                description: 'The promptId from the interactive prompt message.',
              },
              promptType: {
                type: 'string',
                description: 'The type of prompt: "ask_user_question_request", "exit_plan_mode_request", or "git_commit_proposal_request".',
              },
              answer: {
                type: 'string',
                description: 'The user\'s answer. For AskUserQuestion: the selected option label or free-text. For ExitPlanMode/GitCommitProposal: "approve" or "reject".',
              },
            },
            required: ['promptId', 'promptType', 'answer'],
          },
        },
        {
          type: 'function',
          name: 'list_sessions',
          description: 'List or find AI sessions in this workspace. Returns session IDs, titles, running status, and a "lastActive" time (e.g. "2 hours ago"). With no query it returns the most recent sessions. With a query it finds sessions by TOPIC, semantically matching what each session was actually working on (its prompts and the work done) -- not just the title -- so "the session working on the collaborative document system" resolves even when those words are not in the title. Use this before navigating to a session. When the user asks for "the most recent session working on X", pass X as the query and pick the result with the most recent "lastActive".',
          parameters: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Optional topic to find sessions by. Describe what the session was about (e.g. "collaborative document system", "voice mode bugs"); content is matched semantically, not just titles.',
              },
            },
            required: [],
          },
        },
        {
          type: 'function',
          name: 'navigate_to_session',
          description: 'Switch the Nimbalyst UI to a specific AI session, bringing it into focus. Use this when the user asks to switch to, open, or go to a particular session. Call list_sessions first to find the session ID.',
          parameters: {
            type: 'object',
            properties: {
              sessionId: {
                type: 'string',
                description: 'The session ID to navigate to.',
              },
            },
            required: ['sessionId'],
          },
        },
        {
          type: 'function',
          name: 'create_session',
          description: 'Create a new coding session in the current workspace and switch to it. Use this when the user asks to start a new session, open a fresh chat, begin a new task, or anything that implies starting from scratch. After this returns, future submit_agent_prompt and ask_coding_agent calls will target the new session.',
          parameters: {
            type: 'object',
            properties: {
              title: {
                type: 'string',
                description: 'Optional short title for the new session (e.g. "Refactor auth flow"). If the user gave a topic, derive a brief title from it. Omit if the user did not specify what the session is for.',
              },
            },
            required: [],
          },
        },
        {
          type: 'function',
          name: 'propose_commit',
          description: 'Trigger the "Commit with AI" feature. Use this when the user says "propose a commit", "commit with AI", "smart commit", or asks you to summarize and commit their changes. The coding agent will draft a commit message and file list. The proposal arrives shortly as an [INTERACTIVE PROMPT: ... promptType="git_commit_proposal_request"] message -- read its commit message aloud briefly, then wait for the user to say "approve" or "reject" and call respond_to_interactive_prompt with their answer.',
          parameters: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
    ];
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
              text,
            },
          ],
        },
      };

      this.ws.send(JSON.stringify(event));
      // No createResponse() -- this is silent context injection
      return true;
    } catch (error) {
      console.error('[RealtimeAPIClient] Failed to inject context:', error);
      return false;
    }
  }

  /**
   * Send a text message from the user to the assistant
   * This is used to notify the voice assistant when the coding agent completes
   * Returns true if message was sent successfully, false otherwise
   */
  sendUserMessage(text: string): boolean {
    if (!this.ws || !this.connected) {
      console.error('[RealtimeAPIClient] Cannot send user message - WebSocket not connected');
      return false;
    }

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
              text: text,
            },
          ],
        },
      };

      this.ws.send(JSON.stringify(event));

      // Trigger a response from the assistant
      this.createResponse();

      return true;
    } catch (error) {
      console.error('[RealtimeAPIClient] Failed to send user message:', error);
      return false;
    }
  }

  /**
   * Whether there is an open async (deferred) function call awaiting a result.
   * VoiceModeService checks this on agent-task-complete to decide between
   * resolving the open call (gpt-realtime-2) and injecting a wake message.
   */
  hasDeferredCall(): boolean {
    return this.deferredCallIds.length > 0;
  }

  /**
   * Resolve the oldest open async function call with the coding agent's result.
   * Delivers the summary as the function_call_output (which triggers the agent
   * to speak it) instead of a synthetic success + injected wake message.
   * Returns true if a deferred call was resolved, false if none was pending.
   */
  resolveDeferredCall(result: { success: boolean; summary?: string; error?: string }): boolean {
    const callId = this.deferredCallIds.shift();
    if (!callId) return false;
    console.log(`[RealtimeAPIClient] Resolving deferred call ${callId}`);
    this.sendFunctionCallResult(callId, result);
    return true;
  }

  /**
   * Handle incoming audio delta from OpenAI
   * In a full implementation, this would decode and play the audio
   */
  private handleAudioDelta(audioBase64: string): void {
    // Audio is handled via callback
  }

  /**
   * Handle function call from OpenAI
   */
  private async handleFunctionCall(callId: string, name: string, argsJson: string): Promise<void> {
    // Record the call so it shows up in the voice session transcript. The
    // matching 'completed' event is emitted from sendFunctionCallResult().
    const displayName = this.toolDisplayName(name);
    this.pendingToolCalls.set(callId, { name, displayName });
    if (this.onToolCallCallback) {
      let parsedArgs: Record<string, unknown> = {};
      try {
        parsedArgs = argsJson ? JSON.parse(argsJson) : {};
      } catch {
        parsedArgs = {};
      }
      this.onToolCallCallback({ phase: 'started', callId, name, displayName, args: parsedArgs });
    }

    switch (name) {
      case 'submit_agent_prompt': {
        try {
          const args = JSON.parse(argsJson);
          const prompt = args.prompt;

          // Track prompt submission (no content for privacy)
          AnalyticsService.getInstance().sendEvent('voice_prompt_submitted');

          if (!this.onSubmitPromptCallback) {
            throw new Error('No submit prompt callback registered');
          }
          await this.onSubmitPromptCallback(prompt);

          if (this.supportsAsyncFunctionCalls()) {
            // Async (deferred) function calling: keep the call open. The real
            // summary is delivered via resolveDeferredCall() when the coding
            // agent finishes (voice-mode:agent-task-complete), instead of
            // returning a synthetic "queued" and later injecting a wake message.
            this.deferredCallIds.push(callId);
            console.log(`[RealtimeAPIClient] submit_agent_prompt deferred (callId=${callId})`);
          } else {
            // Fallback model: synthetic success now; legacy queue + wake later.
            this.sendFunctionCallResult(callId, {
              success: true,
              message: 'Task queued; it auto-sends after a short countdown the user controls. You will be notified when it completes.',
            });
          }
        } catch (error) {
          console.error('[RealtimeAPIClient] Failed to submit prompt to agent:', error);
          this.sendFunctionCallResult(callId, {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        break;
      }

      case 'stop_voice_session': {
        try {
          if (this.onStopSessionCallback) {
            const stopped = this.onStopSessionCallback();
            this.sendFunctionCallResult(callId, {
              success: stopped,
              message: stopped ? 'Voice session ended.' : 'No active session to stop.',
            });
          } else {
            this.sendFunctionCallResult(callId, {
              success: false,
              error: 'Stop session callback not registered',
            });
          }
        } catch (error) {
          console.error('[RealtimeAPIClient] Failed to stop session:', error);
          this.sendFunctionCallResult(callId, {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        break;
      }

      case 'get_session_summary': {
        try {
          if (this.onGetSessionSummaryCallback) {
            const result = await this.onGetSessionSummaryCallback();
            this.sendFunctionCallResult(callId, result);
          } else {
            this.sendFunctionCallResult(callId, {
              success: false,
              error: 'Session summary callback not registered',
            });
          }
        } catch (error) {
          console.error('[RealtimeAPIClient] Failed to get session summary:', error);
          this.sendFunctionCallResult(callId, {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        break;
      }

      case 'ask_coding_agent': {
        try {
          const args = JSON.parse(argsJson);
          const question = args.question;

          if (!question) {
            this.sendFunctionCallResult(callId, {
              success: false,
              error: 'question parameter is required',
            });
            break;
          }

          if (this.onAskCodingAgentCallback) {
            const result = await this.onAskCodingAgentCallback(question);
            this.sendFunctionCallResult(callId, result);
          } else {
            this.sendFunctionCallResult(callId, {
              success: false,
              error: 'Ask coding agent callback not registered',
            });
          }
        } catch (error) {
          console.error('[RealtimeAPIClient] Failed to ask coding agent:', error);
          this.sendFunctionCallResult(callId, {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        break;
      }

      case 'pause_listening': {
        try {
          this.listeningPaused = true;
          if (this.onPauseListeningCallback) {
            this.onPauseListeningCallback();
          }
          this.sendFunctionCallResult(callId, {
            success: true,
            message: 'Listening paused. The mic will reactivate automatically when a task completes or an event needs attention.',
          });
        } catch (error) {
          console.error('[RealtimeAPIClient] Failed to pause listening:', error);
          this.sendFunctionCallResult(callId, {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        break;
      }

      case 'respond_to_interactive_prompt': {
        try {
          const args = JSON.parse(argsJson);
          const { promptId, promptType, answer } = args;

          if (!promptId || !promptType || !answer) {
            this.sendFunctionCallResult(callId, {
              success: false,
              error: 'promptId, promptType, and answer are all required',
            });
            break;
          }

          if (this.onRespondToPromptCallback) {
            const result = await this.onRespondToPromptCallback({
              sessionId: this.sessionId || '',
              promptId,
              promptType,
              answer,
            });
            this.sendFunctionCallResult(callId, result);
          } else {
            this.sendFunctionCallResult(callId, {
              success: false,
              error: 'Respond to prompt callback not registered',
            });
          }
        } catch (error) {
          console.error('[RealtimeAPIClient] Failed to respond to prompt:', error);
          this.sendFunctionCallResult(callId, {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        break;
      }

      case 'list_sessions': {
        try {
          const args = argsJson ? JSON.parse(argsJson) : {};
          if (this.onListSessionsCallback) {
            const result = await this.onListSessionsCallback(args.query);
            this.sendFunctionCallResult(callId, result);
          } else {
            this.sendFunctionCallResult(callId, {
              success: false,
              error: 'List sessions callback not registered',
            });
          }
        } catch (error) {
          console.error('[RealtimeAPIClient] Failed to list sessions:', error);
          this.sendFunctionCallResult(callId, {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        break;
      }

      case 'navigate_to_session': {
        try {
          const args = JSON.parse(argsJson);
          const { sessionId } = args;

          if (!sessionId) {
            this.sendFunctionCallResult(callId, {
              success: false,
              error: 'sessionId parameter is required',
            });
            break;
          }

          if (this.onNavigateToSessionCallback) {
            const result = await this.onNavigateToSessionCallback(sessionId);
            this.sendFunctionCallResult(callId, result);
          } else {
            this.sendFunctionCallResult(callId, {
              success: false,
              error: 'Navigate to session callback not registered',
            });
          }
        } catch (error) {
          console.error('[RealtimeAPIClient] Failed to navigate to session:', error);
          this.sendFunctionCallResult(callId, {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        break;
      }

      case 'create_session': {
        try {
          const args = argsJson ? JSON.parse(argsJson) : {};
          const title = typeof args.title === 'string' && args.title.trim().length > 0
            ? args.title.trim()
            : undefined;

          if (this.onCreateSessionCallback) {
            const result = await this.onCreateSessionCallback(title);
            this.sendFunctionCallResult(callId, result);
          } else {
            this.sendFunctionCallResult(callId, {
              success: false,
              error: 'Create session callback not registered',
            });
          }
        } catch (error) {
          console.error('[RealtimeAPIClient] Failed to create session:', error);
          this.sendFunctionCallResult(callId, {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        break;
      }

      case 'propose_commit': {
        try {
          if (this.onProposeCommitCallback) {
            const result = await this.onProposeCommitCallback();
            this.sendFunctionCallResult(callId, {
              success: result.success,
              message: result.success
                ? 'Commit proposal requested. Wait for the [INTERACTIVE PROMPT] message.'
                : undefined,
              error: result.error,
            });
          } else {
            this.sendFunctionCallResult(callId, {
              success: false,
              error: 'Propose commit callback not registered',
            });
          }
        } catch (error) {
          console.error('[RealtimeAPIClient] Failed to propose commit:', error);
          this.sendFunctionCallResult(callId, {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        break;
      }

      default: {
        // Not a built-in tool -- route to an extension-contributed voice tool
        // (Core hook 1) if one is registered under this realtime-safe name.
        const namespacedName = this.extensionVoiceToolNameMap.get(name);
        if (namespacedName && this.onExtensionVoiceToolCallback) {
          try {
            const args = argsJson ? JSON.parse(argsJson) : {};
            const result = await this.onExtensionVoiceToolCallback(namespacedName, args);
            this.sendFunctionCallResult(callId, result);
          } catch (error) {
            console.error('[RealtimeAPIClient] Extension voice tool failed:', name, error);
            this.sendFunctionCallResult(callId, {
              success: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          break;
        }

        console.error('[RealtimeAPIClient] Unknown function call:', name);
        this.sendFunctionCallResult(callId, { error: 'Unknown function' });
      }
    }
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
      if (this.onToolCallCallback) {
        const r = (result ?? {}) as Record<string, unknown>;
        const success = typeof r.success === 'boolean' ? r.success : !r.error;
        const summary =
          (typeof r.summary === 'string' && r.summary) ||
          (typeof r.answer === 'string' && r.answer) ||
          (typeof r.message === 'string' && r.message) ||
          (typeof r.error === 'string' && r.error) ||
          undefined;
        this.onToolCallCallback({
          phase: 'completed',
          callId,
          name: pending.name,
          displayName: pending.displayName,
          success,
          summary: summary || undefined,
        });
      }
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
   * Sends a partial session.update touching only turn_detection. No-ops in
   * push_to_talk mode (no turn detection) and when the state is unchanged.
   */
  private setServerResponsesGated(gated: boolean): void {
    if (gated === this.serverResponsesGated) return;
    this.serverResponsesGated = gated;
    if (!this.ws || !this.connected || this.turnDetection.mode === 'push_to_talk') return;
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
    if (this.onTokenUsageCallback) {
      this.onTokenUsageCallback({
        inputAudio: this.inputAudioTokens,
        outputAudio: this.outputAudioTokens,
        text: this.textTokens,
        total: totalTokens,
      });
    }
  }

  /**
   * Get current token usage statistics
   */
  getTokenUsage(): { inputAudio: number; outputAudio: number; text: number; total: number } {
    return {
      inputAudio: this.inputAudioTokens,
      outputAudio: this.outputAudioTokens,
      text: this.textTokens,
      total: this.inputAudioTokens + this.outputAudioTokens + this.textTokens,
    };
  }

  /**
   * Disconnect from OpenAI Realtime API
   * @param reason Optional reason for disconnect (default: 'user_stopped')
   */
  disconnect(reason: 'timeout' | 'error' | 'user_stopped' = 'user_stopped'): void {
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
    this.deferredCallIds = [];

    if (this.ws) {
      this.stopInactivityMonitor();

      // Call disconnect callback before closing
      if (this.onDisconnectCallback) {
        this.onDisconnectCallback(reason);
      }

      this.ws.close();
      this.ws = null;
      this.connected = false;
      this.sessionId = null;
      this.currentResponseId = null;
      this.hasActiveResponse = false;
      this.currentAssistantItemId = null;
      this.serverResponsesGated = false;
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
