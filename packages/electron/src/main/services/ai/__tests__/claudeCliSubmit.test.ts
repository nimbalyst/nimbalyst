import { describe, it, expect, vi } from 'vitest';
import {
  submitClaudeCliPrompt,
  submitWriteGapMs,
  SUBMIT_WRITE_GAP_MS,
  SUBMIT_WRITE_GAP_MAX_MS,
} from '../claudeCliSubmit';
import type { ChatAttachment } from '@nimbalyst/runtime/ai/server/types';

const productionMocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => unknown>(),
  loadSession: vi.fn(),
  writeToTerminal: vi.fn(),
  logUserPrompt: vi.fn(async () => undefined),
  sendEvent: vi.fn(),
  reveal: vi.fn(),
}));

vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({
  AISessionsRepository: { get: productionMocks.loadSession },
}));

vi.mock('../../TerminalSessionManager', () => ({
  getTerminalSessionManager: () => ({
    writeToTerminal: productionMocks.writeToTerminal,
  }),
}));

vi.mock('../claudeCliUserPromptLog', () => ({
  logClaudeCliUserPrompt: productionMocks.logUserPrompt,
}));

vi.mock('../claudeCliRevealTerminal', () => ({
  broadcastClaudeCliRevealTerminal: productionMocks.reveal,
}));

vi.mock('../../analytics/AnalyticsService', () => ({
  AnalyticsService: {
    getInstance: () => ({ sendEvent: productionMocks.sendEvent }),
  },
}));

vi.mock('../../../utils/ipcRegistry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/ipcRegistry')>()),
  safeHandle: vi.fn((channel: string, handler: (...args: any[]) => unknown) => {
    productionMocks.handlers.set(channel, handler);
  }),
}));

vi.mock('../claudeCliLauncherSingleton', () => ({
  ensureClaudeCliSession: vi.fn(),
  isClaudeCliInstalled: vi.fn(),
}));

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

  it('strips PTY-unsafe control bytes (e.g. an embedded ESC sequence) from the prompt before writing', async () => {
    const h = harness();
    await submitClaudeCliPrompt(
      { sessionId: 's1', workspacePath: '/w', prompt: 'do it\x1b[31mnow\x07' },
      h.deps,
    );
    // Non-slash-command prompts are wrapped in bracketed-paste markers so the
    // CLI treats the write as one paste instead of one per PTY fragment
    // (unrelated to control-byte stripping, added after this fix was written).
    expect(h.writes).toEqual([
      ['s1', '\x1b[200~do it[31mnow\x1b[201~'],
      ['s1', '\r'],
    ]);
    expect(h.logUserPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'do it[31mnow' }),
    );
  });

  it('keeps tab and embedded newline/carriage-return in the prompt (legitimate whitespace, not PTY-unsafe)', async () => {
    const h = harness();
    await submitClaudeCliPrompt(
      { sessionId: 's1', workspacePath: '/w', prompt: 'line one\nline two\tindented' },
      h.deps,
    );
    // The composer flattens a real newline to a literal '\n' before it ever
    // reaches the PTY (a genuine newline is Enter to the CLI's readline and
    // would submit mid-prompt) -- unrelated to control-byte stripping, this
    // is the composer's own multi-line-prompt safety behavior.
    expect(h.writes[0]).toEqual(['s1', '\x1b[200~line one\\nline two\tindented\x1b[201~']);
  });

  it('no-ops (no write/log/analytics) when there is nothing to send', async () => {
    const h = harness();
    const res = await submitClaudeCliPrompt({ sessionId: 's1', workspacePath: '/w', prompt: '   ' }, h.deps);
    expect(res).toEqual({ submitted: false });
    expect(h.writes).toHaveLength(0);
    expect(h.logUserPrompt).not.toHaveBeenCalled();
    expect(h.sendAnalytics).not.toHaveBeenCalled();
  });

  it('keeps provider entry non-terminal when post-write prompt logging fails', async () => {
    const h = harness();
    h.logUserPrompt.mockRejectedValueOnce(new Error('disk unavailable'));
    await expect(submitClaudeCliPrompt({ sessionId: 's1', workspacePath: '/w', prompt: 'already entered' }, h.deps))
      .resolves.toEqual({ submitted: true });
    expect(h.writes).toHaveLength(2);
    expect(h.sendAnalytics).toHaveBeenCalledTimes(1);
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

    it('isolates the command name and sends its own menu-dismiss space BEFORE the arguments (NIM-XXXX, corrects NIM-851)', async () => {
      // A bulk-written "track bug foo" let the autocomplete menu keep
      // fuzzy-matching the WHOLE trailing text instead of locking onto
      // "track" at the natural word boundary, so Enter could hijack the
      // wrong highlighted row -- or land on no match and submit the raw
      // text as a literal chat message. Fix: always resolve/dismiss the
      // menu on the bare command name first, then send the argument text.
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

    it('reliably submits "/compact focus on <text>" (the agent-triggered self-compaction case)', async () => {
      const h = harness();
      await submitClaudeCliPrompt(
        { sessionId: 's1', workspacePath: '/w', prompt: '/compact focus on current task state' },
        h.deps,
      );
      expect(h.writes).toEqual([
        ['s1', '/'],
        ['s1', 'compact'],
        ['s1', ' '],
        ['s1', 'focus on current task state'],
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

describe('registered claude-cli:submit-prompt recovery boundary', () => {
  it(
    'keeps every production side effect at zero for fail-closed states, then submits exactly once after recovery',
    async () => {
      productionMocks.handlers.clear();
      productionMocks.loadSession.mockReset();
      productionMocks.writeToTerminal.mockClear();
      productionMocks.logUserPrompt.mockClear();
      productionMocks.sendEvent.mockClear();
      productionMocks.reveal.mockClear();

      const { registerTerminalHandlers } = await import('../../../ipc/TerminalHandlers');
      registerTerminalHandlers();
      const handler = productionMocks.handlers.get('claude-cli:submit-prompt');
      expect(handler).toBeTypeOf('function');
      const payload = {
        sessionId: 'production-session',
        workspacePath: '/workspace',
        prompt: 'once',
      };

      const blockedStates: unknown[] = [
        null,
        { metadata: '{not-json' },
        { metadata: [] },
        { metadata: { modelChangeReconciliation: 'malformed' } },
        { metadata: { modelChangeReconciliation: { status: 'pending' } } },
      ];
      for (const state of blockedStates) {
        productionMocks.loadSession.mockResolvedValueOnce(state);
        await expect(handler!({}, payload)).rejects.toThrow(
          'Session model recovery is pending',
        );
      }
      productionMocks.loadSession.mockRejectedValueOnce(new Error('session store unavailable'));
      await expect(handler!({}, payload)).rejects.toThrow(
        'Session model recovery is pending',
      );

      expect(productionMocks.writeToTerminal).not.toHaveBeenCalled();
      expect(productionMocks.logUserPrompt).not.toHaveBeenCalled();
      expect(productionMocks.sendEvent).not.toHaveBeenCalled();
      expect(productionMocks.reveal).not.toHaveBeenCalled();

      productionMocks.loadSession.mockResolvedValueOnce({
        metadata: { modelChangeReconciliation: null },
      });
      await expect(handler!({}, payload)).resolves.toEqual({ success: true });
      expect(productionMocks.writeToTerminal).toHaveBeenCalledTimes(2);
      expect(productionMocks.logUserPrompt).toHaveBeenCalledTimes(1);
      expect(productionMocks.sendEvent).toHaveBeenCalledTimes(1);
      expect(productionMocks.reveal).toHaveBeenCalledTimes(1);
    },
    20_000,
  );
});
