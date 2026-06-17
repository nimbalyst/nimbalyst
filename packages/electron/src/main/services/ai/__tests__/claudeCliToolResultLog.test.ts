import { describe, it, expect, vi } from 'vitest';
import {
  logClaudeCliToolResults,
  extractPersistedToolResultIds,
  loadSeenToolResultIds,
  type LogClaudeCliToolResultsDeps,
} from '../claudeCliToolResultLog';
import { buildInteractivePromptToolResultContent } from '../../../mcp/tools/interactivePromptTranscript';
import type { ObservedToolResult } from '../claudeCliObservation/claudeApiRequestParser';

type ToolResultRow = Parameters<LogClaudeCliToolResultsDeps['createMessage']>[0];

/**
 * NIM-806 Slice E — tool_result blocks ride in the NEXT `/v1/messages` request
 * body (not the assistant SSE), and the body re-sends every prior result each
 * turn. These tests pin: (1) the row shape that completes the tool card, and
 * (2) dedup-by-tool_use_id across re-deliveries.
 */
describe('logClaudeCliToolResults', () => {
  function harness() {
    const createMessage = vi.fn(async (_row: ToolResultRow) => undefined);
    const notifyMessageLogged = vi.fn();
    const now = new Date('2026-06-08T00:00:00.000Z');
    return {
      createMessage,
      notifyMessageLogged,
      deps: { createMessage, notifyMessageLogged, now: () => now },
      now,
    };
  }

  const result = (toolUseId: string, content = 'ok', isError = false): ObservedToolResult => ({
    toolUseId,
    content,
    isError,
  });

  it('persists a nimbalyst_tool_result row keyed by tool_use_id', async () => {
    const h = harness();
    const seen = new Set<string>();
    await logClaudeCliToolResults(
      { sessionId: 's1', workspacePath: '/w', results: [result('toolu_1', 'file contents')], seen },
      h.deps,
    );
    expect(h.createMessage).toHaveBeenCalledTimes(1);
    const row = h.createMessage.mock.calls[0][0];
    expect(row).toMatchObject({ sessionId: 's1', source: 'claude-code', direction: 'output', hidden: false });
    const parsed = JSON.parse(row.content);
    expect(parsed).toEqual({
      type: 'nimbalyst_tool_result',
      tool_use_id: 'toolu_1',
      result: 'file contents',
      is_error: false,
    });
    expect(h.notifyMessageLogged).toHaveBeenCalledWith('s1', '/w');
  });

  it('carries the error flag through', async () => {
    const h = harness();
    await logClaudeCliToolResults(
      { sessionId: 's1', workspacePath: '/w', results: [result('toolu_e', 'boom', true)], seen: new Set() },
      h.deps,
    );
    expect(JSON.parse(h.createMessage.mock.calls[0][0].content).is_error).toBe(true);
  });

  it('dedups by tool_use_id across re-delivered request bodies (persists each once)', async () => {
    const h = harness();
    const seen = new Set<string>();
    // Turn N: result for toolu_1 arrives.
    await logClaudeCliToolResults({ sessionId: 's1', workspacePath: '/w', results: [result('toolu_1')], seen }, h.deps);
    // Turn N+1: body re-sends toolu_1 AND adds toolu_2.
    await logClaudeCliToolResults(
      { sessionId: 's1', workspacePath: '/w', results: [result('toolu_1'), result('toolu_2')], seen },
      h.deps,
    );
    expect(h.createMessage).toHaveBeenCalledTimes(2);
    const ids = h.createMessage.mock.calls.map((c) => JSON.parse(c[0].content).tool_use_id);
    expect(ids).toEqual(['toolu_1', 'toolu_2']);
  });

  it('broadcasts at most once per call even with multiple new results', async () => {
    const h = harness();
    await logClaudeCliToolResults(
      { sessionId: 's1', workspacePath: '/w', results: [result('a'), result('b')], seen: new Set() },
      h.deps,
    );
    expect(h.createMessage).toHaveBeenCalledTimes(2);
    expect(h.notifyMessageLogged).toHaveBeenCalledTimes(1);
  });

  it('does nothing (no broadcast) when there are no new results', async () => {
    const h = harness();
    const seen = new Set<string>(['toolu_1']);
    await logClaudeCliToolResults({ sessionId: 's1', workspacePath: '/w', results: [result('toolu_1')], seen }, h.deps);
    expect(h.createMessage).not.toHaveBeenCalled();
    expect(h.notifyMessageLogged).not.toHaveBeenCalled();
  });
});

/**
 * NIM-806 BUG 3 double-logging guard — a resumed CLI (`--resume`) replays the
 * whole prior conversation (incl. every old tool_result) in its first request
 * body, but the per-launch `seen` set starts empty. Pre-seeding it from the rows
 * already on disk keeps each tool_result persisted exactly once across restarts.
 */
describe('extractPersistedToolResultIds', () => {
  it('extracts tool_use_ids from persisted nimbalyst_tool_result rows only', () => {
    const rows = [
      { content: buildInteractivePromptToolResultContent({ toolUseId: 'toolu_1', result: 'ok' }) },
      { content: buildInteractivePromptToolResultContent({ toolUseId: 'toolu_2', result: 'x', isError: true }) },
      // Noise the extractor must ignore:
      { content: JSON.stringify({ type: 'nimbalyst_tool_use', id: 'toolu_99', name: 'X', input: {} }) },
      { content: JSON.stringify({ type: 'assistant', message: { id: 'msg_1' } }) },
      { content: '{"prompt":"hello"}' },
      { content: 'not json at all' },
    ];
    expect(extractPersistedToolResultIds(rows)).toEqual(new Set(['toolu_1', 'toolu_2']));
  });

  it('returns an empty set for no matching rows', () => {
    expect(extractPersistedToolResultIds([{ content: '{"type":"assistant"}' }])).toEqual(new Set());
  });
});

describe('loadSeenToolResultIds', () => {
  it('pre-seeds the seen set from the session’s persisted tool_results', async () => {
    const list = vi.fn(async (_sessionId: string) => [
      { content: buildInteractivePromptToolResultContent({ toolUseId: 'toolu_old', result: 'ok' }) },
    ]);
    const seen = await loadSeenToolResultIds('s1', { list });
    expect(list).toHaveBeenCalledWith('s1');
    expect(seen.has('toolu_old')).toBe(true);

    // And the guard works: a replayed old result is skipped, a new one is logged.
    const createMessage = vi.fn(async (_row: ToolResultRow) => undefined);
    await logClaudeCliToolResults(
      {
        sessionId: 's1',
        workspacePath: '/w',
        results: [
          { toolUseId: 'toolu_old', content: 'replayed', isError: false },
          { toolUseId: 'toolu_new', content: 'ok', isError: false },
        ],
        seen,
      },
      { createMessage, notifyMessageLogged: vi.fn(), now: () => new Date('2026-06-08T00:00:00.000Z') },
    );
    const ids = createMessage.mock.calls.map((c) => JSON.parse(c[0].content).tool_use_id);
    expect(ids).toEqual(['toolu_new']);
  });

  it('returns an empty set (never throws) when the list query fails', async () => {
    const list = vi.fn(async () => {
      throw new Error('db down');
    });
    const seen = await loadSeenToolResultIds('s1', { list });
    expect(seen.size).toBe(0);
  });
});
