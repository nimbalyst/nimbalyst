// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { resolveCatalogControlValues, resolveCatalogReasoningValues, supportsEffortLevel } from '../modelUtils';

describe('supportsEffortLevel', () => {
  it.each([
    'claude-code:opus',
    'claude-code:opus-4-6',
    'claude-code:sonnet',
    'claude-code:fable',
    'claude-code-cli:fable-1m',
    'claude-code:opus-4-7',
    'claude-code-cli:opus-4-7-1m',
    'claude-code:sonnet-4-6',
    'claude-code-cli:sonnet-4-6-1m',
  ])('supports current Claude Code effort-capable variants: %s', (modelId) => {
    expect(supportsEffortLevel(modelId)).toBe(true);
  });

  it.each([
    'openai-codex:gpt-5.4',
    'openai-codex-acp:gpt-5.4',
  ])('supports effort for both Codex providers: %s', (modelId) => {
    expect(supportsEffortLevel(modelId)).toBe(true);
  });

  it.each([
    undefined,
    'claude-code:haiku',
    'claude-code:unknown',
    'claude:claude-fable-5',
  ])('does not expose effort for unsupported models: %s', (modelId) => {
    expect(supportsEffortLevel(modelId)).toBe(false);
  });
});

describe('resolveCatalogReasoningValues', () => {
  const controls = [
    { persistenceKey: 'effort-level', allowedValues: ['high', 'max'], defaultValue: 'high' },
    { persistenceKey: 'thinking-mode', allowedValues: ['enabled', 'disabled'], defaultValue: 'enabled' },
  ] as const;

  it('preserves allowed stored values and never heals a present invalid value', () => {
    expect(resolveCatalogReasoningValues(controls, { effortLevel: 'max', thinkingMode: 'disabled' })).toEqual({
      effortLevel: 'max',
      thinkingMode: 'disabled',
    });
    expect(resolveCatalogReasoningValues(controls, { effortLevel: 'low', thinkingMode: 'unsupported' })).toEqual({
      effortLevel: null,
      thinkingMode: null,
    });
  });

  it('resolves arbitrary ordered catalog keys, defaults only absent keys, and reports present unknowns', () => {
    const genericControls = [{
      persistenceKey: 'reasoning-mode',
      allowedValues: ['non-think', 'think-high', 'think-max', 'think-ultra'],
      defaultValue: 'think-high',
    }] as const;
    expect(resolveCatalogControlValues(genericControls, {})).toEqual({
      values: { 'reasoning-mode': 'think-high' },
      invalidPersistenceKeys: [],
    });
    expect(resolveCatalogControlValues(genericControls, {
      catalogControlValues: { 'reasoning-mode': 'unknown' },
    })).toEqual({
      values: { 'reasoning-mode': 'unknown' },
      invalidPersistenceKeys: ['reasoning-mode'],
    });
    expect(resolveCatalogControlValues(genericControls, {
      catalogControlValues: { 'unexpected-control': 'value' },
    })).toEqual({
      values: {
        'unexpected-control': 'value',
        'reasoning-mode': 'think-high',
      },
      invalidPersistenceKeys: ['unexpected-control'],
    });
    expect(resolveCatalogControlValues(genericControls, {
      catalogControlValues: { 'unexpected-control': 'value' },
    }, { discardUnknownPersistenceKeys: true })).toEqual({
      values: { 'reasoning-mode': 'think-high' },
      invalidPersistenceKeys: [],
    });
  });

  it('returns null for controls the selected catalog entry does not support', () => {
    expect(resolveCatalogReasoningValues([], { effortLevel: 'max', thinkingMode: 'disabled' })).toEqual({
      effortLevel: null,
      thinkingMode: null,
    });
  });
});
