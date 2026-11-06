import type {
  DictationAvailability,
  DictationEngineId,
  DictationEvent,
  DictationSettings,
  DictationStartRequest,
  DictationStartResult,
  DictationStopRequest,
} from '../../../shared/dictation';
import {
  selectDictationEngine,
  type DictationEngine,
  type DictationEngineEvent,
  type DictationEngineSession,
} from './DictationEngine';
import { capContextStrings } from './helperProtocol';

/** The webContents that started a dictation; events go only to it. */
export interface DictationTarget {
  readonly id: number;
  isDestroyed(): boolean;
  sendEvent(event: DictationEvent): void;
}

export interface DictationControllerDeps {
  getSettings(): DictationSettings;
  engines: Record<DictationEngineId, DictationEngine>;
  isVoiceModeActive(): boolean;
  /** Ask the OS for microphone access (macOS prompt). Resolves false when denied. */
  ensureMicrophoneAccess(): Promise<boolean>;
  log(message: string): void;
}

function toDictationEvent(
  dictationId: string,
  engine: DictationEngineId,
  event: DictationEngineEvent,
): DictationEvent {
  switch (event.type) {
    case 'ready':
    case 'preparing':
      return { dictationId, type: event.type, engine };
    case 'partial':
    case 'final':
      return { dictationId, type: event.type, text: event.text };
    case 'error':
      return { dictationId, type: 'error', message: event.message };
  }
}

interface ActiveDictation {
  dictationId: string;
  target: DictationTarget;
  engine: DictationEngineId;
  session: DictationEngineSession | null;
  /** Stop requested while the engine was still starting. */
  pendingStop: { cancel: boolean } | null;
  ended: boolean;
  timing: DictationTiming;
}

/**
 * Latency probe, logged once per dictation as `[Dictation] timing`. All values
 * are ms since the start request reached main, so slow startup, a late first
 * partial, and a slow final after stop can be told apart.
 */
interface DictationTiming {
  requestedAt: number;
  micGrantedMs?: number;
  engineStartedMs?: number;
  firstAudioMs?: number;
  audioChunks: number;
  firstPartialMs?: number;
  partials: number;
  /** ms from the latest audio chunk to each final: recognizer lag on speech it already has. */
  finalLagsMs: number[];
  lastAudioAt?: number;
  stopRequestedMs?: number;
  /** ms from the stop request to the last final: the wait after releasing the key. */
  stopToLastFinalMs?: number;
  endedMs?: number;
}

/**
 * Engine-agnostic dictation state machine: one dictation at a time across the
 * app, never alongside Voice Mode, and nothing at all when disabled.
 */
export class DictationController {
  private active: ActiveDictation | null = null;

  constructor(private readonly deps: DictationControllerDeps) {}

  getAvailability(): DictationAvailability {
    return {
      onDevice: this.deps.engines['on-device'].isAvailable(),
      openai: this.deps.engines.openai.isAvailable(),
    };
  }

  isActive(): boolean {
    return this.active !== null;
  }

  async start(target: DictationTarget, request: DictationStartRequest): Promise<DictationStartResult> {
    if (!request || typeof request.dictationId !== 'string' || !request.dictationId) {
      throw new Error('dictation:start requires a dictationId');
    }
    const settings = this.deps.getSettings();
    if (!settings.enabled) return { ok: false, reason: 'disabled' };
    if (this.active || this.deps.isVoiceModeActive()) return { ok: false, reason: 'busy' };

    const engineId = selectDictationEngine(settings.engine, this.getAvailability());
    if (!engineId) return { ok: false, reason: 'no-engine' };

    const active: ActiveDictation = {
      dictationId: request.dictationId,
      target,
      engine: engineId,
      session: null,
      pendingStop: null,
      ended: false,
      timing: { requestedAt: Date.now(), audioChunks: 0, partials: 0, finalLagsMs: [] },
    };
    // Claim the slot before any await so a second start can't race in.
    this.active = active;

    let micGranted = false;
    try {
      micGranted = await this.deps.ensureMicrophoneAccess();
    } catch (error) {
      this.deps.log(`[Dictation] microphone check failed: ${String(error)}`);
    }
    active.timing.micGrantedMs = Date.now() - active.timing.requestedAt;
    if (!micGranted) {
      this.release(active);
      return { ok: false, reason: 'mic-denied' };
    }
    if (active.pendingStop) {
      this.release(active);
      return { ok: false, reason: 'engine-error', message: 'Dictation was stopped before it started.' };
    }

    const result = await this.deps.engines[engineId].start(
      {
        dictationId: request.dictationId,
        contextStrings: capContextStrings(request.contextStrings),
        language: settings.language,
      },
      {
        onEvent: (event) => {
          if (this.active !== active || active.ended) return;
          this.recordEventTiming(active, event.type);
          this.send(active, toDictationEvent(active.dictationId, engineId, event));
        },
        onEnded: () => this.finish(active),
      },
    );

    if (!result.ok) {
      this.release(active);
      this.deps.log(`[Dictation] start failed engine=${engineId} reason=${result.reason} ${result.message ?? ''}`);
      return result;
    }
    if (active.ended) {
      // Target went away or dictation was disabled while starting.
      result.session.stop(true);
      return { ok: false, reason: 'engine-error', message: 'Dictation was cancelled while starting.' };
    }
    active.session = result.session;
    active.timing.engineStartedMs = Date.now() - active.timing.requestedAt;
    // Read through a widened type: TS narrowed pendingStop to null before the await.
    const pendingStop = active.pendingStop as ActiveDictation['pendingStop'];
    if (pendingStop) result.session.stop(pendingStop.cancel);
    this.deps.log(`[Dictation] started engine=${engineId}`);
    return { ok: true, engine: engineId };
  }

  audio(target: DictationTarget, dictationId: string, base64Pcm16: string): void {
    const active = this.active;
    if (!active || active.target.id !== target.id || active.dictationId !== dictationId) return;
    if (typeof base64Pcm16 !== 'string' || !base64Pcm16) return;
    const now = Date.now();
    if (active.timing.firstAudioMs === undefined) active.timing.firstAudioMs = now - active.timing.requestedAt;
    active.timing.audioChunks++;
    active.timing.lastAudioAt = now;
    active.session?.pushAudio(base64Pcm16);
  }

  stop(target: DictationTarget, request: DictationStopRequest): void {
    if (!request || typeof request.dictationId !== 'string') {
      throw new Error('dictation:stop requires a dictationId');
    }
    const active = this.active;
    if (!active || active.target.id !== target.id || active.dictationId !== request.dictationId) return;
    const cancel = request.cancel === true;
    if (active.timing.stopRequestedMs === undefined) {
      active.timing.stopRequestedMs = Date.now() - active.timing.requestedAt;
    }
    if (active.session) {
      active.session.stop(cancel);
    } else {
      active.pendingStop = { cancel };
    }
  }

  /** Cancel whatever is running (window closed, dictation disabled, quit). */
  cancelActive(onlyForTargetId?: number): void {
    const active = this.active;
    if (!active) return;
    if (onlyForTargetId !== undefined && active.target.id !== onlyForTargetId) return;
    if (active.session) {
      active.session.stop(true);
    } else {
      active.pendingStop = { cancel: true };
    }
    this.finish(active);
  }

  dispose(): void {
    this.cancelActive();
    this.deps.engines['on-device'].dispose();
    this.deps.engines.openai.dispose();
  }

  private finish(active: ActiveDictation): void {
    if (active.ended) return;
    active.ended = true;
    if (this.active === active) this.active = null;
    active.timing.endedMs = Date.now() - active.timing.requestedAt;
    this.logTiming(active);
    this.send(active, { dictationId: active.dictationId, type: 'ended' });
  }

  /** End a dictation that never started; the renderer gets the failed result instead of 'ended'. */
  private release(active: ActiveDictation): void {
    active.ended = true;
    if (this.active === active) this.active = null;
  }

  private recordEventTiming(active: ActiveDictation, type: string): void {
    const t = active.timing;
    const now = Date.now();
    if (type === 'partial') {
      t.partials++;
      if (t.firstPartialMs === undefined) t.firstPartialMs = now - t.requestedAt;
    } else if (type === 'final') {
      if (t.lastAudioAt !== undefined) t.finalLagsMs.push(now - t.lastAudioAt);
      if (t.stopRequestedMs !== undefined) t.stopToLastFinalMs = now - t.requestedAt - t.stopRequestedMs;
    }
  }

  private logTiming(active: ActiveDictation): void {
    const { requestedAt: _requestedAt, lastAudioAt: _lastAudioAt, ...t } = active.timing;
    this.deps.log(`[Dictation] timing engine=${active.engine} ${JSON.stringify(t)}`);
  }

  private send(active: ActiveDictation, event: DictationEvent): void {
    if (active.target.isDestroyed()) return;
    active.target.sendEvent(event);
  }
}
