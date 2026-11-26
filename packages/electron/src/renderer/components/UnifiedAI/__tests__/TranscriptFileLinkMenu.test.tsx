// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react';
import { MarkdownRenderer } from '@nimbalyst/runtime/ui/AgentTranscript/components/MarkdownRenderer';
import { TranscriptFileLinkMenu } from '../TranscriptFileLinkMenu';

const { copyPath } = vi.hoisted(() => ({ copyPath: vi.fn() }));

// Keep the shared menu's host services out of this transcript integration test.
vi.mock('../../CommonFileActions', () => ({
  CommonFileActions: ({ filePath, fileName, onClose }: {
    filePath: string;
    fileName: string;
    onClose: () => void;
  }) => (
    <button title={fileName} onClick={() => { copyPath(filePath); onClose(); }}>
      Copy Path
    </button>
  ),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderTranscript(content: string, baseDir = '/repo') {
  const onOpenFile = vi.fn();
  render(
    <TranscriptFileLinkMenu baseDir={baseDir}>
      <MarkdownRenderer content={content} onOpenFile={onOpenFile} />
    </TranscriptFileLinkMenu>,
  );
  return onOpenFile;
}

describe('transcript file link context menu', () => {
  it.each([
    ['open src/a.ts:42:7 here', '/repo', '/repo/src/a.ts'],
    ['[source](src/a.ts:42:7)', '/repo', '/repo/src/a.ts'],
    ['[source](src/my%20file.ts)', 'N:/worktree', 'N:/worktree/src/my file.ts'],
    ['open `src/a.ts` here', '/repo/worktree', '/repo/worktree/src/a.ts'],
    ['[**source**](/other/src/a.ts:42:7)', '/repo', '/other/src/a.ts'],
    ['[source](N:/project/src/a.ts:42)', 'N:/worktree', 'N:/project/src/a.ts'],
    ['[source](/repo/my%20file.ts)', '/repo', '/repo/my file.ts'],
  ])('passes the resolved path to CommonFileActions: %s', async (content, baseDir, path) => {
    const onOpenFile = renderTranscript(content, baseDir);
    const link = screen.getByRole('link');
    // A styled label can put the event target inside the anchor.
    const target = link.querySelector('strong') ?? link;
    const event = createEvent.contextMenu(target, { clientX: 100, clientY: 120 });
    await act(async () => { fireEvent(target, event); });

    expect(event.defaultPrevented).toBe(true);
    expect(onOpenFile).not.toHaveBeenCalled();
    const copy = screen.getByRole('button', { name: 'Copy Path' });
    expect(copy.title).toBe(path.split('/').pop());
    await act(async () => { fireEvent.click(copy); });
    expect(copyPath).toHaveBeenCalledWith(path);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('leaves left-click navigation and its location unchanged', () => {
    const onOpenFile = renderTranscript('[source](/repo/src/a.ts:42:7)');
    fireEvent.click(screen.getByRole('link'));
    expect(onOpenFile).toHaveBeenCalledExactlyOnceWith('/repo/src/a.ts', { line: 42, column: 7 });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(copyPath).not.toHaveBeenCalled();
  });

  it('preserves left-click handling of relative markdown links', () => {
    const onOpenFile = renderTranscript('[source](src/a.ts:42)');
    const link = screen.getByRole('link');
    expect(fireEvent.click(link)).toBe(true);
    expect(onOpenFile).not.toHaveBeenCalled();
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it.each([
    '[site](https://example.com/src/a.ts)',
    '[mail](mailto:user@example.com)',
    '[heading](#section)',
    '[action](nimbalyst://action/open-project-manager)',
  ])('leaves non-file context menus alone: %s', async (content) => {
    renderTranscript(content);
    const link = screen.getByRole('link');
    const event = createEvent.contextMenu(link);
    await act(async () => { fireEvent(link, event); });
    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(copyPath).not.toHaveBeenCalled();
  });

  it('dismisses the menu with Escape', async () => {
    renderTranscript('[source](/repo/src/a.ts)');
    await act(async () => { fireEvent.contextMenu(screen.getByRole('link')); });
    screen.getByRole('menu');
    await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }); });
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
