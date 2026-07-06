import { describe, it, expect } from 'vitest';
import { VoiceBargeInPolicy, ECHO_SUSPECT_INTERRUPT_DEFER_MS, buildServerVadTurnDetection, buildSemanticVadTurnDetection, buildTurnDetection } from '../voiceBargeInPolicy';

describe('VoiceBargeInPolicy', () => {
  const makeClock = () => {
    let t = 1_000_000;
    return { now: () => t, advance: (ms: number) => { t += ms; } };
  };

  it('classifies speech_started during playback as echo-suspect and defers the interrupt', () => {
    const clock = makeClock();
    const policy = new VoiceBargeInPolicy(clock.now);

    policy.notePlaybackStarted();
    clock.advance(750);
    const decision = policy.onSpeechStarted(true);

    expect(decision.echoSuspect).toBe(true);
    expect(decision.msSincePlaybackStarted).toBe(750);
    // Min-duration heuristic: suspects get a probation window, not an interrupt.
    expect(decision.shouldInterrupt).toBe(false);
    expect(decision.deferInterruptMs).toBe(ECHO_SUSPECT_INTERRUPT_DEFER_MS);
    expect(policy.metrics.echoSuspectCount).toBe(1);
    expect(policy.metrics.genuineCount).toBe(0);
    expect(policy.metrics.interruptCount).toBe(0);
  });

  it('deferred timeout interrupts when speech persists through the window', () => {
    const clock = makeClock();
    const policy = new VoiceBargeInPolicy(clock.now);

    policy.notePlaybackStarted();
    clock.advance(700);
    policy.onSpeechStarted(true);
    clock.advance(ECHO_SUSPECT_INTERRUPT_DEFER_MS);

    const fired = policy.onDeferredInterruptTimeout(true);
    expect(fired.shouldInterrupt).toBe(true);
    // Truncation ms measured at fire time (user heard the probation window too).
    expect(fired.msSincePlaybackStarted).toBe(700 + ECHO_SUSPECT_INTERRUPT_DEFER_MS);
    expect(policy.metrics.interruptCount).toBe(1);
  });

  it('deferred timeout suppresses an echo blip that ended inside the window', () => {
    const clock = makeClock();
    const policy = new VoiceBargeInPolicy(clock.now);

    policy.notePlaybackStarted();
    policy.onSpeechStarted(true);
    clock.advance(200);
    policy.onSpeechStopped();
    clock.advance(300);

    const fired = policy.onDeferredInterruptTimeout(true);
    expect(fired.shouldInterrupt).toBe(false);
    expect(policy.metrics.suppressedEchoCount).toBe(1);
    expect(policy.metrics.interruptCount).toBe(0);
  });

  it('deferred timeout is a no-op when playback already drained', () => {
    const clock = makeClock();
    const policy = new VoiceBargeInPolicy(clock.now);

    policy.notePlaybackStarted();
    policy.onSpeechStarted(true);
    clock.advance(400);
    policy.notePlaybackStopped();
    clock.advance(100);

    const fired = policy.onDeferredInterruptTimeout(false);
    expect(fired.shouldInterrupt).toBe(false);
    expect(fired.msSincePlaybackStarted).toBeNull();
    expect(policy.metrics.interruptCount).toBe(0);
  });

  it('classifies speech_started while silent as genuine', () => {
    const policy = new VoiceBargeInPolicy(makeClock().now);
    const decision = policy.onSpeechStarted(false);

    expect(decision.echoSuspect).toBe(false);
    expect(decision.msSincePlaybackStarted).toBeNull();
    expect(policy.metrics.genuineCount).toBe(1);
  });

  it('playback start is idempotent across chunks and re-arms after stop', () => {
    const clock = makeClock();
    const policy = new VoiceBargeInPolicy(clock.now);

    policy.notePlaybackStarted();
    clock.advance(500);
    policy.notePlaybackStarted(); // later chunk must not reset the clock
    clock.advance(500);
    expect(policy.onSpeechStarted(true).msSincePlaybackStarted).toBe(1000);

    policy.notePlaybackStopped();
    policy.notePlaybackStarted();
    clock.advance(200);
    expect(policy.onSpeechStarted(true).msSincePlaybackStarted).toBe(200);
  });

  it('measures speech duration between start and stop', () => {
    const clock = makeClock();
    const policy = new VoiceBargeInPolicy(clock.now);

    policy.onSpeechStarted(false);
    clock.advance(340);
    expect(policy.onSpeechStopped()).toBe(340);
    expect(policy.metrics.lastSpeechDurationMs).toBe(340);
    expect(policy.onSpeechStopped()).toBeNull(); // no matching start
  });

  it('accumulates metrics and resetSession clears them', () => {
    const policy = new VoiceBargeInPolicy(makeClock().now);

    policy.notePlaybackStarted();
    policy.onSpeechStarted(true);
    policy.onSpeechStarted(true);
    policy.notePlaybackStopped();
    policy.onSpeechStarted(false);

    expect(policy.metrics.speechStartedCount).toBe(3);
    expect(policy.metrics.echoSuspectCount).toBe(2);
    expect(policy.metrics.genuineCount).toBe(1);
    // Only the genuine trigger interrupts immediately; the echo-suspect ones defer.
    expect(policy.metrics.interruptCount).toBe(1);

    policy.resetSession();
    expect(policy.metrics.speechStartedCount).toBe(0);
    expect(policy.metrics.lastSpeechDurationMs).toBeNull();
  });
});

describe('buildServerVadTurnDetection', () => {
  it('allows server responses for the user turn', () => {
    const td = buildServerVadTurnDetection({ vadThreshold: 0.6, silenceDurationMs: 400, allowServerResponses: true });
    expect(td).toEqual({
      type: 'server_vad',
      threshold: 0.6,
      prefix_padding_ms: 300,
      silence_duration_ms: 400,
      create_response: true,
      interrupt_response: true,
    });
  });

  it('gates server responses while the agent speaks', () => {
    const td = buildServerVadTurnDetection({ allowServerResponses: false });
    expect(td.create_response).toBe(false);
    expect(td.interrupt_response).toBe(false);
    // Raised from 0.5: residual echo tripped amplitude VAD at the old default.
    expect(td.threshold).toBe(0.85);
    expect(td.silence_duration_ms).toBe(500);
  });
});

describe('buildTurnDetection', () => {
  it('defaults to semantic_vad with auto eagerness', () => {
    const td = buildTurnDetection({ allowServerResponses: true });
    expect(td).toEqual({
      type: 'semantic_vad',
      eagerness: 'auto',
      create_response: true,
      interrupt_response: true,
    });
  });

  it('semantic_vad carries the gating flags', () => {
    const td = buildSemanticVadTurnDetection({ allowServerResponses: false });
    expect(td.create_response).toBe(false);
    expect(td.interrupt_response).toBe(false);
  });

  it('falls back to server_vad when requested, honoring threshold settings', () => {
    const td = buildTurnDetection({ detection: 'server_vad', vadThreshold: 0.7, allowServerResponses: true });
    expect(td.type).toBe('server_vad');
    expect((td as { threshold: number }).threshold).toBe(0.7);
  });
});
