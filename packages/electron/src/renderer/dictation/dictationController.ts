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
}

interface DictationRecord {
  dictationId: string;
  target: RegisteredDictationTarget;
  surface: DictationSurface;
  engine: string | null;
  capture: Pick<AudioCapture, 'start' | 'stop'> | null;
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

  constructor(private deps: DictationControllerDeps) {}

  isEnabled(): boolean {
    return this.deps.store.get(dictationSettingsAtom).enabled;
  }

  isRecording(targetKey?: string): boolean {
    if (!this.activeId) return false;
    if (!targetKey) return true;
    return this.records.get(this.activeId)?.target.key === targetKey;
  }

  /** Start in the focused surface (shortcut). Returns false when nothing happened. */
  startInFocused(trigger: DictationTrigger): Promise<boolean> {
    const target = findFocusedDictationTarget();
    if (!target) return Promise.resolve(false);
    return this.start(target, trigger);
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
    if (this.activeId) this.stop(false);

    const { store: s } = this.deps;
    const dictationId = this.deps.newId();
    const sessionAtom = dictationSessionAtomFamily(dictationId);
    s.set(sessionAtom, INITIAL_DICTATION_SESSION);

    const record: DictationRecord = {
      dictationId,
      target,
      surface: target.surface,
      engine: null,
      capture: null,
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
    s.set(activeDictationAtom, { dictationId, targetKey: target.key, surface: target.surface });

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
      this.finish(dictationId);
      return false;
    }

    record.engine = result.engine;
    const capture = this.deps.createCapture();
    try {
      await capture.start((base64) => this.deps.send(DICTATION_IPC.audio, dictationId, base64));
    } catch (error) {
      this.deps.notify(
        'Dictation could not use the microphone',
        error instanceof Error ? error.message : FAILURE_MESSAGES['mic-denied'],
      );
      void this.sendStop(dictationId, true);
      this.finish(dictationId);
      return false;
    }
    if (!this.records.has(dictationId)) {
      // Ended while the microphone was opening: release it.
      capture.stop();
      return false;
    }
    record.capture = capture;
    this.deps.capture('dictation_started', { engine: result.engine, surface: target.surface, trigger });

    if (record.stopRequested) this.stop(record.stopRequested.cancel);
    return true;
  }

  /**
   * Stop recording. `cancel` (Esc) discards the pending partial and asks the
   * engine not to flush; otherwise trailing finals still land.
   */
  stop(cancel: boolean): void {
    const id = this.activeId;
    if (!id) return;
    const record = this.records.get(id);
    if (!record) return;
    if (!record.capture) {
      // Still starting: remember and apply once start resolves.
      record.stopRequested = { cancel };
      if (cancel) this.clearPartial(record);
      return;
    }
    this.activeId = null;
    this.deps.store.set(activeDictationAtom, null);
    record.capture.stop();
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
    record.cleanupTimer = setTimeout(() => this.finish(id), ENDED_GRACE_MS);
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
        record.capture?.stop();
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
      record.capture?.stop();
    }
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
      createCapture: () => new AudioCapture(),
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
