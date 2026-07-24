import { describe, it, expect, beforeEach } from 'vitest';
import { TranscriptStreamAccumulator } from '../transcriptStreamAccumulator';
import type { TranscriptViewMessage } from '@nimbalyst/runtime/ai/server/transcript/TranscriptProjector';
import type { TranscriptEvent } from '@nimbalyst/runtime/ai/server/transcript/types';

const SESSION_ID = 'test-session';

function makeAssistantEvent(id: number, text: string, sequence = id): TranscriptEvent {
  return {
    id,
    sessionId: SESSION_ID,
    sequence,
    createdAt: new Date(0),
    eventType: 'assistant_message',
    searchableText: text,
    payload: { mode: 'agent' },
    parentEventId: null,
    searchable: true,
    subagentId: null,
    provider: 'claude-code',
    providerToolCallId: null,
  };
}

function makeUserEvent(id: number, text: string, sequence = id): TranscriptEvent {
  return {
    id,
    sessionId: SESSION_ID,
    sequence,
    createdAt: new Date(0),
    eventType: 'user_message',
    searchableText: text,
    payload: { mode: 'agent', inputType: 'user' },
    parentEventId: null,
    searchable: true,
    subagentId: null,
    provider: 'claude-code',
    providerToolCallId: null,
  };
}

function makeDbMessage(id: number, type: 'user_message' | 'assistant_message', text: string): TranscriptViewMessage {
  return {
    id,
    sequence: id,
    createdAt: new Date(0),
    type,
    text,
    subagentId: null,
  };
}

interface Harness {
  acc: TranscriptStreamAccumulator;
  /** Pending scheduled callbacks. Drained by tickFrame(). */
  pendingFrame: Array<() => void>;
  /** Increments once per emit() call (one per atom write). */
  emitCount: number;
  /** The most recent published messages array. */
  lastEmit: { sessionId: string; messages: TranscriptViewMessage[] } | null;
  /** Snapshot of DB messages used during rebuilds. */
  dbMessages: TranscriptViewMessage[];
  tickFrame: () => void;
}

function createHarness(dbMessages: TranscriptViewMessage[] = []): Harness {
  const pendingFrame: Array<() => void> = [];
  const harness: Harness = {
    acc: null as unknown as TranscriptStreamAccumulator,
    pendingFrame,
    emitCount: 0,
    lastEmit: null,
    dbMessages,
    tickFrame: () => {
      // Drain everything queued for "this frame" -- mimics rAF firing once.
      const callbacks = pendingFrame.splice(0, pendingFrame.length);
      for (const cb of callbacks) cb();
    },
  };
  harness.acc = new TranscriptStreamAccumulator({
    emit: (output) => {
      harness.emitCount++;
      harness.lastEmit = output;
    },
    readDbMessages: () => harness.dbMessages,
    schedule: (cb) => {
      pendingFrame.push(cb);
    },
  });
  return harness;
}

describe('TranscriptStreamAccumulator', () => {
  describe('basic flushing', () => {
    let h: Harness;
    beforeEach(() => {
      h = createHarness();
    });

    it('schedules at most one flush per frame for many apply() calls', () => {
      const e = makeAssistantEvent(1, 'hello');
      h.acc.apply(e);
      h.acc.apply({ ...e, searchableText: 'hello world' });
      h.acc.apply({ ...e, searchableText: 'hello world!' });
      // No emit yet -- still in the same frame.
      expect(h.emitCount).toBe(0);
      expect(h.pendingFrame.length).toBe(1);
      h.tickFrame();
      expect(h.emitCount).toBe(1);
      expect(h.lastEmit?.messages).toHaveLength(1);
      expect(h.lastEmit?.messages[0].text).toBe('hello world!');
    });

    it('publishes new events on the next frame', () => {
      h.acc.apply(makeUserEvent(1, 'hi'));
      h.tickFrame();
      expect(h.emitCount).toBe(1);
      expect(h.lastEmit?.messages.map((m) => m.id)).toEqual([1]);

      h.acc.apply(makeAssistantEvent(2, 'response'));
      h.tickFrame();
      expect(h.emitCount).toBe(2);
      expect(h.lastEmit?.messages.map((m) => m.id)).toEqual([1, 2]);
    });
  });

  describe('streaming coalesce performance', () => {
    it('handles 1000 streaming updates over a 500-event transcript with one emit per frame', () => {
      // Seed DB messages to simulate a long session history.
      const dbMessages: TranscriptViewMessage[] = [];
      for (let i = 1; i <= 500; i++) {
        dbMessages.push(makeDbMessage(i, i % 2 === 0 ? 'assistant_message' : 'user_message', `seed-${i}`));
      }
      const h = createHarness(dbMessages);

      // First chunk seeds the live event (id 600). Tick a frame to publish.
      const start = performance.now();
      const liveId = 600;
      const seed = makeAssistantEvent(liveId, '', 600);
      h.acc.apply(seed);
      h.tickFrame();
      expect(h.emitCount).toBe(1);

      // Now stream 1000 text updates to the same id, ticking a frame after
      // every 16 calls (~60Hz). Tracks emits-per-frame and total work.
      let accumulated = '';
      const chunksPerFrame = 16;
      let frames = 0;
      for (let i = 0; i < 1000; i++) {
        accumulated += 't';
        h.acc.apply({ ...seed, searchableText: accumulated });
        if ((i + 1) % chunksPerFrame === 0) {
          frames++;
          // Exactly one flush should be pending at this point.
          expect(h.pendingFrame.length).toBe(1);
          const before = h.emitCount;
          h.tickFrame();
          // Exactly one emit was produced for this frame.
          expect(h.emitCount - before).toBe(1);
        }
      }
      // Flush any remaining buffered chunk.
      h.tickFrame();
      const elapsed = performance.now() - start;

      // Final published state has the full streamed text on the live event.
      const live = h.lastEmit?.messages.find((m) => m.id === liveId);
      expect(live?.text).toBe(accumulated);
      // Total messages published = DB messages with no live overlap + 1 live.
      expect(h.lastEmit?.messages.length).toBe(501);

      // Headroom: 1000 streaming updates over a 500-event transcript should
      // complete well under one second on any reasonable machine. Generous
      // bound so this stays a reliable signal, not a flake source.
      expect(elapsed).toBeLessThan(1000);

      // Bound the number of emits we issued: at most one per frame plus
      // the initial seed and the trailing flush.
      expect(h.emitCount).toBeLessThanOrEqual(frames + 2);
    });
  });

  describe('in-place patch fast path', () => {
    it('reuses the same view message object across pure-text updates within a frame', () => {
      const h = createHarness();
      const seed = makeAssistantEvent(10, 'a');
      h.acc.apply(seed);
      h.tickFrame();
      const firstMessage = h.lastEmit?.messages.find((m) => m.id === 10);
      expect(firstMessage?.text).toBe('a');

      // Ten incremental text updates. After the next flush, the view
      // message identity should be preserved (in-place patch path).
      for (let i = 0; i < 10; i++) {
        h.acc.apply({ ...seed, searchableText: 'a'.repeat(i + 2) });
      }
      h.tickFrame();
      const patchedMessage = h.lastEmit?.messages.find((m) => m.id === 10);
      expect(patchedMessage?.text).toBe('a'.repeat(11));
      expect(patchedMessage).toBe(firstMessage);
    });
  });

  describe('structural changes', () => {
    it('rebuilds when an event payload gains a thinking field', () => {
      const h = createHarness();
      const seed = makeAssistantEvent(20, 'hello');
      h.acc.apply(seed);
      h.tickFrame();
      const before = h.lastEmit?.messages[0];

      // Same id, but now with thinking content. Must not be patched in
      // place because the projector treats thinking-bearing assistant
      // messages as their own UI block.
      h.acc.apply({
        ...seed,
        payload: { mode: 'agent', thinking: 'reasoning...' },
      });
      h.tickFrame();
      const after = h.lastEmit?.messages[0];
      expect(after?.thinking).toBe('reasoning...');
      // Different object identity proves we ran a fresh projection.
      expect(after).not.toBe(before);
    });
  });

  describe('session cleanup', () => {
    it('drops session state on unload()', () => {
      const h = createHarness();
      h.acc.apply(makeAssistantEvent(1, 'x'));
      h.tickFrame();
      expect(h.lastEmit?.messages).toHaveLength(1);

      h.acc.unload(SESSION_ID);
      // After unload, the next event for the same session starts from a
      // clean state -- if state had leaked, the live array would still
      // contain the prior event id.
      h.acc.apply(makeAssistantEvent(99, 'y'));
      h.tickFrame();
      expect(h.lastEmit?.messages.map((m) => m.id)).toEqual([99]);
    });
  });

  describe('DB message reconciliation', () => {
    it('drops optimistic (negative-id) DB messages once a real user_message arrives live', () => {
      const dbMessages: TranscriptViewMessage[] = [
        makeDbMessage(-1, 'user_message', 'optimistic-user'),
        makeDbMessage(5, 'assistant_message', 'past-reply'),
      ];
      const h = createHarness(dbMessages);

      h.acc.apply(makeUserEvent(7, 'real user'));
      h.tickFrame();

      const ids = h.lastEmit?.messages.map((m) => m.id);
      expect(ids).toEqual([5, 7]);
    });

    it('lets live events override DB messages with the same id', () => {
      const dbMessages: TranscriptViewMessage[] = [
        makeDbMessage(42, 'assistant_message', 'old-text'),
      ];
      const h = createHarness(dbMessages);

      h.acc.apply(makeAssistantEvent(42, 'new-text'));
      h.tickFrame();

      const m = h.lastEmit?.messages.find((x) => x.id === 42);
      expect(m?.text).toBe('new-text');
      expect(h.lastEmit?.messages).toHaveLength(1);
    });
  });
});
