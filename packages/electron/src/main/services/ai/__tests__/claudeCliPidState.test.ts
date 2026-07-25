import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseClaudePidFile,
  mapPidStatusToTurnState,
  diffTurnState,
  isClaudePidFileStale,
  watchClaudePidState,
  readClaudePidTurnState,
  type ClaudeTurnState,
} from '../claudeCliPidState';

/**
 * The `claude` CLI writes `~/.claude/sessions/{pid}.json`; we poll it for
 * busy/idle/waiting and map to Nimbalyst turn states. This is the stable
 * turn-level state source for the CLI path (the SDK-only MessageStreamingHandler
 * does not see CLI turns).
 */
describe('parseClaudePidFile', () => {
  it('parses a busy status', () => {
    const r = parseClaudePidFile(JSON.stringify({ status: 'busy', pid: 4321 }));
    expect(r?.status).toBe('busy');
    expect(r?.pid).toBe(4321);
  });

  it('parses idle and waiting', () => {
    expect(parseClaudePidFile('{"status":"idle"}')?.status).toBe('idle');
    expect(parseClaudePidFile('{"status":"waiting"}')?.status).toBe('waiting');
  });

  it('is case-insensitive and trims', () => {
    expect(parseClaudePidFile('{"status":" Busy "}')?.status).toBe('busy');
  });

  it('returns null for malformed JSON', () => {
    expect(parseClaudePidFile('not json')).toBeNull();
    expect(parseClaudePidFile('')).toBeNull();
  });

  it('returns null for an unrecognized status (forward-compat: caller holds last-known)', () => {
    expect(parseClaudePidFile('{"status":"reticulating"}')).toBeNull();
    expect(parseClaudePidFile('{"pid":1}')).toBeNull();
  });

  it('captures kind / waitingFor and normalizes updatedAt (ms passthrough, seconds upscaled)', () => {
    const ms = parseClaudePidFile(
      JSON.stringify({ status: 'waiting', kind: 'interactive', waitingFor: 'Bash', updatedAt: 1_700_000_000_000 }),
    );
    expect(ms).toMatchObject({ kind: 'interactive', waitingFor: 'Bash', updatedAt: 1_700_000_000_000 });
    // A seconds-epoch value (< 1e12) is upscaled to ms.
    expect(parseClaudePidFile('{"status":"busy","updatedAt":1700000000}')?.updatedAt).toBe(1_700_000_000_000);
    // Absent/zero updatedAt → undefined.
    expect(parseClaudePidFile('{"status":"idle"}')?.updatedAt).toBeUndefined();
  });
});

describe('isClaudePidFileStale', () => {
  const at = (status: 'busy' | 'idle' | 'waiting', updatedAt?: number) =>
    ({ status, updatedAt, raw: {} } as ReturnType<typeof parseClaudePidFile> & object);

  it('flags an active file whose updatedAt is older than the threshold', () => {
    expect(isClaudePidFileStale(at('busy', 1_000), 100_000, 60_000)).toBe(true);
    expect(isClaudePidFileStale(at('waiting', 1_000), 100_000, 60_000)).toBe(true);
  });

  it('is fresh when within the threshold', () => {
    expect(isClaudePidFileStale(at('busy', 90_000), 100_000, 60_000)).toBe(false);
  });

  it('never flags idle, and treats a missing updatedAt as fresh (cannot judge)', () => {
    expect(isClaudePidFileStale(at('idle', 1), 1e15, 60_000)).toBe(false);
    expect(isClaudePidFileStale(at('busy', undefined), 1e15, 60_000)).toBe(false);
  });
});

describe('mapPidStatusToTurnState', () => {
  it('maps PID statuses to Nimbalyst turn states', () => {
    expect(mapPidStatusToTurnState('busy')).toBe('running');
    expect(mapPidStatusToTurnState('idle')).toBe('idle');
    expect(mapPidStatusToTurnState('waiting')).toBe('waiting_for_input');
  });
});

describe('diffTurnState', () => {
  it('reports a transition only when the state actually changes', () => {
    expect(diffTurnState('idle', 'running')).toEqual({ changed: true, from: 'idle', to: 'running' });
    expect(diffTurnState('running', 'running')).toEqual({ changed: false, from: 'running', to: 'running' });
  });

  it('treats an undefined previous state as a change', () => {
    expect(diffTurnState(undefined, 'running').changed).toBe(true);
  });
});

/**
 * NIM-814: a hung/dead CLI must not pin the UI to "Thinking" forever. The
 * trustworthy stuck signal is process liveness, NOT `updatedAt` age: the CLI
 * only rewrites `updatedAt` on status transitions (verified empirically against
 * CLI 2.1.170 — a live busy turn showed a 5+ minute old `updatedAt`), so an
 * age threshold would falsely idle long agentic turns.
 */
describe('watchClaudePidState liveness backstop', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const busyFile = JSON.stringify({ status: 'busy', pid: 999, updatedAt: 1_000 });

  function setup(opts: {
    readFile: (p: string) => Promise<string>;
    isProcessAlive: (pid: number) => boolean;
  }) {
    vi.useFakeTimers();
    const states: ClaudeTurnState[] = [];
    const stop = watchClaudePidState({
      pid: 999,
      configDir: '/fake-home/.claude',
      intervalMs: 500,
      readFile: opts.readFile,
      isProcessAlive: opts.isProcessAlive,
      onTurnState: (state) => states.push(state),
    });
    return { states, stop };
  }

  it('keeps trusting an old busy file while the process is alive (no updatedAt staleness)', async () => {
    const { states, stop } = setup({
      readFile: async () => busyFile,
      isProcessAlive: () => true,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(states).toEqual(['running']);
    stop();
  });

  it('maps a busy file to idle once the process is dead', async () => {
    let alive = true;
    const { states, stop } = setup({
      readFile: async () => busyFile,
      isProcessAlive: () => alive,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(states).toEqual(['running']);
    alive = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(states).toEqual(['running', 'idle']);
    stop();
  });

  it('releases a held running state to idle when the file becomes unreadable and the process is dead', async () => {
    let alive = true;
    let readable = true;
    const { states, stop } = setup({
      readFile: async () => {
        if (!readable) throw new Error('ENOENT');
        return busyFile;
      },
      isProcessAlive: () => alive,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(states).toEqual(['running']);
    readable = false;
    await vi.advanceTimersByTimeAsync(1_000);
    // File gone but process alive: hold last-known.
    expect(states).toEqual(['running']);
    alive = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(states).toEqual(['running', 'idle']);
    stop();
  });
});

describe('readClaudePidTurnState (one-shot)', () => {
  it('returns the mapped state for a readable file with a live process', async () => {
    const state = await readClaudePidTurnState({
      pid: 999,
      configDir: '/fake-home/.claude',
      readFile: async () => '{"status":"busy"}',
      isProcessAlive: () => true,
    });
    expect(state).toBe('running');
  });

  it('returns idle for a dead process regardless of file contents', async () => {
    const state = await readClaudePidTurnState({
      pid: 999,
      configDir: '/fake-home/.claude',
      readFile: async () => '{"status":"busy"}',
      isProcessAlive: () => false,
    });
    expect(state).toBe('idle');
  });

  it('returns null when the file is unreadable but the process is alive (unknown)', async () => {
    const state = await readClaudePidTurnState({
      pid: 999,
      configDir: '/fake-home/.claude',
      readFile: async () => {
        throw new Error('ENOENT');
      },
      isProcessAlive: () => true,
    });
    expect(state).toBeNull();
  });
});
