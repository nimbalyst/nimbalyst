// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { prepareVoiceReadyChime } from '../voiceReadyChime';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('unlocks on the click but schedules no sound until listening is ready, then releases audio', async () => {
  const close = vi.fn(async () => {});
  const resume = vi.fn(async () => {});
  const nodes: any[] = [];
  const ramp = { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() };
  vi.stubGlobal('AudioContext', class {
    state = 'running'; currentTime = 1; destination = {};
    close = close; resume = resume;
    createGain() { return { gain: ramp, connect: vi.fn() }; }
    createOscillator() {
      const node = { frequency: ramp, connect: vi.fn(), start: vi.fn(), stop: vi.fn(), onended: null };
      nodes.push(node); return node;
    }
  });
  const cue = prepareVoiceReadyChime();
  expect(resume).toHaveBeenCalledTimes(1);
  expect(nodes).toHaveLength(0);
  expect(await cue.play()).toBe(true);
  expect(nodes.length).toBeGreaterThan(0);
  expect(nodes[0].start).toHaveBeenCalled();
  nodes.at(-1).onended();
  expect(close).toHaveBeenCalledTimes(1);
  expect(await cue.play()).toBe(false);
});

it('cleans up a cancelled startup without playing a false ready signal', async () => {
  const close = vi.fn(async () => {});
  const createOscillator = vi.fn();
  vi.stubGlobal('AudioContext', class {
    resume = vi.fn(async () => {}); close = close; createOscillator = createOscillator;
  });
  const cue = prepareVoiceReadyChime();
  cue.dispose();
  expect(await cue.play()).toBe(false);
  expect(createOscillator).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledTimes(1);
});


it('gives up and releases audio when browser autoplay never unlocks', async () => {
  vi.useFakeTimers();
  const close = vi.fn(async () => {});
  vi.stubGlobal('AudioContext', class {
    resume = () => new Promise<void>(() => {});
    close = close;
  });
  const playing = prepareVoiceReadyChime().play();
  await vi.advanceTimersByTimeAsync(1000);
  expect(await playing).toBe(false);
  expect(close).toHaveBeenCalledTimes(1);
});
