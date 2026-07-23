import { describe, expect, it } from 'vitest';
import { supportsEffortLevel } from '../modelUtils';

describe('supportsEffortLevel', () => {
  it.each([
    'claude-code:opus',
    'claude-code:opus-4-6',
    'claude-code:sonnet',
    'claude-code:fable',
    'claude-code:opus-4-7',
    'claude-code:sonnet-4-6',
  ])('supports current Claude Code effort-capable variants: %s', (modelId) => {
    expect(supportsEffortLevel(modelId)).toBe(true);
  });

  it('supports effort for the Codex SDK transport', () => {
    const modelId = 'openai-codex:gpt-5.4';
    expect(supportsEffortLevel(modelId)).toBe(true);
  });

  it.each([
    undefined,
    'claude-code:haiku',
    'claude-code-cli:fable',
    'claude-code-cli:opus-4-7',
    'claude-code:unknown',
    'claude:claude-fable-5',
    'openai-codex-acp:gpt-5.4',
  ])('does not expose effort for unsupported models: %s', (modelId) => {
    expect(supportsEffortLevel(modelId)).toBe(false);
  });
});
