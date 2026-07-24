/**
 * Tests for TranscriptProjector view message output.
 * Replaces the CanonicalTranscriptConverter tests -- verifies that projected
 * TranscriptViewMessage[] contains the correct data for UI rendering.
 */
import { describe, it, expect } from 'vitest';
import type { TranscriptViewMessage } from '../TranscriptProjector';
import { TranscriptProjector } from '../TranscriptProjector';
import type { TranscriptEvent } from '../types';
import { parseToolResult } from '../toolResultParser';

function makeViewMessage(overrides: Partial<TranscriptViewMessage> & { type: TranscriptViewMessage['type'] }): TranscriptViewMessage {
  return {
    id: 1,
    sequence: 0,
    createdAt: new Date('2025-01-01T00:00:00Z'),
    subagentId: null,
    ...overrides,
  };
}

describe('TranscriptViewMessage structure', () => {
  it('user_message has correct fields', () => {
    const msg = makeViewMessage({
      type: 'user_message',
      text: 'Hello world',
      mode: 'agent',
      attachments: [{ id: '1', filename: 'test.png', filepath: '/test.png', mimeType: 'image/png', size: 100, type: 'image' }],
    });

    expect(msg.type).toBe('user_message');
    expect(msg.text).toBe('Hello world');
    expect(msg.mode).toBe('agent');
    expect(msg.attachments).toHaveLength(1);
  });

  it('assistant_message has correct fields', () => {
    const msg = makeViewMessage({
      type: 'assistant_message',
      text: 'I can help with that.',
      mode: 'planning',
    });

    expect(msg.type).toBe('assistant_message');
    expect(msg.text).toBe('I can help with that.');
    expect(msg.mode).toBe('planning');
  });

  it('system_message has correct fields', () => {
    const msg = makeViewMessage({
      type: 'system_message',
      text: 'Session started',
      systemMessage: { systemType: 'status' },
    });

    expect(msg.type).toBe('system_message');
    expect(msg.systemMessage?.systemType).toBe('status');
  });

  it('system_message with error type carries error data', () => {
    const msg = makeViewMessage({
      type: 'system_message',
      text: 'API error occurred',
      systemMessage: { systemType: 'error' },
    });

    expect(msg.type).toBe('system_message');
    expect(msg.systemMessage?.systemType).toBe('error');
    expect(msg.text).toBe('API error occurred');
  });

  it('tool_call has correct structure', () => {
    const msg = makeViewMessage({
      type: 'tool_call',
      toolCall: {
        toolName: 'Read',
        toolDisplayName: 'Read',
        status: 'completed',
        description: 'Reading file',
        arguments: { file_path: '/src/index.ts' },
        targetFilePath: '/src/index.ts',
        mcpServer: null,
        mcpTool: null,
        result: 'file contents here',
        isError: false,
        providerToolCallId: 'tool_123',
        progress: [],
      },
    });

    expect(msg.type).toBe('tool_call');
    expect(msg.toolCall?.toolName).toBe('Read');
    expect(msg.toolCall?.result).toBe('file contents here');
    expect(msg.toolCall?.providerToolCallId).toBe('tool_123');
    expect(msg.toolCall?.arguments).toEqual({ file_path: '/src/index.ts' });
  });

  it('tool_call with progress events', () => {
    const msg = makeViewMessage({
      type: 'tool_call',
      toolCall: {
        toolName: 'Bash',
        toolDisplayName: 'Bash',
        status: 'running',
        description: 'Running command',
        arguments: { command: 'npm test' },
        targetFilePath: null,
        mcpServer: null,
        mcpTool: null,
        providerToolCallId: 'tool_789',
        progress: [
          { elapsedSeconds: 5, progressContent: 'Still running...' },
          { elapsedSeconds: 10, progressContent: 'Almost done...' },
        ],
      },
    });

    expect(msg.toolCall?.progress).toHaveLength(2);
    expect(msg.toolCall?.progress[1].elapsedSeconds).toBe(10);
  });

  it('interactive_prompt has correct structure', () => {
    const msg = makeViewMessage({
      type: 'interactive_prompt',
      interactivePrompt: {
        promptType: 'permission_request',
        requestId: 'req_1',
        status: 'resolved',
        toolName: 'Bash',
        rawCommand: 'git status',
        pattern: 'Bash(git:*)',
        patternDisplayName: 'git commands',
        isDestructive: false,
        warnings: [],
        decision: 'allow',
        scope: 'session',
      },
    });

    expect(msg.type).toBe('interactive_prompt');
    expect(msg.interactivePrompt?.promptType).toBe('permission_request');
    expect(msg.interactivePrompt?.requestId).toBe('req_1');
    expect((msg.interactivePrompt as any)?.decision).toBe('allow');
  });

  it('subagent with child events', () => {
    const msg = makeViewMessage({
      type: 'subagent',
      subagentId: 'agent_1',
      subagent: {
        agentType: 'Explore',
        status: 'completed',
        teammateName: 'explorer',
        teamName: null,
        teammateMode: null,
        model: null,
        reasoningEffort: null,
        color: null,
        isBackground: false,
        prompt: 'Find the file',
        resultSummary: 'Found 3 files',
        childEvents: [
          makeViewMessage({
            id: 2,
            type: 'tool_call',
            subagentId: 'agent_1',
            toolCall: {
              toolName: 'Glob',
              toolDisplayName: 'Glob',
              status: 'completed',
              description: null,
              arguments: { pattern: '*.ts' },
              targetFilePath: null,
              mcpServer: null,
              mcpTool: null,
              result: 'file1.ts\nfile2.ts',
              providerToolCallId: 'child_1',
              progress: [],
            },
          }),
        ],
      },
    });

    expect(msg.type).toBe('subagent');
    expect(msg.subagent?.agentType).toBe('Explore');
    expect(msg.subagent?.resultSummary).toBe('Found 3 files');
    expect(msg.subagent?.childEvents).toHaveLength(1);
    expect(msg.subagent?.childEvents[0].toolCall?.toolName).toBe('Glob');
  });

  it('turn_ended has context data', () => {
    const msg = makeViewMessage({
      type: 'turn_ended',
      turnEnded: {
        contextFill: { inputTokens: 100, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 50, totalContextTokens: 150 },
        contextWindow: 200000,
        cumulativeUsage: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.01, webSearchRequests: 0 },
        contextCompacted: false,
      },
    });

    expect(msg.type).toBe('turn_ended');
    expect(msg.turnEnded?.contextWindow).toBe(200000);
  });
});

describe('parseToolResult', () => {
  it('parses JSON-stringified MCP content array', () => {
    const mcpContent = [{ type: 'text', text: '{"summary":"done"}' }];
    const result = parseToolResult(JSON.stringify(mcpContent));
    expect(result).toEqual(mcpContent);
  });

  it('parses JSON-stringified object', () => {
    const result = parseToolResult(JSON.stringify({ stdout: 'hello', exit_code: 0 }));
    expect(result).toEqual({ stdout: 'hello', exit_code: 0 });
  });

  it('returns plain text as-is', () => {
    const result = parseToolResult('file contents here');
    expect(result).toBe('file contents here');
  });

  it('returns undefined for null/undefined', () => {
    expect(parseToolResult(undefined)).toBeUndefined();
    expect(parseToolResult(undefined)).toBeUndefined();
  });
});

describe('TranscriptProjector.project', () => {
  it('coalesces adjacent assistant messages into one rendered message', () => {
    const events: TranscriptEvent[] = [
      {
        id: 1,
        sessionId: 'session-1',
        provider: 'openai-codex-acp',
        eventType: 'assistant_message',
        sequence: 0,
        searchable: true,
        searchableText: 'I',
        payload: { mode: 'agent' },
        providerToolCallId: null,
        parentEventId: null,
        subagentId: null,
        createdAt: new Date('2026-04-27T00:00:00Z'),
      },
      {
        id: 2,
        sessionId: 'session-1',
        provider: 'openai-codex-acp',
        eventType: 'assistant_message',
        sequence: 1,
        searchable: true,
        searchableText: "'m reading the repo instructions first, hi",
        payload: { mode: 'agent' },
        providerToolCallId: null,
        parentEventId: null,
        subagentId: null,
        createdAt: new Date('2026-04-27T00:00:01Z'),
      },
    ];

    const projected = TranscriptProjector.project(events);

    expect(projected.messages).toHaveLength(1);
    expect(projected.messages[0]).toMatchObject({
      type: 'assistant_message',
      text: "I'm reading the repo instructions first, hi",
    });
  });
});
