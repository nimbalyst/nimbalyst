// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TranscriptStreamAccumulator } from '../transcriptStreamAccumulator';
import { TranscriptProjector } from '@nimbalyst/runtime/ai/server/transcript/TranscriptProjector';
import { TranscriptRuntime } from '@nimbalyst/runtime/ai/server/transcript/TranscriptRuntime';
import type { RawMessage } from '@nimbalyst/runtime/ai/server/transcript/TranscriptTransformer';
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
  it('replaces an evicted runtime generation while preserving legitimate repeated messages and canonical order', async () => {
    const raw: RawMessage[] = [
      {
        id: 1,
        sessionId: 'A',
        source: 'openai-codex',
        direction: 'input',
        content: JSON.stringify({ prompt: 'Synthetic request' }),
        createdAt: new Date(0),
      },
      ...[
        { type: 'agentMessage', id: 'message-one', text: 'Legitimate repeated response' },
        {
          type: 'commandExecution',
          id: 'tool-one',
          command: 'synthetic-command',
          status: 'completed',
          aggregatedOutput: 'Synthetic result',
        },
        { type: 'agentMessage', id: 'message-two', text: 'Legitimate repeated response' },
      ].map(
        (item, index): RawMessage => ({
          id: index + 2,
          sessionId: 'A',
          source: 'openai-codex',
          direction: 'output',
          content: JSON.stringify({
            method: 'item/completed',
            params: { threadId: 'thread-A', turnId: 'turn-A', item },
          }),
          metadata: { transport: 'app-server' },
          createdAt: new Date(index + 1),
        }),
      ),
      {
        id: 5,
        sessionId: 'B',
        source: 'openai-codex',
        direction: 'input',
        content: JSON.stringify({ prompt: 'Other session' }),
        createdAt: new Date(4),
      },
    ];
    const runtime = new TranscriptRuntime(
      {
        getMessages: async (sessionId, afterId = 0) =>
          raw.filter((row) => row.sessionId === sessionId && row.id > afterId),
      },
      { cacheCap: 1 },
    );
    const atomMessages = new Map<string, TranscriptViewMessage[]>();
    const scheduled: Array<() => void> = [];
    const accumulator = new TranscriptStreamAccumulator({
      // Match sessionStateListeners: the next read sees the previous merged emit,
      // including streamed events, rather than an independent DB-only snapshot.
      emit: ({ sessionId, messages }) => atomMessages.set(sessionId, messages),
      readDbMessages: (sessionId) => atomMessages.get(sessionId) ?? [],
      schedule: (callback) => scheduled.push(callback),
    });
    const flush = () => {
      for (const callback of scheduled.splice(0)) callback();
    };
    runtime.setOnEventWritten((event) => accumulator.apply(event));
    await runtime.getCanonicalEvents('A', 'openai-codex');
    flush();
    expect(atomMessages.get('A')).toHaveLength(4);
    await runtime.getCanonicalEvents('B', 'openai-codex');
    flush();
    const rebuilt = await runtime.getCanonicalEvents('A', 'openai-codex');
    flush();
    const rendered = atomMessages.get('A')!;
    expect(rendered.map((message) => message.id)).toEqual(rebuilt.map((event) => event.id));
    expect(rendered.map((message) => message.sequence)).toEqual([0, 1, 2, 3]);
    expect(
      rendered.filter((message) => message.text === 'Legitimate repeated response'),
    ).toHaveLength(2);
    expect(raw.filter((row) => row.sessionId === 'A')).toHaveLength(4);
  });

  it('ignores late old-generation events and stale atom snapshots after a replacement', () => {
    const h = createHarness();
    const old = { ...makeUserEvent(10, 'old', 0), transcriptGeneration: 1 };
    const current = { ...makeUserEvent(20, 'current', 0), transcriptGeneration: 2 };
    h.acc.apply(old);
    h.tickFrame();
    h.dbMessages = h.lastEmit!.messages;
    h.acc.apply(current);
    h.tickFrame();
    expect(h.lastEmit!.messages.map((m) => m.id)).toEqual([20]);
    const emits = h.emitCount;
    h.acc.apply({ ...old, id: 11 });
    h.tickFrame();
    expect(h.emitCount).toBe(emits);
    h.dbMessages = [{ ...makeDbMessage(10, 'user_message', 'old'), transcriptGeneration: 1 }];
    h.acc.apply({ ...makeAssistantEvent(21, 'new tail', 1), transcriptGeneration: 2 });
    h.tickFrame();
    expect(h.lastEmit!.messages.map((m) => m.id)).toEqual([20, 21]);
  });
  it('recognizes a newer loaded snapshot before accepting a delayed old event', () => {
    const h = createHarness();
    h.acc.apply({ ...makeUserEvent(10, 'old', 0), transcriptGeneration: 1 });
    h.tickFrame();
    h.dbMessages = [
      { ...makeDbMessage(20, 'user_message', 'new'), transcriptGeneration: 2, sequence: 0 },
    ];
    h.acc.apply({ ...makeAssistantEvent(11, 'stale', 1), transcriptGeneration: 1 });
    h.tickFrame();
    h.acc.apply({ ...makeAssistantEvent(21, 'tail', 1), transcriptGeneration: 2 });
    h.tickFrame();
    expect(h.lastEmit!.messages.map((m) => m.id)).toEqual([20, 21]);
  });
  it('orders canonical messages by sequence while retaining unmatched optimistic input at the end', () => {
    const h = createHarness([
      { ...makeDbMessage(90, 'user_message', 'Earlier input'), transcriptGeneration: 1, sequence: 0 },
      makeDbMessage(-1, 'user_message', 'Still pending'),
    ]);
    h.acc.apply({ ...makeUserEvent(80, 'Next input', 1), transcriptGeneration: 1 });
    h.tickFrame();
    expect(h.lastEmit!.messages.map((m) => m.id)).toEqual([90, 80, -1]);
  });
  it('acknowledges only one matching optimistic input and keeps a second identical request', () => {
    const h = createHarness([
      makeDbMessage(-1, 'user_message', 'yes'),
      makeDbMessage(-2, 'user_message', 'yes'),
    ]);
    h.acc.apply({ ...makeUserEvent(10, 'yes', 0), transcriptGeneration: 1 });
    h.tickFrame();
    expect(h.lastEmit!.messages.map((m) => m.id)).toEqual([10, -2]);
  });

  it('acknowledges enriched streaming inputs one-to-one without reusing prior acknowledgments', () => {
    const saved = 'yes\n\n<NIMBALYST_SYSTEM_MESSAGE>Document context</NIMBALYST_SYSTEM_MESSAGE>';
    const h = createHarness([
      makeDbMessage(-1, 'user_message', 'yes'),
      makeDbMessage(-2, 'user_message', 'yes'),
    ]);
    const first = {
      ...makeUserEvent(10, saved, 0),
      transcriptGeneration: 99,
      createdAt: new Date(294),
    };
    h.acc.apply(first);
    h.tickFrame();
    expect(h.lastEmit!.messages.map((m) => m.id)).toEqual([10, -2]);
    h.dbMessages = h.lastEmit!.messages;
    h.acc.apply(first);
    h.tickFrame();
    expect(h.lastEmit!.messages.map((m) => m.id)).toEqual([10, -2]);
    h.dbMessages = h.lastEmit!.messages;
    h.acc.apply({ ...first, id: 11, sequence: 1, createdAt: new Date(700) });
    h.tickFrame();
    expect(h.lastEmit!.messages.map((m) => m.id)).toEqual([10, 11]);
    expect(h.lastEmit!.messages.map((m) => m.text)).toEqual([saved, saved]);
    expect(first.searchableText).toBe(saved);
  });
  it.each([
    { text: 'yes plus a visible suffix', age: 294 },
    { text: 'yes', age: 5000 },
  ])('keeps unmatched enriched streaming input pending: $text/$age', ({ text, age }) => {
    const h = createHarness([makeDbMessage(-1, 'user_message', 'yes')]);
    const saved = text + '\n<NIMBALYST_SYSTEM_MESSAGE>Document context</NIMBALYST_SYSTEM_MESSAGE>';
    h.acc.apply({
      ...makeUserEvent(10, saved, 0),
      transcriptGeneration: 99,
      createdAt: new Date(age),
    });
    h.tickFrame();
    expect(h.lastEmit!.messages.map((m) => m.id)).toEqual([10, -1]);
    expect(h.lastEmit!.messages[0].text).toBe(saved);
  });

  it('recovers a stale optimistic context copy when a new generation arrives', () => {
    const saved =
      'Repeat request\n\n<NIMBALYST_SYSTEM_MESSAGE>Document context</NIMBALYST_SYSTEM_MESSAGE>';
    const canonical = {
      ...makeDbMessage(10, 'user_message', saved),
      transcriptGeneration: 98,
      sequence: 0,
      createdAt: new Date(294),
    };
    const h = createHarness([canonical, makeDbMessage(-4, 'user_message', 'Repeat request')]);
    h.acc.apply({
      ...makeUserEvent(20, saved, 0),
      transcriptGeneration: 99,
      createdAt: new Date(294),
    });
    h.tickFrame();
    expect(h.lastEmit!.messages.map((m) => m.id)).toEqual([20]);
    expect(h.lastEmit!.messages[0].text).toBe(saved);
  });

  it('does not rescan the snapshot generation on each pure text token', () => {
    let reads = 0;
    const snapshot = makeDbMessage(1, 'user_message', 'input');
    Object.defineProperty(snapshot, 'transcriptGeneration', {
      enumerable: true,
      get: () => {
        reads++;
        return 1;
      },
    });
    const h = createHarness([snapshot]);
    const event = { ...makeAssistantEvent(2, 'text', 2), transcriptGeneration: 1 };
    h.acc.apply(event);
    h.tickFrame();
    reads = 0;
    for (let token = 0; token < 1000; token++)
      h.acc.apply({ ...event, searchableText: `text-${token}` });
    expect(reads).toBe(0);
    h.tickFrame();
    expect(h.lastEmit!.messages[1].text).toBe('text-999');
  });
  it('does not reproject its own atom-backed emissions across pure text frames', () => {
    let messages: TranscriptViewMessage[] = [];
    const scheduled: Array<() => void> = [];
    const accumulator = new TranscriptStreamAccumulator({
      emit: (output) => {
        messages = output.messages;
      },
      readDbMessages: () => messages,
      schedule: (callback) => scheduled.push(callback),
    });
    const project = vi.spyOn(TranscriptProjector, 'project');
    try {
      const event = { ...makeAssistantEvent(1, 'first', 0), transcriptGeneration: 1 };
      accumulator.apply(event);
      for (const callback of scheduled.splice(0)) callback();
      expect(project).toHaveBeenCalledTimes(1);
      for (let frame = 0; frame < 5; frame++) {
        accumulator.apply({ ...event, searchableText: `frame-${frame}` });
        for (const callback of scheduled.splice(0)) callback();
      }
      expect(project).toHaveBeenCalledTimes(1);
      expect(messages[0].text).toBe('frame-4');
    } finally {
      project.mockRestore();
    }
  });
  it('retires a queued old text patch when a newer snapshot arrives before the frame flush', () => {
    const h = createHarness();
    const event = { ...makeAssistantEvent(1, 'old text', 0), transcriptGeneration: 1 };
    h.acc.apply(event);
    h.tickFrame();
    h.acc.apply({ ...event, searchableText: 'queued old text' });
    h.dbMessages = [
      {
        ...makeDbMessage(2, 'assistant_message', 'rebuilt text'),
        transcriptGeneration: 2,
        sequence: 0,
      },
    ];
    h.tickFrame();
    expect(h.lastEmit!.messages.map((m) => m.id)).toEqual([2]);
  });
  it('preserves generation when adjacent assistant events fuse into one projected message', () => {
    const h = createHarness();
    h.acc.apply({ ...makeAssistantEvent(1, 'first', 0), transcriptGeneration: 1 });
    h.acc.apply({ ...makeAssistantEvent(2, 'second', 1), transcriptGeneration: 1 });
    h.tickFrame();
    expect(h.lastEmit!.messages).toHaveLength(1);
    expect(h.lastEmit!.messages[0]).toMatchObject({ text: 'firstsecond', transcriptGeneration: 1 });
    h.dbMessages = h.lastEmit!.messages;
    h.acc.apply({ ...makeAssistantEvent(3, 'first', 0), transcriptGeneration: 2 });
    h.acc.apply({ ...makeAssistantEvent(4, 'second', 1), transcriptGeneration: 2 });
    h.tickFrame();
    expect(h.lastEmit!.messages).toHaveLength(1);
    expect(h.lastEmit!.messages[0]).toMatchObject({ text: 'firstsecond', transcriptGeneration: 2 });
  });

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

      h.acc.apply(makeUserEvent(7, 'optimistic-user'));
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
