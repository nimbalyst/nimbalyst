/**
 * Dictation (speech-to-text into the agent input and editors).
 *
 * Shared contract between the main-process DictationService and the renderer.
 * Separate from Voice Mode: dictation never speaks back and never submits.
 * See nimbalyst-local/plans/agent-input-dictation.md and docs/DICTATION.md.
 */

/**
 * 'auto' = macOS system dictation on a Mac, otherwise OpenAI if a key is set.
 * 'system' = hand off to the OS dictation (macOS only); it inserts text itself
 * and never goes through DictationService's engines.
 */
export type DictationEngineSetting = 'auto' | 'system' | 'on-device' | 'openai';

/** The engine actually running a dictation. */
export type DictationEngineId = 'on-device' | 'openai';

export interface DictationSettings {
  /** When false, every dictation affordance is hidden and the shortcut is inert. */
  enabled: boolean;
  engine: DictationEngineSetting;
  /** BCP-47 locale such as 'en-US'. Undefined = system locale. */
  language?: string;
}

export const DEFAULT_DICTATION_SETTINGS: DictationSettings = {
  enabled: true,
  engine: 'auto',
};

/** Audio format the renderer sends: mono PCM16 little-endian, base64-encoded. */
export const DICTATION_SAMPLE_RATE = 24000;

export interface DictationStartRequest {
  /** Renderer-generated id; every event and audio chunk carries it. */
  dictationId: string;
  /** Words to bias recognition toward (file names, identifiers). Capped by main. */
  contextStrings?: string[];
}

export type DictationStartFailure =
  | 'disabled'
  | 'no-engine'
  | 'mic-denied'
  | 'speech-permission-denied'
  | 'busy'
  | 'engine-error';

export type DictationStartResult =
  | { ok: true; engine: DictationEngineId }
  | { ok: false; reason: DictationStartFailure; message?: string };

export interface DictationStopRequest {
  dictationId: string;
  /** true = discard any pending partial (Esc); false = flush a final for buffered audio. */
  cancel: boolean;
}

export type DictationEvent =
  /** Engine is ready for audio (on-device may first download model assets). */
  | { dictationId: string; type: 'ready'; engine: DictationEngineId }
  | { dictationId: string; type: 'preparing'; engine: DictationEngineId }
  /** Replaces the current uncommitted text. */
  | { dictationId: string; type: 'partial'; text: string }
  /** Commits a segment; the current partial is cleared. */
  | { dictationId: string; type: 'final'; text: string }
  | { dictationId: string; type: 'error'; message: string }
  /** No further events for this id. */
  | { dictationId: string; type: 'ended' };

/** What `dictation:get-availability` reports, so the UI can explain a missing engine. */
export interface DictationAvailability {
  /** macOS system dictation can be triggered. */
  system: boolean;
  onDevice: boolean;
  openai: boolean;
}

export const DICTATION_IPC = {
  getSettings: 'dictation:get-settings',
  setSettings: 'dictation:set-settings',
  getAvailability: 'dictation:get-availability',
  start: 'dictation:start',
  /** Fire-and-forget (safeOn): (dictationId: string, base64Pcm16: string) */
  audio: 'dictation:audio',
  stop: 'dictation:stop',
  /** Start macOS system dictation in the focused text field: { ok: boolean } */
  systemStart: 'dictation:system-start',
  /** main -> renderer: DictationEvent */
  event: 'dictation:event',
  /** main -> all windows: DictationSettings */
  settingsChanged: 'dictation:settings-changed',
} as const;
