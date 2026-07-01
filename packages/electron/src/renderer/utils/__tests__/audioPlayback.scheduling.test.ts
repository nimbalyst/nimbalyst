import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

/**
 * Scheduling-math regression test for the "voice speeds up ~8x at the end of a
 * response" bug. AudioPlayback schedules each PCM chunk at an accumulating
 * `nextStartTime`. If chunk delivery lags realtime over a long turn, that
 * accumulator drifts *behind* the AudioContext clock; calling source.start()
 * with a past time makes Web Audio play the buffer immediately, so a backlog of
 * tail chunks all fire at once and overlap (heard as chipmunk speed-up). The fix
 * clamps each chunk's start time to currentTime so playback stays sequential.
 *
 * Runs under the node environment (no Web Audio), so AudioContext/Audio/atob are
 * faked. The fake intentionally does NOT auto-fire source.onended, which mirrors
 * the real failure window (onended lagging behind audio actually finishing) and
 * keeps isPlaying true so the scheduling path under test is exercised.
 */

class FakeAudioBuffer {
  constructor(
    public numberOfChannels: number,
    public length: number,
    public sampleRate: number,
  ) {}
  get duration(): number {
    return this.length / this.sampleRate;
  }
  copyToChannel(): void {}
}

class FakeBufferSource {
  buffer: FakeAudioBuffer | null = null;
  startTime: number | null = null;
  onended: (() => void) | null = null;
  connect(): void {}
  start(when: number): void {
    this.startTime = when;
    FakeAudioContext.current!.startedSources.push(this);
  }
  stop(): void {}
}

class FakeAudioContext {
  static current: FakeAudioContext | null = null;
  state = 'running';
  currentTime = 0;
  startedSources: FakeBufferSource[] = [];
  constructor() {
    FakeAudioContext.current = this;
  }
  createMediaStreamDestination(): { stream: Record<string, never> } {
    return { stream: {} };
  }
  createBuffer(numberOfChannels: number, length: number, sampleRate: number): FakeAudioBuffer {
    return new FakeAudioBuffer(numberOfChannels, length, sampleRate);
  }
  createBufferSource(): FakeBufferSource {
    return new FakeBufferSource();
  }
  async resume(): Promise<void> {
    this.state = 'running';
  }
  close(): void {}
}

/** A 0.1s mono chunk = 2400 samples @ 24kHz = 4800 PCM16 bytes, base64-encoded. */
const CHUNK_SAMPLES = 2400;
const CHUNK_DURATION = CHUNK_SAMPLES / 24000; // 0.1s
const CHUNK_B64 = Buffer.alloc(CHUNK_SAMPLES * 2).toString('base64');

let AudioPlayback: typeof import('../audioPlayback').AudioPlayback;

beforeEach(async () => {
  (globalThis as any).AudioContext = FakeAudioContext;
  (globalThis as any).Audio = class {
    autoplay = false;
    srcObject: unknown = null;
  };
  (globalThis as any).atob = (b64: string) => Buffer.from(b64, 'base64').toString('binary');
  FakeAudioContext.current = null;
  ({ AudioPlayback } = await import('../audioPlayback'));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AudioPlayback scheduling (8x speed-up regression)', () => {
  it('never schedules a chunk in the past even when delivery lags realtime', async () => {
    const playback = new AudioPlayback();
    const ctx = FakeAudioContext.current!;

    // Three chunks arrive fast (delivery ahead of realtime): scheduled into the
    // future at 0, 0.1, 0.2s.
    await playback.play(CHUNK_B64);
    await playback.play(CHUNK_B64);
    await playback.play(CHUNK_B64);

    // Simulate the failure window: the scheduled audio has finished playing in
    // real time (clock advanced to 1.0s) but onended has NOT yet fired, so
    // isPlaying stays true and nextStartTime (0.3) is now far behind the clock.
    ctx.currentTime = 1.0;

    // A backlog of 4 tail chunks flushes at once.
    await playback.play(CHUNK_B64);
    await playback.play(CHUNK_B64);
    await playback.play(CHUNK_B64);
    await playback.play(CHUNK_B64);

    const starts = ctx.startedSources.map((s) => s.startTime!);

    // No chunk may be scheduled before the clock at the time it was scheduled.
    // The first three were scheduled while currentTime was 0; the last four
    // while currentTime was 1.0. Pre-fix, the tail chunks were scheduled at
    // 0.3/0.4/0.5/0.6 (all < 1.0) and fired simultaneously -> the speed-up.
    const tailStarts = starts.slice(3);
    for (const t of tailStarts) {
      expect(t).toBeGreaterThanOrEqual(1.0);
    }

    // And the tail chunks must remain sequential (no overlap): each starts a
    // full chunk-duration after the previous, not all bunched at 1.0.
    for (let i = 1; i < tailStarts.length; i++) {
      expect(tailStarts[i]).toBeCloseTo(tailStarts[i - 1] + CHUNK_DURATION, 5);
    }
  });

  it('keeps chunks sequential during healthy in-order streaming', async () => {
    const playback = new AudioPlayback();
    const ctx = FakeAudioContext.current!;

    for (let i = 0; i < 5; i++) {
      await playback.play(CHUNK_B64);
    }

    const starts = ctx.startedSources.map((s) => s.startTime!);
    expect(starts[0]).toBe(0);
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]).toBeCloseTo(i * CHUNK_DURATION, 5);
    }
  });
});
