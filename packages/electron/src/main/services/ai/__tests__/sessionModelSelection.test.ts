import { describe, expect, it } from 'vitest';
import { ModelIdentifier } from '@nimbalyst/runtime/ai/server/types';
import { resolveSessionModelSelection } from '../sessionModelSelection';

describe('resolveSessionModelSelection', () => {
  it('derives the provider from a provider-qualified Codex model', () => {
    expect(resolveSessionModelSelection('claude-code', 'openai-codex:gpt-5.6-sol')).toEqual({
      provider: 'openai-codex',
      model: 'openai-codex:gpt-5.6-sol',
    });
  });

  it('keeps a matching Claude provider and model', () => {
    expect(resolveSessionModelSelection('claude-code', 'claude-code:sonnet')).toEqual({
      provider: 'claude-code',
      model: 'claude-code:sonnet',
    });
  });

  it('uses the requested provider default when no model is provided', () => {
    const selection = resolveSessionModelSelection('openai-codex');

    expect(selection.provider).toBe('openai-codex');
    expect(selection.model).toBe(ModelIdentifier.getDefaultModelId('openai-codex'));
  });
});
