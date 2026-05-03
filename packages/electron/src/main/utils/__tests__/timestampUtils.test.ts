import { describe, expect, it } from 'vitest';
import { toMillis } from '../timestampUtils';

describe('toMillis', () => {
  it('returns getTime() for Date instances', () => {
    const value = new Date('2026-05-03T12:34:56.789Z');

    expect(toMillis(value)).toBe(value.getTime());
  });

  it('returns numeric input as-is', () => {
    expect(toMillis(0)).toBe(0);
    expect(toMillis(1746275696789)).toBe(1746275696789);
  });

  it('parses ISO strings with explicit UTC designators', () => {
    expect(toMillis('2026-05-03T12:34:56Z')).toBe(Date.parse('2026-05-03T12:34:56Z'));
    expect(toMillis('2026-05-03T12:34:56+02:30')).toBe(Date.parse('2026-05-03T12:34:56+02:30'));
    expect(toMillis('2026-05-03T12:34:56-07:00')).toBe(Date.parse('2026-05-03T12:34:56-07:00'));
  });

  it('normalizes naive timestamp strings to UTC before parsing', () => {
    expect(toMillis('2026-05-03 12:34:56')).toBe(Date.parse('2026-05-03T12:34:56Z'));
    expect(toMillis('2026-05-03T12:34:56')).toBe(Date.parse('2026-05-03T12:34:56Z'));
  });

  it('returns null for empty or invalid input', () => {
    expect(toMillis(null)).toBeNull();
    expect(toMillis(undefined)).toBeNull();
    expect(toMillis('')).toBeNull();
    expect(toMillis('   ')).toBeNull();
    expect(toMillis('not-a-timestamp')).toBeNull();
  });
});
