/**
 * The inline citation chip. A human chip shows initials; a source chip shows
 * its number in the page. Hover or focus opens the popover, which loads on
 * first use.
 */

import type { JSX } from 'react';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { LexicalEditor, NodeKey } from 'lexical';

import { useCitationIndex } from './citationIndex';
import { citationInitials, type Citation } from '../../../core/citationSyntax';

const CitationPopover = lazy(() => import('./CitationPopover'));

const OPEN_DELAY_MS = 150;
const CLOSE_DELAY_MS = 120;

export default function CitationChip({
  citation,
  editor,
  nodeKey,
}: {
  citation: Citation;
  editor: LexicalEditor | null;
  nodeKey: NodeKey;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [reference, setReference] = useState<HTMLSpanElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const index = useCitationIndex(citation.kind === 'source' ? editor : null);

  const schedule = useCallback((next: boolean, delay: number) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(next), delay);
  }, []);
  const cancel = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  useEffect(() => cancel, [cancel]);

  const label = citation.kind === 'human'
    ? citation.label || citationInitials(citation.by)
    : String(index.sourceNumbers.get(nodeKey) ?? '*');

  return (
    <>
      <span
        ref={setReference}
        className={`citation-chip citation-chip--${citation.kind}${open ? ' citation-chip--open' : ''}`}
        data-testid="citation-chip"
        tabIndex={-1}
        onMouseEnter={() => schedule(true, OPEN_DELAY_MS)}
        onMouseLeave={() => schedule(false, CLOSE_DELAY_MS)}
        onFocus={() => schedule(true, 0)}
        onBlur={() => schedule(false, CLOSE_DELAY_MS)}
      >
        {label}
      </span>
      {open && reference ? (
        <Suspense fallback={null}>
          <CitationPopover
            citation={citation}
            reference={reference}
            onClose={() => {
              cancel();
              setOpen(false);
            }}
            onPointerEnter={cancel}
            onPointerLeave={() => schedule(false, CLOSE_DELAY_MS)}
          />
        </Suspense>
      ) : null}
    </>
  );
}
