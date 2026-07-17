import { describe, it, expect, beforeEach } from 'vitest';
import { TranscriptWriter } from '../TranscriptWriter';
import type { ITranscriptEventStore } from '../types';
import { createMockStore } from './helpers/createMockStore';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TranscriptWriter', () => {
  let store: ITranscriptEventStore;
  let writer: TranscriptWriter;

  beforeEach(() => {
    store = createMockStore();
    writer = new TranscriptWriter(store, 'claude-code');
  });

  describe('appendUserMessage', () => {
    it('sets searchable=true and correct payload', async () => {
      const event = await writer.appendUserMessage('session-1', 'Hello world');

      expect(event.eventType).toBe('user_message');
      expect(event.searchable).toBe(true);
      expect(event.searchableText).toBe('Hello world');
      expect(event.payload).toEqual({
        mode: 'agent',
        inputType: 'user',
      });
      expect(event.provider).toBe('claude-code');
      expect(event.sessionId).toBe('session-1');
    });

    it('respects optional mode and inputType', async () => {
      const event = await writer.appendUserMessage('session-1', 'Plan this', {
        mode: 'planning',
        inputType: 'system_message',
      });

      expect(event.payload).toEqual({
        mode: 'planning',
        inputType: 'system_message',
      });
    });

    it('includes attachments when provided', async () => {
      const attachments = [
        {
          id: 'att-1',
          filename: 'test.png',
          filepath: '/tmp/test.png',
          mimeType: 'image/png',
          size: 1024,
          type: 'image',
        },
      ];
      const event = await writer.appendUserMessage('session-1', 'See attached', { attachments });

      expect((event.payload as any).attachments).toEqual(attachments);
    });
  });

  describe('appendAssistantMessage', () => {
    it('sets searchable=true', async () => {
      const event = await writer.appendAssistantMessage('session-1', 'Here is my response');

      expect(event.eventType).toBe('assistant_message');
      expect(event.searchable).toBe(true);
      expect(event.searchableText).toBe('Here is my response');
      expect(event.payload).toEqual({ mode: 'agent' });
    });

    it('coalesces consecutive chunks into one row by extending searchable_text', async () => {
      const first = await writer.appendAssistantMessage('session-1', 'Hello');
      const second = await writer.appendAssistantMessage('session-1', ' world');
      const third = await writer.appendAssistantMessage('session-1', '!');

      expect(second.id).toBe(first.id);
      expect(third.id).toBe(first.id);
      expect(third.searchableText).toBe('Hello world!');

      const all = await store.getSessionEvents('session-1');
      expect(all).toHaveLength(1);
      expect(all[0].searchableText).toBe('Hello world!');
    });

    it('starts a new row after a non-assistant event breaks the chain', async () => {
      await writer.appendAssistantMessage('session-1', 'Reply 1');
      await writer.appendUserMessage('session-1', 'Follow up');
      const second = await writer.appendAssistantMessage('session-1', 'Reply');
      const continued = await writer.appendAssistantMessage('session-1', ' 2');

      expect(continued.id).toBe(second.id);
      const events = await store.getSessionEvents('session-1');
      const assistant = events.filter((e) => e.eventType === 'assistant_message');
      expect(assistant).toHaveLength(2);
      expect(assistant[0].searchableText).toBe('Reply 1');
      expect(assistant[1].searchableText).toBe('Reply 2');
    });

    it('does not coalesce assistant_messages that differ in mode', async () => {
      const a = await writer.appendAssistantMessage('session-1', 'Plan: ', { mode: 'planning' });
      const b = await writer.appendAssistantMessage('session-1', 'Doing it', { mode: 'agent' });

      expect(b.id).not.toBe(a.id);
    });

    it('coalesces across writer instances by reading the tail from the store', async () => {
      const first = await writer.appendAssistantMessage('session-1', 'Hello');

      // Simulate a fresh batch (each processNewMessages call creates a new writer).
      const writer2 = new TranscriptWriter(store, 'claude-code');
      const continued = await writer2.appendAssistantMessage('session-1', ' world');

      expect(continued.id).toBe(first.id);
      expect(continued.searchableText).toBe('Hello world');
    });
  });

  describe('appendSystemMessage', () => {
    it('defaults searchable=true', async () => {
      const event = await writer.appendSystemMessage('session-1', 'Session started');

      expect(event.eventType).toBe('system_message');
      expect(event.searchable).toBe(true);
      expect(event.searchableText).toBe('Session started');
      expect(event.payload).toEqual({ systemType: 'status' });
    });

    it('respects searchable=false override', async () => {
      const event = await writer.appendSystemMessage('session-1', 'internal debug info', {
        searchable: false,
      });

      expect(event.searchable).toBe(false);
    });

    it('includes statusCode when provided', async () => {
      const event = await writer.appendSystemMessage('session-1', 'Error occurred', {
        systemType: 'error',
        statusCode: '500',
      });

      expect(event.payload).toEqual({
        systemType: 'error',
        statusCode: '500',
      });
    });
  });

  describe('createToolCall', () => {
    it('creates with status=running and searchable=false', async () => {
      const event = await writer.createToolCall('session-1', {
        toolName: 'Read',
        toolDisplayName: 'Read File',
        description: 'Reading a file',
        arguments: { file_path: '/tmp/test.ts' },
        targetFilePath: '/tmp/test.ts',
      });

      expect(event.eventType).toBe('tool_call');
      expect(event.searchable).toBe(false);
      expect(event.searchableText).toBeNull();
      expect((event.payload as any).status).toBe('running');
      expect((event.payload as any).toolName).toBe('Read');
      expect((event.payload as any).toolDisplayName).toBe('Read File');
    });
  });

  describe('updateToolCall', () => {
    it('merges result into existing payload', async () => {
      const event = await writer.createToolCall('session-1', {
        toolName: 'Bash',
        toolDisplayName: 'Bash',
        arguments: { command: 'ls' },
      });

      await writer.updateToolCall(event.id, {
        status: 'completed',
        result: 'file1.ts\nfile2.ts',
        durationMs: 150,
      });

      const updated = await store.getEventById(event.id);
      expect((updated!.payload as any).status).toBe('completed');
      expect((updated!.payload as any).result).toBe('file1.ts\nfile2.ts');
      expect((updated!.payload as any).durationMs).toBe(150);
      // Original fields preserved
      expect((updated!.payload as any).toolName).toBe('Bash');
    });

    it('throws for non-existent event', async () => {
      await expect(
        writer.updateToolCall(999, { status: 'completed' }),
      ).rejects.toThrow('event 999 not found');
    });
  });

  describe('createInteractivePrompt', () => {
    it('creates with pending status', async () => {
      const event = await writer.createInteractivePrompt('session-1', {
        promptType: 'permission_request',
        requestId: 'req-1',
        status: 'pending',
        toolName: 'Bash',
        rawCommand: 'rm -rf /tmp',
        pattern: 'Bash(*)',
        patternDisplayName: 'Bash',
        isDestructive: true,
        warnings: ['Destructive operation'],
      });

      expect(event.eventType).toBe('interactive_prompt');
      expect(event.searchable).toBe(false);
      expect((event.payload as any).status).toBe('pending');
      expect((event.payload as any).promptType).toBe('permission_request');
    });
  });

  describe('updateInteractivePrompt', () => {
    it('merges resolution data', async () => {
      const event = await writer.createInteractivePrompt('session-1', {
        promptType: 'permission_request',
        requestId: 'req-1',
        status: 'pending',
        toolName: 'Bash',
        rawCommand: 'ls',
        pattern: 'Bash(*)',
        patternDisplayName: 'Bash',
        isDestructive: false,
        warnings: [],
      });

      await writer.updateInteractivePrompt(event.id, {
        status: 'resolved',
        decision: 'allow',
        scope: 'session',
      } as any);

      const updated = await store.getEventById(event.id);
      expect((updated!.payload as any).status).toBe('resolved');
      expect((updated!.payload as any).decision).toBe('allow');
      expect((updated!.payload as any).scope).toBe('session');
      // Original fields preserved
      expect((updated!.payload as any).toolName).toBe('Bash');
    });
  });

  describe('createSubagent', () => {
    it('creates with running status', async () => {
      const event = await writer.createSubagent('session-1', {
        subagentId: 'sub-1',
        agentType: 'Explore',
        prompt: 'Find all test files',
        model: 'gpt-5.4',
        reasoningEffort: 'high',
      });

      expect(event.eventType).toBe('subagent');
      expect(event.searchable).toBe(false);
      expect(event.subagentId).toBe('sub-1');
      expect((event.payload as any).status).toBe('running');
      expect((event.payload as any).agentType).toBe('Explore');
      expect((event.payload as any).model).toBe('gpt-5.4');
      expect((event.payload as any).reasoningEffort).toBe('high');
    });
  });

  describe('updateSubagent', () => {
    it('merges completion data', async () => {
      const event = await writer.createSubagent('session-1', {
        subagentId: 'sub-1',
        agentType: 'Explore',
        prompt: 'Find files',
      });
      expect((event.payload as any).model).toBeNull();
      expect((event.payload as any).reasoningEffort).toBeNull();

      await writer.updateSubagent(event.id, {
        status: 'completed',
        resultSummary: 'Found 5 files',
        toolCallCount: 3,
        durationMs: 2000,
        model: 'gpt-5.4',
        reasoningEffort: 'high',
      });

      const updated = await store.getEventById(event.id);
      expect((updated!.payload as any).status).toBe('completed');
      expect((updated!.payload as any).resultSummary).toBe('Found 5 files');
      expect((updated!.payload as any).toolCallCount).toBe(3);
      expect((updated!.payload as any).model).toBe('gpt-5.4');
      expect((updated!.payload as any).reasoningEffort).toBe('high');
      // Original fields preserved
      expect((updated!.payload as any).agentType).toBe('Explore');
      expect((updated!.payload as any).prompt).toBe('Find files');
    });
  });

  describe('recordTurnEnded', () => {
    it('records usage data with searchable=false', async () => {
      const event = await writer.recordTurnEnded('session-1', {
        contextFill: {
          inputTokens: 1000,
          cacheReadInputTokens: 500,
          cacheCreationInputTokens: 200,
          outputTokens: 300,
          totalContextTokens: 2000,
        },
        contextWindow: 200000,
        cumulativeUsage: {
          inputTokens: 5000,
          outputTokens: 1500,
          cacheReadInputTokens: 2500,
          cacheCreationInputTokens: 1000,
          costUSD: 0.05,
          webSearchRequests: 0,
        },
      });

      expect(event.eventType).toBe('turn_ended');
      expect(event.searchable).toBe(false);
      expect((event.payload as any).contextWindow).toBe(200000);
      expect((event.payload as any).contextCompacted).toBe(false);
    });
  });

  describe('sequence numbers', () => {
    it('auto-increments per session', async () => {
      const e1 = await writer.appendUserMessage('session-1', 'First');
      const e2 = await writer.appendAssistantMessage('session-1', 'Second');
      const e3 = await writer.appendUserMessage('session-1', 'Third');

      expect(e1.sequence).toBe(0);
      expect(e2.sequence).toBe(1);
      expect(e3.sequence).toBe(2);
    });

    it('sequences are independent per session', async () => {
      const e1 = await writer.appendUserMessage('session-1', 'S1 first');
      const e2 = await writer.appendUserMessage('session-2', 'S2 first');
      const e3 = await writer.appendUserMessage('session-1', 'S1 second');

      expect(e1.sequence).toBe(0);
      expect(e2.sequence).toBe(0);
      expect(e3.sequence).toBe(1);
    });
  });
});
