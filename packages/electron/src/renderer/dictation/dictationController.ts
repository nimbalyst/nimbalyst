/**
 * Dictation controller: one per window.
 *
 * Starts and stops a dictation for a target surface, streams microphone audio
 * to main, and inserts what the engine recognizes. Engine events reach it only
 * through dictationSessionAtomFamily (written by dictationListeners.ts); it
 * never subscribes to IPC itself.
 *
 * Never submits anything. Separate from Voice Mode.
 */

import posthog from 'posthog-js';
import { store } from '@nimbalyst/runtime/store';
import {
  DICTATION_IPC,
  type DictationStartFailure,
  type DictationStartRequest,
  type DictationStartResult,
  type DictationStopRequest,
} from '../../shared/dictation';
import {
  activeDictationAtom,
  dictationOverlayAtom,
  dictationSessionAtomFamily,
  dictationSettingsAtom,
  INITIAL_DICTATION_SESSION,
  type DictationSessionState,
  type DictationSurface,
} from '../store/atoms/dictation';
import { activeFilePathAtom, rawFileTreeAtom } from '../store/atoms/fileTree';
import { AudioCapture } from '../utils/audioCapture';
import { errorNotificationService } from '../services/ErrorNotificationService';
import {
  findFocusedDictationTarget,
  getDictationTarget,
  type RegisteredDictationTarget,
} from './dictationTargets';

type JotaiStore = typeof store;

export type DictationTrigger = 'button' | 'shortcut';

export interface DictationControllerDeps {
  store: JotaiStore;
  invoke: (channel: string, ...args: unknown[]) => Promise<any>;
  send: (channel: string, ...args: unknown[]) => void;
  createCapture: () => Pick<AudioCapture, 'start' | 'stop'>;
  notify: (title: string, message: string) => void;
  capture: (event: string, properties?: Record<string, unknown>) => void;
  contextStrings: () => string[];
  newId: () => string;
  now: () => number;
  /**
   * Keep the microphone open this long after a dictation ends so the next one
   * starts hot. Bluetooth headsets take about 2s to switch into mic mode and
   * deliver digital silence meanwhile, which swallowed the first words.
   * 0 (default) closes it immediately.
   */
  micWarmMs?: number;
  /** 'auto' resolves to macOS system dictation on a Mac. */
  isMac?: boolean;
  /** Defaults to document.activeElement. */
  activeElement?: () => Element | null;
}

/** One open microphone, shared across back-to-back dictations while warm. */
interface MicHolder {
  capture: Pick<AudioCapture, 'start' | 'stop'>;
  /** Where audio goes right now; null while parked (audio is dropped). */
  sink: ((pcm16Base64: string) => void) | null;
  ready: Promise<void>;
  closed: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

/** All-zero PCM16 encodes to only 'A' (plus padding): device warm-up silence. */
const SILENT_CHUNK = /^A+=*$/;

interface DictationRecord {
  dictationId: string;
  target: RegisteredDictationTarget;
  surface: DictationSurface;
  engine: string | null;
  mic: MicHolder | null;
  /** Audio captured before the engine accepted the dictation; null once streaming. */
  pendingAudio: string[] | null;
  /** First non-silent audio arrived. */
  heard: boolean;
  /** Mic released for this record (stopped, cancelled, or failed). */
  micReleased: boolean;
  startedAt: number;
  stoppedAt: number | null;
  /** Stop was requested before start finished (released a held key early). */
  stopRequested: { cancel: boolean } | null;
  insertedSegments: number;
  lastPartial: string;
  /** Guards against re-entry from our own drain write. */
  processing: boolean;
  unsubscribe: () => void;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
}

/** After stop, wait this long for trailing finals before giving up on `ended`. */
const ENDED_GRACE_MS = 10_000;

const FAILURE_MESSAGES: Record<DictationStartFailure, string> = {
  disabled: 'Dictation is turned off in Settings.',
  'no-engine':
    'No speech engine is available. On macOS, on-device recognition needs macOS 13 or later; elsewhere add an OpenAI API key in Settings > Dictation.',
  'mic-denied':
    'Nimbalyst does not have microphone access. Allow it in System Settings > Privacy & Security > Microphone.',
  'speech-permission-denied':
    'Speech recognition permission was denied. Allow Nimbalyst in System Settings > Privacy & Security > Speech Recognition.',
  busy: 'The microphone is in use by Voice Mode or another dictation.',
  'engine-error': 'The speech engine failed to start.',
};

export class DictationController {
  private records = new Map<string, DictationRecord>();
  private activeId: string | null = null;
  private mic: MicHolder | null = null;

  constructor(private deps: DictationControllerDeps) {}

  isEnabled(): boolean {
    return this.deps.store.get(dictationSettingsAtom).enabled;
  }

  /** Auto on a Mac, or chosen explicitly: hand off to the OS dictation. */
  usesSystemDictation(): boolean {
    const engine = this.deps.store.get(dictationSettingsAtom).engine;
    return engine === 'system' || (engine === 'auto' && !!this.deps.isMac);
  }

  isRecording(targetKey?: string): boolean {
    if (!this.activeId) return false;
    if (!targetKey) return true;
    return this.records.get(this.activeId)?.target.key === targetKey;
  }

  /** Start in the focused surface (shortcut). Returns false when nothing happened. */
  startInFocused(trigger: DictationTrigger): Promise<boolean> {
    const target = findFocusedDictationTarget();
    if (target) return this.start(target, trigger);
    // macOS dictation inserts into whatever has focus, so any editable field
    // works, not only surfaces that registered a dictation target.
    if (this.isEnabled() && this.usesSystemDictation() && this.focusedIsEditable()) {
      return this.startSystem('other', trigger);
    }
    return Promise.resolve(false);
  }

  private focusedIsEditable(): boolean {
    const el = this.deps.activeElement ? this.deps.activeElement() : (typeof document !== 'undefined' ? document.activeElement : null);
    if (!el) return false;
    if ((el as HTMLElement).isContentEditable) return true;
    const tag = el.tagName;
    return tag === 'TEXTAREA' || (tag === 'INPUT' && !(el as HTMLInputElement).readOnly);
  }

  /** Mic button: start in this target, or stop if it is already recording. */
  async toggle(targetKey: string): Promise<void> {
    if (this.isRecording(targetKey)) {
      this.stop(false);
      return;
    }
    const target = getDictationTarget(targetKey);
    if (target) await this.start(target, 'button');
  }

  async start(target: RegisteredDictationTarget, trigger: DictationTrigger): Promise<boolean> {
    // Disabled means inert: no IPC, no microphone, no message.
    if (!this.isEnabled()) return false;
    if (this.usesSystemDictation()) return this.startSystem(target.surface, trigger);
    if (this.activeId) this.stopRecord(this.activeId, false);

    const { store: s } = this.deps;
    const dictationId = this.deps.newId();
    const sessionAtom = dictationSessionAtomFamily(dictationId);
    s.set(sessionAtom, INITIAL_DICTATION_SESSION);

    const record: DictationRecord = {
      dictationId,
      target,
      surface: target.surface,
      engine: null,
      mic: null,
      pendingAudio: [],
      heard: false,
      micReleased: false,
      startedAt: this.deps.now(),
      stoppedAt: null,
      stopRequested: null,
      insertedSegments: 0,
      lastPartial: '',
      processing: false,
      unsubscribe: s.sub(sessionAtom, () => this.onSessionChange(dictationId)),
      cleanupTimer: null,
    };
    this.records.set(dictationId, record);
    this.activeId = dictationId;
    s.set(activeDictationAtom, { dictationId, targetKey: target.key, surface: target.surface, hearing: false });

    // Open the microphone now, in parallel with the engine start, and buffer
    // until the engine accepts. Waiting for main first lost about 1.3s of
    // speech at the start of every dictation.
    const micReady = this.attachMic(record);

    const request: DictationStartRequest = { dictationId, contextStrings: this.deps.contextStrings() };
    let result: DictationStartResult;
    try {
      result = await this.deps.invoke(DICTATION_IPC.start, request);
    } catch (error) {
      result = { ok: false, reason: 'engine-error', message: error instanceof Error ? error.message : String(error) };
    }

    // Main can end a dictation before start resolves (settings turned off).
    if (!this.records.has(dictationId)) return false;

    if (!result?.ok) {
      const failure = result && !result.ok ? result : { reason: 'engine-error' as const, message: undefined };
      if (failure.reason !== 'disabled') {
        this.deps.notify('Dictation could not start', failure.message || FAILURE_MESSAGES[failure.reason]);
      }
      this.releaseMic(record, true);
      this.finish(dictationId);
      return false;
    }
    record.engine = result.engine;

    let micError = await micReady;
    if (micError && this.records.has(dictationId)) {
      // First use: the mic opened before main's OS permission check granted
      // it. Main has asked by now, so try once more.
      this.releaseMic(record, true);
      record.micReleased = false;
      micError = await this.attachMic(record);
    }
    if (!this.records.has(dictationId)) return false;
    if (micError) {
      this.deps.notify(
        'Dictation could not use the microphone',
        micError instanceof Error ? micError.message : FAILURE_MESSAGES['mic-denied'],
      );
      void this.sendStop(dictationId, true);
      this.releaseMic(record, true);
      this.finish(dictationId);
      return false;
    }

    // Engine is listening: send what was said while it started, then stream.
    const buffered = record.pendingAudio ?? [];
    record.pendingAudio = null;
    for (const chunk of buffered) this.deps.send(DICTATION_IPC.audio, dictationId, chunk);
    this.deps.capture('dictation_started', { engine: result.engine, surface: target.surface, trigger });

    if (record.stopRequested) this.stopRecord(dictationId, record.stopRequested.cancel);
    return true;
  }

  /**
   * Stop recording. `cancel` (Esc) discards the pending partial and asks the
   * engine not to flush; otherwise trailing finals still land.
   */
  stop(cancel: boolean): void {
    if (this.activeId) this.stopRecord(this.activeId, cancel);
  }

  /** Stop one dictation by id, whether or not it still owns the UI. */
  private stopRecord(id: string, cancel: boolean): void {
    const record = this.records.get(id);
    if (!record) return;
    if (record.pendingAudio !== null) {
      // Engine still starting: keep buffering and stop once start resolves.
      record.stopRequested = { cancel };
      if (cancel) this.clearPartial(record);
      return;
    }
    if (this.activeId === id) {
      this.activeId = null;
      this.deps.store.set(activeDictationAtom, null);
    }
    this.releaseMic(record);
    record.stoppedAt = this.deps.now();
    if (cancel) this.clearPartial(record);
    const sessionAtom = dictationSessionAtomFamily(id);
    const state = this.deps.store.get(sessionAtom);
    if (state.status !== 'ended' && state.status !== 'error') {
      this.deps.store.set(sessionAtom, { ...state, status: 'stopping' });
    }
    void this.sendStop(id, cancel);
    if (cancel) {
      this.finish(id);
      return;
    }
    if (!record.cleanupTimer) record.cleanupTimer = setTimeout(() => this.finish(id), ENDED_GRACE_MS);
  }

  /**
   * macOS dictation owns the mic, recognition, insertion and its own UI, and
   * we get no events back, so nothing is tracked here.
   */
  private async startSystem(surface: DictationSurface | 'other', trigger: DictationTrigger): Promise<boolean> {
    if (this.activeId) this.stopRecord(this.activeId, true);
    // macOS needs the microphone; release ours, warm or not.
    if (this.mic) this.closeMic(this.mic);
    let result: { ok?: boolean } | undefined;
    try {
      result = await this.deps.invoke(DICTATION_IPC.systemStart);
    } catch {
      result = undefined;
    }
    if (!result?.ok) {
      this.deps.notify('Dictation could not start', 'macOS dictation is not available. Choose another engine in Settings > Dictation.');
      return false;
    }
    this.deps.capture('dictation_started', { engine: 'system', surface, trigger });
    return true;
  }

  /** Route microphone audio to this record, opening the mic (or reusing a warm one). */
  private attachMic(record: DictationRecord): Promise<unknown> {
    let holder = this.mic;
    if (holder && !holder.closed) {
      if (holder.idleTimer) clearTimeout(holder.idleTimer);
      holder.idleTimer = null;
    } else {
      const created: MicHolder = {
        capture: this.deps.createCapture(),
        sink: null,
        ready: Promise.resolve(),
        closed: false,
        idleTimer: null,
      };
      created.ready = created.capture.start((b64) => created.sink?.(b64));
      this.mic = holder = created;
    }
    record.mic = holder;
    holder.sink = (b64) => this.onAudio(record, b64);
    return holder.ready.then(
      () => null,
      (error: unknown) => {
        this.closeMic(holder!);
        return error ?? new Error('microphone failed');
      },
    );
  }

  private onAudio(record: DictationRecord, b64: string): void {
    if (record.micReleased) return;
    if (!record.heard) {
      if (SILENT_CHUNK.test(b64)) return; // device still waking up
      record.heard = true;
      const active = this.deps.store.get(activeDictationAtom);
      if (active?.dictationId === record.dictationId) {
        this.deps.store.set(activeDictationAtom, { ...active, hearing: true });
      }
    }
    if (record.pendingAudio) record.pendingAudio.push(b64);
    else this.deps.send(DICTATION_IPC.audio, record.dictationId, b64);
  }

  /** Detach the record from the mic; park it warm unless `immediate`. */
  private releaseMic(record: DictationRecord, immediate = false): void {
    if (record.micReleased) return;
    record.micReleased = true;
    const holder = record.mic;
    if (!holder || holder.closed) return;
    holder.sink = null;
    const warmMs = this.deps.micWarmMs ?? 0;
    if (immediate || warmMs <= 0) {
      this.closeMic(holder);
      return;
    }
    if (holder.idleTimer) clearTimeout(holder.idleTimer);
    holder.idleTimer = setTimeout(() => this.closeMic(holder), warmMs);
  }

  private closeMic(holder: MicHolder): void {
    if (holder.closed) return;
    holder.closed = true;
    holder.sink = null;
    if (holder.idleTimer) clearTimeout(holder.idleTimer);
    holder.idleTimer = null;
    try {
      holder.capture.stop();
    } catch {
      // already stopped
    }
    if (this.mic === holder) this.mic = null;
  }

  private async sendStop(dictationId: string, cancel: boolean): Promise<void> {
    const request: DictationStopRequest = { dictationId, cancel };
    try {
      await this.deps.invoke(DICTATION_IPC.stop, request);
    } catch (error) {
      console.error('[dictation] stop failed:', error);
    }
  }

  private onSessionChange(dictationId: string): void {
    const record = this.records.get(dictationId);
    if (!record || record.processing) return;
    record.processing = true;
    try {
      this.processSession(record);
    } finally {
      record.processing = false;
    }
  }

  private processSession(record: DictationRecord): void {
    const { dictationId } = record;
    const sessionAtom = dictationSessionAtomFamily(dictationId);
    let state: DictationSessionState = this.deps.store.get(sessionAtom);

    while (state.finals.length > 0) {
      const finals = state.finals;
      // Drain before inserting so the same segment is never inserted twice.
      this.deps.store.set(sessionAtom, { ...state, finals: [] });
      for (const text of finals) {
        record.target.commitFinal(text);
        record.insertedSegments += 1;
      }
      record.lastPartial = '';
      this.setOverlay(record, '');
      state = this.deps.store.get(sessionAtom);
    }

    if (state.partial !== record.lastPartial) {
      record.lastPartial = state.partial;
      if (record.target.showPartial) {
        if (state.partial) record.target.showPartial(state.partial);
        else record.target.clearPartial();
      } else {
        this.setOverlay(record, state.partial);
      }
    }

    if (state.status === 'error') {
      this.deps.notify('Dictation stopped', state.error || FAILURE_MESSAGES['engine-error']);
      if (this.activeId === dictationId) this.stop(true);
      else this.finish(dictationId);
      return;
    }

    if (state.status === 'ended') {
      if (this.activeId === dictationId) {
        // Engine ended on its own while we were recording.
        this.activeId = null;
        this.deps.store.set(activeDictationAtom, null);
        record.stoppedAt = this.deps.now();
      }
      this.finish(dictationId);
    }
  }

  private setOverlay(record: DictationRecord, text: string): void {
    const s = this.deps.store;
    if (text) {
      s.set(dictationOverlayAtom, { text, targetKey: record.target.key });
    } else if (s.get(dictationOverlayAtom)?.targetKey === record.target.key) {
      s.set(dictationOverlayAtom, null);
    }
  }

  private clearPartial(record: DictationRecord): void {
    record.lastPartial = '';
    record.target.clearPartial();
    this.setOverlay(record, '');
  }

  private finish(dictationId: string): void {
    const record = this.records.get(dictationId);
    if (!record) return;
    this.records.delete(dictationId);
    if (record.cleanupTimer) clearTimeout(record.cleanupTimer);
    record.unsubscribe();
    if (this.activeId === dictationId) {
      this.activeId = null;
      this.deps.store.set(activeDictationAtom, null);
    }
    // Whatever ended this record, its audio stops here (the review's
    // overlapping-start bug left the mic running when only the active
    // record was released).
    this.releaseMic(record);
    if (record.lastPartial) this.clearPartial(record);
    if (record.insertedSegments > 0) {
      this.deps.capture('dictation_inserted', {
        engine: record.engine,
        surface: record.surface,
        durationMs: Math.max(0, (record.stoppedAt ?? this.deps.now()) - record.startedAt),
        segments: record.insertedSegments,
      });
    }
    dictationSessionAtomFamily.remove(dictationId);
  }
}

// ============================================================================
// Context strings: cheap, capped vocabulary to bias recognition.
// ============================================================================

const MAX_CONTEXT_STRINGS = 100;
const MAX_TREE_NODES = 2000;

export function gatherDictationContextStrings(
  activeFilePath: string | null,
  tree: ReadonlyArray<{ name: string; isDirectory?: boolean; type?: string; children?: any[] }>,
): string[] {
  const out = new Set<string>();
  const add = (name: string) => {
    if (out.size >= MAX_CONTEXT_STRINGS || !name || name.startsWith('.')) return;
    out.add(name);
    const stem = name.replace(/\.[^.]+$/, '');
    if (stem && stem !== name && out.size < MAX_CONTEXT_STRINGS) out.add(stem);
  };
  if (activeFilePath) add(activeFilePath.split(/[\\/]/).pop() ?? '');
  // Breadth-first so top-level names win the cap.
  const queue = [...tree];
  let visited = 0;
  while (queue.length && out.size < MAX_CONTEXT_STRINGS && visited < MAX_TREE_NODES) {
    const node = queue.shift()!;
    visited += 1;
    if (node.name === 'node_modules') continue;
    add(node.name);
    if (node.children) queue.push(...node.children);
  }
  return [...out];
}

let controller: DictationController | null = null;

export function getDictationController(): DictationController {
  if (!controller) {
    controller = new DictationController({
      store,
      invoke: (channel, ...args) => window.electronAPI.invoke(channel, ...args),
      send: (channel, ...args) => window.electronAPI.send(channel, ...args),
      // Accuracy experiment (2026-11-06): flip with renderer_eval
      // `window.__nimDictationMicProcessing = false` to compare raw audio.
      // No warm window: an open mic blocks macOS dictation from starting
      // (it stalls before the recognizer runs), and macOS is the Mac default.
      isMac: navigator.platform.startsWith('Mac'),
      createCapture: () =>
        new AudioCapture({ processing: (window as { __nimDictationMicProcessing?: boolean }).__nimDictationMicProcessing ?? true }),
      notify: (title, message) => {
        errorNotificationService.showWarning(title, message, { allowDuplicate: true });
      },
      capture: (event, properties) => posthog.capture(event, properties),
      contextStrings: () =>
        gatherDictationContextStrings(store.get(activeFilePathAtom), store.get(rawFileTreeAtom) as any),
      newId: () => crypto.randomUUID(),
      now: () => Date.now(),
    });
  }
  return controller;
}
