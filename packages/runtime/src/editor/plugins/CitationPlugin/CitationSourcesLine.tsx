/**
 * Slot for the "Sources" line under a page. It watches only whether the page
 * holds any citation; the line itself (and the citation index behind it)
 * loads the first time one appears, so pages without citations pay nothing.
 */

import type { JSX } from 'react';
import { lazy, Suspense, useEffect, useState } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';

import { CitationNode } from './CitationNodeCore';

const CitationSourcesSummary = lazy(() => import('./CitationSourcesSummary'));

export function CitationSourcesLine(): JSX.Element | null {
  const [editor] = useLexicalComposerContext();
  const [hasCitations, setHasCitations] = useState(false);
  useEffect(() => {
    if (!editor.hasNode(CitationNode)) return undefined;
    return editor.registerMutationListener(
      CitationNode,
      (mutations) => {
        for (const mutation of mutations.values()) {
          if (mutation === 'created') {
            setHasCitations(true);
            return;
          }
        }
      },
      { skipInitialization: false },
    );
  }, [editor]);
  if (!hasCitations) return null;
  return (
    <Suspense fallback={null}>
      <CitationSourcesSummary />
    </Suspense>
  );
}
