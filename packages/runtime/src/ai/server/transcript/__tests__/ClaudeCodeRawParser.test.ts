/**
 * Contract tests for ClaudeCodeRawParser.
 *
 * Verifies that representative raw messages produce the expected
 * canonical event descriptors. These tests ensure that the parser
 * correctly extracts canonical events from the Claude Code SDK
 * raw message format stored in ai_agent_messages.
 */

import { describe, it, expect } from 'vitest';
import { ClaudeCodeRawParser } from '../parsers/ClaudeCodeRawParser';
import type { ParseContext, CanonicalEventDescriptor } from '../parsers/IRawMessageParser';
import type { RawMessage } from '../TranscriptTransformer';

const SESSION_ID = 'test-session';

function makeRawMessage(overrides: Partial<RawMessage>): RawMessage {
  return {
    id: 1,
    sessionId: SESSION_ID,
    source: 'claude-code',
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

describe('ClaudeCodeRawParser', () => {
  describe('input messages', () => {
    it('parses user prompt from { prompt: "..." } format', async () => {
      const parser = new ClaudeCodeRawParser();
      const msg = makeRawMessage({
        direction: 'input',
        content: JSON.stringify({ prompt: 'Hello world', options: {} }),
      });

      const descriptors = await parser.parseMessage(msg, makeContext());

      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]).toMatchObject({
        type: 'user_message',
        text: 'Hello world',
      });
    });

    it('parses system reminder as system_message', async () => {
      const parser = new ClaudeCodeRawParser();
      const msg = makeRawMessage({
        direction: 'input',
        content: JSON.stringify({ prompt: '[System: continuation]' }),
      });

      const descriptors = await parser.parseMessage(msg, makeContext());

      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]).toMatchObject({
        type: 'system_message',
        systemType: 'status',
      });
    });

    it('parses SDK format user message { type: "user", message: { content: "..." } }', async () => {
      const parser = new ClaudeCodeRawParser();
      const msg = makeRawMessage({
        direction: 'input',
        content: JSON.stringify({
          type: 'user',
          message: { role: 'user', content: 'Hello SDK format' },
        }),
      });

      const descriptors = await parser.parseMessage(msg, makeContext());

      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]).toMatchObject({
        type: 'user_message',
        text: 'Hello SDK format',
      });
    });

    it('parses tool_result blocks in input messages', async () => {
      const parser = new ClaudeCodeRawParser();
      const msg = makeRawMessage({
        direction: 'input',
        content: JSON.stringify({
          type: 'user',
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'tool-1', content: 'result text' },
            ],
          },
        }),
      });

      const context = makeContext({
        hasToolCall: (id) => id === 'tool-1',
      });
      const descriptors = await parser.parseMessage(msg, context);

      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]).toMatchObject({
        type: 'tool_call_completed',
        providerToolCallId: 'tool-1',
        result: 'result text',
        status: 'completed',
      });
    });

    it('treats plain text as user_message', async () => {
      const parser = new ClaudeCodeRawParser();
      const msg = makeRawMessage({
        direction: 'input',
        content: 'Just plain text',
      });

      const descriptors = await parser.parseMessage(msg, makeContext());

      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]).toMatchObject({
        type: 'user_message',
        text: 'Just plain text',
      });
    });

    it('skips hidden messages', async () => {
      const parser = new ClaudeCodeRawParser();
      const msg = makeRawMessage({
        direction: 'input',
        content: 'Hidden content',
        hidden: true,
      });

      const descriptors = await parser.parseMessage(msg, makeContext());
      expect(descriptors).toHaveLength(0);
    });
  });

  describe('output messages', () => {
    it('parses text chunk { type: "text", content: "..." }', async () => {
      const parser = new ClaudeCodeRawParser();
      const msg = makeRawMessage({
        content: JSON.stringify({ type: 'text', content: 'Hello assistant' }),
      });

      const descriptors = await parser.parseMessage(msg, makeContext());

      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]).toMatchObject({
        type: 'assistant_message',
        text: 'Hello assistant',
      });
    });

    it('parses assistant chunk with text blocks', async () => {
      const parser = new ClaudeCodeRawParser();
      const msg = makeRawMessage({
        content: JSON.stringify({
          type: 'assistant',
          message: {
            id: 'msg-1',
            content: [{ type: 'text', text: 'Response text' }],
          },
        }),
      });

      const descriptors = await parser.parseMessage(msg, makeContext());

      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]).toMatchObject({
        type: 'assistant_message',
        text: 'Response text',
      });
    });

    it('deduplicates text by message ID', async () => {
      const parser = new ClaudeCodeRawParser();
      const msg1 = makeRawMessage({
        id: 1,
        content: JSON.stringify({
          type: 'assistant',
          message: { id: 'msg-1', content: [{ type: 'text', text: 'First' }] },
        }),
      });
      const msg2 = makeRawMessage({
        id: 2,
        content: JSON.stringify({
          type: 'assistant',
          message: { id: 'msg-1', content: [{ type: 'text', text: 'Duplicate' }] },
        }),
      });

      const ctx = makeContext();
      const d1 = await parser.parseMessage(msg1, ctx);
      const d2 = await parser.parseMessage(msg2, ctx);

      expect(d1).toHaveLength(1);
      expect(d2).toHaveLength(0); // Deduped
    });

    it('parses tool_use blocks', async () => {
      const parser = new ClaudeCodeRawParser();
      const msg = makeRawMessage({
        content: JSON.stringify({
          type: 'assistant',
          message: {
            content: [{
              type: 'tool_use',
              id: 'tool-1',
              name: 'Read',
              input: { file_path: '/test.ts' },
            }],
          },
        }),
      });

      const descriptors = await parser.parseMessage(msg, makeContext());

      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]).toMatchObject({
        type: 'tool_call_started',
        toolName: 'Read',
        providerToolCallId: 'tool-1',
        arguments: { file_path: '/test.ts' },
      });
    });

    it('parses MCP tool calls with server/tool extraction', async () => {
      const parser = new ClaudeCodeRawParser();
      const msg = makeRawMessage({
        content: JSON.stringify({
          type: 'assistant',
          message: {
            content: [{
              type: 'tool_use',
              id: 'mcp-1',
              name: 'mcp__nimbalyst-mcp__excalidraw_add_rectangle',
              input: { label: 'Box' },
            }],
          },
        }),
      });

      const descriptors = await parser.parseMessage(msg, makeContext());

      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]).toMatchObject({
        type: 'tool_call_started',
        toolName: 'mcp__nimbalyst-mcp__excalidraw_add_rectangle',
        mcpServer: 'nimbalyst-mcp',
        mcpTool: 'excalidraw_add_rectangle',
      });
    });

    it('parses subagent spawns (Agent/Task tools)', async () => {
      const parser = new ClaudeCodeRawParser();
      const msg = makeRawMessage({
        content: JSON.stringify({
          type: 'assistant',
          message: {
            content: [{
              type: 'tool_use',
              id: 'agent-1',
              name: 'Agent',
              input: { prompt: 'Do something', name: 'helper' },
            }],
          },
        }),
      });

      const descriptors = await parser.parseMessage(msg, makeContext());

      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]).toMatchObject({
        type: 'subagent_started',
        subagentId: 'agent-1',
        agentType: 'Agent',
        teammateName: 'helper',
        prompt: 'Do something',
      });
    });

    it('deduplicates tool_use blocks by ID', async () => {
      const parser = new ClaudeCodeRawParser();
      const msg1 = makeRawMessage({
        id: 1,
        content: JSON.stringify({
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }],
          },
        }),
      });
      const msg2 = makeRawMessage({
        id: 2,
        content: JSON.stringify({
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }],
          },
        }),
      });

      const ctx = makeContext();
      // First message creates the tool call
      const d1 = await parser.parseMessage(msg1, ctx);
      expect(d1).toHaveLength(1);

      // Second message with same tool ID -- now hasToolCall returns true
      const ctx2 = makeContext({ hasToolCall: (id) => id === 'tool-1' });
      const d2 = await parser.parseMessage(msg2, ctx2);
      expect(d2).toHaveLength(0); // Deduped
    });

    it('parses error chunks', async () => {
      const parser = new ClaudeCodeRawParser();
      const msg = makeRawMessage({
        content: JSON.stringify({
          type: 'error',
          error: 'Something went wrong',
        }),
      });

      const descriptors = await parser.parseMessage(msg, makeContext());

      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]).toMatchObject({
        type: 'system_message',
        text: 'Something went wrong',
        systemType: 'error',
      });
      expect((descriptors[0] as any).isAuthError).toBeUndefined();
    });

    it('marks auth errors from parsed is_auth_error flag', async () => {
      const parser = new ClaudeCodeRawParser();
      const msg = makeRawMessage({
        content: JSON.stringify({
          type: 'error',
          error: 'Invalid API key',
          is_auth_error: true,
        }),
      });

      const [descriptor] = await parser.parseMessage(msg, makeContext());

      expect(descriptor).toMatchObject({
        type: 'system_message',
        systemType: 'error',
        isAuthError: true,
      });
    });

    it('marks auth errors from metadata.isAuthError', async () => {
      const parser = new ClaudeCodeRawParser();
      const msg = makeRawMessage({
        content: JSON.stringify({
          type: 'error',
          error: 'Authentication required',
        }),
        metadata: { isAuthError: true },
      });

      const [descriptor] = await parser.parseMessage(msg, makeContext());

      expect(descriptor).toMatchObject({
        type: 'system_message',
        systemType: 'error',
        isAuthError: true,
      });
    });

    it('parses unknown slash command result as assistant message', async () => {
      const parser = new ClaudeCodeRawParser();
      const msg = makeRawMessage({
        content: JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'Unknown command: /fakecommand',
        }),
      });

      const descriptors = await parser.parseMessage(msg, makeContext());

      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]).toMatchObject({
        type: 'assistant_message',
        text: 'Unknown command: /fakecommand',
      });
    });

    it('skips result chunk text when assistant text was already emitted this session', async () => {
      const parser = new ClaudeCodeRawParser();

      // First: an assistant chunk with text
      await parser.parseMessage(
        makeRawMessage({
          content: JSON.stringify({
            type: 'assistant',
            message: { id: 'msg-1', content: [{ type: 'text', text: 'Hi' }] },
          }),
        }),
        makeContext(),
      );

      // Then: a result chunk echoing the final text
      const descriptors = await parser.parseMessage(
        makeRawMessage({
          id: 2,
          content: JSON.stringify({
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: 'Hi',
          }),
        }),
        makeContext(),
      );

      expect(descriptors).toHaveLength(0);
    });

    it('parses nimbalyst_tool_use', async () => {
      const parser = new ClaudeCodeRawParser();
      const msg = makeRawMessage({
        content: JSON.stringify({
          type: 'nimbalyst_tool_use',
          id: 'ask-1',
          name: 'AskUserQuestion',
          input: { questions: [{ question: 'What?' }] },
        }),
      });

      const descriptors = await parser.parseMessage(msg, makeContext());

      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]).toMatchObject({
        type: 'tool_call_started',
        toolName: 'AskUserQuestion',
        providerToolCallId: 'ask-1',
      });
    });

    it('deduplicates nimbalyst_tool_use via DB fallback when in-memory map misses', async () => {
      const parser = new ClaudeCodeRawParser();
      const msg = makeRawMessage({
        content: JSON.stringify({
          type: 'nimbalyst_tool_use',
          id: 'ask-1',
          name: 'AskUserQuestion',
          input: { questions: [{ question: 'What?' }] },
        }),
      });

      // In-memory map returns false (cross-batch scenario), but DB finds the existing event
      const ctx = makeContext({
        hasToolCall: () => false,
        findByProviderToolCallId: async (id) =>
          id === 'ask-1' ? { id: 999 } as any : null,
      });
      const descriptors = await parser.parseMessage(msg, ctx);

      expect(descriptors).toHaveLength(0); // Deduped via DB lookup
    });

    it('parses nimbalyst_tool_result', async () => {
      const parser = new ClaudeCodeRawParser();
      const msg = makeRawMessage({
        content: JSON.stringify({
          type: 'nimbalyst_tool_result',
          tool_use_id: 'ask-1',
          result: '{"answers": {"q1": "yes"}}',
        }),
      });

      const ctx = makeContext({ hasToolCall: (id) => id === 'ask-1' });
      const descriptors = await parser.parseMessage(msg, ctx);

      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]).toMatchObject({
        type: 'tool_call_completed',
        providerToolCallId: 'ask-1',
        status: 'completed',
      });
    });

    it('treats plain text output as assistant_message', async () => {
      const parser = new ClaudeCodeRawParser();
      const msg = makeRawMessage({
        content: 'Plain text response',
      });

      const descriptors = await parser.parseMessage(msg, makeContext());

      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]).toMatchObject({
        type: 'assistant_message',
        text: 'Plain text response',
      });
    });
  });

  describe('Claude Code 2.1.x format additions', () => {
    it('emits an assistant_message with the thinking side-channel for {type:"thinking"} blocks', async () => {
      const parser = new ClaudeCodeRawParser();
      const msg = makeRawMessage({
        content: JSON.stringify({
          type: 'assistant',
          message: {
            id: 'msg_1',
            role: 'assistant',
            model: 'claude-opus-4-7',
            content: [
              { type: 'thinking', thinking: 'I should reason carefully', signature: 'sig123' },
              { type: 'text', text: 'Final answer.' },
            ],
          },
        }),
      });

      const descriptors = await parser.parseMessage(msg, makeContext());

      expect(descriptors).toHaveLength(2);
      expect(descriptors[0]).toMatchObject({
        type: 'assistant_message',
        text: '',
        thinking: 'I should reason carefully',
        thinkingSignature: 'sig123',
        model: 'claude-opus-4-7',
      });
      expect(descriptors[1]).toMatchObject({
        type: 'assistant_message',
        text: 'Final answer.',
        model: 'claude-opus-4-7',
      });
    });

    it('summarises deferred_tools_delta attachment entries as a status system_message', async () => {
      const parser = new ClaudeCodeRawParser();
      const msg = makeRawMessage({
        content: JSON.stringify({
          type: 'attachment',
          attachment: {
            type: 'deferred_tools_delta',
            addedNames: ['TodoWrite', 'WebFetch'],
          },
        }),
      });

      const descriptors = await parser.parseMessage(msg, makeContext());

      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]).toMatchObject({
        type: 'system_message',
        systemType: 'status',
        text: 'Tools added: TodoWrite, WebFetch',
      });
    });

    it('summarises skill_listing attachments', async () => {
      const parser = new ClaudeCodeRawParser();
      const msg = makeRawMessage({
        content: JSON.stringify({
          type: 'attachment',
          attachment: { type: 'skill_listing', content: '...' },
        }),
      });

      const descriptors = await parser.parseMessage(msg, makeContext());

      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]).toMatchObject({
        type: 'system_message',
        systemType: 'status',
        text: 'Skills list refreshed',
      });
    });

    it('uses args.subagent_type for the subagent agentType', async () => {
      const parser = new ClaudeCodeRawParser();
      const msg = makeRawMessage({
        content: JSON.stringify({
          type: 'assistant',
          message: {
            id: 'msg_2',
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_subagent',
                name: 'Task',
                input: { subagent_type: 'Explore', prompt: 'go look' },
              },
            ],
          },
        }),
      });

      const descriptors = await parser.parseMessage(msg, makeContext());
      const started = descriptors.find(d => d.type === 'subagent_started') as any;
      expect(started).toBeDefined();
      expect(started.agentType).toBe('Explore');
    });
  });
});
