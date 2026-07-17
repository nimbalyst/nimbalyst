import { describe, it, expect, beforeEach } from 'vitest';
import { TranscriptProjector } from '../TranscriptProjector';
import type { TranscriptEvent } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let nextId = 1;

function makeEvent(overrides: Partial<TranscriptEvent> & Pick<TranscriptEvent, 'eventType'>): TranscriptEvent {
  const id = overrides.id ?? nextId++;
  return {
    id,
    sessionId: 'session-1',
    sequence: overrides.sequence ?? id - 1,
    createdAt: overrides.createdAt ?? new Date('2025-01-01T00:00:00Z'),
    eventType: overrides.eventType,
    searchableText: overrides.searchableText ?? null,
    payload: overrides.payload ?? {},
    parentEventId: overrides.parentEventId ?? null,
    searchable: overrides.searchable ?? false,
    subagentId: overrides.subagentId ?? null,
    provider: overrides.provider ?? 'claude-code',
    providerToolCallId: overrides.providerToolCallId ?? null,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TranscriptProjector', () => {
  beforeEach(() => {
    nextId = 1;
  });

  it('returns empty view model for empty events', () => {
    const vm = TranscriptProjector.project([]);
    expect(vm.messages).toEqual([]);
  });

  it('projects simple message list correctly', () => {
    const events: TranscriptEvent[] = [
      makeEvent({
        eventType: 'user_message',
        searchableText: 'Hello',
        searchable: true,
        payload: { mode: 'agent', inputType: 'user' },
      }),
      makeEvent({
        eventType: 'assistant_message',
        searchableText: 'Hi there',
        searchable: true,
        payload: { mode: 'agent' },
      }),
    ];

    const vm = TranscriptProjector.project(events);

    expect(vm.messages).toHaveLength(2);
    expect(vm.messages[0].type).toBe('user_message');
    expect(vm.messages[0].text).toBe('Hello');
    expect(vm.messages[0].mode).toBe('agent');
    expect(vm.messages[1].type).toBe('assistant_message');
    expect(vm.messages[1].text).toBe('Hi there');
  });

  it('groups tool progress under parent tool call', () => {
    const toolCallId = nextId;
    const events: TranscriptEvent[] = [
      makeEvent({
        id: toolCallId,
        eventType: 'tool_call',
        payload: {
          toolName: 'Bash',
          toolDisplayName: 'Bash',
          status: 'running',
          description: null,
          arguments: { command: 'npm test' },
          targetFilePath: null,
          mcpServer: null,
          mcpTool: null,
        },
      }),
      makeEvent({
        eventType: 'tool_progress',
        parentEventId: toolCallId,
        payload: {
          toolName: 'Bash',
          elapsedSeconds: 5,
          progressContent: 'Running tests...',
        },
      }),
      makeEvent({
        eventType: 'tool_progress',
        parentEventId: toolCallId,
        payload: {
          toolName: 'Bash',
          elapsedSeconds: 10,
          progressContent: 'Tests completed',
        },
      }),
    ];

    const vm = TranscriptProjector.project(events);

    // Only the tool_call appears as a message, progress is nested
    expect(vm.messages).toHaveLength(1);
    expect(vm.messages[0].type).toBe('tool_call');
    expect(vm.messages[0].toolCall!.progress).toHaveLength(2);
    expect(vm.messages[0].toolCall!.progress[0].elapsedSeconds).toBe(5);
    expect(vm.messages[0].toolCall!.progress[0].progressContent).toBe('Running tests...');
    expect(vm.messages[0].toolCall!.progress[1].elapsedSeconds).toBe(10);
  });

  it('nests subagent events under subagent parent', () => {
    const events: TranscriptEvent[] = [
      makeEvent({
        eventType: 'user_message',
        searchableText: 'Do something',
        payload: { mode: 'agent', inputType: 'user' },
      }),
      makeEvent({
        eventType: 'subagent',
        subagentId: 'sub-1',
        payload: {
          agentType: 'Explore',
          status: 'completed',
          teammateName: null,
          teamName: null,
          teammateMode: null,
          model: null,
          reasoningEffort: null,
          color: null,
          isBackground: false,
          prompt: 'Find files',
          resultSummary: 'Found 3 files',
        },
      }),
      makeEvent({
        eventType: 'tool_call',
        subagentId: 'sub-1',
        payload: {
          toolName: 'Glob',
          toolDisplayName: 'Glob',
          status: 'completed',
          description: null,
          arguments: { pattern: '*.ts' },
          targetFilePath: null,
          mcpServer: null,
          mcpTool: null,
          result: 'file1.ts\nfile2.ts',
        },
      }),
      makeEvent({
        eventType: 'assistant_message',
        subagentId: 'sub-1',
        searchableText: 'Found the files',
        payload: { mode: 'agent' },
      }),
    ];

    const vm = TranscriptProjector.project(events);

    // Top-level: user_message + subagent
    expect(vm.messages).toHaveLength(2);
    expect(vm.messages[0].type).toBe('user_message');
    expect(vm.messages[1].type).toBe('subagent');
    expect(vm.messages[1].toolCall).toMatchObject({
      toolName: 'Task',
      status: 'completed',
      arguments: { prompt: 'Find files' },
      result: 'Found 3 files',
      providerToolCallId: 'sub-1',
    });
    expect(vm.messages[1].subagent!.childEvents).toHaveLength(2);
    expect(vm.messages[1].subagent!.childEvents[0].type).toBe('tool_call');
    expect(vm.messages[1].subagent!.childEvents[1].type).toBe('assistant_message');
  });

  it('separates top-level and subagent events correctly', () => {
    const events: TranscriptEvent[] = [
      makeEvent({
        eventType: 'user_message',
        searchableText: 'Main message',
        payload: { mode: 'agent', inputType: 'user' },
      }),
      makeEvent({
        eventType: 'assistant_message',
        searchableText: 'Main response',
        payload: { mode: 'agent' },
      }),
      makeEvent({
        eventType: 'subagent',
        subagentId: 'sub-1',
        payload: {
          agentType: 'Explore',
          status: 'running',
          teammateName: null,
          teamName: null,
          teammateMode: null,
          model: null,
          color: null,
          isBackground: false,
          prompt: 'Explore',
        },
      }),
      makeEvent({
        eventType: 'tool_call',
        subagentId: 'sub-1',
        payload: {
          toolName: 'Grep',
          toolDisplayName: 'Grep',
          status: 'completed',
          description: null,
          arguments: { pattern: 'foo' },
          targetFilePath: null,
          mcpServer: null,
          mcpTool: null,
        },
      }),
      makeEvent({
        eventType: 'turn_ended',
        payload: {
          contextFill: {
            inputTokens: 100,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            outputTokens: 50,
            totalContextTokens: 150,
          },
          contextWindow: 200000,
          cumulativeUsage: {
            inputTokens: 100,
            outputTokens: 50,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            costUSD: 0.01,
            webSearchRequests: 0,
          },
          contextCompacted: false,
        },
      }),
    ];

    const vm = TranscriptProjector.project(events);

    // Top-level: user_message, assistant_message, subagent (turn_ended filtered out)
    expect(vm.messages).toHaveLength(3);
    expect(vm.messages[0].type).toBe('user_message');
    expect(vm.messages[1].type).toBe('assistant_message');
    expect(vm.messages[2].type).toBe('subagent');
    expect(vm.messages[2].subagent!.childEvents).toHaveLength(1);
  });

  it('events without subagentId are top-level', () => {
    const events: TranscriptEvent[] = [
      makeEvent({
        eventType: 'user_message',
        searchableText: 'Hello',
        payload: { mode: 'agent', inputType: 'user' },
        subagentId: null,
      }),
      makeEvent({
        eventType: 'tool_call',
        payload: {
          toolName: 'Read',
          toolDisplayName: 'Read',
          status: 'completed',
          description: null,
          arguments: {},
          targetFilePath: null,
          mcpServer: null,
          mcpTool: null,
        },
        subagentId: null,
      }),
    ];

    const vm = TranscriptProjector.project(events);

    expect(vm.messages).toHaveLength(2);
    expect(vm.messages.every((m) => m.subagentId === null)).toBe(true);
  });

  describe('projectSubagent', () => {
    it('projects events for a specific subagent only', () => {
      const events: TranscriptEvent[] = [
        makeEvent({
          eventType: 'user_message',
          searchableText: 'Top-level',
          payload: { mode: 'agent', inputType: 'user' },
        }),
        makeEvent({
          eventType: 'tool_call',
          subagentId: 'sub-1',
          payload: {
            toolName: 'Grep',
            toolDisplayName: 'Grep',
            status: 'completed',
            description: null,
            arguments: {},
            targetFilePath: null,
            mcpServer: null,
            mcpTool: null,
          },
        }),
        makeEvent({
          eventType: 'assistant_message',
          subagentId: 'sub-1',
          searchableText: 'Sub response',
          payload: { mode: 'agent' },
        }),
        makeEvent({
          eventType: 'tool_call',
          subagentId: 'sub-2',
          payload: {
            toolName: 'Read',
            toolDisplayName: 'Read',
            status: 'completed',
            description: null,
            arguments: {},
            targetFilePath: null,
            mcpServer: null,
            mcpTool: null,
          },
        }),
      ];

      const result = TranscriptProjector.projectSubagent(events, 'sub-1');

      expect(result).toHaveLength(2);
      expect(result[0].type).toBe('tool_call');
      expect(result[1].type).toBe('assistant_message');
      expect(result[1].text).toBe('Sub response');
    });
  });

  it('projects interactive prompt events', () => {
    const events: TranscriptEvent[] = [
      makeEvent({
        eventType: 'interactive_prompt',
        payload: {
          promptType: 'permission_request',
          requestId: 'req-1',
          status: 'resolved',
          toolName: 'Bash',
          rawCommand: 'ls',
          pattern: 'Bash(*)',
          patternDisplayName: 'Bash',
          isDestructive: false,
          warnings: [],
          decision: 'allow',
          scope: 'once',
        },
      }),
    ];

    const vm = TranscriptProjector.project(events);

    expect(vm.messages).toHaveLength(1);
    expect(vm.messages[0].interactivePrompt!.promptType).toBe('permission_request');
    expect((vm.messages[0].interactivePrompt as any).decision).toBe('allow');
  });

  it('projects system messages with payload', () => {
    const events: TranscriptEvent[] = [
      makeEvent({
        eventType: 'system_message',
        searchableText: 'Session initialized',
        payload: { systemType: 'init' },
      }),
    ];

    const vm = TranscriptProjector.project(events);

    expect(vm.messages).toHaveLength(1);
    expect(vm.messages[0].text).toBe('Session initialized');
    expect(vm.messages[0].systemMessage!.systemType).toBe('init');
  });

  it('surfaces isAuthError from system_message payload', () => {
    const events: TranscriptEvent[] = [
      makeEvent({
        eventType: 'system_message',
        searchableText: 'Authentication failed. Please log in to continue.',
        payload: { systemType: 'error', isAuthError: true },
      }),
    ];

    const vm = TranscriptProjector.project(events);

    expect(vm.messages).toHaveLength(1);
    expect(vm.messages[0].isError).toBe(true);
    expect(vm.messages[0].isAuthError).toBe(true);
  });

  it('leaves isAuthError undefined for non-auth error system messages', () => {
    const events: TranscriptEvent[] = [
      makeEvent({
        eventType: 'system_message',
        searchableText: 'Rate limit exceeded',
        payload: { systemType: 'error' },
      }),
    ];

    const vm = TranscriptProjector.project(events);

    expect(vm.messages[0].isError).toBe(true);
    expect(vm.messages[0].isAuthError).toBeUndefined();
  });
});
