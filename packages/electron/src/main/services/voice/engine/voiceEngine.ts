/**
 * Voice engine capability boundary.
 *
 * Nimbalyst's voice mode is a speech transport plus a tool layer. The transport
 * is swappable (OpenAI Realtime today, GPT-Live next); the tool layer is not.
 * This file defines the contract every transport implements so the rest of the
 * app -- VoiceModeService, the renderer listeners, the transcript projection --
 * never names a protocol.
 *
 * Deliberately absent from this interface: `response.create`, input-audio
 * commit, VAD event names, conversation items, function-call ids. Those are
 * Realtime spellings of ideas that GPT-Live either expresses differently or
 * does not have at all. An engine that needs one keeps it private.
 */

import type { RealtimeFunctionTool } from '../voiceToolBridge';
import type { VoiceToolCallEvent, VoiceToolHandlers } from './voiceToolRegistry';

/** Why a voice session ended. Same three reasons on every engine. */
export type VoiceEngineDisconnectReason = 'timeout' | 'error' | 'user_stopped';

/**
 * Token counters for a token-billed engine. Realtime accumulates these from
 * each response's usage report; there is no session-final total.
 */
export interface VoiceEngineTokenUsage {
  inputAudio: number;
  outputAudio: number;
  text: number;
  total: number;
}

/**
 * Usage reported by the delegated backend/controller for one response. Kept as
 * its own list, never folded into voice duration: the controller's cost is a
 * separate line item and mixing them produces a number that means nothing.
 *
 * `usage` stays opaque on purpose -- it is the backend model's own usage block,
 * and this interface should not pretend to know that model's billing shape.
 */
export interface VoiceEngineBackendUsage {
  responseId: string;
  /** null when the response was not part of a delegation -- a real observation, not an unreported field. */
  delegationId: string | null;
  usage: Readonly<Record<string, unknown>>;
}

/**
 * Session usage, engine-normalized.
 *
 * Every field is optional and `undefined` means "this engine does not report
 * this", which is NOT the same as zero. Zero is a real measurement -- a UI that
 * cannot tell the two apart is exactly why the existing token counter is not a
 * usable cost or occupancy signal. Render absence as absence.
 *
 * No field here is speculative: each is populated by at least one engine today.
 */
export interface VoiceEngineUsage extends Partial<VoiceEngineTokenUsage> {
  // --- Realtime (token-billed) ---
  // inputAudio / outputAudio / text / total, inherited above. Realtime always
  // populates all four; Live leaves them undefined -- it is billed by the
  // second and has no token counters to report.

  // --- Live (duration-billed) ---

  /**
   * Cumulative seconds of paid session time. Live only.
   *
   * Cumulative, never a sum of snapshots: the engine reports a running total
   * and adding successive reports together double-counts. Realtime leaves this
   * undefined -- it does not bill by duration.
   */
  durationSeconds?: number;

  /**
   * How full the model's context is, 0..1. Live reports this directly.
   *
   * Realtime leaves it undefined rather than deriving one. The value it could
   * derive -- accumulated tokens over a hardcoded window -- is the untrustworthy
   * number this field exists to replace, so publishing it here would relabel
   * the problem instead of fixing it.
   */
  contextUsageRatio?: number;

  /** Per-response backend/controller usage. Live only; see VoiceEngineBackendUsage. */
  backend?: readonly VoiceEngineBackendUsage[];

  /**
   * True once the engine delivered its authoritative end-of-session usage.
   * Live only -- Realtime has no session-final usage event, so it leaves both
   * this and `finalizationMissing` undefined.
   */
  finalized?: boolean;

  /**
   * True when the transport ended before final usage arrived, so the figures
   * above are a floor rather than the bill. Live only.
   *
   * Present so a dead transport under-reports visibly. Silent under-reporting
   * is worse than a missing number, because it looks like a cheap session.
   */
  finalizationMissing?: boolean;
}

export interface VoiceEngineError {
  type: string;
  message: string;
}

/**
 * Everything an engine can tell the application. Named for what the user
 * experiences, not for the wire event that produced it: `userSpeechStarted`
 * is "the user began talking", whether that arrived as a Realtime VAD event
 * or a Live transcript fragment.
 */
export interface VoiceEngineEventMap {
  /** The host is asking for an announcement, not issuing a user command. */
  hostAnnouncement: () => void;
  /** Base64 PCM16 @ 24kHz for the renderer's playback queue. */
  audio: (audioBase64: string) => void;
  /** Incremental assistant speech, as text, for the on-screen transcript. */
  assistantText: (text: string) => void;
  /** Final transcription of one user utterance. */
  userTranscript: (transcript: string) => void;
  /** Streaming partial transcription, keyed by the utterance's stable id. */
  userTranscriptDelta: (delta: string, itemId: string) => void;
  usage: (usage: VoiceEngineUsage) => void;
  /**
   * The user began speaking. Fired for every detection, independent of whether
   * the engine decided to interrupt -- the renderer holds its listen window
   * open on this signal alone.
   */
  userSpeechStarted: () => void;
  userSpeechStopped: () => void;
  /**
   * The application's speech window for one utterance has closed: its
   * transcript has stopped growing.
   *
   * Emitted only by engines that have no end-of-turn signal at all. It is NOT a
   * VAD speech-stopped and NOT a claim that the user's turn ended for the model
   * -- nothing is told to the model on this event. It exists because the
   * listen-window and transcript-persistence machinery needs *some* honest
   * close for an utterance it was told had started, and on Live the only fact
   * available is that the fragments stopped arriving. A late fragment may still
   * extend the utterance afterwards.
   */
  userSpeechWindowClosed: (transcript: string, itemId: string) => void;
  /** The assistant's in-flight speech was abandoned; stop playback now. */
  interrupted: () => void;
  /** A tool call started or finished, for the voice session transcript. */
  toolCall: (event: VoiceToolCallEvent) => void;
  reconnecting: (attempt: number) => void;
  reconnected: () => void;
  error: (error: VoiceEngineError) => void;
  disconnected: (reason: VoiceEngineDisconnectReason) => void;
}

export type VoiceEngineEventName = keyof VoiceEngineEventMap;

/**
 * The transport contract. Modeled on what VoiceModeService actually drives
 * today; anything it does not call does not belong here.
 */
export interface VoiceEngine {
  connect(): Promise<void>;
  disconnect(reason?: VoiceEngineDisconnectReason): void;
  isConnected(): boolean;

  /** Append captured microphone audio (base64 PCM16 @ 24kHz). */
  appendAudio(audioBase64: string): void;
  /**
   * Signal that the user has finished their turn. Push-to-talk uses this;
   * continuously-streaming engines may treat it as a no-op.
   */
  endUserTurn(): void;

  /** Relay a host notification aloud; this does not authorize new coding work. */
  sendHostAnnouncement(text: string): boolean;
  /** Add context the assistant should know but must not respond to. */
  injectContext(text: string): boolean;

  /**
   * Report whether the assistant's audio is currently audible in the renderer.
   * Engines use this for echo suppression and interruption decisions.
   */
  setPlaybackActive(active: boolean): void;
  /**
   * Sleep/wake the listening side. While paused the engine must not drop the
   * session for inactivity; an engine that bills for connection time may close
   * its transport and restore it on the next activity.
   */
  setListeningPaused(paused: boolean): void;

  getUsage(): VoiceEngineUsage;

  /** Subscribe to an engine event. Returns an unsubscribe function. */
  on<K extends VoiceEngineEventName>(event: K, listener: VoiceEngineEventMap[K]): () => void;
}

// --- Registration ---------------------------------------------------------

/**
 * An engine the application can hand its behavior to in one call.
 *
 * The two engines used to be wired differently -- Realtime through ~15
 * `setOnX()` setters, Live through a `toolHandlers` bag -- which meant every
 * new tool or event had to be added in two shapes, and the service had to know
 * which engine it was holding. Both of those are protocol-independent
 * concerns, so they belong here: an engine exposes one event slot setter, one
 * handler bag, and one extension-tool hook, and `registerVoiceEngine()` below
 * is the single place the application fills them in.
 */
export interface VoiceEngineRegistrar extends VoiceEngine {
  /**
   * Replace the single listener for an event. Single-slot (not additive)
   * because the application has exactly one implementation of each -- the
   * legacy `setOnAudio(cb)` semantics, without a setter per event.
   */
  setSingle<K extends VoiceEngineEventName>(event: K, listener: VoiceEngineEventMap[K]): void;
  /** The shared tool implementations. Assign before connect(). */
  readonly toolHandlers: VoiceToolHandlers;
  /** Extension-contributed voice tools. Must be set before connect(). */
  setExtensionVoiceTools(schemas: RealtimeFunctionTool[], nameMap: Map<string, string>): void;
}

/** Everything the application supplies to an engine, in one object. */
export interface VoiceEngineRegistration {
  events: Partial<VoiceEngineEventMap>;
  handlers: VoiceToolHandlers;
  extensionTools?: { schemas: RealtimeFunctionTool[]; nameMap: Map<string, string> };
}

/**
 * Install the application's events, tool handlers, and extension tools on an
 * engine. The one registration call site for every engine.
 *
 * Keys whose value is `undefined` are skipped rather than assigned: an
 * explicitly-absent handler must leave the engine's "callback not registered"
 * error intact instead of overwriting a previously registered one with
 * `undefined`.
 */
export function registerVoiceEngine(
  engine: VoiceEngineRegistrar,
  registration: VoiceEngineRegistration,
): void {
  for (const [event, listener] of Object.entries(registration.events)) {
    if (!listener) continue;
    engine.setSingle(
      event as VoiceEngineEventName,
      listener as VoiceEngineEventMap[VoiceEngineEventName],
    );
  }
  for (const [name, handler] of Object.entries(registration.handlers)) {
    if (handler === undefined) continue;
    (engine.toolHandlers as Record<string, unknown>)[name] = handler;
  }
  // A model can misread quoted history even with correct prompting. Require
  // fresh speech before it may submit work, and consume that evidence before
  // awaiting the queue so concurrent/repeated calls cannot submit twice.
  // This is a necessary condition, not proof of intent: the model still has to
  // interpret the utterance. Expire unused speech so an old conversation cannot
  // authorize a later autonomous submission after idle time.
  let speechValidUntil = 0;
  const revoke = (): void => { speechValidUntil = 0; };
  engine.on('userSpeechStarted', () => { speechValidUntil = Date.now() + 60_000; });
  const extendSpeech = (): void => {
    if (speechValidUntil) speechValidUntil = Date.now() + 60_000;
  };
  engine.on('userSpeechStopped', extendSpeech);
  engine.on('userTranscriptDelta', extendSpeech);
  engine.on('userSpeechWindowClosed', extendSpeech);
  engine.on('hostAnnouncement', revoke);
  engine.on('reconnecting', revoke);
  engine.on('disconnected', revoke);
  const takeSpeech = (): boolean => {
    const allowed = Date.now() < speechValidUntil;
    revoke();
    return allowed;
  };
  const noRequest = 'No new voice request authorizes this submission. The prompt in session history is already submitted. Wait for the user to speak.';
  const submit = registration.handlers.onSubmitPrompt;
  if (submit) {
    engine.toolHandlers.onSubmitPrompt = async (prompt) => {
      if (!takeSpeech()) return { success: false, error: noRequest };
      return submit(prompt);
    };
  }
  const ask = registration.handlers.onAskCodingAgent;
  if (ask) {
    engine.toolHandlers.onAskCodingAgent = async (question) => {
      if (!takeSpeech()) return { success: false, error: noRequest };
      return ask(question);
    };
  }
  const pause = registration.handlers.onPauseListening;
  if (pause) engine.toolHandlers.onPauseListening = () => { revoke(); pause(); };
  if (registration.extensionTools) {
    engine.setExtensionVoiceTools(
      registration.extensionTools.schemas,
      registration.extensionTools.nameMap,
    );
  }
}

// --- Optional engine capabilities -----------------------------------------
// Probed, never assumed. Each is an application-level capability that only
// some engines have; the caller must have a correct path for its absence.

/**
 * An engine that can hold a tool call open until the real outcome exists
 * (Realtime's async function calling). An engine billed by connection time
 * cannot: its transport may be closed long before the work finishes.
 */
export interface VoiceDeferredCallEngine {
  /** Is there an open call waiting on work submitted to THIS agent session? */
  hasDeferredCallFor(sessionId: string): boolean;
  /**
   * Resolve the open call for that agent session with its real outcome.
   *
   * Session-scoped, not FIFO: a voice conversation can have work outstanding in
   * several agent sessions at once, and a completion from one of them must not
   * be handed back as another one's tool return. False when this session has no
   * open call.
   */
  resolveDeferredCallFor(
    sessionId: string,
    result: { success: boolean; summary?: string; error?: string },
  ): boolean;
}

export function asDeferredCallEngine(engine: VoiceEngine): VoiceDeferredCallEngine | null {
  const candidate = engine as Partial<VoiceDeferredCallEngine>;
  return typeof candidate.hasDeferredCallFor === 'function' &&
    typeof candidate.resolveDeferredCallFor === 'function'
    ? (candidate as VoiceDeferredCallEngine)
    : null;
}

/** A coding task this voice conversation started, identified across closures. */
export interface VoiceDurableTask {
  taskId: string;
  /** The agent session the task was submitted to, when it was correlated. */
  sessionId: string | null;
  /** The application's id for the submission that created it, when reported. */
  submissionId: string | null;
  /** The revision of the agent run it became, or null until that run starts. */
  revision: number | null;
}

/**
 * An engine that tracks accepted-but-unfinished work by a durable task id, so
 * a completion arriving after the paid session closed can still be matched to
 * the request that produced it.
 */
export interface VoiceDurableTaskEngine {
  /**
   * The task a completion from this agent session belongs to, or null when that
   * cannot be established. Null means "do not guess": answering the wrong task
   * reports one request's outcome as another's.
   */
  findOpenTaskFor(sessionId: string): VoiceDurableTask | null;
  /** Everything still outstanding for an agent session. */
  getOpenTasksFor(sessionId: string): VoiceDurableTask[];
  /** Record that a task completed. False when unknown, duplicate, or superseded. */
  announceTaskCompletion(taskId: string, summary: string): boolean;
  /**
   * An agent run started for a session. `submissionId` is the application's id
   * for the submission it came from, and is what identifies the task: a run
   * with no submission id, or one this conversation never submitted, binds
   * nothing rather than being matched to a task by recency.
   */
  noteTaskRevision(sessionId: string, revision: number, submissionId?: string | null): void;
}

export function asDurableTaskEngine(engine: VoiceEngine): VoiceDurableTaskEngine | null {
  const candidate = engine as Partial<VoiceDurableTaskEngine>;
  return typeof candidate.findOpenTaskFor === 'function' &&
    typeof candidate.getOpenTasksFor === 'function' &&
    typeof candidate.announceTaskCompletion === 'function' &&
    typeof candidate.noteTaskRevision === 'function'
    ? (candidate as VoiceDurableTaskEngine)
    : null;
}
