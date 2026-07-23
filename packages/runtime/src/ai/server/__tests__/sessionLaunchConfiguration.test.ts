import { describe, expect, it } from 'vitest';
import {
  parseSessionLaunchToolScope,
  resolveSessionReasoningConfiguration,
} from '../sessionLaunchConfiguration';

describe('session launch reasoning configuration', () => {
  it('accepts explicit Codex effort without claiming provider effectiveness', () => {
    expect(resolveSessionReasoningConfiguration({
      provider: 'openai-codex',
      model: 'openai-codex:gpt-5.6-sol',
      effortLevel: 'max',
      appDefaultEffortLevel: 'high',
    })).toEqual({
      requestedEffortLevel: 'max',
      requestedThinkingMode: null,
      effortLevel: 'max',
      thinkingMode: null,
      effortLevelSource: 'requested',
      thinkingModeSource: null,
    });
  });

  it('accepts supported Claude effort and adaptive-thinking requests', () => {
    expect(resolveSessionReasoningConfiguration({
      provider: 'claude-code',
      model: 'claude-code:opus',
      effortLevel: 'xhigh',
      thinkingMode: 'disabled',
      appDefaultEffortLevel: 'medium',
    })).toMatchObject({
      effortLevel: 'xhigh',
      thinkingMode: 'disabled',
      effortLevelSource: 'requested',
      thinkingModeSource: 'requested',
    });
  });

  it('normalizes an app default for the selected model but rejects that value when explicit', () => {
    expect(resolveSessionReasoningConfiguration({
      provider: 'claude-code',
      model: 'claude-code:sonnet-4-6',
      appDefaultEffortLevel: 'xhigh',
    }).effortLevel).toBe('high');

    expect(() => resolveSessionReasoningConfiguration({
      provider: 'claude-code',
      model: 'claude-code:sonnet-4-6',
      effortLevel: 'xhigh',
      appDefaultEffortLevel: 'high',
    })).toThrow('Supported values: low, medium, high, max');
  });

  it.each([
    ['openai-codex-acp', 'openai-codex-acp:gpt-5.6-sol'],
    ['claude-code-cli', 'claude-code-cli:opus'],
    ['claude-code', 'claude-code:haiku'],
    ['opencode', 'opencode:default'],
  ])('rejects effort for unsupported %s models', (provider, model) => {
    expect(() => resolveSessionReasoningConfiguration({
      provider,
      model,
      effortLevel: 'high',
      appDefaultEffortLevel: 'high',
    })).toThrow('Supported values: none');
  });

  it('rejects thinking toggles for fixed-adaptive Fable', () => {
    expect(() => resolveSessionReasoningConfiguration({
      provider: 'claude-code',
      model: 'claude-code:fable',
      thinkingMode: 'disabled',
      appDefaultEffortLevel: 'high',
    })).toThrow('thinkingMode is not supported');
  });

  it('validates tool scopes instead of silently treating unknown values as full', () => {
    expect(parseSessionLaunchToolScope(undefined)).toBe('full');
    expect(parseSessionLaunchToolScope('write')).toBe('write');
    expect(() => parseSessionLaunchToolScope('admin')).toThrow(
      'Invalid toolScope "admin"'
    );
  });
});
