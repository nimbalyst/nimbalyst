import { describe, it, expect } from 'vitest';
import { resolveEffortLevel, DEFAULT_EFFORT_LEVEL } from '../effortLevels';

describe('resolveEffortLevel', () => {
  it('uses the explicit per-session effort when set', () => {
    expect(resolveEffortLevel('low', 'max')).toBe('low');
    expect(resolveEffortLevel('high', 'max')).toBe('high');
  });

  it('falls back to the app default when the session has no effort', () => {
    // The selector displays the app default but never writes it to session
    // metadata; the effective effort must follow that default (GitHub #546).
    expect(resolveEffortLevel(undefined, 'max')).toBe('max');
    expect(resolveEffortLevel(null, 'xhigh')).toBe('xhigh');
    expect(resolveEffortLevel('', 'max')).toBe('max');
  });

  it('returns undefined when neither session nor app default is set', () => {
    expect(resolveEffortLevel(undefined, undefined)).toBeUndefined();
    expect(resolveEffortLevel(null, undefined)).toBeUndefined();
  });

  it('coerces an invalid stored session value to the default level', () => {
    expect(resolveEffortLevel('bogus', 'max')).toBe(DEFAULT_EFFORT_LEVEL);
  });
});
