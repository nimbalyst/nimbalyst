// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { resetPushOutcomeWarnings } from '../pushOutcome';
import { createSessionWriteOutbox } from '../sessionWriteOutbox';
import type { PushChangeOutcome, SessionChange } from '../types';

const row = (content: string) => ({ sessionId: 's', source: 'claude-code', direction: 'output' as const, content, createdAt: new Date() });

beforeEach(() => {
  vi.useFakeTimers();
  resetPushOutcomeWarnings();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function fakeProvider() {
  const events: string[] = [];
  const transient: PushChangeOutcome[] = [];
  const provider = {
    connected: false,
    isConnected: () => provider.connected,
    pushChange: vi.fn(async (_id: string, change: SessionChange) => {
      if (change.type === 'message_added') events.push(`live:${change.message.content}`);
      else if (change.type === 'metadata_updated') events.push(`ts:${change.metadata.updatedAt}`);
      return { published: true };
    }),
    sendSessionMessages: vi.fn(async (_id: string, messages: { content: string }[]) => {
      const outcome = transient.shift() ?? { published: true };
      if (outcome.published) events.push(`sent:${messages.map(m => m.content).join(',')}`);
      return outcome;
    }),
  };
  return { provider, events, transient };
}

it('keeps transcript order across batches, backs off on failure, and hands off to a permanent socket', async () => {
  const { provider, events, transient } = fakeProvider();
  const outbox = createSessionWriteOutbox(provider, { coalesceMs: 10, maxBatch: 2, backoffMs: [100] });
  transient.push({ published: false, reason: 'socket closed before the write finished', retryable: true });

  outbox.enqueue(row('a'), 1, 'cap');
  outbox.enqueue(row('b'), 2, 'cap');
  outbox.enqueue(row('c'), 3, 'cap');
  await vi.advanceTimersByTimeAsync(10);
  // The failed attempt sent nothing and published no timestamp.
  expect(events).toEqual([]);
  expect(outbox.hasPending('s')).toBe(true);

  await vi.advanceTimersByTimeAsync(100);
  expect(events).toEqual(['sent:a,b', 'ts:2']);

  // The session got a room socket meanwhile: the rest goes through it, in order.
  provider.connected = true;
  outbox.enqueue(row('d'), 4, 'queued behind earlier unsent messages');
  await vi.advanceTimersByTimeAsync(10);
  expect(events).toEqual(['sent:a,b', 'ts:2', 'live:c', 'live:d', 'ts:4']);
  expect(outbox.hasPending('s')).toBe(false);
});

it('drops a batch the provider refuses for good, still publishing its timestamp, and stops on dispose', async () => {
  const { provider, events, transient } = fakeProvider();
  const outbox = createSessionWriteOutbox(provider, { coalesceMs: 10 });
  transient.push({ published: false, reason: 'filtered from session-room sync', retryable: false });
  outbox.enqueue(row('hidden'), 7, 'cap');
  await vi.advanceTimersByTimeAsync(10);
  expect(events).toEqual(['ts:7']);
  expect(outbox.hasPending('s')).toBe(false);

  outbox.enqueue(row('late'), 8, 'cap');
  outbox.dispose();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(provider.sendSessionMessages).toHaveBeenCalledTimes(1);
});

it('does not lose a row queued while an earlier batch is still publishing its timestamp', async () => {
  const { provider, events } = fakeProvider();
  let releaseTimestamp!: () => void;
  const publishTimestamp = provider.pushChange.getMockImplementation()!;
  provider.pushChange.mockImplementationOnce(async (id, change) => {
    await new Promise<void>(resolve => { releaseTimestamp = resolve; });
    return publishTimestamp(id, change);
  });
  const outbox = createSessionWriteOutbox(provider, { coalesceMs: 10 });

  outbox.enqueue(row('a'), 1, 'cap');
  await vi.advanceTimersByTimeAsync(10);
  expect(events).toEqual(['sent:a']);
  // Rows arriving while the first batch's timestamp is in flight must wait for it, not race it.
  outbox.enqueue(row('b'), 2, 'queued behind earlier unsent messages');
  await vi.advanceTimersByTimeAsync(10);
  outbox.enqueue(row('c'), 3, 'queued behind earlier unsent messages');
  await vi.advanceTimersByTimeAsync(10);
  expect(provider.sendSessionMessages).toHaveBeenCalledTimes(1);

  releaseTimestamp();
  await vi.advanceTimersByTimeAsync(10);
  expect(events).toEqual(['sent:a', 'ts:1', 'sent:b,c', 'ts:3']);
  expect(outbox.hasPending('s')).toBe(false);
});
