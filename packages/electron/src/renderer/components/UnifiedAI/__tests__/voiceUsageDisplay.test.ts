// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  buildVoiceUsageDisplay,
  formatLiveCost,
  formatVoiceDuration,
} from '../voiceUsageDisplay';

describe('formatVoiceDuration', () => {
  it('formats seconds, minutes and hours', () => {
    expect(formatVoiceDuration(0)).toBe('0:00');
    expect(formatVoiceDuration(7.9)).toBe('0:07');
    expect(formatVoiceDuration(65)).toBe('1:05');
    expect(formatVoiceDuration(3605)).toBe('1:00:05');
    expect(formatVoiceDuration(-4)).toBe('0:00');
  });
});

describe('formatLiveCost', () => {
  it('bills $0.05 per minute, per second', () => {
    expect(formatLiveCost(600)).toBe('$0.50');
    expect(formatLiveCost(60)).toBe('$0.05');
    expect(formatLiveCost(1800)).toBe('$1.50');
  });

  it('never claims a non-empty session was free', () => {
    // 6 seconds is $0.005 -- rounding it to $0.00 would read as "no charge".
    expect(formatLiveCost(6)).toBe('<$0.01');
    expect(formatLiveCost(0)).toBe('$0.00');
  });
});

describe('buildVoiceUsageDisplay', () => {
  it('returns nothing when there is no usage at all', () => {
    expect(buildVoiceUsageDisplay(null)).toBeNull();
    expect(buildVoiceUsageDisplay({})).toBeNull();
  });

  it('labels the Realtime figure as the accumulated tokens it measures', () => {
    const display = buildVoiceUsageDisplay({
      engine: 'realtime',
      inputAudio: 1000,
      outputAudio: 3000,
      text: 10000,
      total: 14000,
    });
    expect(display?.occupancy).toBeNull();
    expect(display?.occupancyTone).toBeNull();
    // Realtime counts tokens accumulated over the session, not how full the
    // model's context is -- the engine declines to report a context ratio for
    // exactly that reason, so the display must not reinstate one.
    expect(display?.lines).toEqual([
      { id: 'tokens', label: 'Tokens used', value: '14,000' },
    ]);
  });

  it('shows duration and cost for Live, with occupancy from the reported ratio', () => {
    const display = buildVoiceUsageDisplay({
      engine: 'live',
      durationSeconds: 125,
      contextUsageRatio: 0.42,
    });
    expect(display?.occupancy).toBe(0.42);
    expect(display?.lines).toEqual([
      { id: 'context', label: 'Context', value: '42%' },
      { id: 'duration', label: 'Voice time', value: '2:05' },
      { id: 'cost', label: 'Voice cost', value: '$0.10' },
    ]);
  });

  it('draws no ring and no context line when the engine did not report occupancy', () => {
    // The bug this guards: rendering `undefined` as 0%, which reads as an
    // almost-empty context window we never measured.
    const display = buildVoiceUsageDisplay({ engine: 'live', durationSeconds: 30 });
    expect(display?.occupancy).toBeNull();
    expect(display?.occupancyTone).toBeNull();
    expect(display?.lines.some((l) => l.id === 'context')).toBe(false);
  });

  it('omits duration and cost when Live reported neither', () => {
    const display = buildVoiceUsageDisplay({ engine: 'live', contextUsageRatio: 0.9 });
    expect(display?.lines.map((l) => l.id)).toEqual(['context']);
    expect(display?.occupancyTone).toBe('critical');
  });

  it('keeps a zero measurement, which is not the same as an absent one', () => {
    const zero = buildVoiceUsageDisplay({ engine: 'live', durationSeconds: 0, contextUsageRatio: 0 });
    expect(zero?.occupancy).toBe(0);
    expect(zero?.lines.map((l) => l.value)).toEqual(['0%', '0:00', '$0.00']);
  });

  it('never derives Live occupancy from token counts', () => {
    const display = buildVoiceUsageDisplay({ engine: 'live', total: 14000, durationSeconds: 60 });
    expect(display?.occupancy).toBeNull();
    expect(display?.lines.some((l) => l.id === 'tokens')).toBe(false);
  });

  it('classifies an unstamped report by what it actually measured', () => {
    expect(buildVoiceUsageDisplay({ durationSeconds: 60 })?.engine).toBe('live');
    expect(buildVoiceUsageDisplay({ total: 100 })?.engine).toBe('realtime');
  });

  it('clamps a reported ratio and never treats accumulated tokens as occupancy', () => {
    expect(buildVoiceUsageDisplay({ engine: 'live', contextUsageRatio: 1.4 })?.occupancy).toBe(1);
    expect(buildVoiceUsageDisplay({ engine: 'realtime', total: 90000 })?.occupancy).toBeNull();
  });

  it('keeps controller usage as its own line and never folds it into voice time', () => {
    const display = buildVoiceUsageDisplay({
      engine: 'live',
      durationSeconds: 60,
      backend: [
        { responseId: 'r1', delegationId: 'd1', usage: { input_tokens: 900 } },
        { responseId: 'r2', delegationId: null, usage: { input_tokens: 40 } },
      ],
    });
    expect(display?.lines.map((l) => l.id)).toEqual(['duration', 'cost', 'backend']);
    expect(display?.lines.find((l) => l.id === 'backend')?.value).toBe('2 responses');
    expect(display?.lines.find((l) => l.id === 'cost')?.value).toBe('$0.05');
  });

  it('marks the figures as a floor when finalization never arrived', () => {
    expect(buildVoiceUsageDisplay({ engine: 'live', durationSeconds: 60 })?.isFloor).toBe(false);
    expect(
      buildVoiceUsageDisplay({ engine: 'live', durationSeconds: 60, finalizationMissing: true })?.isFloor,
    ).toBe(true);
  });
});
