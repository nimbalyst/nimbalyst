// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installUserTimingTrimmer } from '../userTimingTrimmer';

afterEach(() => {
  vi.useRealTimers();
  performance.clearMeasures();
});

describe('installUserTimingTrimmer', () => {
  it('keeps the measure buffer bounded while React keeps writing to it', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const uninstall = installUserTimingTrimmer(performance, 1000);

    for (let i = 0; i < 500; i++) performance.measure(`Component${i % 5}`, { start: 0, end: 1, detail: { devtools: { track: 'Components' } } });
    expect(performance.getEntriesByType('measure')).toHaveLength(500);

    vi.advanceTimersByTime(1000);
    expect(performance.getEntriesByType('measure')).toHaveLength(0);

    uninstall();
    performance.measure('AfterUninstall', { start: 0, end: 1 });
    vi.advanceTimersByTime(5000);
    expect(performance.getEntriesByType('measure')).toHaveLength(1);
  });
});
