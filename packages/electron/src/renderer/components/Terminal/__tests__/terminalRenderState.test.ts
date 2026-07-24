import { describe, expect, it } from 'vitest';
import { canPersistTerminalRenderState } from '../terminalRenderState';

describe('canPersistTerminalRenderState', () => {
  it('rejects the transient terminal state before restore completes', () => {
    expect(canPersistTerminalRenderState(true, false, false)).toBe(false);
  });

  it('allows persistence after the restore baseline is established', () => {
    expect(canPersistTerminalRenderState(true, false, true)).toBe(true);
  });

  it('rejects persistence after disposal', () => {
    expect(canPersistTerminalRenderState(true, true, true)).toBe(false);
  });
});
