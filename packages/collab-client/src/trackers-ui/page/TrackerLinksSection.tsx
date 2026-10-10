/**
 * "Links" — the relations and mentions of a page, at the bottom of the page.
 * One collapsed line per relation (incoming relations read under their
 * inverse name, symmetric ones merge both directions); expanding a line shows
 * the sentence that made each link. Hidden when the page has no links.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { collabOpenOptions, type CollabOpenOptions } from '@nimbalyst/collab-client/core';
import { globalRegistry } from '@nimbalyst/tracker-schema';
import { groupTrackerPageLinks, type LinkedPage, type PageLinksSource, type TrackerPageLink } from './pageLinks';

export interface TrackerLinksSectionProps {
  /** Where the links come from; without one the section stays empty. */
  linksSource?: PageLinksSource | null;
  itemId: string;
  itemType?: string;
  /** Bumped by the host after a save that may have re-indexed links. */
  revision?: number;
  onOpenItem?: (itemId: string, options?: CollabOpenOptions) => void;
}

export const TrackerLinksSection: React.FC<TrackerLinksSectionProps> = ({ linksSource, itemId, itemType, revision = 0, onOpenItem }) => {
  const [links, setLinks] = useState<TrackerPageLink[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const fetchedItemRef = useRef<string | null>(null);

  useEffect(() => {
    // A new page fetches at once and drops the previous page's links; a save on
    // the same page coalesces into one fetch.
    const samePage = fetchedItemRef.current === itemId;
    if (!samePage) {
      fetchedItemRef.current = itemId;
      setLinks([]);
      setExpanded(new Set());
    }
    if (!linksSource) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      linksSource.linksFor(itemId)
        .then((next) => {
          if (cancelled) return;
          if (next) setLinks(next);
          else if (!samePage) setLinks([]);
        })
        .catch((err: unknown) => console.error('[TrackerLinksSection] Failed to load links:', err));
    }, samePage ? 400 : 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [linksSource, itemId, revision]);

  const groups = useMemo(() => groupTrackerPageLinks(links, itemType), [links, itemType]);
  if (groups.length === 0) return null;

  const toggle = (label: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (!next.delete(label)) next.add(label);
    return next;
  });

  const pageButton = (page: LinkedPage, className = '') => (
    <button
      key={page.itemId}
      type="button"
      className={`tracker-links-page inline-flex items-baseline gap-1 min-w-0 text-nim hover:underline disabled:cursor-default disabled:no-underline ${className}`}
      disabled={!onOpenItem}
      onClick={(e) => { e.stopPropagation(); onOpenItem?.(page.itemId, collabOpenOptions(e)); }}
    >
      <span className="text-[11px] text-nim-faint">{globalRegistry.get(page.typeId)?.displayName ?? page.typeId}</span>
      <span className="truncate">{page.title}</span>
    </button>
  );

  return (
    <div className="tracker-links-section @container space-y-1 select-text">
      <h4 className="text-xs font-medium text-nim-muted uppercase tracking-wide">Links</h4>
      {groups.map((group) => {
        const open = expanded.has(group.label);
        return (
          <div key={group.label}>
            <div
              className="tracker-links-line flex items-baseline gap-2 rounded px-1.5 py-1 text-[13px] hover:bg-nim-hover cursor-pointer"
              role="button"
              tabIndex={0}
              aria-expanded={open}
              onClick={() => toggle(group.label)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(group.label); } }}
            >
              <span className={`text-[9px] text-nim-faint transition-transform ${open ? 'rotate-90' : ''}`}>&#9654;</span>
              <span className="text-nim-muted shrink-0 w-28 @md:w-36 truncate">{group.label}</span>
              <span className="text-[12px] text-nim-faint shrink-0 w-4">{group.pages.length}</span>
              <span className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
                {group.pages.map((page) => pageButton(page))}
              </span>
            </div>
            {open && group.pages.map((page) => (
              <div key={page.itemId} className="ml-8 mb-1.5 border-l-2 border-nim pl-2.5 py-1 text-xs text-nim-muted leading-normal">
                {pageButton(page, 'font-medium mr-1')}
                {page.sentences.map((sentence) => <p key={sentence} className="m-0">{sentence}</p>)}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
};
