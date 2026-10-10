/**
 * CitationNode - attaches the editor's React decorator to the React-free class
 * in `./CitationNodeCore.ts` and re-exports it. The interactive chip loads on
 * first use; until then the same chip draws without its popover.
 */

import './Citation.css';

import { lazy, Suspense } from 'react';

import { CitationNodeDecorator } from './CitationNodeCore';
import { citationInitials } from '../../../core/citationSyntax';

const CitationChip = lazy(() => import('./CitationChip'));

CitationNodeDecorator.set((node, editor) => {
  const citation = node.getCitation();
  const placeholder = (
    <span className={`citation-chip citation-chip--${citation.kind}`} data-testid="citation-chip">
      {citation.kind === 'human' ? citation.label || citationInitials(citation.by) : ''}
    </span>
  );
  return (
    <Suspense fallback={placeholder}>
      <CitationChip citation={citation} editor={editor} nodeKey={node.getKey()} />
    </Suspense>
  );
});

export * from './CitationNodeCore';
