// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import {
  behavesAsVariantForModelId,
  resolveClaudeModelPicker,
  setClaudeModelPickerSource,
  variantForBehavesAs,
  withClaudeCustomModels,
} from '../claudeCustomModels';
import type { AIModel } from '../server/types';

const builtIns: AIModel[] = [{ id: 'claude-code:opus', name: 'Claude Agent · Opus 5.5', provider: 'claude-code' }];

describe('resolveClaudeModelPicker', () => {
  it('takes the highest-precedence modelPicker wholesale and drops unusable entries', () => {
    const user = { modelPicker: { options: [{ model: 'UserOnly' }], replaceBuiltInOptions: true } };
    const project = {
      modelPicker: {
        options: [{ model: 'Fast', label: 'Fast Combo', behavesAs: 'claude-opus-4-8' }, { model: '  ' }, { label: 'no model' }, { model: 'Fast' }],
      },
    };
    const picker = resolveClaudeModelPicker([user, project, { env: {} }]);
    expect(picker.options).toEqual([{ model: 'Fast', label: 'Fast Combo', description: undefined, behavesAs: 'claude-opus-4-8' }]);
    expect(picker.replaceBuiltInOptions).toBe(false);
  });

  it('never hides built-ins when there is nothing to replace them with', () => {
    expect(resolveClaudeModelPicker([{ modelPicker: { options: [], replaceBuiltInOptions: true } }]).replaceBuiltInOptions).toBe(false);
  });
});

describe('withClaudeCustomModels', () => {
  afterEach(() => setClaudeModelPickerSource(null));

  it('adds custom rows ahead of built-ins, or replaces them, using behavesAs for capabilities', async () => {
    setClaudeModelPickerSource(async () => ({
      options: [{ model: 'Fast', label: 'Fast Combo', behavesAs: 'claude-opus-4-8' }, { model: 'Plain' }],
      replaceBuiltInOptions: false,
    }));
    const models = await withClaudeCustomModels('claude-code-cli', builtIns, '/ws');
    expect(models.map((m) => m.id)).toEqual(['claude-code-cli:custom/Fast', 'claude-code-cli:custom/Plain', 'claude-code:opus']);
    expect(models[0]).toMatchObject({ name: 'Claude Code CLI · Fast Combo', contextWindow: 1_000_000, behavesAs: 'claude-opus-4-8' });
    expect(models[1].contextWindow).toBe(200_000);
    expect(behavesAsVariantForModelId('claude-code:custom/Fast')).toBe('opus-4-8');
    expect(behavesAsVariantForModelId('claude-code:custom/Plain')).toBeUndefined();

    setClaudeModelPickerSource(async () => ({ options: [{ model: 'Smart' }], replaceBuiltInOptions: true }));
    expect((await withClaudeCustomModels('claude-code', builtIns, '/ws')).map((m) => m.id)).toEqual(['claude-code:custom/Smart']);
  });

  it('maps behavesAs ids to built-in variants', () => {
    expect(variantForBehavesAs('claude-sonnet-5-5')).toBe('sonnet');
    expect(variantForBehavesAs('claude-haiku-5-5')).toBe('haiku');
    expect(variantForBehavesAs('claude-haiku-4-5-20251001')).toBe('haiku-4-5');
    expect(variantForBehavesAs('gpt-5')).toBeUndefined();
  });
});
