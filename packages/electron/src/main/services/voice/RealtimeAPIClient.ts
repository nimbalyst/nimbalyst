/**
 * OpenAI Realtime API WebSocket Client
 *
 * Manages WebSocket connection to OpenAI's Realtime API for voice interactions.
 * Handles audio streaming, function calls, and session management.
 */

import WebSocket from 'ws';
import { ipcMain } from 'electron';
import { AnalyticsService } from '../analytics/AnalyticsService';

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
  audio: {
    input: {
      format: AudioFormat;
      transcription?: { model: string };
      turn_detection?: {
        type: string;
        threshold?: number;
        prefix_padding_ms?: number;
        silence_duration_ms?: number;
      };
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
  vadThreshold?: number;
  silenceDuration?: number;
  interruptible?: boolean;
}

// All available OpenAI Realtime API voices
type VoiceId = 'alloy' | 'ash' | 'ballad' | 'coral' | 'echo' | 'sage' | 'shimmer' | 'verse' | 'marin' | 'cedar';

export class RealtimeAPIClient {
  private ws: WebSocket | null = null;
  private apiKey: string;
  private model: string = 'gpt-realtime';
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

  // When true, the inactivity monitor is suspended (e.g. voice is sleeping)
  private listeningPaused: boolean = false;

  constructor(
    apiKey: string,
    claudeCodeSessionId: string,
    workspacePath: string | null,
    window: Electron.BrowserWindow,
    sessionContext?: string,
    customPrompt?: CustomPromptConfig,
    turnDetection?: TurnDetectionConfig,
    voice?: VoiceId
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
    console.log(`[RealtimeAPIClient] Created with voice=${this.voice}`);
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
   * Connect to OpenAI Realtime API via WebSocket
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `wss://api.openai.com/v1/realtime?model=${this.model}`;

      console.log('[RealtimeAPIClient] Connecting to OpenAI Realtime API', { url });

      // Do NOT send the 'OpenAI-Beta: realtime=v1' header: it selects the retired
      // Beta API shape, which the server now rejects with
      // code=4000 reason=beta_api_shape_disabled. Omitting it selects the GA shape.
      this.ws = new WebSocket(url, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
        },
      });

      this.ws.on('open', () => {
        this.connected = true;
        this.startInactivityMonitor();
        resolve();
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        try {
          const event = JSON.parse(data.toString()) as RealtimeEvent;
          this.handleServerEvent(event);
        } catch (error) {
          console.error('[RealtimeAPIClient] Failed to parse server event', { error });
        }
      });

      this.ws.on('error', (error) => {
        console.error('[RealtimeAPIClient] WebSocket error', { error });
        this.connected = false;
        reject(error);
      });

      this.ws.on('close', (code, reason) => {
        this.connected = false;
      });
    });
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

      case 'session.updated':
        console.log(`[RealtimeAPIClient] session.updated: voice=${(event as any).session?.audio?.output?.voice || 'unknown'}`);
        break;

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

      case 'input_audio_buffer.speech_started':
        console.log('[RealtimeAPIClient] speech_started (VAD detected voice)');
        this.updateActivity();
        this.cancelCurrentResponse();
        if (this.onInterruptionCallback) {
          this.onInterruptionCallback();
        }
        break;

      case 'input_audio_buffer.speech_stopped':
        console.log('[RealtimeAPIClient] speech_stopped (VAD detected silence)');
        this.updateActivity();
        if (this.onSpeechStoppedCallback) {
          this.onSpeechStoppedCallback();
        }
        break;

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

      case 'error':
        const errorEvent = event as any;
        console.error('[RealtimeAPIClient] Server error:', JSON.stringify(errorEvent.error, null, 2));
        console.error('[RealtimeAPIClient] Full error event:', JSON.stringify(errorEvent, null, 2));
        break;

      default:
        break;
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

IMPORTANT: Your knowledge of this codebase is limited to the session context above. You do NOT have current knowledge of this project's code, files, implementation details, or recent changes. Do not assume you know how features work. When in doubt, ask the coding agent.

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
- Be terse. One short sentence per response. No filler phrases.
- When the user says "shut up", "stop talking", "be quiet", "stop listening", "shh", or anything similar: IMMEDIATELY call pause_listening. Say ABSOLUTELY NOTHING before or after calling the tool -- not "ok", not "pausing", not any acknowledgment at all. Do not describe what will happen with the mic. Just call the tool silently.
- For coding tasks: use submit_agent_prompt, say what you did in ~5 words (e.g. "Submitted."), then STOP. Do NOT say anything about waiting, timing out, or checking back. The microphone will go dormant automatically. You will be woken up with an "[INTERNAL: Task complete...]" message when the coding agent finishes. There is NO timeout -- tasks can take minutes. You do NOT need to monitor, wait, or follow up.
- For questions about this project: use ask_coding_agent. The answer will come back as the tool result. Summarize it conversationally for the user.
- Only answer directly for truly general knowledge questions unrelated to this project.
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

    // Apply custom prepend/append if configured
    let instructions = baseInstructions;
    if (this.customPrompt.prepend) {
      instructions = this.customPrompt.prepend + '\n\n' + instructions;
    }
    if (this.customPrompt.append) {
      instructions = instructions + '\n\n' + this.customPrompt.append;
    }

    // Build turn detection config based on settings
    // 'push_to_talk' mode uses type: 'none' which disables automatic turn detection
    const turnDetectionConfig = this.turnDetection.mode === 'push_to_talk'
      ? undefined // No automatic turn detection - user must manually commit audio
      : {
          type: 'server_vad' as const,
          threshold: this.turnDetection.vadThreshold ?? 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: this.turnDetection.silenceDuration ?? 500,
        };

    // GA Realtime API session shape: audio config is nested under audio.{input,output}
    // with format as an object ({type,rate}), not the flat beta fields. PCM16 @ 24kHz
    // matches what the renderer audio pipeline produces/consumes.
    const config: SessionConfig = {
      type: 'realtime',
      output_modalities: ['audio'],
      instructions,
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24000 },
          transcription: { model: 'whisper-1' },
          ...(turnDetectionConfig ? { turn_detection: turnDetectionConfig } : {}),
        },
        output: {
          voice: this.voice,
          format: { type: 'audio/pcm', rate: 24000 },
        },
      },
      tools: [
        {
          type: 'function',
          name: 'submit_agent_prompt',
          description: 'Queue a coding task for yourself to process. Use this when the user asks you to write code, fix bugs, refactor, or perform any coding task. The work will be queued and you will be notified when it completes.',
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
          description: 'List recent AI sessions in this workspace. Returns session IDs, titles, and running status. Use this when the user asks about their sessions, wants to find a session by name, or before navigating to one.',
          parameters: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Optional search string to filter sessions by title.',
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
      ],
    };

    const event = {
      type: 'session.update',
      session: config,
    };

    console.log(`[RealtimeAPIClient] session.update: voice=${config.audio.output.voice}`);
    this.ws.send(JSON.stringify(event));
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
    switch (name) {
      case 'submit_agent_prompt': {
        try {
          const args = JSON.parse(argsJson);
          const prompt = args.prompt;

          // Track prompt submission (no content for privacy)
          AnalyticsService.getInstance().sendEvent('voice_prompt_submitted');

          if (this.onSubmitPromptCallback) {
            await this.onSubmitPromptCallback(prompt);
          } else {
            throw new Error('No submit prompt callback registered');
          }

          this.sendFunctionCallResult(callId, {
            success: true,
            message: 'Task queued successfully. You will be notified when it completes.',
          });
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

    // Trigger assistant response
    this.createResponse();
  }

  /**
   * Request the assistant to generate a response.
   * Explicitly includes voice to prevent voice drift after tool calls.
   */
  private createResponse(): void {
    if (!this.ws || !this.connected) {
      console.error('[RealtimeAPIClient] Cannot create response - not connected');
      return;
    }

    // GA response shape: output_modalities + nested audio.output.voice (was modalities + voice).
    const event = {
      type: 'response.create',
      response: {
        output_modalities: ['audio'],
        audio: {
          output: { voice: this.voice },
        },
      },
    };

    console.log(`[RealtimeAPIClient] response.create: voice=${this.voice}`);
    this.ws.send(JSON.stringify(event));
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
