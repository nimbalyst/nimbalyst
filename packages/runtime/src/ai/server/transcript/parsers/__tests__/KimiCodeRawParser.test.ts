// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { KimiCodeRawParser } from '../KimiCodeRawParser';
import type { RawMessage } from '../../TranscriptTransformer';
import type { ParseContext } from '../IRawMessageParser';

const ctx = {} as ParseContext;

function raw(direction: 'input' | 'output', content: string, metadata?: Record<string, unknown>): RawMessage {
  return {
    id: 1,
    sessionId: 's1',
    direction,
    content,
    metadata,
    hidden: false,
    createdAt: new Date('2026-08-05T12:00:00Z'),
  } as unknown as RawMessage;
}

function sessionUpdate(update: Record<string, unknown>): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId: 'acp-1', update },
  });
}

describe('KimiCodeRawParser', () => {
  it('parses the item.completed envelope into an assistant message', async () => {
    const parser = new KimiCodeRawParser();
    const content = JSON.stringify({
      type: 'item.completed',
      item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Ciao' }] },
    });
    const events = await parser.parseMessage(raw('output', content), ctx);
    expect(events).toEqual([expect.objectContaining({ type: 'assistant_message', text: 'Ciao' })]);
  });

  it('maps ACP tool_call (toolCallId/title/rawInput) to tool_call_started', async () => {
    const parser = new KimiCodeRawParser();
    const content = sessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      title: 'Read file',
      kind: 'read',
      status: 'pending',
      rawInput: { path: '/tmp/x' },
    });
    const events = await parser.parseMessage(raw('output', content), ctx);
    expect(events).toEqual([expect.objectContaining({
      type: 'tool_call_started',
      toolName: 'Read file',
      providerToolCallId: 'tc-1',
      arguments: { path: '/tmp/x' },
    })]);
  });

  it('maps completed and failed tool_call_update to tool_call_completed, ignoring in_progress', async () => {
    const parser = new KimiCodeRawParser();
    const completed = await parser.parseMessage(raw('output', sessionUpdate({
      sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'completed', rawOutput: 'ok',
    })), ctx);
    expect(completed).toEqual([expect.objectContaining({
      type: 'tool_call_completed', providerToolCallId: 'tc-1', status: 'completed', result: 'ok',
    })]);

    const failed = await parser.parseMessage(raw('output', sessionUpdate({
      sessionUpdate: 'tool_call_update', toolCallId: 'tc-2', status: 'failed',
    })), ctx);
    expect(failed).toEqual([expect.objectContaining({ status: 'error', providerToolCallId: 'tc-2' })]);

    const inProgress = await parser.parseMessage(raw('output', sessionUpdate({
      sessionUpdate: 'tool_call_update', toolCallId: 'tc-3', status: 'in_progress',
    })), ctx);
    expect(inProgress).toEqual([]);
  });

  it('suppresses per-chunk text and thought updates (full text arrives via item.completed)', async () => {
    const parser = new KimiCodeRawParser();
    for (const updateType of ['agent_message_chunk', 'agent_thought_chunk']) {
      const events = await parser.parseMessage(raw('output', sessionUpdate({
        sessionUpdate: updateType, content: { type: 'text', text: 'chunk' },
      })), ctx);
      expect(events).toEqual([]);
    }
  });

  it('parses user input as a user_message', async () => {
    const parser = new KimiCodeRawParser();
    const events = await parser.parseMessage(raw('input', 'fai una cosa', { mode: 'agent' }), ctx);
    expect(events).toEqual([expect.objectContaining({ type: 'user_message', text: 'fai una cosa' })]);
  });
});
