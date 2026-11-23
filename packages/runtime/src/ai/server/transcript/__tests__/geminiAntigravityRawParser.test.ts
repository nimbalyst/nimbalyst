// @vitest-environment node
/**
 * Covers the Gemini transcript parser, including the rows written while the
 * provider shipped as an extension.
 *
 * The continuity case is the point of this file. Moving Gemini in-tree changes
 * the `source` stamped on new rows (`gemini-antigravity/antigravity-server` ->
 * `antigravity-gemini-agent`) but must NOT change how an existing session's
 * rows are read — the provider id on the session row is unchanged, the content
 * shape is unchanged, and a user's old Gemini conversations have to keep
 * rendering. A regression here blanks history silently rather than failing.
 */
import { describe, expect, it } from 'vitest';

import { GeminiAntigravityRawParser } from '../parsers/GeminiAntigravityRawParser';
import { selectRawParser } from '../processDescriptor';
import { projectRawMessagesToViewMessages } from '../projectRawMessages';
import type { RawMessage } from '../TranscriptTransformer';
import type { ParseContext } from '../parsers/IRawMessageParser';

const CONTEXT: ParseContext = {
  sessionId: 's1',
  hasToolCall: () => false,
  hasSubagent: () => false,
  findByProviderToolCallId: async () => null,
  findActiveToolCallByRawProviderId: async () => null,
};
const AT = new Date('2026-08-26T12:00:00.000Z');

function raw(overrides: Partial<RawMessage>): RawMessage {
  return {
    id: 1,
    sessionId: 's1',
    source: 'antigravity-gemini-agent',
    direction: 'output',
    content: '',
    createdAt: AT,
    ...overrides,
  };
}

describe('selectRawParser', () => {
  it('routes antigravity-gemini-agent to its own parser', () => {
    // Before this, Gemini fell through to the claude-code default, where a tool
    // row parsed as JSON, matched no Claude shape, and vanished.
    expect(selectRawParser('antigravity-gemini-agent')).toBe('gemini-antigravity');
  });
});

describe('GeminiAntigravityRawParser', () => {
  const parser = new GeminiAntigravityRawParser();

  it('reads a prompt row as a user message', async () => {
    const out = await parser.parseMessage(
      raw({ direction: 'input', content: 'respond with: hi', metadata: { role: 'user' } }),
      CONTEXT,
    );
    expect(out).toEqual([
      { type: 'user_message', text: 'respond with: hi', mode: 'agent', createdAt: AT },
    ]);
  });

  it('reads an answer row as an assistant message', async () => {
    const out = await parser.parseMessage(
      raw({ content: 'Here is the answer.', metadata: { role: 'assistant' } }),
      CONTEXT,
    );
    expect(out).toEqual([
      { type: 'assistant_message', text: 'Here is the answer.', createdAt: AT },
    ]);
  });

  it('keeps an answer that happens to be valid JSON as prose', async () => {
    // An answer discussing a JSON payload must not be parsed as a tool row and
    // dropped. The role, not the content shape, decides.
    const out = await parser.parseMessage(
      raw({ content: '{"result": "the config uses this shape"}', metadata: { role: 'assistant' } }),
      CONTEXT,
    );
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('assistant_message');
  });

  it('expands a tool row into a started/completed pair with the file it targeted', async () => {
    const out = await parser.parseMessage(
      raw({
        content: JSON.stringify({
          name: 'write_file',
          args: { path: 'src/a.ts', content: 'x' },
          result: 'Wrote src/a.ts (1 bytes, 1 line(s)).',
        }),
        metadata: { role: 'tool', toolUseId: 'agy-123-0' },
      }),
      CONTEXT,
    );

    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      type: 'tool_call_started',
      toolName: 'write_file',
      targetFilePath: 'src/a.ts',
      providerToolCallId: 'agy-123-0',
    });
    expect(out[1]).toMatchObject({
      type: 'tool_call_completed',
      providerToolCallId: 'agy-123-0',
      status: 'completed',
      isError: false,
    });
  });

  it('marks a failed tool call as an error', async () => {
    const out = await parser.parseMessage(
      raw({
        content: JSON.stringify({
          name: 'run_command',
          args: { command: 'false' },
          result: { isError: true, error: 'Tool "run_command" is not available in this session.' },
        }),
        metadata: { role: 'tool', toolUseId: 'agy-123-1' },
      }),
      CONTEXT,
    );
    expect(out[1]).toMatchObject({ type: 'tool_call_completed', status: 'error', isError: true });
  });

  describe('rows written while Gemini was an extension', () => {
    // Verbatim shape from an existing session row: the source names the
    // extension's backend module, and there is no toolUseId in the metadata.
    const LEGACY_SOURCE = 'gemini-antigravity/antigravity-server';

    it('still reads a legacy prompt row', async () => {
      const out = await parser.parseMessage(
        raw({
          source: LEGACY_SOURCE,
          direction: 'input',
          content: 'respond with: hi',
          metadata: {
            role: 'user',
            timestamp: 1784728188693,
            model: 'gemini-3.5-flash-extra-low',
            documentContext: { mode: 'agent' },
          },
        }),
        CONTEXT,
      );
      expect(out).toEqual([
        { type: 'user_message', text: 'respond with: hi', mode: 'agent', createdAt: AT },
      ]);
    });

    it('gives a legacy tool row a stable synthetic id derived from the row', async () => {
      const legacy = raw({
        id: 4242,
        source: LEGACY_SOURCE,
        content: JSON.stringify({ name: 'read_file', args: { path: 'a.ts' }, result: 'contents' }),
        metadata: { role: 'tool', timestamp: 1784728188693 },
      });

      const first = await parser.parseMessage(legacy, CONTEXT);
      const second = await parser.parseMessage(legacy, CONTEXT);

      // Derived from the row id, so re-parsing the same session does not mint a
      // second, duplicate tool card.
      expect(first[0]).toMatchObject({ providerToolCallId: 'gemini-tool-4242' });
      expect(second[0]).toMatchObject({ providerToolCallId: 'gemini-tool-4242' });
    });
  });

  it('drops a corrupt tool row rather than showing it as conversation', async () => {
    const out = await parser.parseMessage(
      raw({ content: 'not json at all', metadata: { role: 'tool' } }),
      CONTEXT,
    );
    expect(out).toEqual([]);
  });

  describe('ACP rows from agy acp', () => {
    it('emits agent_thought_chunk as collapsed thinking (empty text, populated thinking)', async () => {
      const p = new GeminiAntigravityRawParser();
      const out = await p.parseMessage(
        raw({
          content: JSON.stringify({
            type: 'session/update',
            sessionId: 'acp-1',
            update: {
              sessionUpdate: 'agent_thought_chunk',
              content: { type: 'text', text: 'Checking search results...' },
            },
          }),
        }),
        CONTEXT,
      );

      expect(out).toEqual([
        {
          type: 'assistant_message',
          text: '',
          thinking: 'Checking search results...',
          createdAt: AT,
        },
      ]);
    });

    it('coalesces consecutive agent_thought_chunk rows into a single collapsed thinking block', async () => {
      const view = await projectRawMessagesToViewMessages(
        [
          raw({
            id: 1,
            direction: 'input',
            content: 'Search the web',
          }),
          raw({
            id: 2,
            content: JSON.stringify({
              type: 'session/update',
              sessionId: 'acp-1',
              update: {
                sessionUpdate: 'agent_thought_chunk',
                content: { type: 'text', text: 'Part 1. ' },
              },
            }),
          }),
          raw({
            id: 3,
            content: JSON.stringify({
              type: 'session/update',
              sessionId: 'acp-1',
              update: {
                sessionUpdate: 'agent_thought_chunk',
                content: { type: 'text', text: 'Part 2.' },
              },
            }),
          }),
          raw({
            id: 4,
            content: JSON.stringify({
              type: 'session/update',
              sessionId: 'acp-1',
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'Final answer.' },
              },
            }),
          }),
        ],
        'antigravity-gemini-agent',
      );

      const thinking = view.filter((m) => m.type === 'assistant_message' && m.thinking);
      expect(thinking).toHaveLength(1);
      expect(thinking[0].thinking).toBe('Part 1. Part 2.');

      const replies = view.filter((m) => m.type === 'assistant_message' && m.text);
      expect(replies).toHaveLength(1);
      expect(replies[0].text).toBe('Final answer.');
    });

    it('maps search_web ACP tool calls to WebSearch', async () => {
      const p = new GeminiAntigravityRawParser();
      const out = await p.parseMessage(
        raw({
          content: JSON.stringify({
            type: 'session/update',
            sessionId: 'acp-1',
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'call_1',
              name: 'search_web',
              kind: 'search',
              title: '"node lts" on Web',
              rawInput: { query: 'node lts' },
            },
          }),
        }),
        CONTEXT,
      );

      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({
        type: 'tool_call_started',
        toolName: 'WebSearch',
        providerToolCallId: 'call_1',
      });
    });
  });
});
