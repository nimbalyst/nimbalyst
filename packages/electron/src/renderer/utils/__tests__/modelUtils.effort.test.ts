import { describe, expect, it } from 'vitest';
import { supportsEffortLevel } from '../modelUtils';

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
