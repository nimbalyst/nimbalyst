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
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc' }),
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
