// @vitest-environment node
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
import { InMemoryTranscriptEventStore } from '../InMemoryTranscriptEventStore';
import { projectRawMessagesToViewMessages } from '../projectRawMessages';
import type { IRawMessageStore, RawMessage } from '../TranscriptTransformer';
import type { TranscriptEvent } from '../types';

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
  describe('Codex commit proposal identity', () => {
    for (const nativeFirst of [false, true]) {
      it(`keeps one completed card across batches and replay (nativeFirst=${nativeFirst})`, async () => {
        const rows: RawMessage[] = [];
        const runtime = new TranscriptRuntime(makeRawStore(rows));
        const append = async (content: unknown, metadata?: Record<string, unknown>) => {
          rows.push({ id: rows.length + 1, sessionId: 'commit', source: 'openai-codex',
            direction: 'output', content: JSON.stringify(content), metadata,
            createdAt: new Date(1792862293000 + rows.length) });
          await runtime.processNewMessages('commit', 'openai-codex');
        };
        // Reused raw IDs must still produce separate proposals in later turns.
        for (const turn of [1, 2]) {
          const id = 'item_0';
          const args = { commitMessage: `commit ${turn}`, filesToStage: ['file.ts'] };
          const enriched = { ...args, filesToStage: ['/repo/file.ts'], repoPath: '/repo',
            targetWorktree: { path: '/repo', branch: 'feature' } };
          const hostStart = { type: 'nimbalyst_tool_use', id,
            name: 'developer_git_commit_proposal', input: enriched };
          const item = { type: 'mcpToolCall', id, server: 'nimbalyst',
            tool: 'developer_git_commit_proposal', arguments: args, status: 'inProgress' };
          const metadata = { transport: 'app-server', editGroupId: `nimtc|item_0|1792862293286|${turn}` };
          const start = { method: 'item/started', params: { turnId: `turn-${turn}`, item } };
          if (nativeFirst) { await append(start, metadata); await append(hostStart); }
          else { await append(hostStart); await append(start, metadata); }
          const pending = await runtime.getViewMessages('commit', 'openai-codex');
          expect(pending.filter(m => m.type === 'tool_call')).toHaveLength(turn);
          expect(pending.at(-1)?.toolCall?.arguments).toEqual(enriched);
          await append({ method: 'item/completed', params: { turnId: `turn-${turn}`, item: { ...item,
            status: 'completed', result: { content: [{ type: 'text', text: `Commit hash: abc123${turn}` }] },
          } } }, metadata);
          const completed = await runtime.getViewMessages('commit', 'openai-codex');
          expect(completed.filter(m => m.type === 'tool_call')).toHaveLength(turn);
          expect(completed.at(-1)?.toolCall).toMatchObject({ status: 'completed', result: `Commit hash: abc123${turn}` });
        }
        await runtime.forceReparseSession('commit', 'openai-codex');
        const replayed = await runtime.getViewMessages('commit', 'openai-codex');
        expect(replayed.filter(m => m.type === 'tool_call')).toHaveLength(2);
        expect(replayed.filter(m => m.type === 'tool_call').map(m => m.toolCall?.status)).toEqual(['completed', 'completed']);
      });
    }
  });

  describe('Claude Code commit proposal host input', () => {
    // The SDK's tool_use row holds the model's raw input. The handler's own row
    // holds what the server resolved, including whether it auto-approved. The
    // widget reads only the tool call's arguments (#1756).
    const id = 'toolu_commit';
    const raw = { workingDirectory: '../sibling', filesToStage: ['a.ts'], commitMessage: 'fix: a', reasoning: 'why' };
    const resolved = { ...raw, filesToStage: ['/repo-sibling/a.ts'], repoPath: '/repo-sibling',
      targetWorktree: { path: '/repo-sibling', branch: 'feature' }, autoApproved: false };
    const sdkStart = { type: 'assistant', message: { id: 'msg_1', role: 'assistant', content: [
      { type: 'tool_use', id, name: 'mcp__nimbalyst__developer_git_commit_proposal', input: raw }] } };
    const hostStart = { type: 'nimbalyst_tool_use', id, name: 'developer_git_commit_proposal', input: resolved };
    const proposal = { type: 'git_commit_proposal', autoApproved: false, proposalId: id, toolUseId: id, status: 'pending' };

    for (const sdkFirst of [true, false]) {
      it(`keeps one card carrying the resolved input live and on reload (sdkFirst=${sdkFirst})`, async () => {
        const rows: RawMessage[] = [];
        const runtime = new TranscriptRuntime(makeRawStore(rows));
        const notified: TranscriptEvent[] = [];
        runtime.setOnEventWritten((event) => notified.push(event));
        // One row per batch, so the second start is matched through the store.
        const append = async (source: string, content: unknown) => {
          rows.push({ id: rows.length + 1, sessionId: 'cc-commit', source, direction: 'output',
            content: JSON.stringify(content), createdAt: new Date(1792862293000 + rows.length) });
          await runtime.processNewMessages('cc-commit', 'claude-code');
        };
        for (const start of sdkFirst ? [sdkStart, hostStart] : [hostStart, sdkStart]) await append('claude-code', start);
        await append('mcp', proposal);

        const live = (await runtime.getViewMessages('cc-commit', 'claude-code')).filter(m => m.type === 'tool_call');
        expect(live).toHaveLength(1);
        expect(live[0].toolCall?.arguments).toEqual(resolved);
        // The renderer refetches on notification; the last one for this call must carry the input.
        expect(notified.filter(e => e.providerToolCallId === id).at(-1)?.payload.arguments).toEqual(resolved);

        // A reload projects every row in one batch.
        await runtime.forceReparseSession('cc-commit', 'claude-code');
        const reloaded = (await runtime.getViewMessages('cc-commit', 'claude-code')).filter(m => m.type === 'tool_call');
        expect(reloaded).toHaveLength(1);
        expect(reloaded[0].toolCall?.arguments).toEqual(resolved);
        const mobile = (await projectRawMessagesToViewMessages(rows, 'claude-code')).filter(m => m.type === 'tool_call');
        expect(mobile.map(m => m.toolCall?.arguments)).toEqual([resolved]);
      });
    }
  });

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

  it('carries one store generation through callbacks, snapshots, projection and tool updates', async () => {
    const messages: RawMessage[] = [
      {
        id: 1,
        sessionId: 's1',
        source: 'openai-codex',
        direction: 'output',
        createdAt: new Date(0),
        metadata: { transport: 'app-server', editGroupId: 'nimtc|tool|0|1' },
        content: JSON.stringify({
          method: 'item/started',
          params: {
            threadId: 'thread',
            turnId: 'turn',
            item: {
              id: 'tool',
              type: 'mcpToolCall',
              server: 'synthetic',
              tool: 'tool',
              arguments: {},
            },
          },
        }),
      },
    ];
    const runtime = new TranscriptRuntime(makeRawStore(messages));
    const notifications: Array<{ id: number; transcriptGeneration?: number }> = [];
    runtime.setOnEventWritten((event) => notifications.push(event));
    const initial = await runtime.getCanonicalEvents('s1', 'openai-codex');
    const generation = initial[0].transcriptGeneration;
    expect(generation).toEqual(expect.any(Number));
    expect(notifications[0]).toBe(initial[0]);
    expect((await runtime.getViewMessages('s1', 'openai-codex'))[0].transcriptGeneration).toBe(
      generation,
    );
    messages.push({
      ...messages[0],
      id: 2,
      content: JSON.stringify({
        method: 'item/completed',
        params: {
          threadId: 'thread',
          turnId: 'turn',
          item: {
            id: 'tool',
            type: 'mcpToolCall',
            server: 'synthetic',
            tool: 'tool',
            arguments: {},
            status: 'completed',
            result: 'done',
          },
        },
      }),
    });
    await runtime.processNewMessages('s1', 'openai-codex');
    const completed = await runtime.getCanonicalEvents('s1', 'openai-codex');
    expect(completed).toHaveLength(1);
    expect(completed[0].payload.status).toBe('completed');
    expect(completed[0].transcriptGeneration).toBe(generation);
    expect(notifications.every((event) => event.transcriptGeneration === generation)).toBe(true);
    await runtime.forceReparseSession('s1', 'openai-codex');
    const rebuilt = await runtime.getCanonicalEvents('s1', 'openai-codex');
    expect(rebuilt[0].transcriptGeneration).toBeGreaterThan(generation!);
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

  // GitHub #1581: tool-call lookups scanned every staged event, so rebuilding a
  // large Codex session on load was quadratic and froze the main process
  // (~5s here before the fix, ~150ms after).
  it('rebuilds a large Codex session in linear time', async () => {
    const messages: RawMessage[] = [];
    const createdAt = new Date('2026-01-01');
    const push = (method: string, item: Record<string, unknown>) =>
      messages.push({
        id: messages.length + 1,
        sessionId: 's1',
        source: 'openai-codex',
        direction: 'output',
        content: JSON.stringify({ method, params: { item, threadId: 't', turnId: 'u' } }),
        createdAt,
        metadata: { transport: 'app-server' },
      });
    const toolCalls = 12_000;
    for (let i = 0; i < toolCalls; i++) {
      const item = { type: 'mcpToolCall', id: `exec-${i}`, server: 'nimbalyst', tool: 'x', arguments: {} };
      push('item/started', { ...item, status: 'inProgress', result: null });
      push('item/completed', { ...item, status: 'completed', result: { content: [{ type: 'text', text: 'ok' }] } });
    }
    const runtime = new TranscriptRuntime(makeRawStore(messages));

    const start = performance.now();
    const events = await runtime.getCanonicalEvents('s1', 'openai-codex');
    const elapsed = performance.now() - start;

    expect(events).toHaveLength(toolCalls);
    expect(events.every((e) => e.payload.status === 'completed')).toBe(true);
    expect(elapsed).toBeLessThan(2000);
  });
});

describe('InMemoryTranscriptEventStore tool-call lookups', () => {
  const toolCall = (sessionId: string, providerToolCallId: string, status: string, sequence: number) => ({
    sessionId,
    sequence,
    createdAt: new Date('2026-01-01'),
    eventType: 'tool_call' as const,
    searchableText: null,
    payload: { toolName: 'x', status },
    parentEventId: null,
    searchable: false,
    subagentId: null,
    provider: 'openai-codex',
    providerToolCallId,
  });

  it('matches raw and synthetic ids per session, preferring the latest active call', async () => {
    const store = new InMemoryTranscriptEventStore();
    const done = await store.insertEvent(toolCall('s1', 'raw|1', 'completed', 0));
    const synth = await store.insertEvent(toolCall('s1', `nimtc|${encodeURIComponent('raw|1')}|9`, 'running', 1));
    await store.insertEvent(toolCall('s2', 'raw|1', 'running', 0));

    expect((await store.findByProviderToolCallId('raw|1', 's1'))?.id).toBe(done.id);
    expect((await store.findActiveToolCallByRawProviderId('raw|1', 's1'))?.id).toBe(synth.id);

    await store.mergeEventPayload(synth.id, { status: 'completed' });
    expect(await store.findActiveToolCallByRawProviderId('raw|1', 's1')).toBeNull();

    await store.deleteSessionEvents('s1');
    expect(await store.getEventById(done.id)).toBeNull();
    expect((await store.findByProviderToolCallId('raw|1', 's2'))?.sessionId).toBe('s2');
  });
});
