import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import * as rtl from '@testing-library/react';
import { MarkdownRenderer } from '../MarkdownRenderer';

const { render, screen, fireEvent, waitFor } = rtl;

const { copyToClipboard } = vi.hoisted(() => ({ copyToClipboard: vi.fn() }));
vi.mock('../../../../utils/clipboard', () => ({ copyToClipboard }));

describe('MarkdownRenderer code block copy button', () => {
  it('copies the fenced block text and briefly shows Copied', async () => {
    copyToClipboard.mockResolvedValueOnce(undefined);
    render(<MarkdownRenderer content={'```bash\nnpm install\n```'} />);

    const button = screen.getByTestId('code-block-copy-button');
    expect(button.textContent).toBe('Copy');

    fireEvent.click(button);

    expect(copyToClipboard).toHaveBeenCalledWith('npm install');
    await waitFor(() => expect(button.textContent).toBe('Copied'));
  });

  it('does not add a copy button to inline code spans', () => {
    render(<MarkdownRenderer content="run `npm install` now" />);
    expect(screen.queryByTestId('code-block-copy-button')).toBeNull();
  });
});
