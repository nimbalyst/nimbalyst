/**
 * The fixed rows at the top of a Pages section, above its tree: Home (the
 * section's editable Home page), Search (every page and typed page as a
 * table) and Types (the map of the section's types). Rows use the tree's
 * classes so they read as part of it; the host opens each surface.
 */
import React from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';

export type PagesSectionEntry = 'home' | 'search' | 'types';

/** `newTab`: Cmd/Ctrl was held on the click. */
export type PagesSectionEntryOpen = (options: { newTab: boolean }) => void;

export interface PagesSectionEntriesProps {
  /** The entry whose surface is open, if any. */
  active: PagesSectionEntry | null;
  /** Absent when the section has no Home page (it was deleted). */
  onOpenHome?: PagesSectionEntryOpen;
  onOpenSearch: PagesSectionEntryOpen;
  onOpenTypes: PagesSectionEntryOpen;
}

const ENTRIES: ReadonlyArray<{ id: PagesSectionEntry; icon: string; label: string }> = [
  { id: 'home', icon: 'home', label: 'Home' },
  { id: 'search', icon: 'manage_search', label: 'Search' },
  { id: 'types', icon: 'category', label: 'Types' },
];

export const PagesSectionEntries: React.FC<PagesSectionEntriesProps> = ({ active, onOpenHome, onOpenSearch, onOpenTypes }) => {
  const handlers: Record<PagesSectionEntry, PagesSectionEntryOpen | undefined> = { home: onOpenHome, search: onOpenSearch, types: onOpenTypes };
  return (
    <div className="pages-section-entries mb-1 border-b border-[var(--nim-border)] pb-1" role="group" aria-label="Section">
      {ENTRIES.filter((entry) => handlers[entry.id]).map((entry) => (
        <button
          key={entry.id}
          type="button"
          className={`pages-section-entry file-tree-file w-full flex items-center text-left${active === entry.id ? ' active' : ''}`}
          style={{ paddingLeft: 8 }}
          data-entry={entry.id}
          aria-current={active === entry.id ? 'page' : undefined}
          onClick={(event) => handlers[entry.id]?.({ newTab: event.metaKey || event.ctrlKey })}
        >
          <span className="file-tree-spacer" />
          <span className="file-tree-icon"><MaterialSymbol icon={entry.icon} size={16} /></span>
          <span className="file-tree-name">{entry.label}</span>
        </button>
      ))}
    </div>
  );
};
