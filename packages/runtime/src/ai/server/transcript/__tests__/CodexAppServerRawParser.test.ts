/**
 * Contract tests for CodexAppServerRawParser.
 *
 * Verifies that representative app-server raw messages produce the expected
 * canonical event descriptors. Raw message content shape:
 *   `JSON.stringify({ method, params })`
 * with `metadata.transport = 'app-server'`.
 */

import { describe, it, expect } from 'vitest';
import { CodexAppServerRawParser } from '../parsers/CodexAppServerRawParser';
import type { ParseContext } from '../parsers/IRawMessageParser';
import type { RawMessage } from '../TranscriptTransformer';

const SESSION_ID = 'test-session';

function makeRawMessage(overrides: Partial<RawMessage>): RawMessage {
  return {
    id: 1,
    sessionId: SESSION_ID,
    source: 'openai-codex',
    direction: 'output',
    content: '',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    metadata: { transport: 'app-server' },
    ...overrides,
  };
}

function envelope(method: string, params: Record<string, unknown>): string {
  return JSON.stringify({ method, params });
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

describe('CodexAppServerRawParser', () => {
  it('parses item/completed agentMessage into an assistant_message descriptor', async () => {
    const parser = new CodexAppServerRawParser();
    const msg = makeRawMessage({
      content: envelope('item/completed', {
        threadId: 't-1',
        turnId: 'turn-1',
        item: { id: 'msg-1', type: 'agentMessage', text: 'hello there', status: 'completed' },
      }),
    });
    const descs = await parser.parseMessage(msg, makeContext());
    expect(descs).toEqual([{ type: 'assistant_message', text: 'hello there', createdAt: msg.createdAt }]);
  });

  it('dedupes repeated item and terminal turn notifications on the same parser instance', async () => {
    const parser = new CodexAppServerRawParser();
    const messageCompleted = makeRawMessage({
      id: 2,
      content: envelope('item/completed', {
        threadId: 't-1',
        turnId: 'turn-1',
        item: { id: 'msg-dup', type: 'agentMessage', text: 'hello there', status: 'completed' },
      }),
    });
    const firstMessage = await parser.parseMessage(messageCompleted, makeContext());
    const secondMessage = await parser.parseMessage(messageCompleted, makeContext());
    expect(firstMessage).toEqual([{ type: 'assistant_message', text: 'hello there', createdAt: messageCompleted.createdAt }]);
    expect(secondMessage).toEqual([]);

    const turnCompleted = makeRawMessage({
      id: 3,
      content: envelope('turn/completed', {
        threadId: 't-1',
        turn: { id: 'turn-1', status: 'completed' },
        usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
      }),
    });
    const firstTurn = await parser.parseMessage(turnCompleted, makeContext());
    const secondTurn = await parser.parseMessage(turnCompleted, makeContext());
    expect(firstTurn).toHaveLength(1);
    expect(firstTurn[0]).toMatchObject({ type: 'turn_ended' });
    expect(secondTurn).toEqual([]);
  });

  it('parses item/completed fileChange into started + completed tool-call descriptors', async () => {
    const parser = new CodexAppServerRawParser();
    const msg = makeRawMessage({
      content: envelope('item/completed', {
        threadId: 't-1',
        turnId: 'turn-1',
        item: {
          id: 'call_abc',
          type: 'fileChange',
          status: 'completed',
          changes: [
            { path: '/tmp/a.md', kind: { type: 'add' }, diff: 'hello\n' },
            { path: '/tmp/b.md', kind: { type: 'update', move_path: null }, diff: '@@ -1,1 +1,1 @@\n-old\n+new\n' },
          ],
        },
      }),
    });
    const descs = await parser.parseMessage(msg, makeContext());
    expect(descs).toHaveLength(2);
    expect(descs[0]).toMatchObject({ type: 'tool_call_started', toolName: 'file_change', targetFilePath: '/tmp/a.md' });
    expect((descs[0] as unknown as { arguments: { changes: Array<{ path: string }> } }).arguments.changes).toHaveLength(2);
    expect(descs[1]).toMatchObject({ type: 'tool_call_completed', status: 'completed', isError: false });
    // Both descriptors carry the same synthetic edit-group ID.
    const startedId = (descs[0] as { providerToolCallId: string }).providerToolCallId;
    const completedId = (descs[1] as { providerToolCallId: string }).providerToolCallId;
    expect(startedId).toBe(completedId);
  });

  it('reuses editGroupId from message metadata when present', async () => {
    const parser = new CodexAppServerRawParser();
    const msg = makeRawMessage({
      metadata: { transport: 'app-server', editGroupId: 'nimtc|call_abc|123|45' },
      content: envelope('item/completed', {
        threadId: 't-1',
        turnId: 'turn-1',
        item: {
          id: 'call_abc',
          type: 'fileChange',
          status: 'completed',
          changes: [{ path: '/tmp/a.md', kind: { type: 'add' }, diff: 'hello\n' }],
        },
      }),
    });
    const descs = await parser.parseMessage(msg, makeContext());
    expect((descs[0] as { providerToolCallId: string }).providerToolCallId).toBe('nimtc|call_abc|123|45');
  });

  it('parses item/completed mcpToolCall into started + completed with mcpServer/mcpTool set', async () => {
    const parser = new CodexAppServerRawParser();
    const msg = makeRawMessage({
      content: envelope('item/completed', {
        threadId: 't-1',
        turnId: 'turn-1',
        item: {
          id: 'mcp-1',
          type: 'mcpToolCall',
          status: 'completed',
          server: 'nimbalyst-mcp',
          tool: 'tracker_list',
          arguments: { type: 'bug' },
          result: { content: [{ type: 'text', text: '3 bugs found' }] },
        },
      }),
    });
    const descs = await parser.parseMessage(msg, makeContext());
    expect(descs).toHaveLength(2);
    expect(descs[0]).toMatchObject({
      type: 'tool_call_started',
      toolName: 'mcp__nimbalyst-mcp__tracker_list',
      mcpServer: 'nimbalyst-mcp',
      mcpTool: 'tracker_list',
    });
    expect(descs[1]).toMatchObject({ type: 'tool_call_completed', status: 'completed', result: '3 bugs found' });
  });

  it('parses item/completed commandExecution with exit code', async () => {
    const parser = new CodexAppServerRawParser();
    const msg = makeRawMessage({
      content: envelope('item/completed', {
        threadId: 't-1',
        turnId: 'turn-1',
        item: {
          id: 'cmd-1',
          type: 'commandExecution',
          status: 'completed',
          command: 'ls',
          aggregated_output: 'a\nb\nc',
          exit_code: 0,
        },
      }),
    });
    const descs = await parser.parseMessage(msg, makeContext());
    expect(descs).toHaveLength(2);
    expect(descs[0]).toMatchObject({ type: 'tool_call_started', toolName: 'command_execution', arguments: { command: 'ls' } });
    expect(descs[1]).toMatchObject({ type: 'tool_call_completed', exitCode: 0, result: 'a\nb\nc' });
  });

  it('parses camel-case commandExecution fields emitted by the app server', async () => {
    const parser = new CodexAppServerRawParser();
    const msg = makeRawMessage({
      content: envelope('item/completed', {
        threadId: 't-1',
        turnId: 'turn-1',
        item: {
          id: 'cmd-2',
          type: 'commandExecution',
          status: 'completed',
          command: 'pwd',
          aggregatedOutput: '/tmp/project',
          exitCode: 0,
        },
      }),
    });

    const descs = await parser.parseMessage(msg, makeContext());

    expect(descs[1]).toMatchObject({
      type: 'tool_call_completed',
      exitCode: 0,
      result: '/tmp/project',
    });
  });

  it('emits a system_message for an error notification', async () => {
    const parser = new CodexAppServerRawParser();
    const msg = makeRawMessage({
      content: envelope('error', {
        threadId: 't-1',
        turnId: 'turn-1',
        error: { message: 'rate limited' },
      }),
    });
    const descs = await parser.parseMessage(msg, makeContext());
    expect(descs).toEqual([{ type: 'system_message', text: 'rate limited', systemType: 'error', createdAt: msg.createdAt }]);
  });

  it('returns no descriptors for delta and status-only notifications', async () => {
    const parser = new CodexAppServerRawParser();
    for (const method of ['item/agentMessage/delta', 'thread/started', 'mcpServer/startupStatus/updated']) {
      const msg = makeRawMessage({ content: envelope(method, { foo: 'bar' }) });
      const descs = await parser.parseMessage(msg, makeContext());
      expect(descs).toEqual([]);
    }
  });

  it('does not render legacy mobile-sync whole-message markers as assistant messages', async () => {
    const parser = new CodexAppServerRawParser();
    const msg = makeRawMessage({
      content: '[Full openai-codex message elided from mobile sync: 32.1 KB raw. View on desktop for the full content.]',
    });

    const descs = await parser.parseMessage(msg, makeContext());

    expect(descs).toEqual([]);
  });

  it('emits tool_call_started for item/started on mcpToolCall items and does not duplicate on later completion', async () => {
    // Custom widgets (developer_git_commit_proposal, AskUserQuestion) render
    // off `tool_call_started`. For MCP tools that block on the user, the
    // started canonical event MUST exist before item/completed (which only
    // fires after the user clicks through the widget). Without this path the
    // tool deadlocks: agent is waiting on MCP, MCP is waiting on user, user
    // is waiting on a widget that has no canonical event to render from.
    const parser = new CodexAppServerRawParser();
    const startMsg = makeRawMessage({
      id: 10,
      content: envelope('item/started', {
        threadId: 't-1',
        turnId: 'turn-1',
        item: {
          id: 'mcp-pending-1',
          type: 'mcpToolCall',
          status: 'in_progress',
          server: 'nimbalyst-mcp',
          tool: 'developer_git_commit_proposal',
          arguments: { commitMessage: 'feat: x', filesToStage: ['a.ts'] },
        },
      }),
    });
    const startedDescs = await parser.parseMessage(startMsg, makeContext());
    expect(startedDescs).toHaveLength(1);
    expect(startedDescs[0]).toMatchObject({
      type: 'tool_call_started',
      toolName: 'mcp__nimbalyst-mcp__developer_git_commit_proposal',
      mcpServer: 'nimbalyst-mcp',
      mcpTool: 'developer_git_commit_proposal',
    });
    const startedProviderId = (startedDescs[0] as { providerToolCallId: string }).providerToolCallId;
    expect(startedProviderId).toMatch(/^nimtc\|/);

    // item/completed for the same rawItemId on the SAME parser instance must
    // NOT re-emit a started descriptor (would create two canonical
    // tool_call_started rows for the same call) and must reuse the original
    // providerToolCallId.
    const completedMsg = makeRawMessage({
      id: 11,
      content: envelope('item/completed', {
        threadId: 't-1',
        turnId: 'turn-1',
        item: {
          id: 'mcp-pending-1',
          type: 'mcpToolCall',
          status: 'completed',
          server: 'nimbalyst-mcp',
          tool: 'developer_git_commit_proposal',
          arguments: { commitMessage: 'feat: x', filesToStage: ['a.ts'] },
          result: { content: [{ type: 'text', text: 'committed abc123' }] },
        },
      }),
    });
    const completedDescs = await parser.parseMessage(completedMsg, makeContext());
    expect(completedDescs).toHaveLength(1);
    expect(completedDescs[0]).toMatchObject({
      type: 'tool_call_completed',
      providerToolCallId: startedProviderId,
      status: 'completed',
    });
  });

  it('parses collabAgentToolCall spawnAgent into subagent start/completed descriptors', async () => {
    const parser = new CodexAppServerRawParser();
    const startMsg = makeRawMessage({
      id: 20,
      content: envelope('item/started', {
        threadId: 't-1',
        turnId: 'turn-1',
        item: {
          id: 'spawn-1',
          type: 'collabAgentToolCall',
          tool: 'spawnAgent',
          status: 'inProgress',
          prompt: 'Create a plan',
          model: 'gpt-5.4',
          reasoningEffort: 'high',
        },
      }),
    });
    const startedDescs = await parser.parseMessage(startMsg, makeContext({
      hasSubagent: (subagentId: string) => subagentId === 'spawn-1',
    }));
    expect(startedDescs).toEqual([{
      type: 'subagent_started',
      subagentId: 'spawn-1',
      agentType: 'Session',
      prompt: 'Create a plan',
      model: 'gpt-5.4',
      reasoningEffort: 'high',
      createdAt: startMsg.createdAt,
    }]);

    const completedMsg = makeRawMessage({
      id: 21,
      content: envelope('item/completed', {
        threadId: 't-1',
        turnId: 'turn-1',
        item: {
          id: 'spawn-1',
          type: 'collabAgentToolCall',
          tool: 'spawnAgent',
          status: 'completed',
          prompt: 'Create a plan',
          receiverThreadIds: ['thread-child-1'],
          model: 'gpt-5.4',
          reasoningEffort: 'high',
        },
      }),
    });
    const completedDescs = await parser.parseMessage(completedMsg, makeContext({
      hasSubagent: (subagentId: string) => subagentId === 'spawn-1',
    }));
    expect(completedDescs).toEqual([{
      type: 'subagent_completed',
      subagentId: 'spawn-1',
      status: 'completed',
      resultSummary: 'receiver_thread_ids: thread-child-1',
      model: 'gpt-5.4',
      reasoningEffort: 'high',
    }]);
  });

  it('parses non-spawn collabAgentToolCall items into tool-call descriptors', async () => {
    const parser = new CodexAppServerRawParser();
    const startMsg = makeRawMessage({
      id: 30,
      content: envelope('item/started', {
        threadId: 't-1',
        turnId: 'turn-1',
        item: {
          id: 'wait-1',
          type: 'collabAgentToolCall',
          tool: 'wait',
          status: 'inProgress',
          receiverThreadIds: ['thread-child-1', 'thread-child-2'],
        },
      }),
    });
    const startedDescs = await parser.parseMessage(startMsg, makeContext());
    expect(startedDescs).toHaveLength(1);
    expect(startedDescs[0]).toMatchObject({
      type: 'tool_call_started',
      toolName: 'wait',
      arguments: {
        receiverThreadIds: ['thread-child-1', 'thread-child-2'],
      },
    });
    const startedProviderId = (startedDescs[0] as { providerToolCallId: string }).providerToolCallId;

    const completedMsg = makeRawMessage({
      id: 31,
      content: envelope('item/completed', {
        threadId: 't-1',
        turnId: 'turn-1',
        item: {
          id: 'wait-1',
          type: 'collabAgentToolCall',
          tool: 'wait',
          status: 'completed',
          receiverThreadIds: ['thread-child-1', 'thread-child-2'],
        },
      }),
    });
    const completedDescs = await parser.parseMessage(completedMsg, makeContext());
    expect(completedDescs).toHaveLength(2);
    expect(completedDescs[0]).toMatchObject({
      type: 'tool_call_started',
      toolName: 'wait',
    });
    expect(completedDescs[1]).toMatchObject({
      type: 'tool_call_completed',
      providerToolCallId: startedProviderId,
      status: 'completed',
      result: 'receiver_thread_ids: thread-child-1, thread-child-2',
    });
  });

  it('parses todoList items into an assistant checklist message', async () => {
    const parser = new CodexAppServerRawParser();
    const msg = makeRawMessage({
      id: 40,
      content: envelope('item/completed', {
        threadId: 't-1',
        turnId: 'turn-1',
        item: {
          id: 'todo-1',
          type: 'todoList',
          status: 'completed',
          items: [
            { text: 'Inspect transcript parser', completed: true },
            { text: 'Add collab-agent coverage', completed: false },
          ],
        },
      }),
    });
    const descs = await parser.parseMessage(msg, makeContext());
    expect(descs).toEqual([{
      type: 'assistant_message',
      text: '- [x] Inspect transcript parser\n- [ ] Add collab-agent coverage',
      createdAt: msg.createdAt,
    }]);
  });

  it('falls back to a generic tool call for unknown tool-like app-server items', async () => {
    const parser = new CodexAppServerRawParser();
    const msg = makeRawMessage({
      id: 50,
      content: envelope('item/completed', {
        threadId: 't-1',
        turnId: 'turn-1',
        item: {
          id: 'web-1',
          type: 'webSearch',
          status: 'completed',
          query: 'claude code transcripts',
          result: {
            content: [{ type: 'text', text: 'search complete' }],
          },
        },
      }),
    });
    const descs = await parser.parseMessage(msg, makeContext());
    expect(descs).toHaveLength(2);
    expect(descs[0]).toMatchObject({
      type: 'tool_call_started',
      toolName: 'webSearch',
      arguments: {
        query: 'claude code transcripts',
      },
    });
    expect(descs[1]).toMatchObject({
      type: 'tool_call_completed',
      status: 'completed',
      result: 'search complete',
    });
  });
});
