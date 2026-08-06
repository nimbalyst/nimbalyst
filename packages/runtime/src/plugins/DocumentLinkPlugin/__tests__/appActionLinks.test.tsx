import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { $createLinkNode, LinkNode } from '@lexical/link';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
} from 'lexical';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DocumentService } from '../../../core/DocumentService';
import { DocumentLinkPlugin } from '../index';

function TypeaheadStub(): null {
  return null;
}

function renderActionLink(href: string) {
  return render(
    <LexicalComposer
      initialConfig={{
        namespace: 'document-link-action-test',
        nodes: [LinkNode],
        onError: (error) => {
          throw error;
        },
        editorState: () => {
          const link = $createLinkNode(href);
          link.append($createTextNode('Open projects'));
          const paragraph = $createParagraphNode();
          paragraph.append(link);
          $getRoot().append(paragraph);
        },
      }}
    >
      <RichTextPlugin
        contentEditable={<ContentEditable />}
        placeholder={null}
        ErrorBoundary={LexicalErrorBoundary}
      />
      <DocumentLinkPlugin
        documentService={{} as DocumentService}
        TypeaheadMenuPlugin={TypeaheadStub}
        triggerFn={() => null}
      />
    </LexicalComposer>,
  );
}

describe('DocumentLinkPlugin app actions', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('intercepts action links and dispatches them instead of navigating', async () => {
    const send = vi.fn();
    vi.stubGlobal('electronAPI', { send });
    renderActionLink('nimbalyst://action/open-project-manager');

    const link = await waitFor(() =>
      screen.getByRole('link', { name: 'Open projects' }),
    );
    // Lexical intentionally sanitizes custom LinkNode schemes in the DOM.
    // DocumentLinkPlugin must recover the authored URL from the backing node.
    expect(link.getAttribute('href')).toBe('about:blank');
    const clickWasNotCanceled = fireEvent.click(link);
    expect(send).toHaveBeenCalledWith(
      'app-action:dispatch',
      'nimbalyst://action/open-project-manager',
    );
    expect(clickWasNotCanceled).toBe(false);
  });
});
