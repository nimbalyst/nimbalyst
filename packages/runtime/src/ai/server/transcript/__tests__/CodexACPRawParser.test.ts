/**
 * Contract tests for CodexACPRawParser.
 *
 * Verifies that representative raw ACP `session/update` envelopes produce
 * the expected canonical event descriptors. The exact envelope shape is
 * defined by CodexACPProtocol.handleSessionUpdate() / mapSessionUpdate().
 */

import { describe, it, expect } from 'vitest';
import { CodexACPRawParser } from '../parsers/CodexACPRawParser';
import type { ParseContext } from '../parsers/IRawMessageParser';
import type { RawMessage } from '../TranscriptTransformer';

const SESSION_ID = 'test-session';

function makeRawMessage(overrides: Partial<RawMessage>): RawMessage {
  return {
    id: 1,
    sessionId: SESSION_ID,
    source: 'openai-codex-acp',
    direction: 'output',
    content: '',
    createdAt: new Date('2026-04-27T00:00:00Z'),
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

function envelope(update: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'session/update',
    sessionId: SESSION_ID,
    update,
  });
}

describe('CodexACPRawParser', () => {
  describe('input messages', () => {
    it('treats plain text input as user_message', async () => {
      const parser = new CodexACPRawParser();
      const msg = makeRawMessage({ direction: 'input', content: 'Hello ACP' });

      const descriptors = await parser.parseMessage(msg, makeContext());

      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]).toMatchObject({
        type: 'user_message',
        text: 'Hello ACP',
      });
    });

    it('marks SYSTEM_REMINDER input as system_message', async () => {
      const parser = new CodexACPRawParser();
      const msg = makeRawMessage({
        direction: 'input',
        content: '<SYSTEM_REMINDER>Name your session</SYSTEM_REMINDER>',
        metadata: { promptType: 'system_reminder', reminderKind: 'session_naming' },
      });

      const descriptors = await parser.parseMessage(msg, makeContext());

      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]).toMatchObject({
        type: 'system_message',
        systemType: 'status',
        reminderKind: 'session_naming',
      });
    });
  });

  describe('agent_message_chunk', () => {
    it('emits assistant_message for text content', async () => {
      const parser = new CodexACPRawParser();
      const msg = makeRawMessage({
        content: envelope({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Hello from ACP' },
        }),
      });

      const descriptors = await parser.parseMessage(msg, makeContext());

      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]).toMatchObject({
        type: 'assistant_message',
        text: 'Hello from ACP',
      });
    });

    it('skips empty text', async () => {
      const parser = new CodexACPRawParser();
      const msg = makeRawMessage({
        content: envelope({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: '' },
        }),
      });

      const descriptors = await parser.parseMessage(msg, makeContext());

      expect(descriptors).toHaveLength(0);
    });
  });

  describe('tool_call', () => {
    it('emits tool_call_started with derived name and target file path', async () => {
      const parser = new CodexACPRawParser();
      const msg = makeRawMessage({
        content: envelope({
          sessionUpdate: 'tool_call',
          toolCallId: 'tool-1',
          title: 'acp_fs.write_text_file (foo.txt)',
          kind: 'edit',
          rawInput: { path: '/tmp/foo.txt', content: 'hi' },
        }),
      });

      const descriptors = await parser.parseMessage(msg, makeContext());

      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]).toMatchObject({
        type: 'tool_call_started',
        toolName: 'Write',
        providerToolCallId: 'tool-1',
        targetFilePath: '/tmp/foo.txt',
      });
    });

    it('maps acp_fs.read_text_file → Read', async () => {
      const parser = new CodexACPRawParser();
      const msg = makeRawMessage({
        content: envelope({
          sessionUpdate: 'tool_call',
          toolCallId: 'tool-2',
          title: 'acp_fs.read_text_file',
          kind: 'read',
          rawInput: { path: '/tmp/bar.txt' },
        }),
      });

      const descriptors = await parser.parseMessage(msg, makeContext());

      expect(descriptors[0]).toMatchObject({
        type: 'tool_call_started',
        toolName: 'Read',
      });
    });

    it('treats serverName.toolName as MCP tool with mcp__ prefix', async () => {
      const parser = new CodexACPRawParser();
      const msg = makeRawMessage({
        content: envelope({
          sessionUpdate: 'tool_call',
          toolCallId: 'tool-3',
          title: 'nimbalyst-session-naming.update_session_meta',
          rawInput: { name: 'My session' },
        }),
      });

      const descriptors = await parser.parseMessage(msg, makeContext());

      expect(descriptors[0]).toMatchObject({
        type: 'tool_call_started',
        toolName: 'mcp__nimbalyst-session-naming__update_session_meta',
        mcpServer: 'nimbalyst-session-naming',
        mcpTool: 'update_session_meta',
      });
    });

    it('promotes locations[0].path into args/targetFilePath when rawInput has no path (apply_patch case)', async () => {
      // Codex's apply_patch emits a tool_call with kind:'edit' and rawInput
      // shaped like { command: '...', patch: '...' } -- no file path. The
      // path lives in ACP's locations[]. Without the promotion, edit
      // tracking can't attribute the file.
      const parser = new CodexACPRawParser();
      const msg = makeRawMessage({
        content: envelope({
          sessionUpdate: 'tool_call',
          toolCallId: 'tool-apply-patch',
          title: 'apply_patch',
          kind: 'edit',
          rawInput: { command: 'apply_patch', patch: '*** Update File: foo.ts\n...' },
          locations: [{ path: '/repo/foo.ts', line: 12 }],
        }),
      });

      const descriptors = await parser.parseMessage(msg, makeContext());

      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]).toMatchObject({
        type: 'tool_call_started',
        toolName: 'ApplyPatch',
        targetFilePath: '/repo/foo.ts',
      });
      const args = (descriptors[0] as { arguments?: Record<string, unknown> }).arguments;
      expect(args?.path).toBe('/repo/foo.ts');
      expect(args?.command).toBe('apply_patch');
    });

    it('does not clobber an existing rawInput path with locations[]', async () => {
      const parser = new CodexACPRawParser();
      const msg = makeRawMessage({
        content: envelope({
          sessionUpdate: 'tool_call',
          toolCallId: 'tool-with-explicit-path',
          title: 'acp_fs.write_text_file',
          kind: 'edit',
          rawInput: { path: '/explicit/path.txt' },
          locations: [{ path: '/different/path.txt' }],
        }),
      });

      const descriptors = await parser.parseMessage(msg, makeContext());

      expect((descriptors[0] as { arguments?: Record<string, unknown> }).arguments?.path).toBe('/explicit/path.txt');
      expect(descriptors[0]).toMatchObject({ targetFilePath: '/explicit/path.txt' });
    });

    it('skips duplicate tool_call descriptors via context.hasToolCall', async () => {
      const parser = new CodexACPRawParser();
      const msg = makeRawMessage({
        content: envelope({
          sessionUpdate: 'tool_call',
          toolCallId: 'tool-4',
          title: 'acp_fs.write_text_file',
          rawInput: { path: '/tmp/x.txt' },
        }),
      });

      const descriptors = await parser.parseMessage(msg, makeContext({
        hasToolCall: (id) => id === 'tool-4',
      }));

      expect(descriptors).toHaveLength(0);
    });
  });

  describe('tool_call_update', () => {
    it('emits only tool_call_completed (started already exists from preceding tool_call)', async () => {
      const parser = new CodexACPRawParser();
      const msg = makeRawMessage({
        content: envelope({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tool-5',
          status: 'completed',
          title: 'acp_fs.write_text_file',
          rawInput: { path: '/tmp/y.txt' },
          rawOutput: { bytesWritten: 10 },
        }),
      });

      const descriptors = await parser.parseMessage(msg, makeContext());

      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]).toMatchObject({
        type: 'tool_call_completed',
        providerToolCallId: 'tool-5',
        status: 'completed',
        isError: false,
      });
    });

    it('emits failed status as error', async () => {
      const parser = new CodexACPRawParser();
      const msg = makeRawMessage({
        content: envelope({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tool-6',
          status: 'failed',
          rawOutput: { error: 'denied' },
        }),
      });

      const descriptors = await parser.parseMessage(msg, makeContext());

      const completed = descriptors.find((d) => d.type === 'tool_call_completed');
      expect(completed).toMatchObject({
        type: 'tool_call_completed',
        status: 'error',
        isError: true,
      });
    });
  });

  describe('session/request_permission', () => {
    it('emits tool_call_started so the user sees the pending tool', async () => {
      const parser = new CodexACPRawParser();
      const raw = JSON.stringify({
        type: 'session/request_permission',
        sessionId: SESSION_ID,
        request: {
          toolCall: {
            toolCallId: 'tool-7',
            title: 'acp_fs.write_text_file',
            kind: 'edit',
            rawInput: { path: '/tmp/z.txt' },
          },
        },
      });
      const msg = makeRawMessage({ content: raw });

      const descriptors = await parser.parseMessage(msg, makeContext());

      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]).toMatchObject({
        type: 'tool_call_started',
        toolName: 'Write',
        providerToolCallId: 'tool-7',
      });
    });
  });

  describe('hidden + non-session/update messages', () => {
    it('skips hidden messages', async () => {
      const parser = new CodexACPRawParser();
      const msg = makeRawMessage({
        hidden: true,
        content: envelope({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'should be skipped' },
        }),
      });

      const descriptors = await parser.parseMessage(msg, makeContext());
      expect(descriptors).toHaveLength(0);
    });

    it('returns empty for unknown event type', async () => {
      const parser = new CodexACPRawParser();
      const msg = makeRawMessage({
        content: JSON.stringify({ type: 'unrelated', payload: 1 }),
      });

      const descriptors = await parser.parseMessage(msg, makeContext());
      expect(descriptors).toHaveLength(0);
    });

    it('returns empty for non-JSON content', async () => {
      const parser = new CodexACPRawParser();
      const msg = makeRawMessage({ content: 'not json' });

      const descriptors = await parser.parseMessage(msg, makeContext());
      expect(descriptors).toHaveLength(0);
    });
  });
});
