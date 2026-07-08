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
        JSON.stringify({ type: 'result', subtype: 'success', num_turns: 1 }),
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
});
