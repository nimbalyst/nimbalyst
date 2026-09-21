// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { NativeFileEventQueue } from '../NativeFileEventQueue';

it('coalesces a duplicate burst without reversing final add/unlink order or losing its observation boundary', async () => {
  const deliver = vi.fn(), fail = vi.fn();
  const queue = new NativeFileEventQueue(() => true, deliver, fail);
  for (let i = 0; i < 128; i++) queue.push('change', `/file-${i}`);
  queue.push('add', '/replaced');
  queue.push('unlink', '/replaced');
  const beforeDuplicate = Date.now();
  for (let i = 0; i < 20_000; i++) queue.push('add', '/replaced');
  await queue.drain();
  expect(fail).not.toHaveBeenCalled();
  const replacements = deliver.mock.calls.filter(([, file]) => file === '/replaced');
  expect(replacements.map(([type]) => type)).toEqual(['unlink', 'add']);
  expect(replacements[1][2]).toBeLessThanOrEqual(beforeDuplicate);
});

it('reports actual bounded backlog loss once and resolves drains without publishing retired events', async () => {
  let current = true;
  const deliver = vi.fn(), fail = vi.fn(() => { current = false; });
  const queue = new NativeFileEventQueue(() => current, deliver, fail);
  for (let i = 0; i < 128; i++) queue.push('change', `/prefix-${i}`);
  for (let i = 0; i < 16_500; i++) queue.push('change', `/burst-${i}`);
  const count = deliver.mock.calls.length;
  await queue.drain();
  await new Promise(resolve => setImmediate(resolve));
  expect(fail).toHaveBeenCalledExactlyOnceWith('event_queue_overflow');
  expect(deliver).toHaveBeenCalledTimes(count);
});
