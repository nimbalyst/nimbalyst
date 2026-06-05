/**
 * Tests for TranscriptRuntime -- the in-memory canonical event runtime
 * that replaces the persisted ai_transcript_events table.
 *
 * Phase 3 of canonical-transcript-deprecation. Where the legacy
 * TranscriptMigrationService tested lazy-migration watermark semantics, the
 * runtime owns the watermark internally and rebuilds canonical events on
 * cache miss. Tests target the new contract: cache-on-first-use,
 * incremental processNewMessages, MRU eviction.
 */

import { describe, it, expect } from 'vitest';
import { TranscriptRuntime } from '../TranscriptRuntime';
import type { IRawMessageStore, RawMessage } from '../TranscriptTransformer';

function makeRawStore(messages: RawMessage[]): IRawMessageStore {
  // Hold the live array so tests that push after construction see new rows.
  return {
    async getMessages(sessionId: string, afterId?: number): Promise<RawMessage[]> {
      const after = afterId ?? 0;
      return messages.filter((m) => m.sessionId === sessionId && m.id > after);
    },
  };
}

function userInput(id: number, sessionId: string, text: string, createdAt = new Date('2026-01-01')): RawMessage {
  return {
    id,
    sessionId,
    source: 'claude-code',
    direction: 'input',
    content: JSON.stringify({ prompt: text }),
    createdAt,
  };
}

describe('TranscriptRuntime', () => {
  it('builds canonical events on first access for an unseen session', async () => {
    const raw = makeRawStore([userInput(1, 's1', 'hello world')]);
    const runtime = new TranscriptRuntime(raw);
    const events = await runtime.getCanonicalEvents('s1', 'claude-code');
    expect(events.length).toBe(1);
    expect(events[0].eventType).toBe('user_message');
    expect(events[0].searchableText).toBe('hello world');
  });

  it('reports needsTransformation = true only for sessions not yet cached', async () => {
    const raw = makeRawStore([userInput(1, 's1', 'hi')]);
    const runtime = new TranscriptRuntime(raw);
    expect(await runtime.needsTransformation('s1')).toBe(true);
    await runtime.getCanonicalEvents('s1', 'claude-code');
    expect(await runtime.needsTransformation('s1')).toBe(false);
  });

  it('forceReparseSession evicts the cache so the next read rebuilds', async () => {
    const raw = makeRawStore([userInput(1, 's1', 'first')]);
    const runtime = new TranscriptRuntime(raw);
    await runtime.getCanonicalEvents('s1', 'claude-code');
    expect(await runtime.needsTransformation('s1')).toBe(false);

    await runtime.forceReparseSession('s1', 'claude-code');
    expect(await runtime.needsTransformation('s1')).toBe(true);
  });

  it('processNewMessages picks up newly written raw messages without rebuilding the prior batch', async () => {
    const messages = [userInput(1, 's1', 'first message')];
    const raw = makeRawStore(messages);
    const runtime = new TranscriptRuntime(raw);

    const initial = await runtime.getCanonicalEvents('s1', 'claude-code');
    expect(initial.length).toBe(1);

    messages.push(userInput(2, 's1', 'second message'));

    const newEvents = await runtime.processNewMessages('s1', 'claude-code');
    expect(newEvents.length).toBe(1);
    expect(newEvents[0].searchableText).toBe('second message');

    const all = await runtime.getCanonicalEvents('s1', 'claude-code');
    expect(all.map((e) => e.searchableText)).toEqual(['first message', 'second message']);
  });

  it('MRU eviction discards the least recently used session when the cap is reached', async () => {
    const sessions = ['s1', 's2', 's3'];
    const raw = makeRawStore(sessions.map((sid, i) => userInput(i + 1, sid, `prompt ${sid}`)));
    const runtime = new TranscriptRuntime(raw, { cacheCap: 2 });

    await runtime.getCanonicalEvents('s1', 'claude-code'); // MRU: [s1]
    await runtime.getCanonicalEvents('s2', 'claude-code'); // MRU: [s1, s2]
    expect(await runtime.needsTransformation('s1')).toBe(false);
    expect(await runtime.needsTransformation('s2')).toBe(false);

    await runtime.getCanonicalEvents('s3', 'claude-code'); // MRU: [s2, s3], s1 evicted
    expect(await runtime.needsTransformation('s1')).toBe(true);
    expect(await runtime.needsTransformation('s2')).toBe(false);
    expect(await runtime.needsTransformation('s3')).toBe(false);
  });
});
