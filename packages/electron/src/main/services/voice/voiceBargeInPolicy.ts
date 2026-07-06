/**
 * Barge-in decision + echo metrics seam for desktop voice mode (echo
 * cancellation round 2; mirrors the iOS BargeInPolicy.swift for NIM-1314).
 *
 * Server VAD `speech_started` cannot distinguish the user talking over the
 * agent from residual echo of the agent's own speech leaking past AEC (open
 * speakers, high volume). This module owns that decision and classifies every
 * VAD trigger as echo-suspect (fired while agent audio was audibly playing in
 * the renderer) vs genuine (fired while silent), so the self-interruption
 * rate is measurable before/after each tuning lever.
 *
 * Pure (no electron imports) so it is unit-testable.
 */

/**
 * How long echo-suspect speech must persist before it interrupts playback
 * (min-duration heuristic). Live 2026-07-02 metrics: every self-interruption
 * fired while agent audio was playing, so suspects get a probation window
 * instead of instant trust. Mirrors BargeInPolicy.echoSuspectInterruptDeferMs.
 */
export const ECHO_SUSPECT_INTERRUPT_DEFER_MS = 500;

export interface BargeInDecision {
  /** Whether the caller should cancel the response and stop playback. */
  shouldInterrupt: boolean;
  /** True when agent audio was audibly playing at the VAD trigger. */
  echoSuspect: boolean;
  /** Milliseconds since the current agent playback started, when playing. */
  msSincePlaybackStarted: number | null;
  /**
   * When set, the caller must schedule onDeferredInterruptTimeout() this many
   * ms out instead of interrupting now.
   */
  deferInterruptMs: number | null;
}

export interface BargeInSessionMetrics {
  speechStartedCount: number;
  echoSuspectCount: number;
  genuineCount: number;
  interruptCount: number;
  /**
   * Echo-suspect triggers whose speech ended inside the defer window
   * (classified as echo; playback was never interrupted).
   */
  suppressedEchoCount: number;
  lastSpeechDurationMs: number | null;
}

const emptyMetrics = (): BargeInSessionMetrics => ({
  speechStartedCount: 0,
  echoSuspectCount: 0,
  genuineCount: 0,
  interruptCount: 0,
  suppressedEchoCount: 0,
  lastSpeechDurationMs: null,
});

export class VoiceBargeInPolicy {
  private metricsState = emptyMetrics();
  private playbackStartedAt: number | null = null;
  private speechStartedAt: number | null = null;

  /** `now` (epoch ms) is injectable so tests can drive time deterministically. */
  constructor(private readonly now: () => number = Date.now) {}

  get metrics(): BargeInSessionMetrics {
    return { ...this.metricsState };
  }

  /**
   * Call when audible playback of an agent turn starts. Idempotent across the
   * chunks of one turn; `notePlaybackStopped()` re-arms it.
   */
  notePlaybackStarted(): void {
    if (this.playbackStartedAt === null) this.playbackStartedAt = this.now();
  }

  /** Call when playback fully drains or is stopped (barge-in, manual stop). */
  notePlaybackStopped(): void {
    this.playbackStartedAt = null;
  }

  /**
   * Milliseconds since the current agent playback started, or null when not
   * playing. Used to compute `audio_end_ms` for conversation.item.truncate.
   */
  msSincePlaybackStarted(): number | null {
    return this.playbackStartedAt === null ? null : this.now() - this.playbackStartedAt;
  }

  /**
   * Server VAD `speech_started`. `playbackActive` is the renderer's audible
   * playback signal. Genuine triggers (nothing playing) interrupt now;
   * echo-suspect ones defer (min-duration heuristic) -- the caller schedules
   * onDeferredInterruptTimeout() `deferInterruptMs` out. Residual-echo blips
   * end inside the window (suppressed, playback never hiccups); a real
   * barge-in keeps speaking through it and interrupts slightly late.
   */
  onSpeechStarted(playbackActive: boolean): BargeInDecision {
    this.speechStartedAt = this.now();
    const msSincePlaybackStarted = playbackActive ? this.msSincePlaybackStarted() : null;

    this.metricsState.speechStartedCount += 1;
    if (playbackActive) {
      this.metricsState.echoSuspectCount += 1;
      return {
        shouldInterrupt: false,
        echoSuspect: true,
        msSincePlaybackStarted,
        deferInterruptMs: ECHO_SUSPECT_INTERRUPT_DEFER_MS,
      };
    }

    this.metricsState.genuineCount += 1;
    this.metricsState.interruptCount += 1;
    return {
      shouldInterrupt: true,
      echoSuspect: false,
      msSincePlaybackStarted: null,
      deferInterruptMs: null,
    };
  }

  /**
   * Called by the caller's timer `deferInterruptMs` after an echo-suspect
   * trigger. Interrupts only if the speech is still ongoing (no speech_stopped
   * cleared it -- a real barge-in, not an echo blip) AND agent audio is still
   * playing (there is something left to interrupt). `msSincePlaybackStarted`
   * is measured now, so truncation reflects what the user actually heard
   * including the probation window.
   */
  onDeferredInterruptTimeout(playbackActive: boolean): BargeInDecision {
    const speechOngoing = this.speechStartedAt !== null;
    if (!speechOngoing) {
      this.metricsState.suppressedEchoCount += 1;
    }
    const interrupt = speechOngoing && playbackActive;
    if (interrupt) this.metricsState.interruptCount += 1;
    return {
      shouldInterrupt: interrupt,
      echoSuspect: true,
      msSincePlaybackStarted: playbackActive ? this.msSincePlaybackStarted() : null,
      deferInterruptMs: null,
    };
  }

  /**
   * Server VAD `speech_stopped`. Returns the speech duration in ms (the
   * signal a later min-duration heuristic would gate on).
   */
  onSpeechStopped(): number | null {
    if (this.speechStartedAt === null) return null;
    const ms = this.now() - this.speechStartedAt;
    this.speechStartedAt = null;
    this.metricsState.lastSpeechDurationMs = ms;
    return ms;
  }

  /** Clear all state at session end (after logging the summary). */
  resetSession(): void {
    this.metricsState = emptyMetrics();
    this.playbackStartedAt = null;
    this.speechStartedAt = null;
  }
}

/** OpenAI Realtime input noise-reduction profiles. 'off' omits the config. */
export type NoiseReductionType = 'near_field' | 'far_field' | 'off';

/**
 * Which turn-detection engine to use. `semantic_vad` has the model judge
 * whether the user is actually trying to speak instead of raw amplitude --
 * far more robust against residual echo of the agent's own voice (live
 * desktop metrics 2026-07-02 showed amplitude server_vad tripping on echo at
 * 0.5 threshold even with AEC routing). Default. `server_vad` is the
 * amplitude fallback for A/B comparison.
 */
export type VadDetectionType = 'semantic_vad' | 'server_vad';

/**
 * Raised from 0.5: live [barge-in] metrics showed residual echo tripping
 * amplitude VAD at the old default (matches the iOS NIM-1314 finding).
 */
export const DEFAULT_VAD_THRESHOLD = 0.85;

export interface ServerVadTurnDetection {
  type: 'server_vad';
  threshold: number;
  prefix_padding_ms: number;
  silence_duration_ms: number;
  create_response: boolean;
  interrupt_response: boolean;
}

export interface SemanticVadTurnDetection {
  type: 'semantic_vad';
  eagerness: 'low' | 'medium' | 'high' | 'auto';
  create_response: boolean;
  interrupt_response: boolean;
}

export type TurnDetectionConfigUnion = ServerVadTurnDetection | SemanticVadTurnDetection;

/**
 * Build the GA server_vad turn_detection config. `allowServerResponses` maps
 * to `create_response` / `interrupt_response`: set false while the agent is
 * audibly speaking so echo-triggered VAD cannot make the server cancel the
 * response or answer its own voice (the client keeps barge-in control).
 */
export function buildServerVadTurnDetection(options: {
  vadThreshold?: number;
  silenceDurationMs?: number;
  allowServerResponses: boolean;
}): ServerVadTurnDetection {
  return {
    type: 'server_vad',
    threshold: options.vadThreshold ?? DEFAULT_VAD_THRESHOLD,
    prefix_padding_ms: 300,
    silence_duration_ms: options.silenceDurationMs ?? 500,
    create_response: options.allowServerResponses,
    interrupt_response: options.allowServerResponses,
  };
}

/**
 * Build the GA semantic_vad turn_detection config (model-judged turn-taking;
 * no amplitude threshold or silence duration).
 */
export function buildSemanticVadTurnDetection(options: {
  eagerness?: SemanticVadTurnDetection['eagerness'];
  allowServerResponses: boolean;
}): SemanticVadTurnDetection {
  return {
    type: 'semantic_vad',
    eagerness: options.eagerness ?? 'auto',
    create_response: options.allowServerResponses,
    interrupt_response: options.allowServerResponses,
  };
}

/**
 * Build the configured turn-detection engine. semantic_vad by default; the
 * threshold/silence options only apply to the server_vad fallback.
 */
export function buildTurnDetection(options: {
  detection?: VadDetectionType;
  vadThreshold?: number;
  silenceDurationMs?: number;
  allowServerResponses: boolean;
}): TurnDetectionConfigUnion {
  if ((options.detection ?? 'semantic_vad') === 'semantic_vad') {
    return buildSemanticVadTurnDetection({ allowServerResponses: options.allowServerResponses });
  }
  return buildServerVadTurnDetection(options);
}
