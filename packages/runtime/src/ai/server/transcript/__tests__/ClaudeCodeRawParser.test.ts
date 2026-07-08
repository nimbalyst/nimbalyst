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

    it('parses wakeup_resume prompt as system_message, not user_message', async () => {
      const parser = new ClaudeCodeRawParser();
      const msg = makeRawMessage({
        direction: 'input',
        content: JSON.stringify({ prompt: 'Continue working on the feature', options: {} }),
        metadata: { promptOrigin: 'wakeup_resume' },
      });

      const descriptors = await parser.parseMessage(msg, makeContext());

      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]).toMatchObject({
        type: 'system_message',
        systemType: 'status',
        reminderKind: 'wakeup_resume',
        text: 'Continue working on the feature',
      });
    });

    it('does not treat regular user prompt with promptOrigin absent as wakeup', async () => {
      const parser = new ClaudeCodeRawParser();
      const msg = makeRawMessage({
        direction: 'input',
        content: JSON.stringify({ prompt: 'Hello world', options: {} }),
      });

      const descriptors = await parser.parseMessage(msg, makeContext());

      expect(descriptors).toHaveLength(1);
      expect(descriptors[0].type).toBe('user_message');
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

    it('emits result chunk text on resume when num_turns is 0 (unknown slash command)', async () => {
      // Regression: on a resumed session, suppressResultChunkText is set to
      // avoid duplicating prior assistant text. But a turn with num_turns===0
      // (e.g. "Unknown command: /foo") has zero assistant chunks and the result
      // text is the only signal of what happened. Suppressing it leaves the
      // turn rendered as completely blank UI, hiding the failure.
      const parser = new ClaudeCodeRawParser();
      parser.setSuppressResultChunkText(true); // resume batch

      const descriptors = await parser.parseMessage(
        makeRawMessage({
          content: JSON.stringify({
            type: 'result',
            subtype: 'success',
            is_error: false,
            num_turns: 0,
            result: 'Unknown command: /nimbalyst-planning:launch-new-session',
          }),
        }),
        makeContext(),
      );

      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]).toMatchObject({
        type: 'assistant_message',
        text: 'Unknown command: /nimbalyst-planning:launch-new-session',
      });
    });

    it('emits result chunk text with num_turns 0 even after prior turns produced text in the same batch', async () => {
      // Regression: in a full-session reparse, processedTextMessageIds
      // accumulates across all turns processed in the batch. By the time we
      // reach a later turn's result chunk, it's non-empty -- but a result
      // chunk with num_turns===0 belongs to a turn that ran zero assistant
      // turns, so its text cannot duplicate anything from prior turns.
      const parser = new ClaudeCodeRawParser();

      // Prior turn produces assistant text.
      await parser.parseMessage(
        makeRawMessage({
          content: JSON.stringify({
            type: 'assistant',
            message: { id: 'msg-1', content: [{ type: 'text', text: 'Plan written.' }] },
          }),
        }),
        makeContext(),
      );

      // Later turn: unknown slash command, num_turns 0, only a result chunk.
      const descriptors = await parser.parseMessage(
        makeRawMessage({
          id: 99,
          content: JSON.stringify({
            type: 'result',
            subtype: 'success',
            is_error: false,
            num_turns: 0,
            result: 'Unknown command: /nimbalyst-planning:launch-new-session',
          }),
        }),
        makeContext(),
      );

      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]).toMatchObject({
        type: 'assistant_message',
        text: 'Unknown command: /nimbalyst-planning:launch-new-session',
      });
    });

    it('still suppresses result chunk text on resume when num_turns > 0', async () => {
      // The carve-out above is gated on num_turns===0. A resumed turn that
      // actually ran assistant turns must still suppress its result echo to
      // avoid duplicating text already produced via assistant chunks in
      // prior batches.
      const parser = new ClaudeCodeRawParser();
      parser.setSuppressResultChunkText(true);

      const descriptors = await parser.parseMessage(
        makeRawMessage({
          content: JSON.stringify({
            type: 'result',
            subtype: 'success',
            is_error: false,
            num_turns: 3,
            result: 'Final assistant response',
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

    it('drops the sync whole-message elision marker instead of rendering a stray bubble', async () => {
      const parser = new ClaudeCodeRawParser();
      const msg = makeRawMessage({
        content:
          '[Full claude-code message elided from mobile sync: 29.2 KB raw. View on desktop for the full content.]',
      });

      const descriptors = await parser.parseMessage(msg, makeContext());

      expect(descriptors).toHaveLength(0);
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

    // Regression: when the commit proposal widget posts back its result, the
    // response row lives in ai_agent_messages as { type: 'git_commit_proposal_response' }
    // with source='nimbalyst'. Without parser support the canonical tool_call
    // event for developer_git_commit_proposal stays at status='running' /
    // result=undefined, and the widget renders as "pending" forever even after
    // a successful commit. See session cb82f2eb-941c-4fb5-b552-adbae567df61.
    describe('git_commit_proposal_response', () => {
      it('emits tool_call_completed with structured result for a committed response', async () => {
        const parser = new ClaudeCodeRawParser();
        const msg = makeRawMessage({
          source: 'nimbalyst',
          content: JSON.stringify({
            type: 'git_commit_proposal_response',
            proposalId: 'toolu_proposal_1',
            action: 'committed',
            commitHash: '0b02b2301eecf073c716f8f0da43d458a611c568',
            commitDate: '2026-06-01T17:00:20-04:00',
            filesCommitted: ['packages/electron/build/build-worker.js'],
            commitMessage: 'fix: SQLite migration adopt crash in packaged builds',
            respondedAt: 1780347621666,
            respondedBy: 'desktop',
          }),
        });

        const context = makeContext({
          hasToolCall: (id) => id === 'toolu_proposal_1',
        });
        const descriptors = await parser.parseMessage(msg, context);

        expect(descriptors).toHaveLength(1);
        const completed = descriptors[0] as any;
        expect(completed.type).toBe('tool_call_completed');
        expect(completed.providerToolCallId).toBe('toolu_proposal_1');
        expect(completed.status).toBe('completed');
        expect(completed.isError).toBe(false);
        const parsedResult = JSON.parse(completed.result);
        expect(parsedResult.action).toBe('committed');
        expect(parsedResult.commitHash).toBe('0b02b2301eecf073c716f8f0da43d458a611c568');
        expect(parsedResult.filesCommitted).toEqual(['packages/electron/build/build-worker.js']);
      });

      it('emits tool_call_completed with status=error for an error response', async () => {
        const parser = new ClaudeCodeRawParser();
        const msg = makeRawMessage({
          source: 'nimbalyst',
          content: JSON.stringify({
            type: 'git_commit_proposal_response',
            proposalId: 'toolu_proposal_2',
            action: 'error',
            error: 'No files were staged. The files may not exist or have no changes.',
            respondedAt: 1780347829579,
            respondedBy: 'desktop',
          }),
        });

        const context = makeContext({
          hasToolCall: (id) => id === 'toolu_proposal_2',
        });
        const descriptors = await parser.parseMessage(msg, context);

        expect(descriptors).toHaveLength(1);
        const completed = descriptors[0] as any;
        expect(completed.type).toBe('tool_call_completed');
        expect(completed.providerToolCallId).toBe('toolu_proposal_2');
        expect(completed.status).toBe('error');
        expect(completed.isError).toBe(true);
      });

      it('does not overwrite an existing committed result with a later error response', async () => {
        // Mirrors session cb82f2eb where a second error response arrived ~3
        // minutes after a successful commit (e.g. duplicate click). The committed
        // outcome must win so the widget keeps showing the commit hash.
        const parser = new ClaudeCodeRawParser();
        const msg = makeRawMessage({
          source: 'nimbalyst',
          content: JSON.stringify({
            type: 'git_commit_proposal_response',
            proposalId: 'toolu_proposal_3',
            action: 'error',
            error: 'No files were staged.',
          }),
        });

        const existingCommittedEvent = {
          id: 42,
          payload: {
            result: JSON.stringify({
              action: 'committed',
              commitHash: 'abc123',
            }),
          },
        } as any;

        const context = makeContext({
          hasToolCall: (id) => id === 'toolu_proposal_3',
          findByProviderToolCallId: async (id) =>
            id === 'toolu_proposal_3' ? existingCommittedEvent : null,
        });
        const descriptors = await parser.parseMessage(msg, context);

        expect(descriptors).toHaveLength(0);
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

  describe('auto-mode permission_denied (issue #371)', () => {
    it('parses system/permission_denied raw message into a system_message descriptor', async () => {
      const parser = new ClaudeCodeRawParser();
      const msg = makeRawMessage({
        content: JSON.stringify({
          type: 'system',
          subtype: 'permission_denied',
          tool_name: 'Bash',
          tool_use_id: 'toolu_abc',
          tool_input: { command: 'rm -rf /' },
          decision_reason: 'Destructive operation',
          decision_reason_type: 'classifier',
          message: 'rm -rf is destructive and was auto-denied',
        }),
      });

      const descriptors = await parser.parseMessage(msg, makeContext());

      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]).toMatchObject({
        type: 'system_message',
        systemType: 'permission_denied',
        deniedToolName: 'Bash',
        deniedReason: 'Destructive operation',
        deniedReasonType: 'classifier',
        deniedInput: { command: 'rm -rf /' },
        text: 'rm -rf is destructive and was auto-denied',
      });
    });

    it('falls back to a synthesised text when SDK omits message field', async () => {
      const parser = new ClaudeCodeRawParser();
      const msg = makeRawMessage({
        content: JSON.stringify({
          type: 'system',
          subtype: 'permission_denied',
          tool_name: 'Write',
          decision_reason: 'Protected path',
        }),
      });

      const descriptors = await parser.parseMessage(msg, makeContext());

      expect(descriptors).toHaveLength(1);
      const desc = descriptors[0] as CanonicalEventDescriptor & { text?: string };
      expect(desc.type).toBe('system_message');
      expect(desc.text).toBe('Write was denied: Protected path');
    });

    it('handles permission_denied with no reason fields gracefully', async () => {
      const parser = new ClaudeCodeRawParser();
      const msg = makeRawMessage({
        content: JSON.stringify({
          type: 'system',
          subtype: 'permission_denied',
          tool_name: 'Edit',
        }),
      });

      const descriptors = await parser.parseMessage(msg, makeContext());

      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]).toMatchObject({
        type: 'system_message',
        systemType: 'permission_denied',
        deniedToolName: 'Edit',
        text: 'Edit was denied',
      });
    });
  });
});
