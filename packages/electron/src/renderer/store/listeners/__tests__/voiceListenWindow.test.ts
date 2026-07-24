import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VoiceListenWindowController } from '../voiceListenWindow';

/**
 * NIM-1594: the listen-window timer must never arm (and therefore never
 * expire into 'sleeping') while the user is actively speaking. Three real
 * paths re-armed it mid-utterance: token-usage from a barge-in-cancelled
 * response, a late transcript-complete for the previous utterance, and the
 * playback-drain post-turn window after a suppressed echo-suspect trigger.
 */
describe('VoiceListenWindowController', () => {
  const WINDOW_MS = 15000;
  let onExpire: ReturnType<typeof vi.fn<() => void>>;
  let onHeldDuringSpeech: ReturnType<typeof vi.fn<(reason: string) => void>>;
  let controller: VoiceListenWindowController;

  beforeEach(() => {
    vi.useFakeTimers();
    onExpire = vi.fn<() => void>();
    onHeldDuringSpeech = vi.fn<(reason: string) => void>();
    controller = new VoiceListenWindowController({
      getWindowMs: () => WINDOW_MS,
      onExpire,
      onHeldDuringSpeech,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('expires after the window when armed while the user is silent', () => {
    controller.start('speech-stopped');
    vi.advanceTimersByTime(WINDOW_MS - 1);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('speechStarted clears a running timer so it cannot expire mid-utterance', () => {
    controller.start('speech-stopped');
    vi.advanceTimersByTime(WINDOW_MS - 1);
    controller.speechStarted();
    vi.advanceTimersByTime(WINDOW_MS * 2);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it('does not arm while user speech is active (token-usage from a cancelled barge-in response)', () => {
    controller.speechStarted();
    // token-usage for the cancelled response arrives mid-utterance
    controller.start('post-turn');
    vi.advanceTimersByTime(WINDOW_MS * 2);
    expect(onExpire).not.toHaveBeenCalled();
    expect(onHeldDuringSpeech).toHaveBeenCalledWith('post-turn');
  });

  it('does not arm on a late transcript-complete for the previous utterance', () => {
    // utterance A ends -> timer armed
    controller.speechStopped();
    // user starts utterance B
    controller.speechStarted();
    // A's transcription completes late
    controller.start('transcript-complete');
    vi.advanceTimersByTime(WINDOW_MS * 2);
    expect(onExpire).not.toHaveBeenCalled();
    expect(onHeldDuringSpeech).toHaveBeenCalledWith('transcript-complete');
  });

  it('arms normally once speech stops after held requests', () => {
    controller.speechStarted();
    controller.start('post-turn'); // held
    controller.speechStopped(); // arms from now
    vi.advanceTimersByTime(WINDOW_MS);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('restarting the timer replaces the previous countdown', () => {
    controller.start('speech-stopped');
    vi.advanceTimersByTime(WINDOW_MS - 1);
    controller.start('post-turn');
    vi.advanceTimersByTime(WINDOW_MS - 1);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('reset clears both the timer and in-flight speech (explicit pause, reconnect, stop)', () => {
    controller.speechStarted();
    controller.reset();
    expect(controller.isUserSpeechActive).toBe(false);
    // after reset the timer can arm again
    controller.start('reconnected');
    vi.advanceTimersByTime(WINDOW_MS);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('clear stops the countdown without touching speech state', () => {
    controller.start('speech-stopped');
    controller.clear();
    vi.advanceTimersByTime(WINDOW_MS * 2);
    expect(onExpire).not.toHaveBeenCalled();
    expect(controller.isUserSpeechActive).toBe(false);
  });

  it('reads the window length at arm time (settings change applies to the next window)', () => {
    let windowMs = WINDOW_MS;
    controller = new VoiceListenWindowController({
      getWindowMs: () => windowMs,
      onExpire,
    });
    windowMs = 5000;
    controller.start('speech-stopped');
    vi.advanceTimersByTime(5000);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });
});
