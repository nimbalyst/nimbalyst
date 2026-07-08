/**
 * SharedDocsHome — the Shared Documents discovery hub rendered in CollabMode's
 * center pane (empty state, and reachable via the Home affordance while docs
 * are open). Search + Favorites + New & Changed + Recently opened + All.
 *
 * Purely presentational over the discovery atoms; opening a doc delegates to
 * the same `onDocumentSelect` path the sidebar uses.
 */

import React, { useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime';
import type { SharedDocument } from '../../store/atoms/collabDocuments';
import { sharedDocumentsAtom } from '../../store/atoms/collabDocuments';
import {
  favoriteSharedDocsAtom,
  recentSharedDocsAtom,
  changedSharedDocsAtom,
  collabFavoritesAtom,
  toggleFavoriteDoc,
  type DocFreshness,
} from '../../store/atoms/collabDiscovery';
import { getCollabNodeName } from './collabTree';
import { getRelativeTimeString } from '../../utils/dateFormatting';

interface SharedDocsHomeProps {
  onDocumentSelect: (doc: SharedDocument) => void;
}

type AllSort = 'updated' | 'name' | 'type';

/** Material Symbol icon for a shared doc's logical type. */
function iconForDoc(documentType: string | undefined): string {
  switch (documentType) {
    case 'excalidraw':
    case 'tldraw':
      return 'draw';
    case 'mindmap':
      return 'account_tree';
    default:
      return 'description';
  }
}

function docName(doc: SharedDocument): string {
  return getCollabNodeName(doc.title) || doc.title;
}

const FreshnessBadge: React.FC<{ freshness: DocFreshness }> = ({ freshness }) =>
  freshness === 'new' ? (
    <span className="shared-docs-badge shared-docs-badge-new text-[10.5px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full text-[var(--nim-success)] bg-[color-mix(in_srgb,var(--nim-success)_16%,transparent)]">
      New
    </span>
  ) : (
    <span className="shared-docs-badge shared-docs-badge-updated text-[10.5px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full text-[var(--nim-warning)] bg-[color-mix(in_srgb,var(--nim-warning)_16%,transparent)]">
      Updated
    </span>
  );

/** A star toggle button; filled + amber when favorited. */
const StarToggle: React.FC<{ documentId: string; favorited: boolean; className?: string }> = ({
  documentId,
  favorited,
  className,
}) => (
  <button
    type="button"
    className={`shared-docs-star shrink-0 flex items-center justify-center bg-transparent border-none cursor-pointer p-0.5 rounded transition-opacity ${
      favorited ? 'text-[var(--nim-warning)] opacity-100' : 'text-[var(--nim-text-faint)] opacity-0 group-hover:opacity-80 hover:!opacity-100'
    } ${className ?? ''}`}
    title={favorited ? 'Unfavorite' : 'Favorite'}
    aria-label={favorited ? 'Unfavorite' : 'Favorite'}
    aria-pressed={favorited}
    onClick={(e) => {
      e.stopPropagation();
      toggleFavoriteDoc(documentId);
    }}
  >
    <MaterialSymbol icon="star" size={16} fill={favorited} />
  </button>
);

/** A compact clickable doc row used by Favorites / Recent / All. */
const DocRow: React.FC<{
  doc: SharedDocument;
  favorited: boolean;
  onOpen: (doc: SharedDocument) => void;
  freshness?: DocFreshness;
}> = ({ doc, favorited, onOpen, freshness }) => (
  <button
    type="button"
    className="shared-docs-row group w-full flex items-center gap-3 px-2.5 py-2 rounded-md text-left bg-transparent border-none cursor-pointer hover:bg-[var(--nim-bg-hover)]"
    onClick={() => onOpen(doc)}
    title={doc.title}
  >
    <span className="shrink-0 w-7 h-7 rounded-md bg-[var(--nim-bg-tertiary)] flex items-center justify-center text-[var(--nim-primary)]">
      <MaterialSymbol icon={iconForDoc(doc.documentType)} size={17} />
    </span>
    <span className="flex-1 min-w-0 truncate text-[13.5px] text-[var(--nim-text)]">{docName(doc)}</span>
    {freshness && <FreshnessBadge freshness={freshness} />}
    <StarToggle documentId={doc.documentId} favorited={favorited} />
    <span className="shrink-0 text-[12px] text-[var(--nim-text-faint)] min-w-[80px] text-right">
      {getRelativeTimeString(doc.updatedAt ?? doc.createdAt ?? Date.now())}
    </span>
  </button>
);

/** A card used in the New & Changed grid. */
const ChangedCard: React.FC<{
  doc: SharedDocument;
  freshness: DocFreshness;
  favorited: boolean;
  onOpen: (doc: SharedDocument) => void;
}> = ({ doc, freshness, favorited, onOpen }) => (
  <button
    type="button"
    className="shared-docs-card group relative text-left w-full rounded-lg p-3.5 bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] cursor-pointer hover:border-[var(--nim-text-faint)] transition-colors"
    onClick={() => onOpen(doc)}
    title={doc.title}
  >
    <div className="flex items-start justify-between mb-2.5">
      <span className="w-[34px] h-[34px] rounded-md bg-[var(--nim-bg-tertiary)] flex items-center justify-center text-[var(--nim-primary)]">
        <MaterialSymbol icon={iconForDoc(doc.documentType)} size={19} />
      </span>
      <div className="flex items-center gap-1.5">
        <FreshnessBadge freshness={freshness} />
        <StarToggle documentId={doc.documentId} favorited={favorited} />
      </div>
    </div>
    <p className="m-0 text-[14px] font-semibold text-[var(--nim-text)] leading-snug line-clamp-2">
      {docName(doc)}
    </p>
    <div className="mt-1.5 text-[12px] text-[var(--nim-text-faint)]">
      {getRelativeTimeString(doc.updatedAt ?? doc.createdAt ?? Date.now())}
    </div>
  </button>
);

const SectionHeader: React.FC<{ icon: string; label: string; right?: React.ReactNode }> = ({
  icon,
  label,
  right,
}) => (
  <div className="flex items-center justify-between mb-3">
    <div className="flex items-center gap-2 text-[13px] font-semibold uppercase tracking-wide text-[var(--nim-text-muted)]">
      <MaterialSymbol icon={icon} size={18} className="text-[var(--nim-text-faint)]" />
      {label}
    </div>
    {right}
  </div>
);

export const SharedDocsHome: React.FC<SharedDocsHomeProps> = ({ onDocumentSelect }) => {
  const allDocs = useAtomValue(sharedDocumentsAtom);
  const favoriteDocs = useAtomValue(favoriteSharedDocsAtom);
  const recentDocs = useAtomValue(recentSharedDocsAtom);
  const changedDocs = useAtomValue(changedSharedDocsAtom);
  const favorites = useAtomValue(collabFavoritesAtom);
  const favoriteSet = useMemo(() => new Set(favorites), [favorites]);

  const [query, setQuery] = useState('');
  const [allSort, setAllSort] = useState<AllSort>('updated');

  const trimmedQuery = query.trim().toLowerCase();
  const hasQuery = trimmedQuery.length > 0;

  const searchResults = useMemo(() => {
    if (!hasQuery) return [];
    return allDocs
      .filter((d) => !d.decryptFailed && docName(d).toLowerCase().includes(trimmedQuery))
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }, [allDocs, hasQuery, trimmedQuery]);

  const sortedAllDocs = useMemo(() => {
    const openable = allDocs.filter((d) => !d.decryptFailed);
    const copy = [...openable];
    if (allSort === 'name') {
      copy.sort((a, b) => docName(a).localeCompare(docName(b)));
    } else if (allSort === 'type') {
      copy.sort(
        (a, b) =>
          (a.documentType ?? '').localeCompare(b.documentType ?? '') ||
          docName(a).localeCompare(docName(b)),
      );
    } else {
      copy.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    }
    return copy;
  }, [allDocs, allSort]);

  const cycleSort = () =>
    setAllSort((s) => (s === 'updated' ? 'name' : s === 'name' ? 'type' : 'updated'));
  const sortLabel = allSort === 'updated' ? 'Last updated' : allSort === 'name' ? 'Name' : 'Type';

  return (
    <div className="shared-docs-home flex-1 overflow-y-auto px-8 py-6 select-text">
      <div className="max-w-[860px] mx-auto">
        <h1 className="m-0 text-[20px] font-semibold text-[var(--nim-text)]">Shared documents</h1>
        <p className="mt-0.5 mb-5 text-[13px] text-[var(--nim-text-faint)]">
          Find, revisit, and catch up on what your team has been working on.
        </p>

        {/* Search */}
        <div className="shared-docs-search flex items-center gap-2.5 rounded-lg px-3.5 py-2.5 mb-6 bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] focus-within:border-[var(--nim-primary)]">
          <MaterialSymbol icon="search" size={20} className="text-[var(--nim-text-muted)]" />
          <input
            autoFocus
            className="flex-1 bg-transparent border-none outline-none text-[14px] text-[var(--nim-text)] placeholder:text-[var(--nim-text-faint)]"
            placeholder="Search shared documents"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search shared documents"
          />
          {hasQuery && (
            <button
              type="button"
              className="bg-transparent border-none cursor-pointer text-[var(--nim-text-muted)] hover:text-[var(--nim-text)] p-0.5"
              onClick={() => setQuery('')}
              aria-label="Clear search"
              title="Clear search"
            >
              <MaterialSymbol icon="close" size={16} />
            </button>
          )}
        </div>

        {hasQuery ? (
          <div className="shared-docs-section">
            <SectionHeader icon="search" label={`Results (${searchResults.length})`} />
            {searchResults.length === 0 ? (
              <p className="text-[13px] text-[var(--nim-text-faint)] px-2.5 py-3 m-0">
                No shared documents match “{query.trim()}”.
              </p>
            ) : (
              <div className="flex flex-col">
                {searchResults.map((doc) => (
                  <DocRow
                    key={doc.documentId}
                    doc={doc}
                    favorited={favoriteSet.has(doc.documentId)}
                    onOpen={onDocumentSelect}
                  />
                ))}
              </div>
            )}
          </div>
        ) : (
          <>
            {favoriteDocs.length > 0 && (
              <div className="shared-docs-section mb-7">
                <SectionHeader icon="star" label="Favorites" />
                <div className="flex flex-col">
                  {favoriteDocs.map((doc) => (
                    <DocRow
                      key={doc.documentId}
                      doc={doc}
                      favorited
                      onOpen={onDocumentSelect}
                    />
                  ))}
                </div>
              </div>
            )}

            {changedDocs.length > 0 && (
              <div className="shared-docs-section mb-7">
                <SectionHeader icon="bolt" label="New & changed" />
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {changedDocs.map(({ doc, freshness }) => (
                    <ChangedCard
                      key={doc.documentId}
                      doc={doc}
                      freshness={freshness}
                      favorited={favoriteSet.has(doc.documentId)}
                      onOpen={onDocumentSelect}
                    />
                  ))}
                </div>
              </div>
            )}

            {recentDocs.length > 0 && (
              <div className="shared-docs-section mb-7">
                <SectionHeader icon="history" label="Recently opened" />
                <div className="flex flex-col">
                  {recentDocs.map((doc) => (
                    <DocRow
                      key={doc.documentId}
                      doc={doc}
                      favorited={favoriteSet.has(doc.documentId)}
                      onOpen={onDocumentSelect}
                    />
                  ))}
                </div>
              </div>
            )}

            <div className="shared-docs-section">
              <SectionHeader
                icon="folder_shared"
                label="All shared documents"
                right={
                  sortedAllDocs.length > 0 ? (
                    <button
                      type="button"
                      className="flex items-center gap-1 text-[12px] text-[var(--nim-text-muted)] border border-[var(--nim-border)] rounded px-2 py-1 bg-transparent cursor-pointer hover:text-[var(--nim-text)] hover:border-[var(--nim-text-faint)]"
                      onClick={cycleSort}
                      title="Change sort order"
                    >
                      {sortLabel}
                      <MaterialSymbol icon="expand_more" size={16} />
                    </button>
                  ) : undefined
                }
              />
              {sortedAllDocs.length === 0 ? (
                <p className="text-[13px] text-[var(--nim-text-faint)] px-2.5 py-3 m-0">
                  No shared documents yet. Create one or share a local file to collaborate.
                </p>
              ) : (
                <div className="flex flex-col">
                  {sortedAllDocs.map((doc) => (
                    <DocRow
                      key={doc.documentId}
                      doc={doc}
                      favorited={favoriteSet.has(doc.documentId)}
                      onOpen={onDocumentSelect}
                    />
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
};
