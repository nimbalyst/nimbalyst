import { describe, expect, it, vi } from 'vitest';

import { createPGLiteAgentMessagesStore } from '../PGLiteAgentMessagesStore';

describe('PGLiteAgentMessagesStore.listTail', () => {
  it('queries the newest rows and returns them in chronological order', async () => {
    const query = vi.fn(async (_sql: string, _params?: any[]) => ({
      rows: [
        {
          id: 9,
          session_id: 'session-1',
          created_at: new Date(9_000),
          source: 'test',
          direction: 'output',
          content: 'message-9',
          metadata: '{"kind":"answer"}',
          hidden: false,
          provider_message_id: null,
        },
        {
          id: 10,
          session_id: 'session-1',
          created_at: new Date(10_000),
          source: 'test',
          direction: 'output',
          content: 'message-10',
          metadata: null,
          hidden: false,
          provider_message_id: null,
        },
      ],
    }));
    const store = createPGLiteAgentMessagesStore({ query: query as any });

    const messages = await store.listTail?.('session-1', 2);

    expect(query).toHaveBeenCalledOnce();
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('ORDER BY id DESC');
    expect(sql).toContain(') tail');
    expect(sql).toContain('ORDER BY id ASC');
    expect(params).toEqual(['session-1', 2]);
    expect(messages?.map((message) => message.id)).toEqual([9, 10]);
    expect(messages?.[0].metadata).toEqual({ kind: 'answer' });
  });
});
