import { describe, it, expect, vi, beforeEach } from 'vitest';

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock('../../utils/logger', () => ({
  logger: {
    main: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
  },
}));

import { workspaceAttributionThrottle } from '../WorkspaceAttributionThrottle';

describe('WorkspaceAttributionThrottle', () => {
  let now = 0;

  beforeEach(() => {
    now = 1_000_000;
    workspaceAttributionThrottle.resetForTesting(() => now);
    warn.mockReset();
  });

  it('admits the burst capacity, drops subsequent events, and refills over time', () => {
    const ws = '/workspace';

    // First 20 events in an instant: admitted.
    for (let i = 0; i < 20; i++) {
      expect(workspaceAttributionThrottle.tryAcquire(ws)).toBe(true);
    }

    // 21st event in the same tick: dropped.
    expect(workspaceAttributionThrottle.tryAcquire(ws)).toBe(false);

    // After 100ms (10 tokens refilled at 20/sec): 10 admitted, 11th dropped.
    now += 500; // 500ms -> 10 tokens
    for (let i = 0; i < 10; i++) {
      expect(workspaceAttributionThrottle.tryAcquire(ws)).toBe(true);
    }
    expect(workspaceAttributionThrottle.tryAcquire(ws)).toBe(false);

    // After 1s further: bucket fully refills to capacity (20).
    now += 1_000;
    for (let i = 0; i < 20; i++) {
      expect(workspaceAttributionThrottle.tryAcquire(ws)).toBe(true);
    }
    expect(workspaceAttributionThrottle.tryAcquire(ws)).toBe(false);

    // Throttle warning fires (cooldown means it logs at most once here).
    const warnCalls = warn.mock.calls.filter((call) =>
      String(call[0]).includes('Burst rate exceeded'),
    );
    expect(warnCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('throttles per workspace independently', () => {
    const wsA = '/workspace-a';
    const wsB = '/workspace-b';

    // Drain A's bucket.
    for (let i = 0; i < 20; i++) {
      expect(workspaceAttributionThrottle.tryAcquire(wsA)).toBe(true);
    }
    expect(workspaceAttributionThrottle.tryAcquire(wsA)).toBe(false);

    // B is still full.
    expect(workspaceAttributionThrottle.tryAcquire(wsB)).toBe(true);
  });
});
