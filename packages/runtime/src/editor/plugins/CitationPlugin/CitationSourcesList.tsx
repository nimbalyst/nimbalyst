/**
 * A page's citations as a list, in document order, for a side panel: who or
 * what each cites, the quote, and a jump to where it sits in the page. The
 * same facts as the chip's popover, without hovering every chip.
 */

import type { JSX } from 'react';
import type { LexicalEditor } from 'lexical';

import { $collectCitationNodes, useCitationIndex } from './citationIndex';
import { getCitationHost } from './citationHost';
import { citationInitials, isWebSource, type Citation } from '../../../core/citationSyntax';

function displayDate(at: string | undefined): string | null {
  if (!at) return null;
  return /^(\d{4}-\d{2}-\d{2})/.exec(at)?.[1] ?? at;
}

/** Scrolls the page to its `index`th citation and flashes the chip. */
export function revealCitation(editor: LexicalEditor, index: number): void {
  const key = editor.getEditorState().read(() => $collectCitationNodes()[index]?.getKey());
  const element = key ? editor.getElementByKey(key) : null;
  if (!element) return;
  element.scrollIntoView({ block: 'center', behavior: 'smooth' });
  element.animate?.(
    [{ backgroundColor: 'var(--nim-primary)' }, { backgroundColor: 'transparent' }],
    { duration: 1200, easing: 'ease-out' },
  );
}

function CitationRow({ citation, onReveal }: { citation: Citation; onReveal: () => void }): JSX.Element {
  const host = getCitationHost();
  if (citation.kind === 'human') {
    const name = citation.by ?? citation.label;
    const origin = [citation.sessionTitle ?? 'Session', displayDate(citation.at)].filter(Boolean).join(' · ');
    const canOpen = Boolean(host.openHumanCitation) && (host.canOpenHumanCitation?.(citation) ?? true);
    return (
      <li className="citation-sources-row flex gap-2.5 py-2">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-nim-tertiary text-[11px] font-bold text-nim-primary">
          {citationInitials(name)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] text-nim">{name}</div>
          {canOpen ? (
            <button
              type="button"
              className="citation-sources-open border-none bg-transparent p-0 text-left text-xs text-nim-faint hover:text-nim-primary"
              onClick={() => host.openHumanCitation?.(citation)}
            >
              {origin} &#8250;
            </button>
          ) : (
            <div className="text-xs text-nim-faint">{origin}</div>
          )}
          {citation.quote && <q className="mt-0.5 block select-text text-xs italic text-nim-muted">{citation.quote}</q>}
        </div>
        <button type="button" className="citation-sources-reveal shrink-0 self-start border-none bg-transparent p-0 text-xs text-nim-faint hover:text-nim" onClick={onReveal}>
          Go to
        </button>
      </li>
    );
  }
  return (
    <li className="citation-sources-row flex gap-2.5 py-2">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] text-nim">{citation.label || citation.target}</div>
        {host.openSource ? (
          <button
            type="button"
            className="citation-sources-open max-w-full truncate border-none bg-transparent p-0 text-left text-xs text-nim-faint hover:text-nim-primary"
            onClick={() => host.openSource?.(citation.target)}
          >
            {isWebSource(citation.target) ? 'Open link' : 'Open document'} &#8250;
          </button>
        ) : (
          <div className="truncate select-text text-xs text-nim-faint">{citation.target}</div>
        )}
      </div>
      <button type="button" className="citation-sources-reveal shrink-0 self-start border-none bg-transparent p-0 text-xs text-nim-faint hover:text-nim" onClick={onReveal}>
        Go to
      </button>
    </li>
  );
}

export default function CitationSourcesList({ editor }: { editor: LexicalEditor }): JSX.Element {
  const { citations } = useCitationIndex(editor);
  if (citations.length === 0) {
    return <div className="text-xs text-nim-faint">This page cites nothing yet.</div>;
  }
  return (
    <ul className="citation-sources-list m-0 list-none divide-y divide-[var(--nim-border)] p-0" data-testid="citation-sources-list">
      {citations.map((citation, index) => (
        <CitationRow key={index} citation={citation} onReveal={() => revealCitation(editor, index)} />
      ))}
    </ul>
  );
}
