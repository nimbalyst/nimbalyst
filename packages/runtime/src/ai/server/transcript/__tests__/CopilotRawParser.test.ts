/**
 * Contract tests for CopilotRawParser.
 *
 * Verifies that representative raw messages produce the expected
 * canonical event descriptors for GitHub Copilot ACP format messages.
 */

import { describe, it, expect } from 'vitest';
import { CopilotRawParser } from '../parsers/CopilotRawParser';
import type { ParseContext } from '../parsers/IRawMessageParser';
import type { RawMessage } from '../TranscriptTransformer';

const SESSION_ID = 'test-session';

function makeRawMessage(overrides: Partial<RawMessage>): RawMessage {
  return {
    id: 1,
    sessionId: SESSION_ID,
    source: 'copilot-cli',
    direction: 'output',
    content: '',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function makeContext(overrides?: Partial<ParseContext>): ParseContext {
  return {
    sessionId: SESSION_ID,
    hasToolCall: () => false,
    hasSubagent: () => false,
    findByProviderToolCallId: async () => null,
    findActiveToolCallByRawProviderId: async () => null,
    ...overrides,
  };
}

describe('CopilotRawParser', () => {
  describe('input messages', () => {
    it('parses plain text input as user_message', async () => {
      const parser = new CopilotRawParser();
      const msg = makeRawMessage({
        direction: 'input',
        content: 'Hello Copilot',
      });

      const descriptors = await parser.parseMessage(msg, makeContext());

      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]).toMatchObject({
        type: 'user_message',
        text: 'Hello Copilot',
        mode: 'agent',
      });
    });

    it('uses mode from metadata', async () => {
      const parser = new CopilotRawParser();
      const msg = makeRawMessage({
        direction: 'input',
        content: 'Plan this feature',
        metadata: { mode: 'planning' },
      });

      const descriptors = await parser.parseMessage(msg, makeContext());

      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]).toMatchObject({
        type: 'user_message',
        text: 'Plan this feature',
        mode: 'planning',
      });
    });

    it('detects system reminder messages', async () => {
      const parser = new CopilotRawParser();
      const msg = makeRawMessage({
        direction: 'input',
        content: '<SYSTEM_REMINDER>You are a helpful assistant</SYSTEM_REMINDER>',
      });

      const descriptors = await parser.parseMessage(msg, makeContext());

      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]).toMatchObject({
        type: 'system_message',
        systemType: 'status',
      });
    });

    it('detects system reminder via metadata', async () => {
      const parser = new CopilotRawParser();
      const msg = makeRawMessage({
        direction: 'input',
        content: 'System context update',
        metadata: { promptType: 'system_reminder' },
      });

      const descriptors = await parser.parseMessage(msg, makeContext());

      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]).toMatchObject({
        type: 'system_message',
        systemType: 'status',
      });
    });

    it('skips empty input', async () => {
      const parser = new CopilotRawParser();
      const msg = makeRawMessage({
        direction: 'input',
        content: '   ',
      });

      const descriptors = await parser.parseMessage(msg, makeContext());
      expect(descriptors).toHaveLength(0);
    });
  });

  describe('item.completed messages', () => {
    it('parses assistant response from item.completed format', async () => {
      const parser = new CopilotRawParser();
      const msg = makeRawMessage({
        content: JSON.stringify({
          type: 'item.completed',
          item: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Hello! How can I help?' }],
          },
        }),
      });

      const descriptors = await parser.parseMessage(msg, makeContext());

      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]).toMatchObject({
        type: 'assistant_message',
        text: 'Hello! How can I help?',
      });
    });

    it('concatenates multiple output_text parts', async () => {
      const parser = new CopilotRawParser();
      const msg = makeRawMessage({
        content: JSON.stringify({
          type: 'item.completed',
          item: {
            type: 'message',
            role: 'assistant',
            content: [
              { type: 'output_text', text: 'Part one. ' },
              { type: 'output_text', text: 'Part two.' },
            ],
          },
        }),
      });

      const descriptors = await parser.parseMessage(msg, makeContext());

      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]).toMatchObject({
        type: 'assistant_message',
        text: 'Part one. Part two.',
      });
    });

    it('skips item.completed with non-assistant role', async () => {
      const parser = new CopilotRawParser();
      const msg = makeRawMessage({
        content: JSON.stringify({
          type: 'item.completed',
          item: {
            type: 'message',
            role: 'system',
            content: [{ type: 'output_text', text: 'System message' }],
          },
        }),
      });

      const descriptors = await parser.parseMessage(msg, makeContext());
      expect(descriptors).toHaveLength(0);
    });

    it('skips item.completed with empty text', async () => {
      const parser = new CopilotRawParser();
      const msg = makeRawMessage({
        content: JSON.stringify({
          type: 'item.completed',
          item: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: '' }],
          },
        }),
      });

      const descriptors = await parser.parseMessage(msg, makeContext());
      expect(descriptors).toHaveLength(0);
    });
  });

  describe('ACP session/update notifications', () => {
    it('skips agent_message_chunk text events (accumulated for item.completed)', async () => {
      const parser = new CopilotRawParser();
      const msg = makeRawMessage({
        content: JSON.stringify({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'copilot-session-1',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Hello' },
            },
          },
        }),
      });

      const descriptors = await parser.parseMessage(msg, makeContext());
      expect(descriptors).toHaveLength(0);
    });

    it('skips agent_message_chunk thinking events', async () => {
      const parser = new CopilotRawParser();
      const msg = makeRawMessage({
        content: JSON.stringify({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'thinking', text: 'Let me think...' },
            },
          },
        }),
      });

      const descriptors = await parser.parseMessage(msg, makeContext());
      expect(descriptors).toHaveLength(0);
    });

    it('parses tool_call updates', async () => {
      const parser = new CopilotRawParser();
      const msg = makeRawMessage({
        content: JSON.stringify({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            update: {
              sessionUpdate: 'tool_call',
              id: 'tc-1',
              name: 'Read',
              arguments: { file_path: '/src/index.ts' },
            },
          },
        }),
      });

      const descriptors = await parser.parseMessage(msg, makeContext());

      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]).toMatchObject({
        type: 'tool_call_started',
        toolName: 'Read',
        providerToolCallId: 'tc-1',
        arguments: { file_path: '/src/index.ts' },
      });
    });

    it('parses tool_call with name in content', async () => {
      const parser = new CopilotRawParser();
      const msg = makeRawMessage({
        content: JSON.stringify({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            update: {
              sessionUpdate: 'tool_use',
              content: {
                id: 'tc-2',
                name: 'Edit',
                input: { file_path: '/src/app.ts', old_string: 'a', new_string: 'b' },
              },
            },
          },
        }),
      });

      const descriptors = await parser.parseMessage(msg, makeContext());

      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]).toMatchObject({
        type: 'tool_call_started',
        toolName: 'Edit',
        providerToolCallId: 'tc-2',
      });
    });

    it('parses tool_result updates', async () => {
      const parser = new CopilotRawParser();
      const msg = makeRawMessage({
        content: JSON.stringify({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            update: {
              sessionUpdate: 'tool_result',
              id: 'tc-1',
              output: 'file contents here',
            },
          },
        }),
      });

      const descriptors = await parser.parseMessage(msg, makeContext());

      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]).toMatchObject({
        type: 'tool_call_completed',
        providerToolCallId: 'tc-1',
        status: 'completed',
        result: 'file contents here',
      });
    });

    it('parses error updates', async () => {
      const parser = new CopilotRawParser();
      const msg = makeRawMessage({
        content: JSON.stringify({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            update: {
              sessionUpdate: 'error',
              message: 'Rate limit exceeded',
            },
          },
        }),
      });

      const descriptors = await parser.parseMessage(msg, makeContext());

      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]).toMatchObject({
        type: 'system_message',
        text: 'Rate limit exceeded',
        systemType: 'error',
      });
    });
  });

  describe('plain text output', () => {
    it('treats non-JSON output as assistant_message', async () => {
      const parser = new CopilotRawParser();
      const msg = makeRawMessage({
        content: 'Plain text response from Copilot',
      });

      const descriptors = await parser.parseMessage(msg, makeContext());

      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]).toMatchObject({
        type: 'assistant_message',
        text: 'Plain text response from Copilot',
      });
    });
  });

  describe('edge cases', () => {
    it('skips hidden messages', async () => {
      const parser = new CopilotRawParser();
      const msg = makeRawMessage({
        content: JSON.stringify({
          type: 'item.completed',
          item: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Hidden response' }],
          },
        }),
        hidden: true,
      });

      const descriptors = await parser.parseMessage(msg, makeContext());
      expect(descriptors).toHaveLength(0);
    });

    it('handles unknown session/update types gracefully', async () => {
      const parser = new CopilotRawParser();
      const msg = makeRawMessage({
        content: JSON.stringify({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            update: {
              sessionUpdate: 'some_future_type',
              content: { data: 'unknown' },
            },
          },
        }),
      });

      const descriptors = await parser.parseMessage(msg, makeContext());
      expect(descriptors).toHaveLength(0);
    });

    it('treats malformed JSON as plain text assistant_message', async () => {
      const parser = new CopilotRawParser();
      const msg = makeRawMessage({
        content: '{ invalid json',
      });

      const descriptors = await parser.parseMessage(msg, makeContext());

      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]).toMatchObject({
        type: 'assistant_message',
        text: '{ invalid json',
      });
    });

    it('preserves createdAt from raw message', async () => {
      const timestamp = new Date('2026-03-15T10:30:00Z');
      const parser = new CopilotRawParser();
      const msg = makeRawMessage({
        content: JSON.stringify({
          type: 'item.completed',
          item: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'With timestamp' }],
          },
        }),
        createdAt: timestamp,
      });

      const descriptors = await parser.parseMessage(msg, makeContext());

      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]).toMatchObject({
        type: 'assistant_message',
        text: 'With timestamp',
        createdAt: timestamp,
      });
    });
  });
});
