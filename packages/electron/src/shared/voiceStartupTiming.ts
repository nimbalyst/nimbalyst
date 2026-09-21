/** Local diagnostics only: fixed stage names, random attempt ID, and durations. */
export type VoiceStartupStage =
  | 'permission' | 'session-context' | 'session-files' | 'project-summary'
  | 'command-catalog' | 'extension-context' | 'extension-context-timeout' | 'tool-discovery'
  | 'engine-preparation' | 'live-socket-open' | 'live-config-sent' | 'live-session-ready'
  | 'live-fallback' | 'realtime-socket-open' | 'connection-ipc'
  | 'microphone-access' | 'audio-context-running' | 'microphone-ready' | 'listening-ready'
  | 'ready-chime-played' | 'ready-chime-unavailable';

export class VoiceStartupTiming {
  readonly id: string;
  private readonly started: number;
  private previous: number;
  private finished = false;

  constructor(
    private readonly side: 'main' | 'renderer',
    id?: string,
    private readonly now: () => number = () => performance.now(),
    private readonly write: (record: Record<string, string | number>) => void = record => console.info('[VoiceStartup]', JSON.stringify(record)),
  ) {
    // Never log an arbitrary IPC argument: only a random UUID may correlate the two processes.
    this.id = typeof id === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)
      ? id : crypto.randomUUID();
    this.started = this.previous = this.now();
    this.write({ attempt: this.id, side, stage: 'begin', elapsedMs: 0 });
  }

  mark(stage: VoiceStartupStage): void {
    if (this.finished) return;
    const at = this.now();
    this.write({ attempt: this.id, side: this.side, stage, stageMs: Math.round(at - this.previous), elapsedMs: Math.round(at - this.started) });
    this.previous = at;
  }

  finish(outcome: 'ready' | 'failed'): void {
    if (this.finished) return;
    this.finished = true;
    this.write({ attempt: this.id, side: this.side, stage: 'finished', outcome, elapsedMs: Math.round(this.now() - this.started) });
  }
}
