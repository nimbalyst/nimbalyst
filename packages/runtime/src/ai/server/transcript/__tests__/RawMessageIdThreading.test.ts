import { describe, it, expect } from 'vitest';
import { projectRawMessagesToViewMessages } from '../projectRawMessages';
import type { RawMessage } from '../TranscriptTransformer';

/**
 * The edit/rewind feature targets a user message by its raw ai_agent_messages.id.
 * The canonical event `id` is an in-memory sequence, NOT the raw row id, so the
 * raw id is threaded onto the user_message payload and surfaced on the view
 * model. This pins that wiring through the full parse -> project pipeline.
 */
describe('rawMessageId threading (raw -> view message)', () => {
  it('surfaces the raw ai_agent_messages.id on projected user messages', async () => {
    const raw: RawMessage[] = [
      {
        id: 101,
        sessionId: 's1',
        source: 'claude-code',
        direction: 'input',
        content: JSON.stringify({ prompt: 'first user message', options: {} }),
        createdAt: new Date(1000),
        hidden: false,
      },
      {
        id: 102,
        sessionId: 's1',
        source: 'claude-code',
        direction: 'input',
        content: JSON.stringify({ prompt: 'second user message', options: {} }),
        createdAt: new Date(3000),
        hidden: false,
      },
    ];

    const view = await projectRawMessagesToViewMessages(raw, 'claude-code');

    const userMessages = view.filter((m) => m.type === 'user_message');
    expect(userMessages).toHaveLength(2);

    // Each projected user message carries the raw id of the row it came from --
    // and the canonical (in-memory) id is a DIFFERENT, sequence-based number.
    const first = userMessages.find((m) => m.text?.includes('first user message'));
    const second = userMessages.find((m) => m.text?.includes('second user message'));
    expect(first?.rawMessageId).toBe(101);
    expect(second?.rawMessageId).toBe(102);
    expect(first?.id).not.toBe(first?.rawMessageId);
  });

  it('leaves rawMessageId undefined on non-user messages', async () => {
    const raw: RawMessage[] = [
      {
        id: 201,
        sessionId: 's2',
        source: 'claude-code',
        direction: 'input',
        content: JSON.stringify({ prompt: 'hi', options: {} }),
        createdAt: new Date(1000),
        hidden: false,
      },
      {
        id: 202,
        sessionId: 's2',
        source: 'claude-code',
        direction: 'output',
        content: JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'hello back' }] },
        }),
        createdAt: new Date(2000),
        hidden: false,
      },
    ];

    const view = await projectRawMessagesToViewMessages(raw, 'claude-code');
    const assistant = view.find((m) => m.type === 'assistant_message');
    if (assistant) {
      expect(assistant.rawMessageId).toBeUndefined();
    }
    const user = view.find((m) => m.type === 'user_message');
    expect(user?.rawMessageId).toBe(201);
  });
});
