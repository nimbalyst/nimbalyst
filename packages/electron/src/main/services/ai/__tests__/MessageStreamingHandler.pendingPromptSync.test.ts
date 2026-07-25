import { describe, expect, it } from 'vitest';
import { hasPersistedPendingPrompt } from '../MessageStreamingHandler';

describe('MessageStreamingHandler terminal structured-prompt projection', () => {
  it.each(['normal completion', 'error completion'])(
    '%s retains the durable pending prompt bit for its queue and sync fences',
    () => {
      expect(hasPersistedPendingPrompt({ hasPendingPrompt: true })).toBe(true);
      expect(hasPersistedPendingPrompt({ hasPendingPrompt: false })).toBe(false);
    },
  );

  it('does not fence a cancelled or absent prompt', () => {
    expect(hasPersistedPendingPrompt({ cancelled: true })).toBe(false);
    expect(hasPersistedPendingPrompt(null)).toBe(false);
  });
});
