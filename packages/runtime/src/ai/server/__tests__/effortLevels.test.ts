import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EFFORT_LEVEL,
  DEFAULT_THINKING_MODE,
  clampEffortLevel,
  getAvailableEffortLevels,
  parseThinkingMode,
  resolveEffortCeiling,
  resolveEffortLevel,
  resolveThinkingMode,
} from '../effortLevels';

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

describe('thinking mode parsing', () => {
  it('defaults to enabled (preserving the SDK adaptive-thinking default)', () => {
    expect(DEFAULT_THINKING_MODE).toBe('enabled');
    expect(parseThinkingMode(undefined)).toBe('enabled');
    expect(parseThinkingMode(null)).toBe('enabled');
  });

  it('accepts enabled and disabled modes', () => {
    expect(parseThinkingMode('enabled')).toBe('enabled');
    expect(parseThinkingMode('disabled')).toBe('disabled');
  });

  it('falls back to the default for unknown values', () => {
    expect(parseThinkingMode('on')).toBe('enabled');
    expect(parseThinkingMode('off')).toBe('enabled');
    expect(parseThinkingMode('')).toBe('enabled');
  });
});

describe('resolveThinkingMode', () => {
  it('uses the explicit per-session mode when set', () => {
    expect(resolveThinkingMode('disabled', 'enabled')).toBe('disabled');
    expect(resolveThinkingMode('enabled', 'disabled')).toBe('enabled');
  });

  it('falls back to the app default when the session has no mode', () => {
    expect(resolveThinkingMode(undefined, 'disabled')).toBe('disabled');
    expect(resolveThinkingMode(null, 'disabled')).toBe('disabled');
    expect(resolveThinkingMode('', 'disabled')).toBe('disabled');
  });

  it('falls back to enabled when neither is set', () => {
    expect(resolveThinkingMode(undefined, undefined)).toBe('enabled');
    expect(resolveThinkingMode(null, undefined)).toBe('enabled');
  });

  it('sanitizes an invalid session value instead of trusting it', () => {
    expect(resolveThinkingMode('off', 'disabled')).toBe(DEFAULT_THINKING_MODE);
  });
});

describe('per-model effort ceilings', () => {
  // Ceilings mirror `supported_reasoning_levels` in the codex binary's model
  // catalog. Sending a level above a model's ceiling is rejected by codex, and
  // nothing else in the tree records which model stops where.
  it.each([
    ['gpt-6-astra', 'ultra'],
    ['gpt-5.6-sol', 'ultra'],
    ['gpt-5.6-terra', 'ultra'],
    ['gpt-5.6-luna', 'max'],
    ['gpt-5.5', 'xhigh'],
    ['gpt-5.4', 'xhigh'],
    ['gpt-5.4-mini', 'xhigh'],
  ] as const)('clamps ultra to %s\'s ceiling of %s', (model, ceiling) => {
    expect(resolveEffortCeiling(model)).toBe(ceiling);
    expect(clampEffortLevel('ultra', model)).toBe(ceiling);
    expect(clampEffortLevel('low', model)).toBe('low');
  });

  it('resolves the ceiling from a provider-prefixed id', () => {
    expect(clampEffortLevel('ultra', 'openai-codex:gpt-6-astra')).toBe('ultra');
    expect(clampEffortLevel('max', 'openai-codex:gpt-5.4')).toBe('xhigh');
  });

  it('clamps an unrecognized codex model to xhigh', () => {
    // Preserves the behavior every codex model had before per-model ceilings,
    // so a model we have not catalogued can never send a level codex rejects.
    expect(clampEffortLevel('ultra', 'openai-codex:gpt-7-unreleased')).toBe('xhigh');
  });

  it('never offers ultra outside codex', () => {
    // ultra exists only in the codex catalog; Claude's slider stops at max.
    expect(clampEffortLevel('ultra', 'claude-code:opus')).toBe('max');
    expect(getAvailableEffortLevels('claude-code:opus').map((l) => l.key)).not.toContain('ultra');
    expect(getAvailableEffortLevels(undefined).map((l) => l.key)).not.toContain('ultra');
  });

  it('offers exactly the levels a model accepts', () => {
    expect(getAvailableEffortLevels('gpt-6-astra').map((l) => l.key)).toEqual([
      'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
    ]);
    expect(getAvailableEffortLevels('gpt-5.4').map((l) => l.key)).toEqual([
      'low', 'medium', 'high', 'xhigh',
    ]);
  });
});
