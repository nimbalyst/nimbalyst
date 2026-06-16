import { describe, it, expect } from 'vitest';
import { selectFocusedRestartSessions } from '../restartContinuationSelection';

describe('selectFocusedRestartSessions (NIM-813)', () => {
  it('keeps only the session the focused window is viewing', () => {
    const running = ['a', 'b', 'c'];
    const viewing = { a: false, b: true, c: false };
    expect(selectFocusedRestartSessions(running, viewing)).toEqual(['b']);
  });

  it('returns [] when the focused window views none of the running sessions', () => {
    const running = ['a', 'b'];
    const viewing = { a: false, b: false };
    expect(selectFocusedRestartSessions(running, viewing)).toEqual([]);
  });

  it('returns [] when there is no focused window (empty map)', () => {
    expect(selectFocusedRestartSessions(['a', 'b'], {})).toEqual([]);
  });

  it('ignores a viewed session that is not running/streaming', () => {
    // The focused window views 'z', but 'z' was not in the running set.
    expect(selectFocusedRestartSessions(['a', 'b'], { z: true })).toEqual([]);
  });
});
