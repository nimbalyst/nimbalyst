import { describe, it, expect } from 'vitest';
import {
  parseToolName,
  rollupKey,
  aggregateToolCalls,
  toDayBucket,
  extractClaudeTools,
  extractCodexTools,
} from '../toolUsage';

describe('parseToolName', () => {
  it('treats built-in tools as non-MCP', () => {
    expect(parseToolName('Read')).toEqual({
      toolName: 'Read',
      mcpServer: null,
      mcpTool: null,
      isMcp: false,
    });
  });

  it('splits mcp__server__tool into server and tool', () => {
    expect(parseToolName('mcp__nimbalyst__display_chart')).toEqual({
      toolName: 'mcp__nimbalyst__display_chart',
      mcpServer: 'nimbalyst',
      mcpTool: 'display_chart',
      isMcp: true,
    });
  });

  it('keeps multi-segment tool names intact after the server', () => {
    const parsed = parseToolName(
      'mcp__nimbalyst-excalidraw__excalidraw_add_rectangle',
    );
    expect(parsed.mcpServer).toBe('nimbalyst-excalidraw');
    expect(parsed.mcpTool).toBe('excalidraw_add_rectangle');
    expect(parsed.isMcp).toBe(true);
  });

  it('handles a malformed mcp name with no tool segment', () => {
    const parsed = parseToolName('mcp__loneserver');
    expect(parsed.mcpServer).toBe('loneserver');
    expect(parsed.mcpTool).toBeNull();
    expect(parsed.isMcp).toBe(true);
  });
});

describe('rollupKey', () => {
  it('rolls MCP tools up to mcp:<server>', () => {
    expect(
      rollupKey(
        parseToolName('mcp__nimbalyst-excalidraw__excalidraw_add_rectangle'),
      ),
    ).toBe('mcp:nimbalyst-excalidraw');
  });

  it('keeps built-in tools under their own name', () => {
    expect(rollupKey(parseToolName('Bash'))).toBe('Bash');
  });
});

describe('aggregateToolCalls', () => {
  it('tallies counts and error counts per distinct tool', () => {
    const result = aggregateToolCalls([
      { name: 'Read' },
      { name: 'Read' },
      { name: 'Bash', isError: true },
      { name: 'mcp__nimbalyst__display_chart' },
    ]);
    const byName = Object.fromEntries(result.map((r) => [r.toolName, r]));

    expect(byName['Read'].count).toBe(2);
    expect(byName['Read'].errorCount).toBe(0);
    expect(byName['Bash'].count).toBe(1);
    expect(byName['Bash'].errorCount).toBe(1);
    expect(byName['mcp__nimbalyst__display_chart'].mcpServer).toBe('nimbalyst');
  });

  it('skips empty or invalid names', () => {
    const result = aggregateToolCalls([
      { name: '' },
      { name: undefined as unknown as string },
      { name: 'Grep' },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].toolName).toBe('Grep');
  });

  it('counts repeated lifecycle chunks with the same invocation ID once', () => {
    const result = aggregateToolCalls([
      { name: 'mcp__nimbalyst__display_chart', invocationId: 'call-1' },
      {
        name: 'mcp__nimbalyst__display_chart',
        invocationId: 'call-1',
        isError: true,
      },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ count: 1, errorCount: 1 });
  });
});

describe('toDayBucket', () => {
  it('formats a UTC YYYY-MM-DD day', () => {
    expect(toDayBucket(new Date('2026-07-21T18:30:00.000Z'))).toBe(
      '2026-07-21',
    );
  });
});

describe('extractClaudeTools', () => {
  it('pulls tool_use blocks with id and name from an assistant message', () => {
    const msg = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_01',
            name: 'mcp__nimbalyst-extension-dev__database_query',
            input: {},
          },
          { type: 'text', text: 'hi' },
        ],
      },
    };
    const tools = extractClaudeTools(msg);
    expect(tools).toEqual([
      {
        id: 'toolu_01',
        name: 'mcp__nimbalyst-extension-dev__database_query',
        isError: false,
      },
    ]);
  });

  it('returns nothing for messages with no tool_use block', () => {
    expect(
      extractClaudeTools({
        message: { content: [{ type: 'thinking', thinking: '' }] },
      }),
    ).toEqual([]);
    expect(extractClaudeTools({ type: 'user', message: {} })).toEqual([]);
  });
});

describe('extractCodexTools', () => {
  it('maps a completed mcpToolCall to mcp__server__tool', () => {
    const envelope = {
      method: 'item/completed',
      params: {
        item: {
          type: 'mcpToolCall',
          id: 'exec-603041c7',
          server: 'nimbalyst',
          tool: 'update_session_meta',
          status: 'completed',
        },
      },
    };
    expect(extractCodexTools(envelope)).toEqual([
      {
        id: 'exec-603041c7',
        name: 'mcp__nimbalyst__update_session_meta',
        isError: false,
      },
    ]);
  });

  it('maps app-server commandExecution to the live command_execution name', () => {
    const envelope = {
      method: 'item/completed',
      params: {
        item: {
          type: 'commandExecution',
          id: 'exec-361e',
          status: 'completed',
        },
      },
    };
    expect(extractCodexTools(envelope)).toEqual([
      { id: 'exec-361e', name: 'command_execution', isError: false },
    ]);
  });

  it('flags a non-completed status as an error', () => {
    const envelope = {
      method: 'item/completed',
      params: {
        item: { type: 'commandExecution', id: 'exec-9', status: 'failed' },
      },
    };
    expect(extractCodexTools(envelope)[0].isError).toBe(true);
  });

  it('ignores item/started envelopes (dedup by only counting completed)', () => {
    expect(
      extractCodexTools({
        method: 'item/started',
        params: { item: { type: 'mcpToolCall' } },
      }),
    ).toEqual([]);
  });

  it('extracts legacy SDK function, command, and MCP completion rows', () => {
    expect(
      extractCodexTools({
        type: 'item.completed',
        item: {
          type: 'function_call',
          id: 'item_0',
          name: 'Read',
          status: 'completed',
        },
      }),
    ).toEqual([{ id: 'item_0', name: 'Read', isError: false }]);
    expect(
      extractCodexTools({
        type: 'item.completed',
        item: { type: 'command_execution', id: 'item_0', exit_code: 1 },
      }),
    ).toEqual([{ id: 'item_0', name: 'command_execution', isError: true }]);
    expect(
      extractCodexTools({
        type: 'item.completed',
        item: {
          type: 'mcp_tool_call',
          id: 'item_0',
          server: 'nimbalyst',
          tool: 'update_session_meta',
        },
      }),
    ).toEqual([
      {
        id: 'item_0',
        name: 'mcp__nimbalyst__update_session_meta',
        isError: false,
      },
    ]);
  });
});
