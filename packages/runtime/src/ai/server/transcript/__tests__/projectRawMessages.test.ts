/**
 * Integration tests for projectRawMessagesToViewMessages -- the client-side
 * transcript projection used by mobile (iOS/Android) transcript bundles.
 *
 * Verifies that raw messages end up as properly projected TranscriptViewMessages
 * for both Claude Code and Codex providers, matching desktop rendering.
 */

import { describe, it, expect } from 'vitest';
import {
  projectRawMessagesToViewMessages,
  rawMessagesToCanonicalEvents,
} from '../projectRawMessages';
import type { RawMessage } from '../TranscriptTransformer';

const SESSION_ID = 'test-session';

function raw(overrides: Partial<RawMessage>): RawMessage {
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

describe('projectRawMessagesToViewMessages', () => {
  it('returns empty array for no messages', async () => {
    const vms = await projectRawMessagesToViewMessages([], 'claude-code');
    expect(vms).toEqual([]);
  });

  describe('Codex provider', () => {
    it('projects a user prompt followed by an assistant text response', async () => {
      const messages: RawMessage[] = [
        raw({
          id: 1,
          direction: 'input',
          content: JSON.stringify({ prompt: 'Hello codex' }),
        }),
        raw({
          id: 2,
          content: 'Sure -- hi back!',
        }),
      ];

      const vms = await projectRawMessagesToViewMessages(messages, 'openai-codex');

      expect(vms).toHaveLength(2);
      expect(vms[0]).toMatchObject({ type: 'user_message', text: 'Hello codex' });
      expect(vms[1]).toMatchObject({ type: 'assistant_message', text: 'Sure -- hi back!' });
    });

    it('projects a Codex function_call event as a tool_call view message (no raw JSON leaks)', async () => {
      const messages: RawMessage[] = [
        raw({
          id: 1,
          source: 'openai-codex',
          content: JSON.stringify({
            type: 'item.completed',
            item: {
              type: 'function_call',
              id: 'fc-1',
              name: 'Read',
              arguments: JSON.stringify({ file_path: '/test.ts' }),
              output: 'file contents here',
              status: 'completed',
            },
          }),
        }),
      ];

      const vms = await projectRawMessagesToViewMessages(messages, 'openai-codex');

      const toolCall = vms.find(m => m.type === 'tool_call');
      expect(toolCall).toBeDefined();
      expect(toolCall?.toolCall?.toolName).toBe('Read');

      // Regression: the raw Codex JSON must NOT appear as plain assistant text.
      const hasRawJsonText = vms.some(
        m => m.text && m.text.includes('"type":"item.completed"'),
      );
      expect(hasRawJsonText).toBe(false);
    });
  });

  describe('Codex item ID reuse across turns', () => {
    // Regression: Codex resets item IDs (item_1, item_2, ...) per turn within
    // a single session. The mobile path runs all messages through the parser
    // from scratch with a fresh in-memory event store, so the second turn's
    // item_1 must still produce a fresh tool_call event when the toolName
    // differs from the first turn's item_1. Without the fix, the parser's
    // hasToolCall(id) short-circuit silently drops every later-turn tool call.
    it('produces separate tool_call events when Codex reuses item_1 with a different toolName', async () => {
      const messages: RawMessage[] = [
        // Turn 1: item_1 is a command_execution
        raw({
          id: 1,
          source: 'openai-codex',
          content: JSON.stringify({
            type: 'item.started',
            item: {
              id: 'item_1',
              type: 'command_execution',
              command: 'rg --files',
              status: 'in_progress',
            },
          }),
        }),
        raw({
          id: 2,
          source: 'openai-codex',
          content: JSON.stringify({
            type: 'item.completed',
            item: {
              id: 'item_1',
              type: 'command_execution',
              command: 'rg --files',
              aggregated_output: 'a.ts\nb.ts',
              exit_code: 0,
              status: 'completed',
            },
          }),
        }),
        // Turn 2 reuses item_1 for an MCP git commit proposal
        raw({
          id: 3,
          source: 'openai-codex',
          content: JSON.stringify({
            type: 'item.started',
            item: {
              id: 'item_1',
              type: 'mcp_tool_call',
              server: 'nimbalyst-mcp',
              tool: 'developer_git_commit_proposal',
              arguments: { commitMessage: 'feat: x', filesToStage: ['a.ts'] },
              status: 'in_progress',
            },
          }),
        }),
      ];

      const vms = await projectRawMessagesToViewMessages(messages, 'openai-codex');

      const toolCalls = vms.filter((m) => m.type === 'tool_call');
      expect(toolCalls).toHaveLength(2);
      const names = toolCalls.map((m) => m.toolCall?.toolName).sort();
      expect(names).toEqual([
        'command_execution',
        'mcp__nimbalyst-mcp__developer_git_commit_proposal',
      ]);
    });

    it('produces separate tool_call events when Codex reuses item_0 for the same MCP tool name', async () => {
      const messages: RawMessage[] = [
        raw({
          id: 1,
          source: 'openai-codex',
          content: JSON.stringify({
            type: 'item.started',
            item: {
              id: 'item_0',
              type: 'mcp_tool_call',
              server: 'nimbalyst-mcp',
              tool: 'developer_git_commit_proposal',
              arguments: { commitMessage: 'first commit', filesToStage: ['a.ts'] },
              status: 'in_progress',
            },
          }),
        }),
        raw({
          id: 2,
          source: 'openai-codex',
          content: JSON.stringify({
            type: 'item.completed',
            item: {
              id: 'item_0',
              type: 'mcp_tool_call',
              server: 'nimbalyst-mcp',
              tool: 'developer_git_commit_proposal',
              result: {
                content: [{ type: 'text', text: 'Auto-committed 1 file(s).\nCommit hash: first123' }],
              },
              error: null,
              status: 'completed',
            },
          }),
        }),
        raw({
          id: 3,
          source: 'openai-codex',
          content: JSON.stringify({
            type: 'item.started',
            item: {
              id: 'item_0',
              type: 'mcp_tool_call',
              server: 'nimbalyst-mcp',
              tool: 'developer_git_commit_proposal',
              arguments: { commitMessage: 'second commit', filesToStage: ['b.ts'] },
              status: 'in_progress',
            },
          }),
        }),
        raw({
          id: 4,
          source: 'openai-codex',
          content: JSON.stringify({
            type: 'item.completed',
            item: {
              id: 'item_0',
              type: 'mcp_tool_call',
              server: 'nimbalyst-mcp',
              tool: 'developer_git_commit_proposal',
              result: {
                content: [{ type: 'text', text: 'Auto-committed 1 file(s).\nCommit hash: second456' }],
              },
              error: null,
              status: 'completed',
            },
          }),
        }),
      ];

      const vms = await projectRawMessagesToViewMessages(messages, 'openai-codex');

      const toolCalls = vms.filter((m) => m.type === 'tool_call');
      expect(toolCalls).toHaveLength(2);
      // CodexRawParser wraps raw item ids in synthetic edit-group IDs of
      // the form `nimtc|<rawId>|<ts>|<idx>` so reuses of `item_0` across
      // turns get distinct, durable canonical IDs.
      const firstId = toolCalls[0].toolCall?.providerToolCallId ?? '';
      const secondId = toolCalls[1].toolCall?.providerToolCallId ?? '';
      expect(firstId.startsWith('nimtc|item_0|')).toBe(true);
      expect(secondId.startsWith('nimtc|item_0|')).toBe(true);
      expect(firstId).not.toBe(secondId);
      expect((toolCalls[0].toolCall?.arguments as any).commitMessage).toBe('first commit');
      expect((toolCalls[1].toolCall?.arguments as any).commitMessage).toBe('second commit');
      expect(toolCalls[0].toolCall?.result).toContain('first123');
      expect(toolCalls[1].toolCall?.result).toContain('second456');
    });
  });

  describe('Codex app-server transport', () => {
    // Regression: the mobile path used to hardcode CodexRawParser (SDK shape),
    // so app-server-transport sessions parsed every output message as garbage,
    // the catch in rawMessagesToCanonicalEvents swallowed the throws, and only
    // user prompts (which share an input shape across transports) rendered.
    // The fix routes through CodexRawParserDispatcher.
    it('projects assistant + tool_call events from app-server-transport messages', async () => {
      const messages: RawMessage[] = [
        raw({
          id: 1,
          source: 'openai-codex',
          direction: 'input',
          content: JSON.stringify({ prompt: 'Hello codex' }),
        }),
        raw({
          id: 2,
          source: 'openai-codex',
          metadata: { transport: 'app-server', eventType: 'item/completed' },
          content: JSON.stringify({
            method: 'item/completed',
            params: {
              item: {
                id: 'item_0',
                type: 'agentMessage',
                status: 'completed',
                text: 'Sure -- hi back!',
              },
            },
          }),
        }),
        raw({
          id: 3,
          source: 'openai-codex',
          metadata: { transport: 'app-server', eventType: 'item/completed' },
          content: JSON.stringify({
            method: 'item/completed',
            params: {
              item: {
                id: 'item_1',
                type: 'mcpToolCall',
                status: 'completed',
                server: 'nimbalyst-mcp',
                tool: 'developer_git_log',
                arguments: { limit: 5 },
                result: { content: [{ type: 'text', text: 'log output' }] },
              },
            },
          }),
        }),
      ];

      const vms = await projectRawMessagesToViewMessages(messages, 'openai-codex');

      expect(vms.find(m => m.type === 'user_message')?.text).toBe('Hello codex');
      expect(vms.find(m => m.type === 'assistant_message')?.text).toBe('Sure -- hi back!');
      const toolCall = vms.find(m => m.type === 'tool_call');
      expect(toolCall?.toolCall?.toolName).toBe('mcp__nimbalyst-mcp__developer_git_log');
    });

    it('projects synthetic AskUserQuestion result rows onto app-server tool calls', async () => {
      const messages: RawMessage[] = [
        raw({
          id: 1,
          source: 'openai-codex',
          metadata: { transport: 'app-server', eventType: 'item/started' },
          content: JSON.stringify({
            method: 'item/started',
            params: {
              turnId: 'turn-ask',
              item: {
                id: 'call_question_123',
                type: 'mcpToolCall',
                status: 'in_progress',
                server: 'nimbalyst',
                tool: 'AskUserQuestion',
                arguments: {
                  questions: [
                    {
                      header: 'COMMIT SCOPE',
                      question: 'Which changes should be committed?',
                      options: [{ label: 'Everything' }],
                    },
                  ],
                },
              },
            },
          }),
        }),
        raw({
          id: 2,
          source: 'claude-code',
          content: JSON.stringify({
            type: 'nimbalyst_tool_result',
            tool_use_id: 'call_question_123',
            result: JSON.stringify({
              answers: { commit_scope: 'Everything' },
              cancelled: false,
              respondedBy: 'mobile',
            }),
            is_error: false,
          }),
        }),
      ];

      const vms = await projectRawMessagesToViewMessages(messages, 'openai-codex');

      const toolCall = vms.find(m => m.type === 'tool_call');
      expect(toolCall?.toolCall?.toolName).toBe('mcp__nimbalyst__AskUserQuestion');
      expect(toolCall?.toolCall?.providerToolCallId).toMatch(/^nimtc\|call_question_123\|/);
      expect(toolCall?.toolCall?.status).toBe('completed');
      expect(JSON.parse(toolCall?.toolCall?.result as string)).toMatchObject({
        answers: { commit_scope: 'Everything' },
        respondedBy: 'mobile',
      });
    });
  });

  describe('Codex ACP provider', () => {
    // Regression: mobile parser-selection used to fall through to ClaudeCodeRawParser
    // for openai-codex-acp sessions, silently dropping every ACP session/update
    // envelope (including tool widgets like the git commit proposal).
    it('routes openai-codex-acp messages through CodexACPRawParser', async () => {
      const messages: RawMessage[] = [
        raw({
          id: 1,
          source: 'openai-codex-acp',
          content: JSON.stringify({
            type: 'session/update',
            sessionId: SESSION_ID,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Hello from ACP' },
            },
          }),
        }),
      ];

      const vms = await projectRawMessagesToViewMessages(messages, 'openai-codex-acp');

      expect(vms).toHaveLength(1);
      expect(vms[0]).toMatchObject({ type: 'assistant_message', text: 'Hello from ACP' });
    });
  });

  describe('Claude Code provider', () => {
    it('projects a user prompt as a user_message', async () => {
      const messages: RawMessage[] = [
        raw({
          id: 1,
          direction: 'input',
          content: JSON.stringify({ prompt: 'Refactor this file' }),
        }),
      ];

      const vms = await projectRawMessagesToViewMessages(messages, 'claude-code');

      expect(vms).toHaveLength(1);
      expect(vms[0]).toMatchObject({ type: 'user_message', text: 'Refactor this file' });
    });
  });

  // Regression: session cb82f2eb-941c-4fb5-b552-adbae567df61. The widget for
  // developer_git_commit_proposal must show "Changes Committed" after the user
  // resolves the commit prompt, even when a later duplicate response carries
  // an error (e.g. "No files were staged" after the file was already committed).
  describe('git_commit_proposal end-to-end projection', () => {
    const PROPOSAL_ID = 'toolu_01PS9EteLyYXJbVx6JojBWQ6';

    function commitProposalMessages(): RawMessage[] {
      return [
        raw({
          id: 100,
          source: 'claude-code',
          direction: 'output',
          content: JSON.stringify({
            type: 'nimbalyst_tool_use',
            id: PROPOSAL_ID,
            name: 'developer_git_commit_proposal',
            input: {
              filesToStage: [
                { path: 'packages/electron/build/build-worker.js', status: 'modified' },
              ],
              commitMessage: 'fix: SQLite migration adopt crash in packaged builds',
            },
          }),
          createdAt: new Date('2026-06-01T20:55:58.643Z'),
        }),
      ];
    }

    function committedResponse(id: number): RawMessage {
      return raw({
        id,
        source: 'nimbalyst',
        direction: 'output',
        content: JSON.stringify({
          type: 'git_commit_proposal_response',
          proposalId: PROPOSAL_ID,
          action: 'committed',
          commitHash: '0b02b2301eecf073c716f8f0da43d458a611c568',
          commitDate: '2026-06-01T17:00:20-04:00',
          filesCommitted: ['packages/electron/build/build-worker.js'],
          commitMessage: 'fix: SQLite migration adopt crash in packaged builds',
        }),
        createdAt: new Date('2026-06-01T21:00:21.666Z'),
      });
    }

    function errorResponse(id: number): RawMessage {
      return raw({
        id,
        source: 'nimbalyst',
        direction: 'output',
        content: JSON.stringify({
          type: 'git_commit_proposal_response',
          proposalId: PROPOSAL_ID,
          action: 'error',
          error: 'No files were staged. The files may not exist or have no changes.',
        }),
        createdAt: new Date('2026-06-01T21:03:49.579Z'),
      });
    }

    it('projects a successful commit response onto the tool_call view message', async () => {
      const messages = [...commitProposalMessages(), committedResponse(101)];

      const vms = await projectRawMessagesToViewMessages(messages, 'claude-code');
      const toolCall = vms.find(m => m.type === 'tool_call');

      expect(toolCall).toBeDefined();
      expect(toolCall?.toolCall?.toolName).toBe('developer_git_commit_proposal');
      expect(toolCall?.toolCall?.status).toBe('completed');

      const result = JSON.parse(toolCall!.toolCall!.result as string);
      expect(result.action).toBe('committed');
      expect(result.commitHash).toBe('0b02b2301eecf073c716f8f0da43d458a611c568');
    });

    it('preserves the committed result when a later error response arrives for the same proposal', async () => {
      const messages = [
        ...commitProposalMessages(),
        committedResponse(101),
        errorResponse(102),
      ];

      const vms = await projectRawMessagesToViewMessages(messages, 'claude-code');
      const toolCall = vms.find(m => m.type === 'tool_call');

      expect(toolCall?.toolCall?.status).toBe('completed');
      const result = JSON.parse(toolCall!.toolCall!.result as string);
      expect(result.action).toBe('committed');
      expect(result.commitHash).toBe('0b02b2301eecf073c716f8f0da43d458a611c568');
      expect(result.error).toBeUndefined();
    });
  });

  it('rawMessagesToCanonicalEvents assigns sequential ids and sequences', async () => {
    const messages: RawMessage[] = [
      raw({ id: 1, direction: 'input', content: JSON.stringify({ prompt: 'first' }) }),
      raw({ id: 2, direction: 'input', content: JSON.stringify({ prompt: 'second' }) }),
    ];

    const events = await rawMessagesToCanonicalEvents(messages, 'claude-code');

    expect(events).toHaveLength(2);
    expect(events[0].id).toBe(1);
    expect(events[1].id).toBe(2);
    expect(events[0].sequence).toBeLessThan(events[1].sequence);
  });
});
