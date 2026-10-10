/**
 * The "Sources" line at the bottom of a page: who and what the page cites,
 * built from the citations in it. Renders nothing when there are none.
 * Loaded by `CitationSourcesLine` once the page holds a citation.
 */

import type { JSX } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';

import { useCitationIndex } from './citationIndex';
import { formatCitationSummaryParts, summarizeCitations } from '../../../core/citationSyntax';

export default function CitationSourcesSummary(): JSX.Element | null {
  const [editor] = useLexicalComposerContext();
  const { citations } = useCitationIndex(editor);
  if (citations.length === 0) return null;
  const parts = formatCitationSummaryParts(summarizeCitations(citations));
  return (
    <div className="citation-sources-line" data-testid="citation-sources-line" contentEditable={false}>
      <b>Sources</b>
      {parts.map((part) => (
        <span key={part}> &#183; {part}</span>
      ))}
    </div>
  );
}
