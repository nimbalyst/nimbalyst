// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createPersonalSyncWriteGate, describePersonalSyncWriteGate } from '../personalSyncWriteGate';

describe('personal-sync write gate', () => {
  it('opens only on a verified read, closes on a key failure, and reopens on the next clean read', () => {
    const gate = createPersonalSyncWriteGate();
    const seen = vi.fn();
    gate.onChange(seen);

    expect(gate.canWrite()).toBe(false);
    gate.markVerified();
    expect(gate.canWrite()).toBe(true);
    gate.markBlocked('decryption-failed', 'row s1 unreadable');
    expect(gate.canWrite()).toBe(false);
    expect(gate.snapshot()).toEqual({ state: 'blocked', reason: 'decryption-failed', detail: 'row s1 unreadable' });
    // Same block again is not a change.
    gate.markBlocked('decryption-failed', 'row s1 unreadable');
    gate.markVerified();
    expect(gate.canWrite()).toBe(true);
    expect(seen).toHaveBeenCalledTimes(3);
  });

  it('keeps an update requirement in place across clean reads and bounds the detail', () => {
    const gate = createPersonalSyncWriteGate();
    gate.markVerified();
    gate.markBlocked('update-required', 'x'.repeat(1000));
    gate.markVerified();
    expect(gate.snapshot().state).toBe('blocked');
    expect(gate.snapshot().detail).toHaveLength(300);
    expect(describePersonalSyncWriteGate(gate.snapshot())).toMatch(/^Update Nimbalyst/);
    expect(describePersonalSyncWriteGate({ state: 'verified', reason: null, detail: null })).toBeNull();
    expect(describePersonalSyncWriteGate({ state: 'blocked', reason: 'decryption-failed', detail: null })).toMatch(/cannot read/);
  });
});
