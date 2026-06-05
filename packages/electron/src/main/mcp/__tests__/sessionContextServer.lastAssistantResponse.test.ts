import { describe, expect, it, vi } from 'vitest';
import { fetchLastAssistantResponse, type MessageRowDb } from '../sessionContextServer';

interface SimRow {
  id: number;
  session_id: string;
  message_kind: 'user' | 'assistant' | 'tool' | 'system' | 'meta';
  searchable_text: string | null;
}

function makeDb(rows: SimRow[]): MessageRowDb {
  return {
    query: vi.fn(async <T = unknown>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> => {
      const norm = sql.replace(/\s+/g, ' ').trim();
      const sessionId = params[0] as string;

      if (norm.startsWith("SELECT id FROM ai_agent_messages WHERE session_id = $1 AND message_kind = 'user'")) {
        const matches = rows
          .filter((r) => r.session_id === sessionId && r.message_kind === 'user')
          .sort((a, b) => b.id - a.id)
          .slice(0, 1)
          .map((r) => ({ id: r.id }));
        return { rows: matches as unknown as T[] };
      }

      if (norm.startsWith("SELECT searchable_text FROM ai_agent_messages WHERE session_id = $1 AND message_kind = 'assistant'")) {
        const sinceId = params[1] as number;
        const matches = rows
          .filter(
            (r) =>
              r.session_id === sessionId &&
              r.message_kind === 'assistant' &&
              r.searchable_text !== null &&
              r.id > sinceId,
          )
          .sort((a, b) => a.id - b.id)
          .map((r) => ({ searchable_text: r.searchable_text }));
        return { rows: matches as unknown as T[] };
      }

      throw new Error(`unexpected SQL: ${norm}`);
    }) as MessageRowDb['query'],
  };
}

describe('fetchLastAssistantResponse', () => {
  it('assembles all assistant rows that follow the most recent user prompt', async () => {
    // Simulates a chunked-provider turn: one user prompt, then several
    // assistant rows that together make up the streamed reply.
    const db = makeDb([
      { id: 1, session_id: 's1', message_kind: 'user', searchable_text: 'first question' },
      { id: 2, session_id: 's1', message_kind: 'assistant', searchable_text: 'first reply' },
      { id: 3, session_id: 's1', message_kind: 'user', searchable_text: 'second question' },
      { id: 4, session_id: 's1', message_kind: 'assistant', searchable_text: 'Sure, here is the' },
      { id: 5, session_id: 's1', message_kind: 'assistant', searchable_text: ' answer to your' },
      { id: 6, session_id: 's1', message_kind: 'assistant', searchable_text: ' question.' },
    ]);

    const result = await fetchLastAssistantResponse(db, 's1');

    expect(result).toBe('Sure, here is the\n answer to your\n question.');
  });

  it('returns null when the session has no assistant rows', async () => {
    const db = makeDb([
      { id: 1, session_id: 's1', message_kind: 'user', searchable_text: 'hello' },
    ]);

    const result = await fetchLastAssistantResponse(db, 's1');
    expect(result).toBeNull();
  });

  it('returns the only assistant turn when there is no user prompt yet', async () => {
    // Edge case: assistant produced output before any user prompt (e.g. an
    // initial greeting). Aggregator should still return the assembled text.
    const db = makeDb([
      { id: 1, session_id: 's1', message_kind: 'assistant', searchable_text: 'welcome' },
      { id: 2, session_id: 's1', message_kind: 'assistant', searchable_text: ' aboard' },
    ]);

    const result = await fetchLastAssistantResponse(db, 's1');
    expect(result).toBe('welcome\n aboard');
  });

  it('ignores assistant rows from prior turns', async () => {
    const db = makeDb([
      { id: 1, session_id: 's1', message_kind: 'user', searchable_text: 'q1' },
      { id: 2, session_id: 's1', message_kind: 'assistant', searchable_text: 'older reply' },
      { id: 3, session_id: 's1', message_kind: 'user', searchable_text: 'q2' },
      { id: 4, session_id: 's1', message_kind: 'assistant', searchable_text: 'newer reply' },
    ]);

    const result = await fetchLastAssistantResponse(db, 's1');
    expect(result).toBe('newer reply');
    expect(result).not.toContain('older reply');
  });

  it('respects the maxLen cap', async () => {
    const longText = 'x'.repeat(5000);
    const db = makeDb([
      { id: 1, session_id: 's1', message_kind: 'user', searchable_text: 'q' },
      { id: 2, session_id: 's1', message_kind: 'assistant', searchable_text: longText },
    ]);

    const result = await fetchLastAssistantResponse(db, 's1', 100);
    expect(result).toHaveLength(100);
    expect(result).toBe('x'.repeat(100));
  });

  it('does not leak rows from other sessions', async () => {
    const db = makeDb([
      { id: 1, session_id: 's1', message_kind: 'user', searchable_text: 'q1' },
      { id: 2, session_id: 's1', message_kind: 'assistant', searchable_text: 'reply for s1' },
      { id: 3, session_id: 's2', message_kind: 'assistant', searchable_text: 'reply for s2' },
    ]);

    expect(await fetchLastAssistantResponse(db, 's1')).toBe('reply for s1');
    expect(await fetchLastAssistantResponse(db, 's2')).toBe('reply for s2');
  });
});
