import type {
  DictationAvailability,
  DictationEngineId,
  DictationEngineSetting,
  DictationStartFailure,
} from '../../../shared/dictation';

/** Engine-side events; the service stamps the dictationId and owns 'ended'. */
export type DictationEngineEvent =
  | { type: 'ready' }
  | { type: 'preparing' }
  | { type: 'partial'; text: string }
  | { type: 'final'; text: string }
  | { type: 'error'; message: string };

export interface DictationEngineCallbacks {
  onEvent(event: DictationEngineEvent): void;
  /** Called exactly once when the dictation is over (stopped, cancelled, or crashed). */
  onEnded(): void;
}

export interface DictationEngineStartOptions {
  dictationId: string;
  contextStrings: string[];
  language?: string;
}

export interface DictationEngineSession {
  /** base64 mono PCM16 LE at DICTATION_SAMPLE_RATE. */
  pushAudio(base64Pcm16: string): void;
  /** cancel=true discards pending text; false flushes a final for buffered audio. */
  stop(cancel: boolean): void;
}

export type DictationEngineStartResult =
  | { ok: true; session: DictationEngineSession }
  | { ok: false; reason: DictationStartFailure; message?: string };

export interface DictationEngine {
  readonly id: DictationEngineId;
  isAvailable(): boolean;
  start(options: DictationEngineStartOptions, callbacks: DictationEngineCallbacks): Promise<DictationEngineStartResult>;
  /** Release background resources (helper process, sockets). */
  dispose(): void;
}

/**
 * 'auto' prefers on-device, then OpenAI. An explicit choice never falls back:
 * a user who picked on-device for privacy must not have audio sent to OpenAI.
 */
export function selectDictationEngine(
  setting: DictationEngineSetting,
  availability: DictationAvailability,
): DictationEngineId | null {
  switch (setting) {
    case 'on-device':
      return availability.onDevice ? 'on-device' : null;
    case 'openai':
      return availability.openai ? 'openai' : null;
    case 'system':
      // macOS dictation runs outside this service (DICTATION_IPC.systemStart).
      return null;
    default:
      if (availability.onDevice) return 'on-device';
      if (availability.openai) return 'openai';
      return null;
  }
}
