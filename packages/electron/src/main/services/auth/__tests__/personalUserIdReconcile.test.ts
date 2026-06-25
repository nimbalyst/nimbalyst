import { describe, it, expect } from 'vitest';
import { reconcilePersonalUserId } from '../personalUserIdReconcile';

describe('reconcilePersonalUserId (NIM-859)', () => {
  it('overwrites a stale cached id with the authoritative exchange sub', () => {
    const r = reconcilePersonalUserId('member-live-54840568', 'member-live-c35e991d');
    expect(r).toEqual({ personalUserId: 'member-live-c35e991d', changed: true });
  });

  it('reports no change when the cached id already matches the exchange sub', () => {
    const r = reconcilePersonalUserId('member-live-c35e991d', 'member-live-c35e991d');
    expect(r).toEqual({ personalUserId: 'member-live-c35e991d', changed: false });
  });

  it('adopts the exchange sub when nothing was cached', () => {
    const r = reconcilePersonalUserId(null, 'member-live-c35e991d');
    expect(r).toEqual({ personalUserId: 'member-live-c35e991d', changed: true });
  });

  it('keeps the cached id when the exchange yields nothing (offline / failure)', () => {
    const r = reconcilePersonalUserId('member-live-54840568', null);
    expect(r).toEqual({ personalUserId: 'member-live-54840568', changed: false });
  });
});
