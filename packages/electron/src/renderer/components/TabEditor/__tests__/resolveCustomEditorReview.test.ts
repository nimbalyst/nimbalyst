// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { resolveCustomEditorReview } from '../resolveCustomEditorReview';

it('exits a committed review before ancillary history fails, using captured bytes and session', async () => {
  const calls: string[] = [];
  const recordHistory = vi.fn(async () => { calls.push('history'); throw new Error('snapshot failed'); });
  await expect(resolveCustomEditorReview({
    accepted: true, generation: 7, content: 'accepted CSV', sessionId: 'original-session',
    resolve: vi.fn(async () => { calls.push('committed'); return true; }),
    clear: () => calls.push('cleared'), recordHistory,
  })).rejects.toThrow('snapshot failed');
  expect(calls).toEqual(['committed', 'cleared', 'history']);
  expect(recordHistory).toHaveBeenCalledWith('accepted CSV', 'original-session', true);
});

it.each([false, true])('leaves review intact when decision %s is refused', async accepted => {
  const clear = vi.fn();
  const recordHistory = vi.fn();
  const resolve = vi.fn(async () => false);
  await resolveCustomEditorReview({ accepted, generation: 8, content: 'CSV', sessionId: 'session', resolve, clear, recordHistory });
  expect(resolve).toHaveBeenCalledWith(accepted, { generation: 8 });
  expect(clear).not.toHaveBeenCalled();
  expect(recordHistory).not.toHaveBeenCalled();
});
