import { describe, it, expect } from 'vitest';
import {
  composeClaudeCliPtySubmission,
  composeClaudeCliContextPreamble,
} from '../claudeCliPromptComposer';

describe('composeClaudeCliPtySubmission', () => {
  it('returns just the trimmed prompt when there are no attachments', () => {
    expect(composeClaudeCliPtySubmission({ prompt: '  fix the bug  ' })).toBe('fix the bug');
  });

  it('appends absolute attachment paths after the prompt on one line', () => {
    const out = composeClaudeCliPtySubmission({
      prompt: 'look at this',
      attachments: [{ filepath: '/tmp/a.png' }, { filepath: '/tmp/b.png' }],
    });
    expect(out).toBe('look at this /tmp/a.png /tmp/b.png');
  });

  it('returns just the paths when the prompt is empty', () => {
    expect(
      composeClaudeCliPtySubmission({ prompt: '', attachments: [{ filepath: '/tmp/a.png' }] }),
    ).toBe('/tmp/a.png');
  });

  it('skips attachments without a usable filepath', () => {
    const out = composeClaudeCliPtySubmission({
      prompt: 'hi',
      attachments: [{ filepath: '' }, { filepath: null }, { filepath: '/tmp/c.png' }],
    });
    expect(out).toBe('hi /tmp/c.png');
  });

  it('returns empty string when nothing to send', () => {
    expect(composeClaudeCliPtySubmission({ prompt: '   ', attachments: [] })).toBe('');
  });

  /**
   * NIM-818: the CLI is never told which document "this" is — the SDK path's
   * active-doc preamble was skipped entirely. The composer now appends a
   * compact single-line context block (active-doc URI + selection, NOT full
   * content — the CLI can Read/readCollabDoc itself) after the typed prompt.
   */
  describe('document context (NIM-818)', () => {
    it('appends the active document path after the prompt', () => {
      const out = composeClaudeCliPtySubmission({
        prompt: 'summarize this doc',
        documentContext: { filePath: '/ws/notes.md' },
      });
      expect(out).toContain('summarize this doc');
      expect(out).toContain('<ACTIVE_DOCUMENT>/ws/notes.md</ACTIVE_DOCUMENT>');
      expect(out.indexOf('summarize this doc')).toBeLessThan(out.indexOf('<ACTIVE_DOCUMENT>'));
      expect(out).not.toContain('\n');
    });

    it('includes the selection with newlines flattened to literal \\n', () => {
      const out = composeClaudeCliPtySubmission({
        prompt: 'what does this do?',
        documentContext: {
          filePath: '/ws/a.ts',
          textSelection: { text: 'line one\nline two\r\nline three' },
        },
      });
      expect(out).toContain('<SELECTED_TEXT>line one\\nline two\\nline three</SELECTED_TEXT>');
      expect(out).not.toContain('\n');
    });

    it('tells the CLI to use readCollabDoc for collab:// documents', () => {
      const out = composeClaudeCliPtySubmission({
        prompt: 'summarize this',
        documentContext: { filePath: 'collab://org:x:doc:y', fileType: 'collab-markdown' },
      });
      expect(out).toContain('readCollabDoc');
    });

    it('keeps attachment paths at the end, after the context block', () => {
      const out = composeClaudeCliPtySubmission({
        prompt: 'compare',
        attachments: [{ filepath: '/tmp/a.png' }],
        documentContext: { filePath: '/ws/notes.md' },
      });
      expect(out.indexOf('<ACTIVE_DOCUMENT>')).toBeLessThan(out.indexOf('/tmp/a.png'));
      expect(out.endsWith('/tmp/a.png')).toBe(true);
    });

    it('caps a huge selection', () => {
      const out = composeClaudeCliPtySubmission({
        prompt: 'check',
        documentContext: { filePath: '/ws/a.ts', textSelection: { text: 'x'.repeat(10_000) } },
      });
      expect(out.length).toBeLessThan(5_000);
      expect(out).toContain('truncated');
    });

    it('is a no-op without a filePath or selection', () => {
      expect(
        composeClaudeCliPtySubmission({ prompt: 'hello', documentContext: {} }),
      ).toBe('hello');
      expect(composeClaudeCliPtySubmission({ prompt: 'hello' })).toBe('hello');
    });

    it('still no-ops the whole submission when there is no prompt and no attachments', () => {
      // Context alone is not a send — nothing typed means nothing submitted.
      expect(
        composeClaudeCliPtySubmission({ prompt: '', documentContext: { filePath: '/ws/a.md' } }),
      ).toBe('');
    });
  });
});

describe('composeClaudeCliContextPreamble', () => {
  it('returns empty for no context', () => {
    expect(composeClaudeCliContextPreamble(undefined)).toBe('');
    expect(composeClaudeCliContextPreamble(null)).toBe('');
    expect(composeClaudeCliContextPreamble({})).toBe('');
  });

  it('produces a single-line block for doc + selection', () => {
    const preamble = composeClaudeCliContextPreamble({
      filePath: '/ws/a.md',
      textSelection: { text: 'foo\nbar' },
    });
    expect(preamble).toContain('<ACTIVE_DOCUMENT>/ws/a.md</ACTIVE_DOCUMENT>');
    expect(preamble).toContain('<SELECTED_TEXT>foo\\nbar</SELECTED_TEXT>');
    expect(preamble).not.toContain('\n');
  });
});
