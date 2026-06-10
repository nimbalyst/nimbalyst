/**
 * Unit tests for importedClaudeCodeModel - the helper that derives a
 * Nimbalyst model id from the raw per-turn model on imported Claude Code
 * entries. Before this, imported sessions had no model and the renderer
 * fell back to Sonnet, so an Opus session displayed as Sonnet (#394).
 */

import { describe, it, expect } from 'vitest';
import { importedClaudeCodeModel } from '../ClaudeCodeSessionSync';
import type { ClaudeCodeEntry } from '../ClaudeCodeSessionScanner';

function assistant(model: string | undefined): ClaudeCodeEntry {
  return { type: 'assistant', message: model === undefined ? {} : { model } };
}

describe('importedClaudeCodeModel', () => {
  it('maps an opus turn to claude-code:opus', () => {
    expect(importedClaudeCodeModel([assistant('claude-opus-4-7')])).toBe(
      'claude-code:opus',
    );
  });

  it('maps a fable turn to claude-code:fable-5', () => {
    // A genuine-CLI session run on claude-fable-5 must import as Fable, not fall
    // through to the Opus default (the #394 bug class, for the flagship variant).
    expect(importedClaudeCodeModel([assistant('claude-fable-5')])).toBe(
      'claude-code:fable-5',
    );
  });

  it('maps a sonnet turn to claude-code:sonnet', () => {
    expect(importedClaudeCodeModel([assistant('claude-sonnet-4-6')])).toBe(
      'claude-code:sonnet',
    );
  });

  it('maps a haiku turn to claude-code:haiku', () => {
    expect(importedClaudeCodeModel([assistant('claude-haiku-4-5-20251001')])).toBe(
      'claude-code:haiku',
    );
  });

  it('uses the most recent recognizable turn when models differ', () => {
    // A session that started on Sonnet and switched to Opus should report Opus.
    const entries = [assistant('claude-sonnet-4-6'), assistant('claude-opus-4-7')];
    expect(importedClaudeCodeModel(entries)).toBe('claude-code:opus');
  });

  it('skips entries that carry no model (user / tool turns)', () => {
    const entries: ClaudeCodeEntry[] = [
      { type: 'user', message: { role: 'user', content: 'hi' } },
      assistant('claude-opus-4-7'),
      { type: 'user', message: { role: 'user', content: 'thanks' } },
    ];
    expect(importedClaudeCodeModel(entries)).toBe('claude-code:opus');
  });

  it('returns undefined for an empty session', () => {
    expect(importedClaudeCodeModel([])).toBeUndefined();
  });

  it('returns undefined when no turn has a model', () => {
    const entries: ClaudeCodeEntry[] = [
      { type: 'user', message: { role: 'user', content: 'hi' } },
      assistant(undefined),
    ];
    expect(importedClaudeCodeModel(entries)).toBeUndefined();
  });

  it('returns undefined for an unrecognized model id (caller defaults it)', () => {
    expect(importedClaudeCodeModel([assistant('some-future-model')])).toBeUndefined();
  });

  it('ignores an empty-string model', () => {
    expect(importedClaudeCodeModel([assistant('')])).toBeUndefined();
  });
});
