import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import * as rtl from '@testing-library/react';
import { MarkdownRenderer } from '../MarkdownRenderer';

const { render, screen, fireEvent, waitFor, act } = rtl;

const { copyToClipboard } = vi.hoisted(() => ({ copyToClipboard: vi.fn() }));
vi.mock('../../../../utils/clipboard', () => ({ copyToClipboard }));

describe('MarkdownRenderer code block copy button', () => {
  it('copies and resets confirmation under StrictMode', async () => {
    copyToClipboard.mockResolvedValueOnce(undefined);
    render(<React.StrictMode><MarkdownRenderer content={'```bash\nnpm install\n```'} /></React.StrictMode>);

    // The button is icon-only, so its accessible name is the only label a
    // screen reader (or this test) can read.
    const button = screen.getByTestId('code-block-copy-button');
    expect(button.getAttribute('aria-label')).toBe('Copy code');

    vi.useFakeTimers();
    try {
      await act(async () => { fireEvent.click(button); });
      expect(copyToClipboard).toHaveBeenCalledWith('npm install');
      expect(button.getAttribute('aria-label')).toBe('Copied');
      await act(async () => { vi.advanceTimersByTime(1500); });
      expect(button.getAttribute('aria-label')).toBe('Copy code');
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['unlabelled single line', '```\necho hello\n```', 'echo hello'],
    ['unlabelled multiline', '```\nfirst\n  second\n```', 'first\n  second'],
    ['labelled multiline', '```bash\necho first\n  echo second\n```', 'echo first\n  echo second'],
  ])('copies raw text from %s blocks', async (_name, content, expected) => {
    copyToClipboard.mockResolvedValueOnce(undefined);
    render(<MarkdownRenderer content={content} />);
    await act(async () => { fireEvent.click(screen.getByTestId('code-block-copy-button')); });
    expect(copyToClipboard).toHaveBeenLastCalledWith(expected);
  });

  it('logs and leaves the button unchanged when the clipboard write fails', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    copyToClipboard.mockRejectedValueOnce(new Error('denied'));
    render(<MarkdownRenderer content={'```bash\nnpm install\n```'} />);

    const button = screen.getByTestId('code-block-copy-button');
    fireEvent.click(button);

    await waitFor(() => expect(consoleErrorSpy).toHaveBeenCalled());
    expect(button.getAttribute('aria-label')).toBe('Copy code');

    consoleErrorSpy.mockRestore();
  });

  it('does not add a copy button to inline code spans, and keeps them inline', () => {
    const { container } = render(<MarkdownRenderer content="run `npm install` now" />);
    expect(screen.queryByTestId('code-block-copy-button')).toBeNull();

    // Inline spans share the fenced-block style object, so a change meant for
    // blocks can silently turn them into block elements - which breaks the
    // sentence onto separate lines and adds the copy button's reserved gutter.
    const inlineCode = container.querySelector('code');
    expect(inlineCode?.style.display).toBe('inline-block');
    expect(inlineCode?.style.padding).toBe('0.25rem 0.5rem');
  });
});
