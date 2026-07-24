import { describe, expect, it } from 'vitest';
import { parseCodexEvent } from '../codexEventParser';

describe('parseCodexEvent token_count parsing', () => {
  it('extracts usage and context snapshot from event_msg token_count payload', () => {
    const parsed = parseCodexEvent({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          model_context_window: 258400,
          last_token_usage: {
            input_tokens: 100452,
            output_tokens: 76,
            total_tokens: 100528,
          },
        },
      },
    });

    const usageEvent = parsed.find((event) => event.usage || event.contextSnapshot);
    expect(usageEvent).toBeDefined();
    expect(usageEvent?.usage).toEqual({
      input_tokens: 100452,
      output_tokens: 76,
      total_tokens: 100528,
    });
    expect(usageEvent?.contextSnapshot).toEqual({
      contextFillTokens: 100452,
      contextWindow: 258400,
    });
  });

  it('falls back to flat info usage for direct token_count events', () => {
    const parsed = parseCodexEvent({
      type: 'token_count',
      info: {
        input_tokens: 12,
        output_tokens: 3,
        total_tokens: 15,
        model_context_window: 200000,
      },
    });

    const usageEvent = parsed.find((event) => event.usage || event.contextSnapshot);
    expect(usageEvent).toBeDefined();
    expect(usageEvent?.usage).toEqual({
      input_tokens: 12,
      output_tokens: 3,
      total_tokens: 15,
    });
    expect(usageEvent?.contextSnapshot).toEqual({
      contextFillTokens: 12,
      contextWindow: 200000,
    });
  });

  it('normalizes command_execution items into a Bash-like tool call shape', () => {
    const parsed = parseCodexEvent({
      type: 'item.completed',
      item: {
        id: 'cmd-1',
        type: 'command_execution',
        command: '/bin/zsh -lc "sed -n \'1,20p\' CLAUDE.md"',
        aggregated_output: '# CLAUDE.md',
        exit_code: 0,
        status: 'completed',
      },
    });

    expect(parsed).toContainEqual({
      toolCall: {
        id: 'cmd-1',
        name: 'command_execution',
        arguments: {
          command: '/bin/zsh -lc "sed -n \'1,20p\' CLAUDE.md"',
        },
        result: {
          success: true,
          command: '/bin/zsh -lc "sed -n \'1,20p\' CLAUDE.md"',
          output: '# CLAUDE.md',
          exit_code: 0,
          status: 'completed',
        },
      },
      rawEvent: {
        type: 'item.completed',
        item: {
          id: 'cmd-1',
          type: 'command_execution',
          command: '/bin/zsh -lc "sed -n \'1,20p\' CLAUDE.md"',
          aggregated_output: '# CLAUDE.md',
          exit_code: 0,
          status: 'completed',
        },
      },
    });
  });

  it('normalizes mcp_tool_call items into canonical MCP tool names', () => {
    const parsed = parseCodexEvent({
      type: 'item.completed',
      item: {
        id: 'mcp-1',
        type: 'mcp_tool_call',
        server: 'nimbalyst-extension-dev',
        tool: 'database_query',
        arguments: { sql: 'SELECT 1' },
        result: { rows: [{ value: 1 }] },
        error: null,
        status: 'completed',
      },
    });

    expect(parsed).toContainEqual({
      toolCall: {
        id: 'mcp-1',
        name: 'mcp__nimbalyst-extension-dev__database_query',
        arguments: { sql: 'SELECT 1' },
        result: {
          success: true,
          result: { rows: [{ value: 1 }] },
          status: 'completed',
        },
      },
      rawEvent: {
        type: 'item.completed',
        item: {
          id: 'mcp-1',
          type: 'mcp_tool_call',
          server: 'nimbalyst-extension-dev',
          tool: 'database_query',
          arguments: { sql: 'SELECT 1' },
          result: { rows: [{ value: 1 }] },
          error: null,
          status: 'completed',
        },
      },
    });
  });
});
