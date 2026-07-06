import { describe, it, expect } from 'vitest';
import { CLAUDE_CODE_VARIANTS, ModelIdentifier } from '@nimbalyst/runtime/ai/server/types';
import { isModelEnabled } from '../modelEnablementFilter';

/**
 * The gate that once hid Fable 5 from the picker (NIM-1486). These lock in the
 * "can't happen again" invariant: an empty/undefined allow-list shows every
 * shipped variant, and the family conveniences (sentinel, -1m) work for the CLI
 * provider too — not just the SDK provider.
 */
describe('isModelEnabled', () => {
  const id = (provider: string, v: string) => ModelIdentifier.create(provider as any, v).combined;

  it('disabled provider hides everything', () => {
    expect(isModelEnabled({ id: 'claude-code:fable', provider: 'claude-code' }, { enabled: false })).toBe(false);
  });

  it('empty allow-list shows every shipped variant (incl. fable) for both families', () => {
    for (const provider of ['claude-code', 'claude-code-cli']) {
      for (const variant of CLAUDE_CODE_VARIANTS) {
        const base = { id: id(provider, variant), provider };
        expect(isModelEnabled(base, { enabled: true })).toBe(true); // undefined list
        expect(isModelEnabled(base, { enabled: true, models: [] })).toBe(true); // empty list
        // ...and the 1M row.
        const oneM = { id: id(provider, `${variant}-1m`), provider };
        expect(isModelEnabled(oneM, { enabled: true, models: [] })).toBe(true);
      }
    }
  });

  it('a non-empty list still restricts to listed ids', () => {
    const entry = { enabled: true, models: ['claude-code:opus'] };
    expect(isModelEnabled({ id: 'claude-code:opus', provider: 'claude-code' }, entry)).toBe(true);
    expect(isModelEnabled({ id: 'claude-code:fable', provider: 'claude-code' }, entry)).toBe(false);
  });

  it('selecting a base variant also surfaces its 1M row — for the CLI provider too', () => {
    // Regression: the old inline filter special-cased only `claude-code`, so a
    // claude-code-cli allow-list would have dropped the -1m row.
    const entry = { enabled: true, models: ['claude-code-cli:sonnet'] };
    expect(isModelEnabled({ id: 'claude-code-cli:sonnet', provider: 'claude-code-cli' }, entry)).toBe(true);
    expect(isModelEnabled({ id: 'claude-code-cli:sonnet-1m', provider: 'claude-code-cli' }, entry)).toBe(true);
  });

  it('the provider-id sentinel means "all of this provider" for both families', () => {
    expect(
      isModelEnabled({ id: 'claude-code:fable', provider: 'claude-code' }, { enabled: true, models: ['claude-code'] }),
    ).toBe(true);
    expect(
      isModelEnabled(
        { id: 'claude-code-cli:fable', provider: 'claude-code-cli' },
        { enabled: true, models: ['claude-code-cli'] },
      ),
    ).toBe(true);
  });
});
