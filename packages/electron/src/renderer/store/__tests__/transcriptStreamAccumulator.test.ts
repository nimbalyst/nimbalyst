// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TRANSCRIPT_REBUILD_HOLD_LIMIT_MS, TranscriptStreamAccumulator } from '../transcriptStreamAccumulator';
import { reconcileTranscriptMessages } from '../transcriptReconciliation';
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
      // The real emit writes the session atom, which readDbMessages reads.
      harness.dbMessages = output.messages;
    },
    readDbMessages: () => harness.dbMessages,
    schedule: (cb) => {
      pendingFrame.push(cb);
    },
  });
  return harness;
}

describe('TranscriptStreamAccumulator', () => {
  it('does not retain events for a session this window has not loaded', () => {
    // Every window receives every session's events; one that never opened the
    // session used to keep all of them (base64 tool results included) forever.
    let tracked = false;
    const harness = createHarness([makeDbMessage(1, 'user_message', 'hi')]);
    const acc = new TranscriptStreamAccumulator({
      emit: (output) => { harness.emitCount++; harness.lastEmit = output; },
      readDbMessages: () => harness.dbMessages,
      schedule: (cb) => { harness.pendingFrame.push(cb); },
      isSessionTracked: () => tracked,
    });

    acc.apply(makeAssistantEvent(2, 'x'.repeat(1000)));
    expect(acc.retainedEventCount(SESSION_ID)).toBe(0);
    expect(acc.hasPendingFlush(SESSION_ID)).toBe(false);

    tracked = true;
    acc.apply(makeAssistantEvent(3, 'loaded'));
    harness.tickFrame();
    expect(acc.retainedEventCount(SESSION_ID)).toBe(1);
    expect(harness.lastEmit?.messages.map(m => m.text)).toEqual(['hi', 'loaded']);
  });

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

  it('keeps a complete transcript on screen while an evicted session is rebuilt page by page (#919)', async () => {
    // Under multi-session load main evicts a busy session from its transcript
    // cache; the next write rebuilds it from raw row 0 in a new generation and
    // streams the events a page at a time. Frames render between pages.
    const items = Array.from({ length: 1100 }, (_, i) => i % 2 === 0
      ? { type: 'agentMessage', id: `message-${i}`, text: `Reply ${i}` }
      : { type: 'commandExecution', id: `tool-${i}`, command: `step ${i}`, status: 'completed', aggregatedOutput: 'ok' });
    const raw: RawMessage[] = [
      { id: 1, sessionId: 'A', source: 'openai-codex', direction: 'input', content: JSON.stringify({ prompt: 'Long request' }), createdAt: new Date(0) },
      ...items.map((item, i): RawMessage => ({
        id: i + 2,
        sessionId: 'A',
        source: 'openai-codex',
        direction: 'output',
        content: JSON.stringify({ method: 'item/completed', params: { threadId: 'thread-A', turnId: 'turn-A', item } }),
        metadata: { transport: 'app-server' },
        createdAt: new Date(i + 1),
      })),
      { id: 5000, sessionId: 'B', source: 'openai-codex', direction: 'input', content: JSON.stringify({ prompt: 'Other session' }), createdAt: new Date(0) },
    ];
    const atomMessages = new Map<string, TranscriptViewMessage[]>();
    const scheduled: Array<() => void> = [];
    const frame = () => {
      for (const callback of scheduled.splice(0)) callback();
    };
    const runtime = new TranscriptRuntime(
      {
        getMessages: async (sessionId, afterId = 0, limit) => {
          frame();
          const rows = raw.filter((row) => row.sessionId === sessionId && row.id > afterId);
          return limit === undefined ? rows : rows.slice(0, limit);
        },
      },
      { cacheCap: 1 },
    );
    const emitted: number[] = [];
    const accumulator = new TranscriptStreamAccumulator({
      emit: ({ sessionId, messages }) => {
        atomMessages.set(sessionId, messages);
        if (sessionId === 'A') emitted.push(messages.length);
      },
      readDbMessages: (sessionId) => atomMessages.get(sessionId) ?? [],
      schedule: (callback) => scheduled.push(callback),
    });
    runtime.setOnEventWritten((event) => accumulator.apply(event));
    await runtime.getCanonicalEvents('A', 'openai-codex');
    frame();
    const complete = atomMessages.get('A')!.length;
    expect(complete).toBe(1101);
    await runtime.getCanonicalEvents('B', 'openai-codex');
    frame();
    emitted.length = 0;

    // The agent's next logged row: incremental processing from the reset watermark.
    await runtime.processNewMessages('A', 'openai-codex');
    frame();
    const rebuilt = await runtime.getCanonicalEvents('A', 'openai-codex');
    expect(Math.min(...emitted), 'a frame showed a partly rebuilt transcript').toBe(complete);
    expect(atomMessages.get('A')!.map((m) => m.id)).toEqual(
      TranscriptProjector.project(rebuilt).messages.map((m) => m.id),
    );
  });
  it('switches to a newer generation once its snapshot lands, even before the live rebuild catches up', () => {
    const old = [0, 1, 2, 3, 4, 5].map((i) => ({
      ...makeDbMessage(100 + i, i % 2 ? 'assistant_message' : 'user_message', `m${i}`),
      transcriptGeneration: 1,
      sequence: i,
    }));
    const h = createHarness(old);
    h.acc.apply({ ...makeUserEvent(200, 'm0', 0), transcriptGeneration: 2 });
    h.acc.apply({ ...makeAssistantEvent(201, 'm1', 1), transcriptGeneration: 2 });
    h.tickFrame();
    expect(h.emitCount).toBe(0);
    expect(h.dbMessages).toBe(old);
    // The reload that follows every logged row returns the complete new generation.
    h.dbMessages = [0, 1, 2, 3, 4, 5].map((i) => ({
      ...makeDbMessage(200 + i, i % 2 ? 'assistant_message' : 'user_message', `m${i}`),
      transcriptGeneration: 2,
      sequence: i,
    }));
    h.acc.apply({ ...makeUserEvent(202, 'm2', 2), transcriptGeneration: 2 });
    h.acc.apply({ ...makeAssistantEvent(206, 'm6', 6), transcriptGeneration: 2 });
    h.tickFrame();
    expect(h.dbMessages.map((m) => m.id)).toEqual([200, 201, 202, 203, 204, 205, 206]);
  });
  it('asks for a reload when the screen shows more messages than the rebuild will, and shows the reply once it lands', async () => {
    // The window opened the session while its subagent ran, so the children
    // streamed in without their parent and sit at top level. The rebuild nests
    // them again and never reaches the on-screen count. External CLI ingest and
    // blocked-agent rows send no reload of their own.
    const cc = (id: number, payload: Record<string, unknown>, direction: 'input' | 'output' = 'output', sessionId = 'A'): RawMessage => ({
      id, sessionId, source: 'claude-code', direction, content: JSON.stringify(payload), createdAt: new Date(id),
    });
    const raw: RawMessage[] = [
      cc(1, { prompt: 'Audit the repo' }, 'input'),
      cc(2, { type: 'assistant', message: { id: 'm1', model: 'claude-x', content: [{ type: 'tool_use', id: 'task-1', name: 'Task', input: { prompt: 'audit', subagent_type: 'general-purpose' } }] } }),
      cc(1000, { prompt: 'Other session' }, 'input', 'B'),
    ];
    const runtime = new TranscriptRuntime(
      {
        getMessages: async (sessionId, afterId = 0, limit) => {
          const rows = raw.filter((row) => row.sessionId === sessionId && row.id > afterId);
          return limit === undefined ? rows : rows.slice(0, limit);
        },
      },
      { cacheCap: 1 },
    );
    await runtime.getCanonicalEvents('A', 'claude-code');
    const atom = new Map<string, TranscriptViewMessage[]>();
    const scheduled: Array<() => void> = [];
    const frame = () => {
      for (const callback of scheduled.splice(0)) callback();
    };
    const reloads: Promise<void>[] = [];
    const accumulator = new TranscriptStreamAccumulator({
      emit: ({ sessionId, messages }) => atom.set(sessionId, messages),
      readDbMessages: (sessionId) => atom.get(sessionId) ?? [],
      schedule: (callback) => scheduled.push(callback),
      // As reloadSessionDataAtom: a full load, reconciled into the atom.
      requestSnapshot: (sessionId) => reloads.push((async () => {
        const incoming = await runtime.getViewMessages(sessionId, 'claude-code');
        atom.set(sessionId, reconcileTranscriptMessages(atom.get(sessionId) ?? [], incoming));
      })()),
    });
    runtime.setOnEventWritten((event) => accumulator.apply(event));
    atom.set('A', await runtime.getViewMessages('A', 'claude-code'));
    for (let i = 0; i < 5; i++) {
      raw.push(cc(3 + i, { type: 'assistant', parent_tool_use_id: 'task-1', message: { id: `c${i}`, model: 'claude-x', content: [{ type: 'tool_use', id: `read-${i}`, name: 'Read', input: { file_path: `/f${i}` } }] } }));
      await runtime.processNewMessages('A', 'claude-code');
      frame();
    }
    await runtime.getCanonicalEvents('B', 'claude-code');
    frame();
    raw.push(cc(20, { type: 'assistant', message: { id: 'm2', model: 'claude-x', content: [{ type: 'text', text: 'Audit finished: 3 issues' }] } }));
    await runtime.processNewMessages('A', 'claude-code');
    frame();
    expect(reloads).toHaveLength(1);
    await Promise.all(reloads);
    frame();
    expect(atom.get('A')!.some((m) => m.text === 'Audit finished: 3 issues'), 'newest reply is on screen').toBe(true);
    expect(reloads).toHaveLength(1);
  });
  it('publishes a held rebuild once the time limit passes when no reload lands', () => {
    let atom: TranscriptViewMessage[] = [];
    let clock = 0;
    const requested: string[] = [];
    const scheduled: Array<() => void> = [];
    const frame = () => {
      for (const callback of scheduled.splice(0)) callback();
    };
    const accumulator = new TranscriptStreamAccumulator({
      emit: ({ messages }) => { atom = messages; },
      readDbMessages: () => atom,
      schedule: (callback) => scheduled.push(callback),
      requestSnapshot: (sessionId) => requested.push(sessionId),
      now: () => clock,
    });
    const base = { sessionId: 'S', createdAt: new Date(0), parentEventId: null, searchable: true, provider: 'claude-code', providerToolCallId: null } as const;
    const user = (id: number, sequence: number, transcriptGeneration: number) => ({ ...base, id, sequence, transcriptGeneration, eventType: 'user_message' as const, searchableText: 'Run the audit', payload: { mode: 'agent', inputType: 'user' }, subagentId: null });
    const subagent = (id: number, sequence: number, transcriptGeneration: number) => ({ ...base, id, sequence, transcriptGeneration, eventType: 'subagent' as const, searchableText: null, payload: { agentType: 'general', status: 'running', prompt: 'audit' }, subagentId: 'sa-1' });
    const child = (id: number, sequence: number, transcriptGeneration: number) => ({ ...base, id, sequence, transcriptGeneration, eventType: 'tool_call' as const, searchableText: null, payload: { toolName: 'Read', toolDisplayName: 'Read', status: 'completed', description: null, arguments: {}, targetFilePath: null, mcpServer: null, mcpTool: null, result: 'ok' }, subagentId: 'sa-1' });
    const reply = (id: number, sequence: number, transcriptGeneration: number) => ({ ...base, id, sequence, transcriptGeneration, eventType: 'assistant_message' as const, searchableText: 'Audit finished: 3 issues', payload: { mode: 'agent' }, subagentId: null });
    atom = [
      { id: 1, transcriptGeneration: 1, sequence: 0, createdAt: new Date(0), type: 'user_message', text: 'Run the audit', subagentId: null },
      { id: 2, transcriptGeneration: 1, sequence: 1, createdAt: new Date(0), type: 'subagent', subagentId: 'sa-1' },
    ];
    for (let i = 0; i < 5; i++) accumulator.apply(child(10 + i, 2 + i, 1) as never);
    frame();
    expect(atom.filter((m) => m.id >= 0)).toHaveLength(7);
    const complete = atom;
    for (const event of [user(101, 0, 2), subagent(102, 1, 2), ...[0, 1, 2, 3, 4].map((i) => child(110 + i, 2 + i, 2)), reply(120, 7, 2)])
      accumulator.apply(event as never);
    frame();
    expect(atom).toBe(complete);
    expect(requested).toEqual(['S']);
    clock += TRANSCRIPT_REBUILD_HOLD_LIMIT_MS;
    frame();
    expect(atom.some((m) => m.text === 'Audit finished: 3 issues'), 'the reply after the rebuild is on screen').toBe(true);
    expect(requested).toEqual(['S']);
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
    { text: 'yes plus a visible suffix', age: 294, sentAt: 0, acknowledged: false },
    { text: 'yes', age: 294, sentAt: 1000, acknowledged: false },
    // #1620: slow turn setup saves the prompt long after send.
    { text: 'yes', age: 8000, sentAt: 0, acknowledged: true },
  ])('matches enriched streaming input by text and send order: $text/$age', ({ text, age, sentAt, acknowledged }) => {
    const h = createHarness([
      { ...makeDbMessage(-1, 'user_message', 'yes'), createdAt: new Date(sentAt) },
    ]);
    const saved = text + '\n<NIMBALYST_SYSTEM_MESSAGE>Document context</NIMBALYST_SYSTEM_MESSAGE>';
    h.acc.apply({
      ...makeUserEvent(10, saved, 0),
      transcriptGeneration: 99,
      createdAt: new Date(age),
    });
    h.tickFrame();
    expect(h.lastEmit!.messages.map((m) => m.id)).toEqual(acknowledged ? [10] : [10, -1]);
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
    expect(h.dbMessages.map((m) => m.id)).toEqual([2]);
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

  describe('text patch fast path', () => {
    it('publishes a new object for the patched message only, so memoized rows see the text', () => {
      const h = createHarness();
      h.acc.apply(makeUserEvent(9, 'prompt'));
      const seed = makeAssistantEvent(10, 'a');
      h.acc.apply(seed);
      h.tickFrame();
      const firstArray = h.lastEmit!.messages;
      const [firstUser, firstMessage] = firstArray;
      expect(firstMessage?.text).toBe('a');

      for (let i = 0; i < 10; i++) {
        h.acc.apply({ ...seed, searchableText: 'a'.repeat(i + 2) });
      }
      h.tickFrame();
      const [user, patchedMessage] = h.lastEmit!.messages;
      expect(patchedMessage.text).toBe('a'.repeat(11));
      expect(patchedMessage).not.toBe(firstMessage);
      expect(firstMessage.text).toBe('a');
      expect(h.lastEmit!.messages).not.toBe(firstArray);
      expect(user).toBe(firstUser);
    });
  });

  describe('structural changes', () => {
    it('keeps unchanged rows and arrays stable across structural rebuilds', () => {
      const h = createHarness();
      const user = makeUserEvent(1, 'prompt');
      h.acc.apply(user);
      h.acc.apply(makeAssistantEvent(2, 'reply'));
      h.tickFrame();
      const initial = h.lastEmit!.messages;

      h.acc.apply(makeUserEvent(3, 'next prompt'));
      h.tickFrame();
      const appended = h.lastEmit!.messages;
      expect(appended.map(m => m.text)).toEqual(['prompt', 'reply', 'next prompt']);
      expect(appended[0]).toBe(initial[0]);
      expect(appended[1]).toBe(initial[1]);

      // A repeated non-text event takes the rebuild path but changes nothing.
      h.acc.apply({ ...user });
      h.tickFrame();
      expect(h.lastEmit!.messages).toBe(appended);
    });

    it('keeps a row a reload inserted before the next rebuild', () => {
      const h = createHarness();
      h.acc.apply(makeUserEvent(1, 'prompt'));
      h.tickFrame();
      h.dbMessages = h.lastEmit!.messages;

      // The reload lands between the live event and the next frame's rebuild.
      const event = makeUserEvent(2, 'next prompt');
      h.acc.apply(event);
      const reloaded = TranscriptProjector.project([event]).messages[0];
      const atom = [...h.dbMessages, reloaded];
      h.dbMessages = atom;
      const emits = h.emitCount;
      h.tickFrame();

      // The rebuild matches what the atom holds, so nothing is republished.
      expect(h.dbMessages).toBe(atom);
      expect(h.emitCount).toBe(emits);
    });

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
      h.dbMessages = []; // unload accompanies releasing the session atom
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
