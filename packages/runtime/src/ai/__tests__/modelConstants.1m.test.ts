import { describe, it, expect } from 'vitest';
import {
  CLAUDE_CODE_VARIANTS_WITH_1M,
  CLAUDE_CODE_NATIVE_1M_VARIANTS,
  baseContextWindowForVariant,
} from '../modelConstants';

/**
 * The bare CLI aliases and their `[1m]` forms are NOT interchangeable.
 *
 * Measured against Claude Code CLI 2.1.220 via
 * `claude -p --model <alias> --output-format json`, reading
 * `modelUsage[<id>].contextWindow`:
 *
 *   opus          -> claude-opus-5        contextWindow   200000
 *   opus[1m]      -> claude-opus-5[1m]    contextWindow  1000000
 *   fable         -> claude-fable-5       contextWindow   200000
 *   fable[1m]     -> claude-fable-5[1m]   contextWindow  1000000
 *   sonnet[1m]    -> claude-sonnet-5[1m]  contextWindow  1000000
 *   claude-opus-5 -> claude-opus-5        contextWindow   200000
 *
 * Note the last row: even the full Anthropic model id yields 200k. Only the
 * CLI's `[1m]` suffix selects the extended window, so the picker has to offer a
 * distinct row for it. The CLI's own `/model` menu agrees, listing "Opus (1M
 * context)" and "Opus" as separate entries.
 */
describe('Claude Code 1M context variants', () => {
  it('offers a separate 1M row for each current-generation variant', () => {
    expect(CLAUDE_CODE_VARIANTS_WITH_1M).toContain('opus');
    expect(CLAUDE_CODE_VARIANTS_WITH_1M).toContain('fable');
    expect(CLAUDE_CODE_VARIANTS_WITH_1M).toContain('sonnet');
  });

  it('does not offer a 1M row for haiku, which has no extended form', () => {
    expect(CLAUDE_CODE_VARIANTS_WITH_1M).not.toContain('haiku');
  });

  /**
   * `resolveClaudeCliModelArg` collapses every pinned opus variant to the bare
   * `opus` alias, so an `opus-4-7-1m` row would silently run Opus 5 at 1M
   * instead of Opus 4.7. Offering it would be a lie, not a feature.
   */
  it('does not offer 1M rows for pinned legacy variants', () => {
    expect(CLAUDE_CODE_VARIANTS_WITH_1M).not.toContain('opus-4-8');
    expect(CLAUDE_CODE_VARIANTS_WITH_1M).not.toContain('opus-4-7');
    expect(CLAUDE_CODE_VARIANTS_WITH_1M).not.toContain('opus-4-6');
    expect(CLAUDE_CODE_VARIANTS_WITH_1M).not.toContain('sonnet-4-6');
  });

  it('seeds the bare rows at 200k, matching what the CLI actually reports', () => {
    expect(baseContextWindowForVariant('opus')).toBe(200_000);
    expect(baseContextWindowForVariant('fable')).toBe(200_000);
    expect(baseContextWindowForVariant('sonnet')).toBe(200_000);
    expect(baseContextWindowForVariant('haiku')).toBe(200_000);
  });

  it('treats no bare variant as natively 1M', () => {
    expect(CLAUDE_CODE_NATIVE_1M_VARIANTS).toHaveLength(0);
  });
});
