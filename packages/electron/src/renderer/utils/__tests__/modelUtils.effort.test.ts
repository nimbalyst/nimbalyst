// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { getClaudeCodeModelLabel, getClaudeCodeModelShortLabel, supportsEffortLevel } from '../modelUtils';
import { registerClaudeCustomModelsFromCatalog } from '@nimbalyst/runtime/ai/claudeCustomModels';

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
    'claude-code:haiku',
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
    'claude-code:haiku-4-5',
    'claude-code:unknown',
    'claude:claude-fable-5',
  ])('does not expose effort for unsupported models: %s', (modelId) => {
    expect(supportsEffortLevel(modelId)).toBe(false);
  });
});

describe('custom Claude gateway models', () => {
  it('take their label from the catalog and their capabilities from behavesAs', () => {
    registerClaudeCustomModelsFromCatalog([
      { id: 'claude-code:custom/Fast', name: 'Claude Agent · Fast Combo', provider: 'claude-code', behavesAs: 'claude-opus-4-8' },
      { id: 'claude-code:custom/Plain', name: 'Claude Agent · Plain', provider: 'claude-code' },
    ]);
    expect(getClaudeCodeModelLabel('claude-code:custom/Fast')).toBe('Claude Agent · Fast Combo');
    expect(getClaudeCodeModelShortLabel('claude-code:custom/Fast')).toBe('Fast Combo');
    expect(supportsEffortLevel('claude-code:custom/Fast')).toBe(true);
    expect(supportsEffortLevel('claude-code:custom/Plain')).toBe(false);
    expect(getClaudeCodeModelShortLabel('claude-code:custom/Unknown')).toBe('Unknown');
  });
});
