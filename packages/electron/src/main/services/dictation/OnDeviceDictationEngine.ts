import type { ChildProcessWithoutNullStreams } from 'child_process';
import type { DictationStartFailure } from '../../../shared/dictation';
import type {
  DictationEngine,
  DictationEngineCallbacks,
  DictationEngineStartOptions,
  DictationEngineStartResult,
} from './DictationEngine';
import {
  createLineSplitter,
  encodeHelperCommand,
  parseHelperLine,
  type HelperCommand,
  type HelperMessage,
} from './helperProtocol';

/** Keep the helper warm between dictations; model load is the slow part. */
export const HELPER_IDLE_SHUTDOWN_MS = 60_000;
/** How long start waits for ready/preparing before giving up. */
const START_TIMEOUT_MS = 15_000;
/** How long stop waits for the helper's 'ended' before ending locally. */
const STOP_TIMEOUT_MS = 8_000;
/** SFSpeechRecognizer on-device needs macOS 13 (Darwin 22). */
const MIN_DARWIN_MAJOR = 22;

export interface OnDeviceEngineDeps {
  platform: NodeJS.Platform;
  /** os.release(), e.g. '25.0.0'. */
  osRelease: string;
  helperPath: string;
  fileExists(path: string): boolean;
  spawnHelper(path: string): ChildProcessWithoutNullStreams;
  log(message: string): void;
  idleShutdownMs?: number;
}

interface ActiveDictation {
  id: string;
  callbacks: DictationEngineCallbacks;
  resolveStart: ((result: DictationEngineStartResult) => void) | null;
  startTimer: ReturnType<typeof setTimeout> | null;
  stopTimer: ReturnType<typeof setTimeout> | null;
  ended: boolean;
}

function mapHelperErrorCode(code: string): DictationStartFailure {
  return code === 'speech-permission-denied' ? 'speech-permission-denied' : 'engine-error';
}

/**
 * macOS on-device engine backed by the nimbalyst-dictation Swift helper.
 * The helper is spawned on first use, kept warm for HELPER_IDLE_SHUTDOWN_MS
 * after a dictation ends, and killed on dispose (app quit).
 */
export class OnDeviceDictationEngine implements DictationEngine {
  readonly id = 'on-device' as const;
  private helper: ChildProcessWithoutNullStreams | null = null;
  private active: ActiveDictation | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: OnDeviceEngineDeps) {}

  isAvailable(): boolean {
    if (this.deps.platform !== 'darwin') return false;
    const major = Number.parseInt(this.deps.osRelease.split('.')[0] ?? '', 10);
    if (!Number.isFinite(major) || major < MIN_DARWIN_MAJOR) return false;
    return this.deps.fileExists(this.deps.helperPath);
  }

  async start(
    options: DictationEngineStartOptions,
    callbacks: DictationEngineCallbacks,
  ): Promise<DictationEngineStartResult> {
    if (this.active) {
      return { ok: false, reason: 'busy' };
    }
    this.clearIdleTimer();
    let helper: ChildProcessWithoutNullStreams;
    try {
      helper = this.ensureHelper();
    } catch (error) {
      return { ok: false, reason: 'engine-error', message: `Could not start the dictation helper: ${String(error)}` };
    }

    const active: ActiveDictation = {
      id: options.dictationId,
      callbacks,
      resolveStart: null,
      startTimer: null,
      stopTimer: null,
      ended: false,
    };
    this.active = active;

    const result = new Promise<DictationEngineStartResult>((resolve) => {
      active.resolveStart = resolve;
      active.startTimer = setTimeout(() => {
        this.failStart(active, 'engine-error', 'On-device dictation did not start in time.');
        this.send({ type: 'stop', id: active.id, cancel: true });
      }, START_TIMEOUT_MS);
    });

    this.send({
      type: 'start',
      id: options.dictationId,
      ...(options.language ? { locale: options.language } : {}),
      contextualStrings: options.contextStrings,
    }, helper);
    return result;
  }

  dispose(): void {
    this.clearIdleTimer();
    if (this.active) this.endActive(this.active);
    this.killHelper();
  }

  private ensureHelper(): ChildProcessWithoutNullStreams {
    if (this.helper && this.helper.exitCode === null && !this.helper.killed) return this.helper;
    const helper = this.deps.spawnHelper(this.deps.helperPath);
    this.helper = helper;
    helper.stdout.on('data', createLineSplitter((line) => {
      const message = parseHelperLine(line);
      if (message) this.handleMessage(message);
    }));
    helper.stderr.on('data', (chunk: Buffer) => {
      this.deps.log(`[Dictation] helper stderr: ${chunk.toString('utf8').trim()}`);
    });
    // EPIPE after the helper died is reported through 'exit'; don't crash main.
    helper.stdin.on('error', (error) => {
      this.deps.log(`[Dictation] helper stdin error: ${String(error)}`);
    });
    helper.on('error', (error) => {
      this.deps.log(`[Dictation] helper process error: ${String(error)}`);
      this.handleExit(helper);
    });
    helper.on('exit', (code, signal) => {
      this.deps.log(`[Dictation] helper exited code=${code} signal=${signal}`);
      this.handleExit(helper);
    });
    return helper;
  }

  private handleExit(helper: ChildProcessWithoutNullStreams): void {
    if (this.helper !== helper) return;
    this.helper = null;
    const active = this.active;
    if (!active) return;
    if (active.resolveStart) {
      this.failStart(active, 'engine-error', 'The dictation helper stopped unexpectedly.');
      return;
    }
    active.callbacks.onEvent({ type: 'error', message: 'The dictation helper stopped unexpectedly.' });
    this.endActive(active);
  }

  private handleMessage(message: HelperMessage): void {
    if (message.type === 'hello') {
      this.deps.log(`[Dictation] helper ready engine=${message.engine} v${message.version}`);
      return;
    }
    const active = this.active;
    if (!active || !('id' in message) || message.id !== active.id) {
      if (message.type === 'error') this.deps.log(`[Dictation] helper error ${message.code}: ${message.message}`);
      return;
    }
    switch (message.type) {
      case 'preparing':
      case 'ready':
        if (active.resolveStart) this.resolveStart(active, { ok: true, session: this.sessionFor(active) });
        active.callbacks.onEvent({ type: message.type });
        return;
      case 'partial':
        active.callbacks.onEvent({ type: 'partial', text: message.text });
        return;
      case 'final':
        active.callbacks.onEvent({ type: 'final', text: message.text });
        return;
      case 'error':
        if (active.resolveStart) {
          this.failStart(active, mapHelperErrorCode(message.code), message.message);
          return;
        }
        active.callbacks.onEvent({ type: 'error', message: message.message });
        return;
      case 'ended':
        if (active.resolveStart) {
          this.failStart(active, 'engine-error', 'On-device dictation ended before it started.');
          return;
        }
        this.endActive(active);
        return;
    }
  }

  private sessionFor(active: ActiveDictation) {
    return {
      pushAudio: (base64Pcm16: string) => {
        if (this.active !== active || active.ended) return;
        this.send({ type: 'audio', id: active.id, data: base64Pcm16 });
      },
      stop: (cancel: boolean) => {
        if (this.active !== active || active.ended || active.stopTimer) return;
        this.send({ type: 'stop', id: active.id, cancel });
        active.stopTimer = setTimeout(() => this.endActive(active), STOP_TIMEOUT_MS);
      },
    };
  }

  private resolveStart(active: ActiveDictation, result: DictationEngineStartResult): void {
    const resolve = active.resolveStart;
    active.resolveStart = null;
    if (active.startTimer) clearTimeout(active.startTimer);
    active.startTimer = null;
    resolve?.(result);
  }

  /** A failed start never reaches onEnded: the caller never saw it begin. */
  private failStart(active: ActiveDictation, reason: DictationStartFailure, message: string): void {
    this.resolveStart(active, { ok: false, reason, message });
    active.ended = true;
    if (this.active === active) this.active = null;
    this.scheduleIdleShutdown();
  }

  private endActive(active: ActiveDictation): void {
    if (active.ended) return;
    active.ended = true;
    if (active.stopTimer) clearTimeout(active.stopTimer);
    if (active.startTimer) clearTimeout(active.startTimer);
    if (this.active === active) this.active = null;
    active.callbacks.onEnded();
    this.scheduleIdleShutdown();
  }

  private send(command: HelperCommand, helper = this.helper): void {
    if (!helper || helper.exitCode !== null || !helper.stdin.writable) return;
    helper.stdin.write(encodeHelperCommand(command));
  }

  private scheduleIdleShutdown(): void {
    this.clearIdleTimer();
    if (!this.helper) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.active) this.killHelper();
    }, this.deps.idleShutdownMs ?? HELPER_IDLE_SHUTDOWN_MS);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private killHelper(): void {
    const helper = this.helper;
    if (!helper) return;
    this.helper = null;
    this.send({ type: 'shutdown' }, helper);
    helper.stdin.end();
    // SIGTERM if the helper doesn't exit on its own promptly.
    const killTimer = setTimeout(() => {
      if (helper.exitCode === null) helper.kill('SIGTERM');
    }, 1_000);
    killTimer.unref?.();
  }
}
