import { describe, it, expect } from 'vitest';
import { CLAUDE_CODE_VARIANTS, ModelIdentifier } from '@nimbalyst/runtime/ai/server/types';
import {
  DEFAULT_CLAUDE_CODE_MODELS,
  claudeCodeCatalogModelIds,
  reconcileClaudeCodeModels,
} from '../claudeCodeModelReconcile';

/**
 * Guards against the drift that hid Fable 5 and sonnet-4-6 from the Claude Code
 * model picker (NIM-1486): the default enabled list and the back-fill logic must
 * stay in lockstep with the catalog source of truth (`CLAUDE_CODE_VARIANTS`).
 */
describe('claude-code model reconciliation', () => {
  const idOf = (v: string) => ModelIdentifier.create('claude-code', v).combined;

  it('default enabled list covers every shipped variant', () => {
    for (const variant of CLAUDE_CODE_VARIANTS) {
      expect(DEFAULT_CLAUDE_CODE_MODELS).toContain(idOf(variant));
    }
    // ...including the two that were previously missing.
    expect(DEFAULT_CLAUDE_CODE_MODELS).toContain('claude-code:fable');
    expect(DEFAULT_CLAUDE_CODE_MODELS).toContain('claude-code:sonnet-4-6');
  });

  it('back-fills a variant that shipped before this snapshot existed (undefined known)', () => {
    // Simulates an existing user whose saved list predates fable/sonnet-4-6.
    const legacy = [
      'claude-code:opus',
      'claude-code:opus-4-7',
      'claude-code:opus-4-6',
      'claude-code:sonnet',
      'claude-code:haiku',
    ];
    const result = reconcileClaudeCodeModels(legacy, undefined);
    expect(result.changed).toBe(true);
    expect(result.models).toContain('claude-code:fable');
    expect(result.models).toContain('claude-code:sonnet-4-6');
    // Existing entries are preserved.
    for (const id of legacy) expect(result.models).toContain(id);
    // Snapshot now records the full catalog.
    expect(result.known).toEqual(expect.arrayContaining(claudeCodeCatalogModelIds()));
  });

  it('does not re-add a variant the user deliberately removed (already known)', () => {
    // fable is known (previously reconciled) but the user turned it off.
    const known = claudeCodeCatalogModelIds();
    const withoutFable = known.filter((id) => id !== 'claude-code:fable');
    const result = reconcileClaudeCodeModels(withoutFable, known);
    expect(result.changed).toBe(false);
    expect(result.models).not.toContain('claude-code:fable');
  });

  it('is a no-op for a fresh install already holding the full catalog', () => {
    const result = reconcileClaudeCodeModels(
      [...DEFAULT_CLAUDE_CODE_MODELS],
      undefined,
    );
    expect(result.changed).toBe(false);
  });

  it('enables a hypothetical future variant without code changes', () => {
    // A variant not yet in the catalog snapshot is treated as new.
    const catalog = [...claudeCodeCatalogModelIds(), 'claude-code:zeta'];
    const current = [...claudeCodeCatalogModelIds()];
    const known = claudeCodeCatalogModelIds();
    const result = reconcileClaudeCodeModels(current, known, catalog);
    expect(result.changed).toBe(true);
    expect(result.models).toContain('claude-code:zeta');
  });
});
