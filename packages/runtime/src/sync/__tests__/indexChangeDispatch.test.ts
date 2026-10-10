// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { createHierarchySnapshotDispatch } from '../indexChangeDispatch';
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('retries failed reconciliation against the latest server snapshot and invalidates stale freshness guards', async () => {
  vi.useFakeTimers();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const dispatch = createHierarchySnapshotDispatch(() => true);
  dispatch.replace([{sessionId: 'child', parentSessionId: 'A'}]);
  const apply = vi.fn().mockRejectedValueOnce(new Error('DB busy')).mockResolvedValue(undefined);
  const unsubscribe = dispatch.subscribe(apply);
  await vi.advanceTimersByTimeAsync(0);
  const olderIsCurrent = apply.mock.calls[0][1];
  expect(olderIsCurrent()).toBe(true);
  dispatch.update({sessionId: 'child', parentSessionId: 'B'});
  expect(olderIsCurrent()).toBe(false);
  await vi.advanceTimersByTimeAsync(5000);
  expect(apply).toHaveBeenCalledTimes(2);
  expect(apply.mock.calls[1][0]).toEqual([{sessionId: 'child', parentSessionId: 'B'}]);
  const newerIsCurrent = apply.mock.calls[1][1];
  dispatch.invalidate();
  expect(newerIsCurrent()).toBe(false);
  unsubscribe();
  await vi.advanceTimersByTimeAsync(5000);
  expect(apply).toHaveBeenCalledTimes(2);
});
