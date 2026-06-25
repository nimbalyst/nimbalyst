import { describe, expect, it } from 'vitest';
import { resolveCodexServiceTier } from '../codexFastMode';

describe('resolveCodexServiceTier', () => {
  it('uses the global provider default when the session has no override', () => {
    expect(resolveCodexServiceTier(undefined, true)).toBe('fast');
    expect(resolveCodexServiceTier(null, false)).toBeUndefined();
  });

  it('lets the session override enable or disable Fast mode', () => {
    expect(resolveCodexServiceTier(true, false)).toBe('fast');
    expect(resolveCodexServiceTier(false, true)).toBeUndefined();
  });
});

