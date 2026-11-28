// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { NativeFileEventQueue } from '../NativeFileEventQueue';

/** The lifecycle's reporter: a call is a native failure, its methods a backlog overflow. */
function reporter() {
  return Object.assign(vi.fn(), { overflowed: vi.fn(), resynced: vi.fn() });
}

it('coalesces a duplicate burst without reversing final add/unlink order or losing its observation boundary', async () => {
  const deliver = vi.fn(), fail = reporter();
  const queue = new NativeFileEventQueue(() => true, deliver, fail);
  for (let i = 0; i < 128; i++) queue.push('change', `/file-${i}`);
  queue.push('add', '/replaced');
  queue.push('unlink', '/replaced');
  const beforeDuplicate = Date.now();
  for (let i = 0; i < 20_000; i++) queue.push('add', '/replaced');
  await queue.drain();
  expect(fail).not.toHaveBeenCalled();
  expect(fail.overflowed).not.toHaveBeenCalled();
  const replacements = deliver.mock.calls.filter(([, file]) => file === '/replaced');
  expect(replacements.map(([type]) => type)).toEqual(['unlink', 'add']);
  expect(replacements[1][2]).toBeLessThanOrEqual(beforeDuplicate);
});

it('C1: drops an overflowed backlog once without failing, keeps delivering later pushes in order, and resolves earlier drains', async () => {
  const deliver = vi.fn(), fail = reporter();
  const queue = new NativeFileEventQueue(() => true, deliver, fail);
  for (let i = 0; i < 128; i++) queue.push('change', `/prefix-${i}`);
  for (let i = 0; i < 1000; i++) queue.push('change', `/burst-${i}`);
  let drainedBeforeDrop = false;
  void queue.drain().then(() => { drainedBeforeDrop = true; });
  for (let i = 1000; i < 16_500; i++) queue.push('change', `/burst-${i}`);
  expect(fail.overflowed).toHaveBeenCalledExactlyOnceWith(16_384);
  const afterDrop = deliver.mock.calls.length;
  queue.push('add', '/after-drop');
  await null; await null;
  // The drop released the earlier drain before anything after it was delivered.
  expect(drainedBeforeDrop).toBe(true);
  expect(deliver).toHaveBeenCalledTimes(afterDrop);
  await queue.drain();
  expect(fail).not.toHaveBeenCalled();
  expect(fail.resynced).toHaveBeenCalledOnce();
  const later = deliver.mock.calls.slice(afterDrop).map(([, file]) => file);
  // Everything pushed after the drop arrives, in push order; nothing dropped reappears.
  const firstLater = Number(later[0].slice('/burst-'.length));
  expect(later).toEqual([...Array.from({ length: 16_500 - firstLater }, (_, i) => `/burst-${firstLater + i}`), '/after-drop']);
  expect(deliver.mock.calls.length + 16_384).toBe(128 + 16_500 + 1);
});

it('C3: a second overflow before the backlog is delivered drops again but resyncs once, after the queue empties', async () => {
  const deliver = vi.fn(), fail = reporter();
  const queue = new NativeFileEventQueue(() => true, deliver, fail);
  for (let i = 0; i < 128; i++) queue.push('change', `/prefix-${i}`);
  for (let i = 0; i < 16_500; i++) queue.push('change', `/first-${i}`);
  for (let i = 0; i < 16_500; i++) queue.push('change', `/second-${i}`);
  expect(fail.overflowed.mock.calls).toEqual([[16_384], [16_384]]);
  expect(fail.resynced).not.toHaveBeenCalled();
  let deliveredAtResync = -1;
  fail.resynced.mockImplementation(() => { deliveredAtResync = deliver.mock.calls.length; });
  await queue.drain();
  expect(fail.resynced).toHaveBeenCalledOnce();
  expect(deliveredAtResync).toBe(deliver.mock.calls.length);
  expect(deliver.mock.calls.at(-1)?.[1]).toBe('/second-16499');
  expect(fail).not.toHaveBeenCalled();
});

it('neither delivers nor resyncs the backlog of a handle that was retired during an overflow', async () => {
  let current = true;
  const deliver = vi.fn(), fail = reporter();
  fail.overflowed.mockImplementation(() => { current = false; });
  const queue = new NativeFileEventQueue(() => current, deliver, fail);
  for (let i = 0; i < 128; i++) queue.push('change', `/prefix-${i}`);
  for (let i = 0; i < 16_500; i++) queue.push('change', `/burst-${i}`);
  const count = deliver.mock.calls.length;
  await queue.drain();
  await new Promise(resolve => setImmediate(resolve));
  expect(fail.overflowed).toHaveBeenCalledOnce();
  expect(deliver).toHaveBeenCalledTimes(count);
  expect(fail.resynced).not.toHaveBeenCalled();
});
