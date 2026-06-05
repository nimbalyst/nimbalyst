import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import * as rtl from '@testing-library/react';
import { MarkdownRenderer } from '../MarkdownRenderer';

const { render, screen, fireEvent } = rtl;

describe('MarkdownRenderer file-path autolinking', () => {
  it('autolinks a bare workspace-relative path and opens it on click', () => {
    const onOpenFile = vi.fn();
    render(
      <MarkdownRenderer
        content="Check packages/electron/src/foo.ts now"
        onOpenFile={onOpenFile}
      />,
    );

    const link = screen.getByText('packages/electron/src/foo.ts');
    expect(link.tagName).toBe('A');

    fireEvent.click(link);
    expect(onOpenFile).toHaveBeenCalledWith('packages/electron/src/foo.ts');
  });

  it('strips the :line:col suffix before opening', () => {
    const onOpenFile = vi.fn();
    render(
      <MarkdownRenderer content="open src/a/foo.ts:42:7 here" onOpenFile={onOpenFile} />,
    );

    fireEvent.click(screen.getByText('src/a/foo.ts:42:7'));
    expect(onOpenFile).toHaveBeenCalledWith('src/a/foo.ts');
  });

  it('does not autolink when no onOpenFile handler is provided', () => {
    const { container } = render(
      <MarkdownRenderer content="Check packages/electron/src/foo.ts now" />,
    );
    expect(container.querySelector('a')).toBeNull();
  });

  it('autolinks a path inside inline code and opens it on click', () => {
    const onOpenFile = vi.fn();
    const { container } = render(
      <MarkdownRenderer content="run `packages/a/foo.ts`" onOpenFile={onOpenFile} />,
    );
    const link = screen.getByText('packages/a/foo.ts');
    expect(link.tagName).toBe('A');
    // Still rendered within inline code styling.
    expect(link.closest('code')).not.toBeNull();
    fireEvent.click(link);
    expect(onOpenFile).toHaveBeenCalledWith('packages/a/foo.ts');
  });

  it('does NOT autolink paths inside fenced code blocks', () => {
    const onOpenFile = vi.fn();
    const { container } = render(
      <MarkdownRenderer
        content={'```\nedit packages/a/foo.ts here\n```'}
        onOpenFile={onOpenFile}
      />,
    );
    expect(container.querySelector('a')).toBeNull();
  });
});
