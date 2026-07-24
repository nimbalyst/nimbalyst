/**
 * Unit tests for AgentMessageWriteQueue.
 *
 * Covers: per-session ordering, flush triggers (idle / size / explicit),
 * batched-INSERT-failure fallback to per-row writes, idempotent flushAll,
 * batch-event coalescing, multi-row pressure logging.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  AgentMessageWriteQueue,
  type MessagesLoggedBatchEvent,
} from '../AgentMessageWriteQueue';
import type { CreateAgentMessageInput } from '../../../ai/server/types';

function makeMessage(overrides: Partial<CreateAgentMessageInput> = {}): CreateAgentMessageInput {
  return {
    sessionId: 'session-a',
    source: 'claude-code',
    direction: 'output',
    content: 'chunk',
    createdAt: new Date('2026-05-05T00:00:00Z'),
    ...overrides,
  };
}

/**
 * Test writer that records every batch it receives. Optionally fails on the
 * first call so we can exercise the per-row fallback path.
 */
function makeRecordingWriter(opts: { failBatched?: boolean } = {}) {
  const batches: CreateAgentMessageInput[][] = [];
  let calls = 0;
  const writer = vi.fn(async (messages: CreateAgentMessageInput[]) => {
    calls += 1;
    if (opts.failBatched && calls === 1 && messages.length > 1) {
      throw new Error('simulated batched INSERT failure');
    }
    // Defensive copy so later mutations to the input array can't corrupt history.
    batches.push([...messages]);
  });
  return { writer, batches, getCalls: () => calls };
}

describe('AgentMessageWriteQueue — single-row write', () => {
  it('persists a single row through the writer when idle timer fires', async () => {
    const { writer, batches } = makeRecordingWriter();
    const queue = new AgentMessageWriteQueue({ idleFlushMs: 5, writer });

    await queue.enqueue(makeMessage({ content: 'first' }));

    expect(batches.length).toBe(1);
    expect(batches[0].length).toBe(1);
    expect(batches[0][0].content).toBe('first');
  });
});

describe('AgentMessageWriteQueue — FIFO ordering across mixed sessions', () => {
  it('preserves enqueue order in the flushed batch regardless of session', async () => {
    const { writer, batches } = makeRecordingWriter();
    const queue = new AgentMessageWriteQueue({ idleFlushMs: 60_000, writer });

    queue.enqueue(makeMessage({ sessionId: 'A', content: 'a1' }));
    queue.enqueue(makeMessage({ sessionId: 'B', content: 'b1' }));
    queue.enqueue(makeMessage({ sessionId: 'A', content: 'a2' }));
    queue.enqueue(makeMessage({ sessionId: 'B', content: 'b2', direction: 'input' }));
    await queue.flushAll();

    expect(batches.length).toBe(1);
    expect(batches[0].map((m) => `${m.sessionId}:${m.content}`)).toEqual([
      'A:a1', 'B:b1', 'A:a2', 'B:b2',
    ]);
  });
});

describe('AgentMessageWriteQueue — row-threshold flush trigger', () => {
  it('forces a flush at the row threshold without waiting for idle', async () => {
    const { writer, batches } = makeRecordingWriter();
    const queue = new AgentMessageWriteQueue({
      idleFlushMs: 60_000,
      rowFlushThreshold: 3,
      writer,
    });

    queue.enqueue(makeMessage({ content: 'a' }));
    queue.enqueue(makeMessage({ content: 'b' }));
    expect(writer).not.toHaveBeenCalled();

    // 3rd row hits the threshold and should flush immediately.
    await queue.enqueue(makeMessage({ content: 'c' }));

    expect(writer).toHaveBeenCalledTimes(1);
    expect(batches[0].map((m) => m.content)).toEqual(['a', 'b', 'c']);
  });
});

describe('AgentMessageWriteQueue — idle flush', () => {
  it('flushes after the idle window even when below the row threshold', async () => {
    vi.useFakeTimers();
    try {
      const { writer, batches } = makeRecordingWriter();
      const queue = new AgentMessageWriteQueue({
        idleFlushMs: 200,
        rowFlushThreshold: 1000,
        writer,
      });

      const p1 = queue.enqueue(makeMessage({ content: 'idle-1' }));
      const p2 = queue.enqueue(makeMessage({ content: 'idle-2' }));

      expect(writer).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(199);
      expect(writer).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2);
      // Switch back so the awaited promise can resolve via real microtasks.
      vi.useRealTimers();
      await Promise.all([p1, p2]);

      expect(writer).toHaveBeenCalledTimes(1);
      expect(batches[0].length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resets the idle deadline on every enqueue (idle since last enqueue, not first)', async () => {
    vi.useFakeTimers();
    try {
      const { writer } = makeRecordingWriter();
      const queue = new AgentMessageWriteQueue({
        idleFlushMs: 200,
        rowFlushThreshold: 1000,
        writer,
      });

      // Enqueue at t=0, t=150, t=300, t=450, t=600. If the timer were a "deadline
      // from first enqueue" it would fire at t=200 with only the first row. With
      // proper reset semantics it should NOT fire until 200ms after the last
      // enqueue (t=800).
      queue.enqueue(makeMessage({ content: 'r1' }));
      await vi.advanceTimersByTimeAsync(150);
      queue.enqueue(makeMessage({ content: 'r2' }));
      await vi.advanceTimersByTimeAsync(150);
      queue.enqueue(makeMessage({ content: 'r3' }));
      await vi.advanceTimersByTimeAsync(150);
      queue.enqueue(makeMessage({ content: 'r4' }));
      await vi.advanceTimersByTimeAsync(150);
      queue.enqueue(makeMessage({ content: 'r5' }));

      // t=600 now, last enqueue just happened. Writer must not have fired yet.
      expect(writer).not.toHaveBeenCalled();

      // t=799 — still under the idle window since last enqueue.
      await vi.advanceTimersByTimeAsync(199);
      expect(writer).not.toHaveBeenCalled();

      // t=801 — idle window since last enqueue elapsed; flush fires once with all 5 rows.
      await vi.advanceTimersByTimeAsync(2);
      vi.useRealTimers();
      await new Promise((r) => setTimeout(r, 0));

      expect(writer).toHaveBeenCalledTimes(1);
      expect(writer.mock.calls[0][0].length).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('AgentMessageWriteQueue — explicit flushAll', () => {
  it('flushes any pending rows and is idempotent when buffer is empty', async () => {
    const { writer, batches } = makeRecordingWriter();
    const queue = new AgentMessageWriteQueue({ idleFlushMs: 60_000, writer });

    queue.enqueue(makeMessage({ content: 'pending' }));
    await queue.flushAll();

    expect(writer).toHaveBeenCalledTimes(1);
    expect(batches[0][0].content).toBe('pending');

    // Second flushAll should not call the writer again.
    await queue.flushAll();
    expect(writer).toHaveBeenCalledTimes(1);
  });
});

describe('AgentMessageWriteQueue — error fallback', () => {
  it('falls back to per-row inserts when the batched INSERT throws', async () => {
    const { writer } = makeRecordingWriter({ failBatched: true });
    const queue = new AgentMessageWriteQueue({
      idleFlushMs: 60_000,
      writer,
      // Quietly suppress the warn() emitted by the fallback path.
      logger: { warn: () => {} },
    });

    const messages = [
      makeMessage({ content: 'row-1' }),
      makeMessage({ content: 'row-2' }),
      makeMessage({ content: 'row-3' }),
    ];
    const promises = messages.map((m) => queue.enqueue(m));
    await queue.flushAll();
    await Promise.all(promises);

    // 1 batched call (which threw) + 3 per-row calls = 4 total.
    expect(writer).toHaveBeenCalledTimes(4);
    expect(writer.mock.calls[0][0].length).toBe(3); // batched
    expect(writer.mock.calls[1][0].length).toBe(1); // per-row 1
    expect(writer.mock.calls[2][0].length).toBe(1); // per-row 2
    expect(writer.mock.calls[3][0].length).toBe(1); // per-row 3
  });
});

describe('AgentMessageWriteQueue — batch event emission', () => {
  it('emits one event per session per flush, with mixed direction when applicable', async () => {
    const { writer } = makeRecordingWriter();
    const queue = new AgentMessageWriteQueue({ idleFlushMs: 60_000, writer });

    const events: MessagesLoggedBatchEvent[] = [];
    queue.onBatch((e) => events.push(e));

    queue.enqueue(makeMessage({ sessionId: 'A', direction: 'output' }));
    queue.enqueue(makeMessage({ sessionId: 'A', direction: 'input' }));
    queue.enqueue(makeMessage({ sessionId: 'B', direction: 'output' }));
    await queue.flushAll();

    expect(events.length).toBe(2);
    const a = events.find((e) => e.sessionId === 'A')!;
    const b = events.find((e) => e.sessionId === 'B')!;
    expect(a.count).toBe(2);
    expect(a.direction).toBe('mixed');
    expect(b.count).toBe(1);
    expect(b.direction).toBe('output');
  });

  it('counts only visible rows; mixed visible/hidden batch still emits with visible count', async () => {
    const { writer } = makeRecordingWriter();
    const queue = new AgentMessageWriteQueue({ idleFlushMs: 60_000, writer });

    const events: MessagesLoggedBatchEvent[] = [];
    queue.onBatch((e) => events.push(e));

    queue.enqueue(makeMessage({ sessionId: 'A', hidden: false, direction: 'output' }));
    queue.enqueue(makeMessage({ sessionId: 'A', hidden: true, direction: 'output' }));
    queue.enqueue(makeMessage({ sessionId: 'A', hidden: false, direction: 'output' }));
    await queue.flushAll();

    expect(events.length).toBe(1);
    expect(events[0].sessionId).toBe('A');
    expect(events[0].count).toBe(2); // hidden row excluded from count
    expect(events[0].direction).toBe('output');
  });

  it('does NOT emit a session event when all rows for that session are hidden', async () => {
    const { writer } = makeRecordingWriter();
    const queue = new AgentMessageWriteQueue({ idleFlushMs: 60_000, writer });

    const events: MessagesLoggedBatchEvent[] = [];
    queue.onBatch((e) => events.push(e));

    queue.enqueue(makeMessage({ sessionId: 'A', hidden: true }));
    queue.enqueue(makeMessage({ sessionId: 'A', hidden: true }));
    // Session B has visible rows so its event should still emit.
    queue.enqueue(makeMessage({ sessionId: 'B', hidden: false }));
    await queue.flushAll();

    expect(events.length).toBe(1);
    expect(events[0].sessionId).toBe('B');
  });
});

describe('AgentMessageWriteQueue — pressure telemetry', () => {
  it('logs WRITE_QUEUE_PRESSURE when the buffer depth exceeds the threshold', async () => {
    const warnSpy = vi.fn();
    const { writer } = makeRecordingWriter();
    const queue = new AgentMessageWriteQueue({
      idleFlushMs: 60_000,
      rowFlushThreshold: 5,
      pressureDepthThreshold: 4,
      pressureFlushMsThreshold: 60_000, // disable flush-time path
      writer,
      logger: { warn: warnSpy },
    });

    for (let i = 0; i < 5; i++) {
      queue.enqueue(makeMessage({ content: `c${i}` }));
    }
    await queue.flushAll();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('WRITE_QUEUE_PRESSURE');
    expect(warnSpy.mock.calls[0][0]).toContain('depth=5');
  });

  it('does NOT log slow-flush pressure for single-row batches', async () => {
    // Single-row writes contended by unrelated table activity are normal and
    // shouldn't trip the pressure log; only multi-row slow flushes signal a
    // real coalescing problem.
    const warnSpy = vi.fn();
    const writer = vi.fn(async () => {
      // Real-time delay so flushMs comfortably exceeds the threshold.
      await new Promise<void>((r) => setTimeout(r, 30));
    });
    const queue = new AgentMessageWriteQueue({
      idleFlushMs: 5,
      pressureDepthThreshold: 1000,
      pressureFlushMsThreshold: 1, // very low so any real-time delay would trip on a multi-row batch
      writer,
      logger: { warn: warnSpy },
    });

    await queue.enqueue(makeMessage({ content: 'lonely' }));

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('DOES log slow-flush pressure for multi-row batches that exceed the threshold', async () => {
    const warnSpy = vi.fn();
    const writer = vi.fn(async () => {
      await new Promise<void>((r) => setTimeout(r, 30));
    });
    const queue = new AgentMessageWriteQueue({
      idleFlushMs: 60_000,
      rowFlushThreshold: 2,
      pressureDepthThreshold: 1000,
      pressureFlushMsThreshold: 1,
      writer,
      logger: { warn: warnSpy },
    });

    queue.enqueue(makeMessage({ content: 'a' }));
    await queue.enqueue(makeMessage({ content: 'b' })); // tripping the row threshold

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('WRITE_QUEUE_PRESSURE');
    expect(warnSpy.mock.calls[0][0]).toContain('rows=2');
  });
});
