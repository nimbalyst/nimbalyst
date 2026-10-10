/**
 * The citation popover: who said it, the context, the snapshotted quote and
 * the session it came from; or a source's title and target. Loaded on first
 * hover so the eager editor bundle carries none of it.
 */

import './CitationPopover.css';

import type { JSX } from 'react';
import {
  FloatingPortal,
  flip,
  offset,
  shift,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from '@floating-ui/react';

import { getCitationHost } from './citationHost';
import { citationInitials, isWebSource, type Citation, type HumanCitation, type SourceCitation } from '../../../core/citationSyntax';
import { formatPageMarkDate } from '../../../core/pageMarkSyntax';

function displayDate(at: string | undefined): string | null {
  if (!at) return null;
  const day = /^(\d{4}-\d{2}-\d{2})/.exec(at)?.[1];
  return day ?? at;
}

function HumanPopover({ citation }: { citation: HumanCitation }): JSX.Element {
  const host = getCitationHost();
  const canOpen = Boolean(host.openHumanCitation) && (host.canOpenHumanCitation?.(citation) ?? true);
  const date = displayDate(citation.at);
  const origin = [citation.sessionTitle ?? 'Session', date].filter(Boolean).join(', ');
  return (
    <>
      <div className="citation-popover-source">
        <span className="citation-popover-avatar">{citationInitials(citation.by ?? citation.label)}</span>
        <b>{citation.by ?? citation.label}</b>
        {citation.context ? <span>{citation.context}</span> : null}
        {!citation.context && date ? <span>{formatPageMarkDate(date, new Date().getFullYear())}</span> : null}
      </div>
      {citation.quote ? <q className="citation-popover-quote select-text">{citation.quote}</q> : null}
      {canOpen ? (
        <button type="button" className="citation-popover-go" onClick={() => host.openHumanCitation?.(citation)}>
          {origin} &#8250;
        </button>
      ) : (
        <div className="citation-popover-origin">{origin}</div>
      )}
    </>
  );
}

function SourcePopover({ citation }: { citation: SourceCitation }): JSX.Element {
  const host = getCitationHost();
  return (
    <>
      <div className="citation-popover-source">
        <b>{citation.label || citation.target}</b>
      </div>
      <div className="citation-popover-target select-text">{citation.target}</div>
      {host.openSource ? (
        <button type="button" className="citation-popover-go" onClick={() => host.openSource?.(citation.target)}>
          {isWebSource(citation.target) ? 'Open link' : 'Open document'} &#8250;
        </button>
      ) : null}
    </>
  );
}

export default function CitationPopover({
  citation,
  reference,
  onClose,
  onPointerEnter,
  onPointerLeave,
}: {
  citation: Citation;
  reference: HTMLElement;
  onClose: () => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}): JSX.Element {
  const { refs, floatingStyles, context } = useFloating({
    open: true,
    onOpenChange: (next) => {
      if (!next) onClose();
    },
    elements: { reference },
    placement: 'bottom-start',
    middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
  });
  const { getFloatingProps } = useInteractions([useDismiss(context), useRole(context, { role: 'dialog' })]);
  return (
    <FloatingPortal>
      <div
        ref={refs.setFloating}
        style={floatingStyles}
        className="citation-popover"
        data-testid="citation-popover"
        onMouseEnter={onPointerEnter}
        onMouseLeave={onPointerLeave}
        {...getFloatingProps()}
      >
        {citation.kind === 'human' ? <HumanPopover citation={citation} /> : <SourcePopover citation={citation} />}
      </div>
    </FloatingPortal>
  );
}
