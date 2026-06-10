import { describe, it, expect } from 'vitest';
import { ClaudeCodeProvider } from '../ClaudeCodeProvider';

/**
 * The Claude Code picker is sourced from `ClaudeCodeProvider.getModels()`
 * filtered by the user's enabled-models list. These cases lock in that the
 * catalog actually produces the Fable 5 rows the picker needs, in the right
 * order. Without them, the variant could resolve correctly yet never appear.
 */
describe('ClaudeCodeProvider.getModels — Fable 5 catalog rows', () => {
  it('emits standard and 1M Fable 5 rows', async () => {
    const ids = (await ClaudeCodeProvider.getModels()).map((m) => m.id);
    expect(ids).toContain('claude-code:fable-5');
    expect(ids).toContain('claude-code:fable-5-1m');
  });

  it('orders Fable 5 ahead of opus (flagship first)', async () => {
    const ids = (await ClaudeCodeProvider.getModels()).map((m) => m.id);
    expect(ids.indexOf('claude-code:fable-5')).toBeLessThan(ids.indexOf('claude-code:opus'));
  });

  it('labels the rows "Fable 5" and "Fable 5 (1M)"', async () => {
    const models = await ClaudeCodeProvider.getModels();
    const base = models.find((m) => m.id === 'claude-code:fable-5');
    const extended = models.find((m) => m.id === 'claude-code:fable-5-1m');
    expect(base?.name).toContain('Fable 5');
    expect(base?.contextWindow).toBe(200000);
    expect(extended?.name).toContain('Fable 5');
    expect(extended?.name).toContain('(1M)');
    expect(extended?.contextWindow).toBe(1000000);
  });
});
