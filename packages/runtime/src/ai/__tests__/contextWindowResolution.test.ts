import { describe, it, expect } from 'vitest';
import {
  resolveClaudeCodeParentContextWindow,
  claudeCodeFamilyKeyword,
  baseContextWindowForVariant,
} from '../modelConstants';

/**
 * GitHub #825 / NIM-1660 — the context meter divided a real token fill by a
 * hardcoded 200k ceiling, producing impossible ">100%" readings on models that
 * actually run a 1M window. These tests pin the parent-window resolution that
 * replaces the hardcode: read the CLI-reported per-model window, deterministically
 * selecting the PARENT model's entry (never a sub-agent's smaller window).
 */
describe('resolveClaudeCodeParentContextWindow', () => {
  it('returns the parent 1M window, not the Haiku sub-agent 200k, regardless of map order', () => {
    // A plain `opus` turn that spawned a Haiku sub-agent. Before the fix the
    // meter used a hardcoded 200k; the real parent window is 1M.
    const parentFirst = {
      'claude-opus-4-8': { contextWindow: 1_000_000 },
      'claude-haiku-4-5-20251001': { contextWindow: 200_000 },
    };
    const subagentFirst = {
      'claude-haiku-4-5-20251001': { contextWindow: 200_000 },
      'claude-opus-4-8': { contextWindow: 1_000_000 },
    };
    expect(resolveClaudeCodeParentContextWindow('claude-code:opus', parentFirst)).toBe(1_000_000);
    expect(resolveClaudeCodeParentContextWindow('claude-code:opus', subagentFirst)).toBe(1_000_000);
  });

  it('resolves plain fable and sonnet parents to 1M', () => {
    expect(
      resolveClaudeCodeParentContextWindow('claude-code:fable', {
        'claude-fable-5': { contextWindow: 1_000_000 },
        'claude-haiku-4-5-20251001': { contextWindow: 200_000 },
      }),
    ).toBe(1_000_000);
    expect(
      resolveClaudeCodeParentContextWindow('claude-code:sonnet', {
        'claude-sonnet-5': { contextWindow: 1_000_000 },
      }),
    ).toBe(1_000_000);
  });

  it('handles a stored -1m id (hide-but-valid) by resolving the same parent window', () => {
    expect(
      resolveClaudeCodeParentContextWindow('claude-code:opus-1m', {
        'claude-opus-4-8': { contextWindow: 1_000_000 },
      }),
    ).toBe(1_000_000);
  });

  it('returns a genuinely-Haiku session at 200k (its own window, not another entry)', () => {
    expect(
      resolveClaudeCodeParentContextWindow('claude-code:haiku', {
        'claude-haiku-4-5-20251001': { contextWindow: 200_000 },
      }),
    ).toBe(200_000);
  });

  it('falls back to undefined when no usable window is present (caller uses the registry seed)', () => {
    expect(resolveClaudeCodeParentContextWindow('claude-code:opus', undefined)).toBeUndefined();
    expect(resolveClaudeCodeParentContextWindow('claude-code:opus', {})).toBeUndefined();
    expect(
      resolveClaudeCodeParentContextWindow('claude-code:opus', {
        'claude-opus-4-8': { contextWindow: 0 },
        'claude-haiku-4-5-20251001': undefined,
      }),
    ).toBeUndefined();
  });

  it('when the family cannot be matched, takes the largest reported window (parent >= sub-agent)', () => {
    // Unknown/unclassifiable session id, but usage still carries the real windows.
    expect(
      resolveClaudeCodeParentContextWindow('mystery:model', {
        'claude-opus-4-8': { contextWindow: 1_000_000 },
        'claude-haiku-4-5-20251001': { contextWindow: 200_000 },
      }),
    ).toBe(1_000_000);
  });
});

describe('claudeCodeFamilyKeyword', () => {
  it('collapses variants to their family for modelUsage-key matching', () => {
    expect(claudeCodeFamilyKeyword('claude-code:opus')).toBe('opus');
    expect(claudeCodeFamilyKeyword('claude-code:opus-1m')).toBe('opus');
    expect(claudeCodeFamilyKeyword('claude-code:opus-4-6')).toBe('opus');
    expect(claudeCodeFamilyKeyword('claude-code-cli:fable')).toBe('fable');
    expect(claudeCodeFamilyKeyword('claude-code:sonnet-4-6')).toBe('sonnet');
    expect(claudeCodeFamilyKeyword('claude-code:haiku')).toBe('haiku');
  });
  it('returns undefined for unclassifiable ids', () => {
    expect(claudeCodeFamilyKeyword(undefined)).toBeUndefined();
    expect(claudeCodeFamilyKeyword('openai:gpt-5.6-sol')).toBeUndefined();
  });
});

describe('baseContextWindowForVariant', () => {
  it('reports 1M for all 1M variants (current-gen + legacy pinned) and 200k for haiku', () => {
    expect(baseContextWindowForVariant('opus')).toBe(1_000_000);
    expect(baseContextWindowForVariant('fable')).toBe(1_000_000);
    expect(baseContextWindowForVariant('sonnet')).toBe(1_000_000);
    // Legacy pinned variants are 1M too — single row, no redundant -1m duplicate.
    expect(baseContextWindowForVariant('opus-4-6')).toBe(1_000_000);
    expect(baseContextWindowForVariant('opus-4-7')).toBe(1_000_000);
    expect(baseContextWindowForVariant('sonnet-4-6')).toBe(1_000_000);
    expect(baseContextWindowForVariant('haiku')).toBe(200_000);
  });
});
