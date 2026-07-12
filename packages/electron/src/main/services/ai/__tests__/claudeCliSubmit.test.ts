import { describe, it, expect, vi } from 'vitest';
import { submitClaudeCliPrompt } from '../claudeCliSubmit';
import type { ChatAttachment } from '@nimbalyst/runtime/ai/server/types';

function harness() {
  const writes: Array<[string, string]> = [];
  const logUserPrompt = vi.fn(async () => undefined);
  const sendAnalytics = vi.fn();
  const deps = {
    writeToTerminal: (sessionId: string, data: string) => { writes.push([sessionId, data]); },
    logUserPrompt,
    sendAnalytics,
    delay: async () => undefined,
  };
  return { writes, logUserPrompt, sendAnalytics, deps };
}

const img = (filepath: string): ChatAttachment => ({
  id: filepath, filename: 'x.png', filepath, mimeType: 'image/png', size: 1, type: 'image', addedAt: 0,
});

describe('submitClaudeCliPrompt', () => {
  it('writes the composed PTY line, then a separate Enter', async () => {
    const h = harness();
    await submitClaudeCliPrompt(
      { sessionId: 's1', workspacePath: '/w', prompt: 'do it', attachments: [img('/tmp/a.png')] },
      h.deps,
    );
    expect(h.writes).toEqual([
      ['s1', 'do it /tmp/a.png'],
      ['s1', '\r'],
    ]);
  });

  it('logs the CLEAN typed prompt + attachments, NOT the path-augmented PTY line', async () => {
    const h = harness();
    const attachments = [img('/tmp/a.png')];
    await submitClaudeCliPrompt(
      { sessionId: 's1', workspacePath: '/w', prompt: 'do it', attachments },
      h.deps,
    );
    expect(h.logUserPrompt).toHaveBeenCalledWith({
      sessionId: 's1',
      workspacePath: '/w',
      prompt: 'do it',
      attachments,
    });
  });

  it('reports real attachment flags to analytics', async () => {
    const h = harness();
    await submitClaudeCliPrompt(
      { sessionId: 's1', workspacePath: '/w', prompt: 'hi', attachments: [img('/a'), img('/b')] },
      h.deps,
    );
    expect(h.sendAnalytics).toHaveBeenCalledWith({
      messageLength: 2,
      hasAttachments: true,
      attachmentCount: 2,
      hasDocumentContext: false,
    });
  });

  it('appends the document-context block to the PTY line but logs the clean prompt (NIM-818)', async () => {
    const h = harness();
    await submitClaudeCliPrompt(
      {
        sessionId: 's1',
        workspacePath: '/w',
        prompt: 'summarize this doc',
        documentContext: { filePath: '/ws/notes.md', textSelection: { text: 'pick\nme' } },
      },
      h.deps,
    );
    expect(h.writes[0][1]).toContain('<ACTIVE_DOCUMENT>/ws/notes.md</ACTIVE_DOCUMENT>');
    expect(h.writes[0][1]).toContain('<SELECTED_TEXT>pick\\nme</SELECTED_TEXT>');
    expect(h.logUserPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'summarize this doc' }),
    );
    expect(h.sendAnalytics).toHaveBeenCalledWith(
      expect.objectContaining({ hasDocumentContext: true }),
    );
  });

  it('no-ops (no write/log/analytics) when there is nothing to send', async () => {
    const h = harness();
    const res = await submitClaudeCliPrompt({ sessionId: 's1', workspacePath: '/w', prompt: '   ' }, h.deps);
    expect(res).toEqual({ submitted: false });
    expect(h.writes).toHaveLength(0);
    expect(h.logUserPrompt).not.toHaveBeenCalled();
    expect(h.sendAnalytics).not.toHaveBeenCalled();
  });

  /**
   * NIM-819: the claude TUI only opens its slash/memory mode when / or # is
   * the FIRST interactive keystroke on an empty prompt — a bulk-pasted line is
   * treated as literal text. Trigger-prefixed prompts are written as the
   * trigger char alone, then the rest, then Enter.
   */
  describe('TUI trigger prompts (NIM-819)', () => {
    it('writes / as its own keystroke before the rest of a slash command', async () => {
      const h = harness();
      await submitClaudeCliPrompt({ sessionId: 's1', workspacePath: '/w', prompt: '/clear' }, h.deps);
      expect(h.writes).toEqual([
        ['s1', '/'],
        ['s1', 'clear'],
        ['s1', ' '], // NIM-851: dismiss the autocomplete menu so Enter runs the literal command
        ['s1', '\r'],
      ]);
    });

    it('writes # as its own keystroke before a memory note', async () => {
      const h = harness();
      await submitClaudeCliPrompt(
        { sessionId: 's1', workspacePath: '/w', prompt: '# remember the build cmd' },
        h.deps,
      );
      expect(h.writes[0]).toEqual(['s1', '#']);
      expect(h.writes[1]).toEqual(['s1', ' remember the build cmd']);
      expect(h.writes[2]).toEqual(['s1', '\r']);
    });

    it('types a trailing space to dismiss the autocomplete menu before Enter on a bare slash command (NIM-851)', async () => {
      const h = harness();
      await submitClaudeCliPrompt({ sessionId: 's1', workspacePath: '/w', prompt: '/implement' }, h.deps);
      expect(h.writes).toEqual([
        ['s1', '/'],
        ['s1', 'implement'],
        ['s1', ' '],
        ['s1', '\r'],
      ]);
    });

    it('resolves the slash-command menu before writing an argument tail', async () => {
      const h = harness();
      await submitClaudeCliPrompt({ sessionId: 's1', workspacePath: '/w', prompt: '/track bug foo' }, h.deps);
      expect(h.writes).toEqual([
        ['s1', '/'],
        ['s1', 'track'],
        ['s1', ' '],
        ['s1', 'bug foo'],
        ['s1', '\r'],
      ]);
    });

    it('single-line normalizes a slash-command argument tail before writing to the PTY', async () => {
      const h = harness();
      await submitClaudeCliPrompt(
        {
          sessionId: 's1',
          workspacePath: '/w',
          prompt: '/compact focus on current state\r\n/clear\tthen continue',
        },
        h.deps,
      );
      expect(h.writes).toEqual([
        ['s1', '/'],
        ['s1', 'compact'],
        ['s1', ' '],
        ['s1', 'focus on current state /clear then continue'],
        ['s1', '\r'],
      ]);
      expect(h.writes.slice(0, -1).every(([, data]) => !/[\r\n]/.test(data))).toBe(true);
    });

    it('strips PTY control bytes from slash-command input', async () => {
      const h = harness();
      await submitClaudeCliPrompt(
        { sessionId: 's1', workspacePath: '/w', prompt: '/compact focus on keep\x1b[31mstate\x07' },
        h.deps,
      );
      expect(h.writes).toEqual([
        ['s1', '/'],
        ['s1', 'compact'],
        ['s1', ' '],
        ['s1', 'focus on keep[31mstate'],
        ['s1', '\r'],
      ]);
      expect(h.logUserPrompt).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: '/compact focus on keep[31mstate' }),
      );
    });

    it('does NOT add a menu-dismiss space for # memory notes (NIM-851)', async () => {
      const h = harness();
      await submitClaudeCliPrompt({ sessionId: 's1', workspacePath: '/w', prompt: '#note' }, h.deps);
      expect(h.writes).toEqual([
        ['s1', '#'],
        ['s1', 'note'],
        ['s1', '\r'],
      ]);
    });

    it('a bare trigger char still submits (opens the native menu)', async () => {
      const h = harness();
      await submitClaudeCliPrompt({ sessionId: 's1', workspacePath: '/w', prompt: '/' }, h.deps);
      expect(h.writes).toEqual([
        ['s1', '/'],
        ['s1', '\r'],
      ]);
    });

    it('does NOT append the document-context block to a slash command', async () => {
      const h = harness();
      await submitClaudeCliPrompt(
        {
          sessionId: 's1',
          workspacePath: '/w',
          prompt: '/compact',
          documentContext: { filePath: '/ws/notes.md' },
        },
        h.deps,
      );
      expect(h.writes.map(([, d]) => d).join('')).not.toContain('ACTIVE_DOCUMENT');
    });

    it('a prompt WITH attachments goes through the normal composed path even if slash-prefixed', async () => {
      const h = harness();
      await submitClaudeCliPrompt(
        { sessionId: 's1', workspacePath: '/w', prompt: '/review', attachments: [img('/tmp/a.png')] },
        h.deps,
      );
      expect(h.writes).toEqual([
        ['s1', '/review /tmp/a.png'],
        ['s1', '\r'],
      ]);
    });
  });
});
