/**
 * Contract tests for VoiceRawParser.
 *
 * Verifies that voice-session (`openai-realtime`) raw messages produce the
 * expected canonical event descriptors: user/assistant speech, [system]
 * diagnostics, and (the key new behavior) tool calls rendered as real
 * tool_call events.
 */

import { describe, it, expect } from 'vitest';
import { VoiceRawParser } from '../parsers/VoiceRawParser';
import type { ParseContext } from '../parsers/IRawMessageParser';
import type { RawMessage } from '../TranscriptTransformer';

const SESSION_ID = 'voice-test-session';

function makeRawMessage(overrides: Partial<RawMessage>): RawMessage {
  return {
    id: 1,
    sessionId: SESSION_ID,
    source: 'voice',
    direction: 'output',
    content: '',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function makeContext(): ParseContext {
  return {
    sessionId: SESSION_ID,
    hasToolCall: () => false,
    hasSubagent: () => false,
    findByProviderToolCallId: async () => null,
    findActiveToolCallByRawProviderId: async () => null,
  };
}

describe('VoiceRawParser', () => {
  it('parses input speech as a user_message', async () => {
    const parser = new VoiceRawParser();
    const msg = makeRawMessage({ direction: 'input', content: 'What server backend do we use?' });

    const descriptors = await parser.parseMessage(msg, makeContext());

    expect(descriptors).toEqual([
      { type: 'user_message', text: 'What server backend do we use?', createdAt: msg.createdAt },
    ]);
  });

  it('parses plain output speech as an assistant_message', async () => {
    const parser = new VoiceRawParser();
    const msg = makeRawMessage({ direction: 'output', content: 'We use better-sqlite3.' });

    const descriptors = await parser.parseMessage(msg, makeContext());

    expect(descriptors).toEqual([
      { type: 'assistant_message', text: 'We use better-sqlite3.', createdAt: msg.createdAt },
    ]);
  });

  it('parses [system] diagnostics as a system_message', async () => {
    const parser = new VoiceRawParser();
    const msg = makeRawMessage({ direction: 'output', content: '[system] Listen window: sleeping' });

    const descriptors = await parser.parseMessage(msg, makeContext());

    expect(descriptors).toEqual([
      { type: 'system_message', text: 'Listen window: sleeping', systemType: 'status', createdAt: msg.createdAt },
    ]);
  });

  it('parses a started tool call into tool_call_started', async () => {
    const parser = new VoiceRawParser();
    const msg = makeRawMessage({
      content: JSON.stringify({
        kind: 'voiceToolCall',
        phase: 'started',
        callId: 'call_abc',
        name: 'search_project_knowledge',
        displayName: 'memory.search_project_knowledge',
        args: { query: 'server backend' },
      }),
    });

    const descriptors = await parser.parseMessage(msg, makeContext());

    expect(descriptors).toEqual([
      {
        type: 'tool_call_started',
        toolName: 'search_project_knowledge',
        toolDisplayName: 'memory.search_project_knowledge',
        arguments: { query: 'server backend' },
        providerToolCallId: 'call_abc',
        createdAt: msg.createdAt,
      },
    ]);
  });

  it('parses a completed tool call into tool_call_completed and matches on callId', async () => {
    const parser = new VoiceRawParser();
    const msg = makeRawMessage({
      content: JSON.stringify({
        kind: 'voiceToolCall',
        phase: 'completed',
        callId: 'call_abc',
        name: 'search_project_knowledge',
        displayName: 'memory.search_project_knowledge',
        success: true,
        summary: 'Found: better-sqlite3 with a WriteCoordinator.',
      }),
    });

    const descriptors = await parser.parseMessage(msg, makeContext());

    expect(descriptors).toEqual([
      {
        type: 'tool_call_completed',
        providerToolCallId: 'call_abc',
        status: 'completed',
        result: 'Found: better-sqlite3 with a WriteCoordinator.',
        isError: false,
      },
    ]);
  });

  it('marks a failed tool call as an error', async () => {
    const parser = new VoiceRawParser();
    const msg = makeRawMessage({
      content: JSON.stringify({
        kind: 'voiceToolCall',
        phase: 'completed',
        callId: 'call_xyz',
        name: 'ask_coding_agent',
        displayName: 'Ask coding agent',
        success: false,
        summary: 'timed out',
      }),
    });

    const descriptors = await parser.parseMessage(msg, makeContext());

    expect(descriptors[0]).toMatchObject({
      type: 'tool_call_completed',
      providerToolCallId: 'call_xyz',
      status: 'error',
      isError: true,
    });
  });

  it('treats non-tool JSON-looking output as assistant text', async () => {
    const parser = new VoiceRawParser();
    const msg = makeRawMessage({ direction: 'output', content: '{not really json' });

    const descriptors = await parser.parseMessage(msg, makeContext());

    expect(descriptors).toEqual([
      { type: 'assistant_message', text: '{not really json', createdAt: msg.createdAt },
    ]);
  });
});
