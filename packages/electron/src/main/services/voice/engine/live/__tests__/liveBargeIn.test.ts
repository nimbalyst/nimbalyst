// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { LiveBargeInCoordinator } from '../liveBargeIn';

/**
 * Time and timers are injected so the probation window is exercised exactly,
 * rather than by waiting 500ms of real time per case.
 *
 * The cases below are the two failure directions that fragment-counting got
 * wrong: an echo of the assistant's own words must not cut it off, and a short
 * genuine interruption must still flush.
 */
function harness(options?: { playing?: boolean }) {
  let now = 1_000;
  let playing = options?.playing ?? true;
  const flushes: number[] = [];
  const timers: Array<{ at: number; fn: () => void }> = [];

  const coordinator = new LiveBargeInCoordinator({
    isPlaybackActive: () => playing,
    flushPlayback: () => flushes.push(now),
    now: () => now,
    setTimer: (fn, ms) => {
      const timer = { at: now + ms, fn };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      const index = timers.indexOf(handle as { at: number; fn: () => void });
      if (index >= 0) timers.splice(index, 1);
    },
  });

  return {
    coordinator,
    flushes,
    setPlaying(value: boolean) {
      playing = value;
      coordinator.setPlaybackActive(value);
    },
    /** Advance the clock, firing any probation timer that comes due. */
    advance(ms: number) {
      now += ms;
      for (const timer of [...timers]) {
        if (timer.at > now) continue;
        timers.splice(timers.indexOf(timer), 1);
        timer.fn();
      }
    },
  };
}

const ASSISTANT_SPEECH = 'The delivery table already has a created at column.';

describe('LiveBargeInCoordinator', () => {
  it('flushes queued audio for words the assistant did not just say', () => {
    const h = harness();
    h.setPlaying(true);
    h.coordinator.noteAssistantText(ASSISTANT_SPEECH);

    h.coordinator.onUserSpeechStarted();
    h.coordinator.onUserTranscriptDelta('utterance-1', 'no ');
    h.advance(120);
    h.coordinator.onUserTranscriptDelta('utterance-1', 'hold on');

    // Probation is not bypassable: a second fragment is evidence, not a
    // trigger. Flushing here is what cut the assistant off over an echo.
    expect(h.flushes).toEqual([]);

    h.advance(400);
    expect(h.flushes).toHaveLength(1);
    expect(h.coordinator.metrics.interruptCount).toBe(1);
  });

  it('does not cut the assistant off for an echo of its own voice', () => {
    const h = harness();
    h.setPlaying(true);
    h.coordinator.noteAssistantText(ASSISTANT_SPEECH);

    // Residual echo transcribes as the assistant's own words, and it can very
    // well arrive as more than one fragment inside the probation window.
    h.coordinator.onUserSpeechStarted();
    h.coordinator.onUserTranscriptDelta('echo-1', 'a created ');
    h.advance(120);
    h.coordinator.onUserTranscriptDelta('echo-1', 'at column');
    expect(h.flushes).toEqual([]);

    h.advance(600);
    expect(h.flushes).toEqual([]);
    expect(h.coordinator.metrics.suppressedEchoCount).toBe(1);
    expect(h.coordinator.metrics.interruptCount).toBe(0);
  });

  it('flushes a one-word interruption, which produces a single fragment', () => {
    const h = harness();
    h.setPlaying(true);
    h.coordinator.noteAssistantText(ASSISTANT_SPEECH);

    // "stop" is the whole utterance: no continuation fragment will ever arrive,
    // so anything waiting for one never flushes at all.
    h.coordinator.onUserSpeechStarted();
    h.coordinator.onUserTranscriptDelta('utterance-1', 'stop');
    h.advance(500);

    expect(h.flushes).toHaveLength(1);
    expect(h.coordinator.metrics.interruptCount).toBe(1);
  });

  it('requires sustained speech when there is no assistant transcript to compare', () => {
    const h = harness();
    h.setPlaying(true);

    // Native transcription of the assistant's side can lag, leaving nothing to
    // match against. Suppressing is the safer error, so a blip is held.
    h.coordinator.onUserSpeechStarted();
    h.coordinator.onUserTranscriptDelta('blip-1', 'the');
    h.advance(600);
    expect(h.flushes).toEqual([]);

    const h2 = harness();
    h2.setPlaying(true);
    h2.coordinator.onUserSpeechStarted();
    h2.coordinator.onUserTranscriptDelta('utterance-1', 'that is not ');
    h2.advance(350);
    h2.coordinator.onUserTranscriptDelta('utterance-1', 'what I asked for');
    h2.advance(200);
    expect(h2.flushes).toHaveLength(1);
  });

  it('does nothing when the assistant is not audible', () => {
    const h = harness({ playing: false });
    h.setPlaying(false);

    h.coordinator.onUserSpeechStarted();
    h.coordinator.onUserTranscriptDelta('utterance-1', 'open the file');
    h.advance(1000);

    // There is no queued audio to drop; flushing anyway would only add noise.
    expect(h.flushes).toEqual([]);
  });

  it('abandons a pending decision once playback drains on its own', () => {
    const h = harness();
    h.setPlaying(true);
    h.coordinator.noteAssistantText(ASSISTANT_SPEECH);

    h.coordinator.onUserSpeechStarted();
    h.coordinator.onUserTranscriptDelta('utterance-1', 'no hold on');
    h.setPlaying(false);
    h.advance(600);

    expect(h.flushes).toEqual([]);
  });

  it('re-judges a suppressed utterance that keeps talking', () => {
    const h = harness();
    h.setPlaying(true);
    h.coordinator.noteAssistantText(ASSISTANT_SPEECH);

    // Starts out looking exactly like echo, so the window suppresses it...
    h.coordinator.onUserSpeechStarted();
    h.coordinator.onUserTranscriptDelta('utterance-1', 'a created ');
    h.advance(600);
    expect(h.flushes).toEqual([]);

    // ...and then the user keeps going with words we never said. A late flush
    // beats none.
    h.coordinator.onUserTranscriptDelta('utterance-1', 'column is not what I asked for');
    expect(h.flushes).toHaveLength(1);
    expect(h.coordinator.metrics.interruptCount).toBe(1);
  });

  it('does not treat a word split across assistant deltas as a genuine interruption', () => {
    const h = harness();
    h.setPlaying(true);

    // Native transcription streams the assistant's side in arbitrary chunks, so
    // a single word arrives as several deltas. Reassembling them with a
    // separator invents words the assistant never said -- and then the user's
    // exact echo of a real one matches nothing and cuts the assistant off.
    h.coordinator.noteAssistantText('con');
    h.coordinator.noteAssistantText('text');
    h.coordinator.onUserSpeechStarted();
    h.coordinator.onUserTranscriptDelta('echo', 'context');
    h.advance(600);

    expect(h.flushes).toEqual([]);
    expect(h.coordinator.metrics.interruptCount).toBe(0);
  });

  it('separates assistant turns that are a pause apart rather than gluing them', () => {
    const h = harness();
    h.setPlaying(true);

    // The flip side of concatenating deltas: two *turns* must not fuse into a
    // word that was never spoken. A gap in the stream is a boundary.
    h.coordinator.noteAssistantText('done');
    h.advance(3000);
    h.coordinator.noteAssistantText('sure');

    h.coordinator.onUserSpeechStarted();
    h.coordinator.onUserTranscriptDelta('echo', 'done sure');
    h.advance(600);

    // Both words were genuinely said, just not adjacently: still echo.
    expect(h.flushes).toEqual([]);
  });
});
