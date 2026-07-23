import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EFFORT_LEVEL,
  DEFAULT_THINKING_MODE,
  normalizeEffortForModel,
  parseThinkingMode,
  resolveEffortLevel,
  supportedEffortLevelsForModel,
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

  it('normalizes unsupported Claude effort without upgrading it', () => {
    expect(resolveEffortLevel('xhigh', 'max', 'claude-code:sonnet-4-6')).toBe('high');
    expect(resolveEffortLevel(undefined, 'xhigh', 'claude-code:opus-4-6')).toBe('high');
    expect(resolveEffortLevel('max', 'low', 'claude-code:sonnet-4-6')).toBe('max');
  });

  it.each([
    'claude-code:haiku',
    'claude-code-cli:sonnet',
    'openai-codex-acp:gpt-5.4',
  ])('omits effort entirely when %s cannot forward that degree of freedom', (modelId) => {
    expect(resolveEffortLevel('high', 'max', modelId)).toBeUndefined();
  });
});

describe('Claude effort capabilities', () => {
  it.each([
    'claude-code:fable',
    'claude-code:opus',
    'claude-code:opus-4-7',
    'claude-code:sonnet',
  ])('offers the full current-generation ladder for %s', (modelId) => {
    expect(supportedEffortLevelsForModel(modelId).map(level => level.key))
      .toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it.each([
    'claude-code:opus-4-6',
    'claude-code:sonnet-4-6',
  ])('omits xhigh for legacy adaptive model %s', (modelId) => {
    expect(supportedEffortLevelsForModel(modelId).map(level => level.key))
      .toEqual(['low', 'medium', 'high', 'max']);
    expect(normalizeEffortForModel(modelId, 'xhigh')).toBe('high');
  });

  it('declares no adaptive-effort control for Haiku', () => {
    expect(supportedEffortLevelsForModel('claude-code:haiku')).toEqual([]);
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
