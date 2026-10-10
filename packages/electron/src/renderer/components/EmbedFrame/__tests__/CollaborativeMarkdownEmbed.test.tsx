/**
 * An agent edit to a shared markdown document lands as a pending diff. A tab
 * shows the Keep/Revert bar for it; an embedded editor (a type page's prose, a
 * canvas card) must too, or the removed text stays on screen with no way to
 * resolve it.
 */
import React, { useEffect } from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { EditorHost } from '@nimbalyst/runtime';

const fakeLexicalEditor = { id: 'lexical-editor', setEditable: vi.fn() };

vi.mock('@nimbalyst/runtime', () => ({
  DocumentPathProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  MarkdownEditor: ({ onEditorReady }: { onEditorReady?: (editor: unknown) => void }) => {
    useEffect(() => onEditorReady?.(fakeLexicalEditor), [onEditorReady]);
    return <div data-testid="markdown-editor" />;
  },
}));

vi.mock('@nimbalyst/runtime/collab-lexical', () => ({
  CollabLexicalProvider: class {
    handleStatusChange() {}
    destroy() {}
  },
}));

// Page history is opt-in and covered in HistoryDialog/__tests__/useCollabBodyHistory.
vi.mock('../../HistoryDialog/useCollabBodyHistory', () => ({ useCollabBodyHistory: () => undefined }));

vi.mock('../../UnifiedDiffHeader', () => ({
  LexicalDiffHeaderAdapter: ({ editor, filePath }: { editor?: unknown; filePath: string }) => (
    editor ? <div data-testid="diff-header" data-file-path={filePath} /> : null
  ),
}));

import { CollaborativeMarkdownEmbed } from '../CollaborativeMarkdownEmbed';

function renderEmbed(readOnly: boolean) {
  const host = {
    readOnly,
    fileName: 'Architecture',
    onReadOnlyChanged: (callback: (next: boolean) => void) => {
      callback(readOnly);
      return () => {};
    },
  } as unknown as EditorHost;
  const resource = {
    syncProvider: { getStatus: () => 'connected' },
    replica: { wasHydratedFromStore: () => true, getState: () => 'ready' },
    config: { orgId: 'org-1', documentId: 'type-page:decision', userName: 'Ada' },
  } as any;
  return render(<CollaborativeMarkdownEmbed host={host} resource={resource} />);
}

describe('CollaborativeMarkdownEmbed', () => {
  it('shows the Keep/Revert bar for the embedded editor when editable', async () => {
    renderEmbed(false);
    const header = await screen.findByTestId('diff-header');
    expect(header.getAttribute('data-file-path')).toBe('collab://org:org-1:doc:type-page:decision');
    expect(fakeLexicalEditor.setEditable).toHaveBeenLastCalledWith(true);
  });

  it('shows no review bar on a read-only embed', async () => {
    renderEmbed(true);
    await screen.findByTestId('markdown-editor');
    expect(screen.queryByTestId('diff-header')).toBeNull();
    expect(fakeLexicalEditor.setEditable).toHaveBeenLastCalledWith(false);
  });
});
