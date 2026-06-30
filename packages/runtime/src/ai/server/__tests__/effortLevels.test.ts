import { describe, expect, it } from 'vitest';
import { DEFAULT_THINKING_MODE, parseThinkingMode } from '../effortLevels';

describe('thinking mode parsing', () => {
  it('defaults extended thinking to disabled', () => {
    expect(DEFAULT_THINKING_MODE).toBe('disabled');
  });

  it('accepts supported thinking modes', () => {
    expect(parseThinkingMode('enabled')).toBe('enabled');
    expect(parseThinkingMode('disabled')).toBe('disabled');
  });

  it('falls back to the default for missing or invalid values', () => {
    expect(parseThinkingMode(undefined)).toBe(DEFAULT_THINKING_MODE);
    expect(parseThinkingMode(null)).toBe(DEFAULT_THINKING_MODE);
    expect(parseThinkingMode('adaptive')).toBe(DEFAULT_THINKING_MODE);
  });
});
