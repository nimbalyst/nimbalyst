import { describe, it, expect, vi } from 'vitest';
import { logClaudeCliUserPrompt } from '../claudeCliUserPromptLog';

/**
 * NIM-806 BUG 1 — the user's typed prompt is captured at SEND time (the input box
 * → PTY path) and persisted as a `direction:'input'` row, NOT scraped from the
 * `/v1/messages` request body (which on a real Claude Code turn is the whole
 * injected context: CLAUDE.md, memory, <system-reminder>, file context). These
 * tests pin the row shape the existing `ClaudeCodeRawParser` projects.
 */
describe('logClaudeCliUserPrompt', () => {
  function harness() {
    const createMessage = vi.fn(async () => undefined);
    const notifyMessageLogged = vi.fn();
    const now = new Date('2026-06-08T00:00:00.000Z');
    return {
      createMessage,
      notifyMessageLogged,
      deps: { createMessage, notifyMessageLogged, now: () => now },
      now,
    };
  }

  it('persists the typed prompt as a claude-code input row with the { prompt } shape', async () => {
    const h = harness();
    await logClaudeCliUserPrompt(
      { sessionId: 'sess-1', workspacePath: '/work', prompt: 'hello world' },
      h.deps,
    );
    expect(h.createMessage).toHaveBeenCalledTimes(1);
    expect(h.createMessage).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      source: 'claude-code',
      direction: 'input',
      content: JSON.stringify({ prompt: 'hello world' }),
      hidden: false,
      createdAt: h.now,
    });
  });

  it('broadcasts ai:message-logged so the transcript reloads', async () => {
    const h = harness();
    await logClaudeCliUserPrompt(
      { sessionId: 'sess-1', workspacePath: '/work', prompt: 'hi' },
      h.deps,
    );
    expect(h.notifyMessageLogged).toHaveBeenCalledWith('sess-1', '/work');
  });

  it('does nothing for a blank prompt with no attachments (no row, no broadcast)', async () => {
    const h = harness();
    await logClaudeCliUserPrompt({ sessionId: 'sess-1', workspacePath: '/work', prompt: '   ' }, h.deps);
    await logClaudeCliUserPrompt({ sessionId: 'sess-1', workspacePath: '/work', prompt: '' }, h.deps);
    expect(h.createMessage).not.toHaveBeenCalled();
    expect(h.notifyMessageLogged).not.toHaveBeenCalled();
  });

  it('persists attachments into row metadata (chips render off msg.metadata.attachments)', async () => {
    const h = harness();
    const attachments = [
      { id: 'a1', filename: 'x.png', filepath: '/tmp/x.png', mimeType: 'image/png', size: 10, type: 'image' as const, addedAt: 0 },
    ];
    await logClaudeCliUserPrompt(
      { sessionId: 'sess-1', workspacePath: '/work', prompt: 'see this', attachments },
      h.deps,
    );
    expect(h.createMessage).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      source: 'claude-code',
      direction: 'input',
      content: JSON.stringify({ prompt: 'see this' }),
      hidden: false,
      createdAt: h.now,
      metadata: { attachments },
    });
  });

  it('persists an image-only submission (blank prompt + attachments)', async () => {
    const h = harness();
    const attachments = [
      { id: 'a1', filename: 'x.png', filepath: '/tmp/x.png', mimeType: 'image/png', size: 10, type: 'image' as const, addedAt: 0 },
    ];
    await logClaudeCliUserPrompt(
      { sessionId: 'sess-1', workspacePath: '/work', prompt: '', attachments },
      h.deps,
    );
    expect(h.createMessage).toHaveBeenCalledTimes(1);
    expect(h.createMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: JSON.stringify({ prompt: '' }), metadata: { attachments } }),
    );
    expect(h.notifyMessageLogged).toHaveBeenCalledWith('sess-1', '/work');
  });

  it('swallows a repository error without throwing (best-effort logging)', async () => {
    const h = harness();
    h.createMessage.mockRejectedValueOnce(new Error('db down'));
    await expect(
      logClaudeCliUserPrompt({ sessionId: 'sess-1', workspacePath: '/work', prompt: 'hi' }, h.deps),
    ).resolves.toBeUndefined();
    // A failed persist must not broadcast a reload for a row that isn't there.
    expect(h.notifyMessageLogged).not.toHaveBeenCalled();
  });
});
