import { describe, expect, it } from 'vitest';

import { shouldSyncMessageForSessionRoom, truncateContentForSync } from '../syncContentTruncator';

describe('truncateContentForSync', () => {
  it('caps oversized unknown-provider messages at a small opaque marker', () => {
    const raw = 'x'.repeat(40 * 1024);

    const result = truncateContentForSync(raw, 'custom-provider');

    expect(result.content.length).toBeLessThan(512);
    expect(result.content).toContain('elided from mobile sync');
    expect(result.stats.bytesAfter).toBeLessThan(512);
    expect(result.stats.elidedBytes).toBeGreaterThan(30 * 1024);
  });

  it('truncates the top-level tool_use_result so Edit results do not hit the whole-message marker', () => {
    // Claude Code attaches a `tool_use_result` sibling to message.content on
    // Edit/Write tool-result messages (filePath, oldString, newString,
    // originalFile, structuredPatch). For a large-file edit it is tens of KB and
    // lives OUTSIDE message.content, so per-block truncation never touches it --
    // the message then trips MAX_SYNC_MESSAGE_BYTES and gets replaced by the
    // opaque "[Full claude-code message elided...]" marker, which mobile renders
    // as a stray text bubble. The tool_result block content itself is tiny.
    const raw = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            tool_use_id: 'toolu_x',
            type: 'tool_result',
            content: 'The file /a/b/MarkdownRenderer.tsx has been updated successfully.',
          },
        ],
      },
      parent_tool_use_id: null,
      session_id: 'abc',
      tool_use_result: {
        filePath: '/a/b/MarkdownRenderer.tsx',
        oldString: 'x'.repeat(6 * 1024),
        newString: 'y'.repeat(6 * 1024),
        originalFile: 'z'.repeat(20 * 1024),
        structuredPatch: Array.from({ length: 200 }, (_, i) => ({ line: i, text: 'patch'.repeat(8) })),
        userModified: false,
      },
    });

    const result = truncateContentForSync(raw, 'claude-code');

    expect(result.stats.bytesAfter).toBeLessThanOrEqual(16 * 1024);
    expect(result.content).not.toContain('Full claude-code message elided');
    // Still valid JSON with the small tool_result intact (so mobile renders the
    // tool completion, not a stray bubble).
    const parsed = JSON.parse(result.content);
    expect(parsed.message.content[0].content).toContain('has been updated successfully');
    expect(parsed.tool_use_result.filePath).toBe('/a/b/MarkdownRenderer.tsx');
  });

  it('strips the dead thinking signature blob from sync but keeps the thinking text', () => {
    const raw = JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg_1',
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'short reasoning', signature: 'A'.repeat(12 * 1024) },
          { type: 'text', text: 'Done.' },
        ],
      },
    });

    const result = truncateContentForSync(raw, 'claude-code');
    const parsed = JSON.parse(result.content);
    const thinkingBlock = parsed.message.content[0];

    expect(thinkingBlock.signature).toBeUndefined();
    expect(thinkingBlock.thinking).toBe('short reasoning');
    expect(parsed.message.content[1].text).toBe('Done.');
    expect(result.stats.elidedBytes).toBeGreaterThan(11 * 1024);
  });

  it('caps known-provider sync rows even after per-block truncation', () => {
    const raw = JSON.stringify({
      message: {
        content: [
          { type: 'tool_result', content: 'a'.repeat(12 * 1024) },
          { type: 'tool_result', content: 'b'.repeat(12 * 1024) },
          { type: 'tool_result', content: 'c'.repeat(12 * 1024) },
          { type: 'tool_use', name: 'read', input: { path: '/tmp/file.txt' } },
        ],
      },
    });

    const result = truncateContentForSync(raw, 'claude-code');

    expect(result.stats.bytesAfter).toBeLessThanOrEqual(16 * 1024);
    expect(result.stats.blocksTruncated).toBeGreaterThan(1);
  });

  it('preserves Codex app-server command events while truncating nested output', () => {
    const raw = JSON.stringify({
      method: 'item/completed',
      params: {
        item: {
          id: 'cmd-1',
          type: 'commandExecution',
          status: 'completed',
          command: 'cat large.log',
          aggregatedOutput: 'x'.repeat(32 * 1024),
          exitCode: 0,
        },
        threadId: 'thread-1',
        turnId: 'turn-1',
      },
    });

    const result = truncateContentForSync(raw, 'openai-codex');

    expect(result.stats.bytesAfter).toBeLessThanOrEqual(16 * 1024);
    expect(result.content).not.toContain('Full openai-codex message elided');
    const parsed = JSON.parse(result.content);
    expect(parsed.method).toBe('item/completed');
    expect(parsed.params.item.aggregatedOutput).toContain('elided from mobile sync');
    expect(parsed.params.item.command).toBe('cat large.log');
  });

  it('preserves Codex app-server MCP events while truncating nested result content', () => {
    const raw = JSON.stringify({
      method: 'item/completed',
      params: {
        item: {
          id: 'mcp-1',
          type: 'mcpToolCall',
          status: 'completed',
          server: 'posthog',
          tool: 'exec',
          arguments: { command: 'info execute-sql' },
          result: {
            content: [{ type: 'text', text: 'schema'.repeat(6 * 1024) }],
          },
        },
        threadId: 'thread-1',
        turnId: 'turn-1',
      },
    });

    const result = truncateContentForSync(raw, 'openai-codex');

    expect(result.stats.bytesAfter).toBeLessThanOrEqual(16 * 1024);
    expect(result.content).not.toContain('Full openai-codex message elided');
    const parsed = JSON.parse(result.content);
    expect(parsed.method).toBe('item/completed');
    expect(parsed.params.item.result.content[0].text).toHaveLength(4 * 1024);
    expect(parsed.params.item.result.content[0].text).toMatch(/^schemaschema/);
    expect(parsed.params.item.result.content[1].text).toContain('elided from mobile sync');
    expect(parsed.params.item.arguments).toEqual({ command: 'info execute-sql' });
  });

  it('skips transient Codex app-server delta events from session-room sync', () => {
    expect(
      shouldSyncMessageForSessionRoom('openai-codex', {
        transport: 'app-server',
        eventType: 'item/agentMessage/delta',
      }),
    ).toBe(false);

    expect(
      shouldSyncMessageForSessionRoom('openai-codex', {
        transport: 'app-server',
        eventType: 'turn/diff/updated',
      }),
    ).toBe(false);
  });

  it('keeps completed Codex app-server events syncable', () => {
    expect(
      shouldSyncMessageForSessionRoom('openai-codex', {
        transport: 'app-server',
        eventType: 'item/completed',
      }),
    ).toBe(true);

    expect(
      shouldSyncMessageForSessionRoom('openai-codex', {
        transport: 'app-server',
        eventType: 'item/started',
      }),
    ).toBe(true);
  });

  it('skips transient Claude Code chunk types from session-room sync', () => {
    expect(
      shouldSyncMessageForSessionRoom(
        'claude-code',
        undefined,
        JSON.stringify({ type: 'tool_progress', name: 'Bash' }),
      ),
    ).toBe(false);

    expect(
      shouldSyncMessageForSessionRoom(
        'claude-code',
        undefined,
        JSON.stringify({ type: 'auth_status', isAuthenticating: true }),
      ),
    ).toBe(false);

    expect(
      shouldSyncMessageForSessionRoom(
        'claude-code',
        undefined,
        JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }),
      ),
    ).toBe(false);
  });

  it('skips claude-code thinking_tokens progress ticks from sync', () => {
    expect(
      shouldSyncMessageForSessionRoom(
        'claude-code',
        undefined,
        JSON.stringify({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 150 }),
      ),
    ).toBe(false);
  });

  it('skips transient Claude Code system subtypes (hooks, tasks)', () => {
    expect(
      shouldSyncMessageForSessionRoom(
        'claude-code',
        undefined,
        JSON.stringify({ type: 'system', subtype: 'hook_started', hook: 'PreToolUse' }),
      ),
    ).toBe(false);

    expect(
      shouldSyncMessageForSessionRoom(
        'claude-code',
        undefined,
        JSON.stringify({ type: 'system', subtype: 'task_progress' }),
      ),
    ).toBe(false);
  });

  it('drops the large non-rendering system/init chunk from sync', () => {
    // system/init is ~17 KB of tools/mcp_servers/slash_commands metadata that
    // no transcript consumer (desktop or mobile) renders. Syncing it wasted
    // bytes and -- worse -- the whole-message clamp rewrote it into a bare
    // "[Full claude-code message elided...]" marker string. On mobile that
    // string fails JSON.parse and falls through to the plain-text branch,
    // surfacing as a stray assistant bubble that desktop never shows.
    expect(
      shouldSyncMessageForSessionRoom(
        'claude-code',
        undefined,
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc', tools: [] }),
      ),
    ).toBe(false);
  });

  it('keeps durable Claude Code chunks syncable', () => {
    expect(
      shouldSyncMessageForSessionRoom(
        'claude-code',
        undefined,
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }),
      ),
    ).toBe(true);

    expect(
      shouldSyncMessageForSessionRoom(
        'claude-code',
        undefined,
        JSON.stringify({ type: 'system', subtype: 'compact_boundary' }),
      ),
    ).toBe(true);
  });

  it('drops claude-code result chunks except the num_turns===0 text-backfill case', () => {
    // Normal turn results duplicate the final assistant text and carry
    // usage/cost fields mobile never reads -- drop.
    expect(
      shouldSyncMessageForSessionRoom(
        'claude-code',
        undefined,
        JSON.stringify({ type: 'result', subtype: 'success', num_turns: 3, result: 'final text', usage: { input_tokens: 100 } }),
      ),
    ).toBe(false);

    // Unknown-slash-command turns (num_turns===0) render ONLY via the result
    // chunk -- keep.
    expect(
      shouldSyncMessageForSessionRoom(
        'claude-code',
        undefined,
        JSON.stringify({ type: 'result', subtype: 'success', num_turns: 0, result: 'Unknown command: /foo' }),
      ),
    ).toBe(true);

    // num_turns===0 with no result text renders nothing -- drop.
    expect(
      shouldSyncMessageForSessionRoom(
        'claude-code',
        undefined,
        JSON.stringify({ type: 'result', subtype: 'success', num_turns: 0, result: '   ' }),
      ),
    ).toBe(false);
  });

  it('applies claude-code transient filtering to claude-code-cli sessions', () => {
    expect(
      shouldSyncMessageForSessionRoom(
        'claude-code-cli',
        undefined,
        JSON.stringify({ type: 'tool_progress', name: 'Bash' }),
      ),
    ).toBe(false);

    expect(
      shouldSyncMessageForSessionRoom(
        'claude-code-cli',
        undefined,
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }),
      ),
    ).toBe(true);
  });

  it('drops hidden rows for every source except opencode', () => {
    // Every raw parser early-returns on hidden rows, so they render nothing.
    expect(
      shouldSyncMessageForSessionRoom('claude-code', undefined, JSON.stringify({ type: 'user' }), true),
    ).toBe(false);
    expect(
      shouldSyncMessageForSessionRoom('openai-codex', { transport: 'app-server', eventType: 'item/completed' }, '{}', true),
    ).toBe(false);

    // OpenCode persists its whole SSE stream hidden and renders FROM those
    // hidden output rows -- they must keep syncing.
    expect(
      shouldSyncMessageForSessionRoom(
        'opencode',
        { eventType: 'message.part.delta' },
        JSON.stringify({ type: 'message.part.delta', properties: { field: 'text', delta: 'hi', messageID: 'm1' } }),
        true,
      ),
    ).toBe(true);
  });

  it('drops non-rendering legacy codex transport events', () => {
    expect(
      shouldSyncMessageForSessionRoom('openai-codex', { eventType: 'token_count' }, JSON.stringify({ type: 'token_count', info: {} })),
    ).toBe(false);
    expect(
      shouldSyncMessageForSessionRoom('openai-codex', { eventType: 'thread.started' }, JSON.stringify({ type: 'thread.started', thread_id: 't1' })),
    ).toBe(false);
    expect(
      shouldSyncMessageForSessionRoom(
        'openai-codex',
        { eventType: 'event_msg' },
        JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: {} } }),
      ),
    ).toBe(false);

    // Rendered legacy events keep syncing: items carry text/tools/todo_list.
    expect(
      shouldSyncMessageForSessionRoom(
        'openai-codex',
        { eventType: 'item.completed' },
        JSON.stringify({ type: 'item.completed', item: { type: 'message', text: 'hi' } }),
      ),
    ).toBe(true);
    expect(
      shouldSyncMessageForSessionRoom(
        'openai-codex',
        { eventType: 'task_complete' },
        JSON.stringify({ type: 'task_complete', last_agent_message: 'done' }),
      ),
    ).toBe(true);
  });

  it('whitelists opencode SSE events by what the parser can render', () => {
    const opencodeMeta = (eventType: string) => ({ eventType, openCodeProvider: true });

    // Role-map + rendered types keep syncing.
    expect(
      shouldSyncMessageForSessionRoom('opencode', opencodeMeta('message.updated'), JSON.stringify({ type: 'message.updated', properties: { info: { id: 'm1', role: 'assistant' } } }), true),
    ).toBe(true);
    expect(
      shouldSyncMessageForSessionRoom('opencode', opencodeMeta('session.error'), '{}', true),
    ).toBe(true);
    expect(
      shouldSyncMessageForSessionRoom('opencode', opencodeMeta('todo.updated'), '{}', true),
    ).toBe(true);

    // Tool parts render from part.updated; text snapshots there are
    // cumulative dupes of the delta stream.
    expect(
      shouldSyncMessageForSessionRoom(
        'opencode',
        opencodeMeta('message.part.updated'),
        JSON.stringify({ type: 'message.part.updated', properties: { part: { type: 'tool', id: 'p1' } } }),
        true,
      ),
    ).toBe(true);
    expect(
      shouldSyncMessageForSessionRoom(
        'opencode',
        opencodeMeta('message.part.updated'),
        JSON.stringify({ type: 'message.part.updated', properties: { part: { type: 'text', text: 'cumulative snapshot' } } }),
        true,
      ),
    ).toBe(false);

    // Only text-field deltas render.
    expect(
      shouldSyncMessageForSessionRoom(
        'opencode',
        opencodeMeta('message.part.delta'),
        JSON.stringify({ type: 'message.part.delta', properties: { field: 'text', delta: 'hi', messageID: 'm1' } }),
        true,
      ),
    ).toBe(true);
    expect(
      shouldSyncMessageForSessionRoom(
        'opencode',
        opencodeMeta('message.part.delta'),
        JSON.stringify({ type: 'message.part.delta', properties: { field: 'reasoning', delta: 'thinking...', messageID: 'm1' } }),
        true,
      ),
    ).toBe(false);

    // session.idle only yields turn_ended, which the projector drops.
    expect(
      shouldSyncMessageForSessionRoom('opencode', opencodeMeta('session.idle'), '{}', true),
    ).toBe(false);
    // Unknown SSE types hit the parser's default: return [].
    expect(
      shouldSyncMessageForSessionRoom('opencode', opencodeMeta('server.connected'), '{}', true),
    ).toBe(false);

    // Non-SSE rows (no eventType, e.g. user input) always sync.
    expect(shouldSyncMessageForSessionRoom('opencode', {}, 'user prompt text')).toBe(true);
  });

  it('drops non-rendering codex ACP session updates', () => {
    expect(
      shouldSyncMessageForSessionRoom(
        'openai-codex-acp',
        undefined,
        JSON.stringify({ type: 'session/update', sessionId: 's1', update: { sessionUpdate: 'usage_update', used: 100, size: 200000 } }),
      ),
    ).toBe(false);
    expect(
      shouldSyncMessageForSessionRoom(
        'openai-codex-acp',
        undefined,
        JSON.stringify({ type: 'session/request_permission_preview', sessionId: 's1' }),
      ),
    ).toBe(false);

    // Rendered updates keep syncing.
    expect(
      shouldSyncMessageForSessionRoom(
        'openai-codex-acp',
        undefined,
        JSON.stringify({ type: 'session/update', sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } } }),
      ),
    ).toBe(true);
    expect(
      shouldSyncMessageForSessionRoom(
        'openai-codex-acp',
        undefined,
        JSON.stringify({ type: 'session/request_permission', sessionId: 's1', request: {} }),
      ),
    ).toBe(true);
  });

  it('drops copilot-cli agent_message_chunk rows (item.completed is self-contained)', () => {
    expect(
      shouldSyncMessageForSessionRoom(
        'copilot-cli',
        { eventType: 'session/update' },
        JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial' } } } }),
      ),
    ).toBe(false);
    expect(
      shouldSyncMessageForSessionRoom(
        'copilot-cli',
        { eventType: 'session/update' },
        JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'thinking', text: 'hmm' } } } }),
      ),
    ).toBe(false);

    // The completed item carries the full text itself -- keep.
    expect(
      shouldSyncMessageForSessionRoom(
        'copilot-cli',
        { eventType: 'item.completed' },
        JSON.stringify({ type: 'item.completed', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'full text' }] } }),
      ),
    ).toBe(true);
  });
});
