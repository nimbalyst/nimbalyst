import { describe, it, expect, vi } from 'vitest';
import {
  submitClaudeCliPrompt,
  submitWriteGapMs,
  SUBMIT_WRITE_GAP_MS,
  SUBMIT_WRITE_GAP_MAX_MS,
} from '../claudeCliSubmit';
import type { ChatAttachment } from '@nimbalyst/runtime/ai/server/types';

/** Bracketed-paste markers the composed path wraps its payload in. */
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
const pasted = (s: string) => PASTE_START + s + PASTE_END;

function harness() {
  const writes: Array<[string, string]> = [];
  const delays: number[] = [];
  const logUserPrompt = vi.fn(async () => undefined);
  const sendAnalytics = vi.fn();
  const deps = {
    writeToTerminal: (sessionId: string, data: string) => { writes.push([sessionId, data]); },
    logUserPrompt,
    sendAnalytics,
    delay: async (ms: number) => { delays.push(ms); },
  };
  return { writes, delays, logUserPrompt, sendAnalytics, deps };
}

const img = (filepath: string): ChatAttachment => ({
  id: filepath, filename: 'x.png', filepath, mimeType: 'image/png', size: 1, type: 'image', addedAt: 0,
});

describe('submitClaudeCliPrompt Enter confirmation', () => {
  /**
   * Measured on claude 2.1.220 (nimbalyst-local/cli-paste-probes/05 and 06): a
   * payload carrying an image path strands at 25ms and 200ms and only submits
   * from ~400ms. The CLI reads and decodes the file after the bytes land, and an
   * Enter arriving during that window is swallowed.
   *
   * `submitWriteGapMs` is computed from the PAYLOAD LENGTH, so a short sentence
   * plus one path is ~300 chars -> 25ms, no matter how many megabytes the
   * referenced image is. No constant fixes that; confirm the turn started and
   * press Enter again if it did not.
   */
  it('re-sends Enter when the first one did not start a turn', async () => {
    const h = harness();
    let started = false;
    await submitClaudeCliPrompt(
      { sessionId: 's1', workspacePath: '/w', prompt: 'look', attachments: [img('/tmp/a.png')] },
      // Turn only starts after a SECOND Enter, as a swallowed first Enter behaves.
      {
        ...h.deps,
        hasTurnStarted: () => started,
        writeToTerminal: (sessionId: string, data: string) => {
          h.writes.push([sessionId, data]);
          if (data === '\r' && h.writes.filter(([, d]) => d === '\r').length >= 2) started = true;
        },
      },
    );

    const enters = h.writes.filter(([, d]) => d === '\r');
    expect(enters.length).toBe(2);
  });

  it('does not re-send Enter when the first one worked', async () => {
    const h = harness();
    await submitClaudeCliPrompt(
      { sessionId: 's1', workspacePath: '/w', prompt: 'look', attachments: [img('/tmp/a.png')] },
      { ...h.deps, hasTurnStarted: () => true },
    );
    expect(h.writes.filter(([, d]) => d === '\r').length).toBe(1);
  });
});

describe('submitClaudeCliPrompt', () => {
  it('writes the composed PTY line, then a separate Enter', async () => {
    const h = harness();
    await submitClaudeCliPrompt(
      { sessionId: 's1', workspacePath: '/w', prompt: 'do it', attachments: [img('/tmp/a.png')] },
      h.deps,
    );
    expect(h.writes).toEqual([
      ['s1', pasted('do it /tmp/a.png')],
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

    it('does NOT add a menu-dismiss space when the slash command already has args (menu closed by its own space) (NIM-851)', async () => {
      const h = harness();
      await submitClaudeCliPrompt({ sessionId: 's1', workspacePath: '/w', prompt: '/track bug foo' }, h.deps);
      expect(h.writes).toEqual([
        ['s1', '/'],
        ['s1', 'track bug foo'],
        ['s1', '\r'],
      ]);
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
        ['s1', pasted('/review /tmp/a.png')],
        ['s1', '\r'],
      ]);
    });
  });

  /**
   * A single large pty.write is fragmented by the OS PTY layer; the CLI's paste
   * detector saw each fragment as its own paste, so one message arrived as
   * several "[Pasted text #N]" placeholders. Enter landing mid-drain then
   * submitted only part of it.
   */
  describe('large-payload submission', () => {
    it('wraps the composed payload in bracketed-paste markers', async () => {
      const h = harness();
      await submitClaudeCliPrompt(
        { sessionId: 's1', workspacePath: '/w', prompt: 'hello' },
        h.deps,
      );
      expect(h.writes[0][1]).toBe(pasted('hello'));
    });

    it('does NOT wrap a slash command (the trigger must stay a real keystroke)', async () => {
      const h = harness();
      await submitClaudeCliPrompt(
        { sessionId: 's1', workspacePath: '/w', prompt: '/clear' },
        h.deps,
      );
      for (const [, data] of h.writes) {
        expect(data).not.toContain(PASTE_START);
        expect(data).not.toContain(PASTE_END);
      }
    });

    it('keeps the original gap for ordinary prompts', () => {
      expect(submitWriteGapMs(0)).toBe(SUBMIT_WRITE_GAP_MS);
      expect(submitWriteGapMs(500)).toBe(SUBMIT_WRITE_GAP_MS);
    });

    it('scales the gap with payload size so Enter cannot land mid-drain', () => {
      expect(submitWriteGapMs(20_000)).toBeGreaterThan(SUBMIT_WRITE_GAP_MS);
      expect(submitWriteGapMs(20_000)).toBeGreaterThanOrEqual(75);
    });

    it('caps the gap so a huge paste cannot stall submission', () => {
      expect(submitWriteGapMs(50_000_000)).toBe(SUBMIT_WRITE_GAP_MAX_MS);
    });

    it('waits longer before Enter for a large prompt than a small one', async () => {
      const small = harness();
      await submitClaudeCliPrompt(
        { sessionId: 's1', workspacePath: '/w', prompt: 'hi' },
        small.deps,
      );
      const large = harness();
      await submitClaudeCliPrompt(
        { sessionId: 's1', workspacePath: '/w', prompt: 'x'.repeat(20_000) },
        large.deps,
      );
      expect(large.delays[0]).toBeGreaterThan(small.delays[0]);
    });
  });
});
