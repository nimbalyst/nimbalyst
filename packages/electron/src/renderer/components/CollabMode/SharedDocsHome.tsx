/**
 * SharedDocsHome — the Shared Documents discovery hub rendered in CollabMode's
 * center pane (empty state, and reachable via the Home affordance while docs
 * are open). Search + Favorites + New & Changed + Recently opened + All.
 *
 * Purely presentational over the discovery atoms; opening a doc delegates to
 * the same `onDocumentSelect` path the sidebar uses.
 */

import React, { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import { useAtomValue } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime';
import type { SharedDocument } from '../../store/atoms/collabDocuments';
import {
  emptySharedDocumentTrash,
  removeSharedDocument,
  restoreSharedDocument,
  sharedDocumentsAtom,
  teamSyncStatusAtom,
  trashedSharedDocumentsAtom,
  trashSharedDocument,
} from '../../store/atoms/collabDocuments';
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
import {
  sweepEmptySharedDocuments,
  type SharedDocumentCleanupProgress,
} from '../../utils/sharedDocumentCleanup';
import { errorNotificationService } from '../../services/ErrorNotificationService';
import { getCollaborativeDocumentTypeCatalog } from '../../services/CollaborativeDocumentTypeCatalog';
import { resolveSharedDocumentTypePresentation } from '../../utils/sharedDocumentTypeMetadata';

interface SharedDocsHomeProps {
  workspacePath: string;
  onDocumentSelect: (doc: SharedDocument) => void;
}

type AllSort = 'updated' | 'name' | 'type';

/** Resolve through the live catalog so unloaded extensions never borrow another editor's icon. */
export function iconForSharedDocument(doc: SharedDocument): string {
  return resolveSharedDocumentTypePresentation(
    doc,
    getCollaborativeDocumentTypeCatalog(),
  ).icon;
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
      <MaterialSymbol icon={iconForSharedDocument(doc)} size={17} />
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
        <MaterialSymbol icon={iconForSharedDocument(doc)} size={19} />
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

export const SharedDocsHome: React.FC<SharedDocsHomeProps> = ({ workspacePath, onDocumentSelect }) => {
  const documentTypeCatalog = getCollaborativeDocumentTypeCatalog();
  const catalogRevision = useSyncExternalStore(
    documentTypeCatalog.subscribe,
    documentTypeCatalog.getSnapshot,
    documentTypeCatalog.getSnapshot,
  );
  const allDocs = useAtomValue(sharedDocumentsAtom);
  const trashedDocs = useAtomValue(trashedSharedDocumentsAtom);
  const teamSyncStatus = useAtomValue(teamSyncStatusAtom);
  const favoriteDocs = useAtomValue(favoriteSharedDocsAtom);
  const recentDocs = useAtomValue(recentSharedDocsAtom);
  const changedDocs = useAtomValue(changedSharedDocsAtom);
  const favorites = useAtomValue(collabFavoritesAtom);
  const favoriteSet = useMemo(() => new Set(favorites), [favorites]);

  const [query, setQuery] = useState('');
  const [allSort, setAllSort] = useState<AllSort>('updated');
  const [view, setView] = useState<'documents' | 'trash'>('documents');
  const [cleanupProgress, setCleanupProgress] = useState<SharedDocumentCleanupProgress | null>(null);

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
          resolveSharedDocumentTypePresentation(a, documentTypeCatalog).typeLabel.localeCompare(
            resolveSharedDocumentTypePresentation(b, documentTypeCatalog).typeLabel,
          ) ||
          docName(a).localeCompare(docName(b)),
      );
    } else {
      copy.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    }
    return copy;
  }, [allDocs, allSort, catalogRevision, documentTypeCatalog]);

  const cycleSort = () =>
    setAllSort((s) => (s === 'updated' ? 'name' : s === 'name' ? 'type' : 'updated'));
  const sortLabel = allSort === 'updated' ? 'Last updated' : allSort === 'name' ? 'Name' : 'Type';

  const handleCleanup = useCallback(async () => {
    if (teamSyncStatus !== 'connected' || cleanupProgress) return;
    const { inspectSharedDocumentEmptiness } = await import('../../utils/documentSeedOrchestrator');
    const result = await sweepEmptySharedDocuments(
      allDocs,
      (document) => inspectSharedDocumentEmptiness({
        workspacePath,
        documentId: document.documentId,
        documentType: document.documentType,
        title: document.title,
      }),
      trashSharedDocument,
      setCleanupProgress,
    );
    setCleanupProgress(null);
    if (result.failed > 0) {
      errorNotificationService.showWarning(
        'Cleanup finished with skipped documents',
        `Moved ${result.moved} empty document${result.moved === 1 ? '' : 's'} to Trash; ${result.failed} could not be verified.`,
        { duration: 7000 },
      );
    } else {
      errorNotificationService.showInfo(
        'Empty-document cleanup finished',
        `Moved ${result.moved} empty document${result.moved === 1 ? '' : 's'} to Trash.`,
        { duration: 5000 },
      );
    }
  }, [allDocs, cleanupProgress, teamSyncStatus, workspacePath]);

  if (view === 'trash') {
    return (
      <div className="shared-docs-trash flex-1 overflow-y-auto px-8 py-6 select-text bg-nim">
        <div className="max-w-[860px] mx-auto">
          <div className="flex items-start justify-between gap-4 mb-5">
            <div>
              <button
                type="button"
                className="flex items-center gap-1 bg-transparent border-none p-0 mb-2 text-[12px] text-[var(--nim-text-muted)] hover:text-[var(--nim-text)] cursor-pointer"
                onClick={() => setView('documents')}
              >
                <MaterialSymbol icon="arrow_back" size={16} />
                Shared documents
              </button>
              <h1 className="m-0 text-[20px] font-semibold text-[var(--nim-text)]">Trash</h1>
              <p className="mt-0.5 mb-0 text-[13px] text-[var(--nim-text-faint)]">
                Documents are permanently removed after 30 days. Restore returns them to their original folder.
              </p>
            </div>
            <button
              type="button"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-[var(--nim-danger)] bg-transparent text-[12px] text-[var(--nim-danger)] cursor-pointer hover:bg-[color-mix(in_srgb,var(--nim-danger)_10%,transparent)] disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={trashedDocs.length === 0 || teamSyncStatus !== 'connected'}
              onClick={() => {
                if (window.confirm(`Permanently delete ${trashedDocs.length} document${trashedDocs.length === 1 ? '' : 's'}? This cannot be undone.`)) {
                  emptySharedDocumentTrash();
                }
              }}
            >
              <MaterialSymbol icon="delete_forever" size={17} />
              Empty Trash
            </button>
          </div>

          {trashedDocs.length === 0 ? (
            <div className="rounded-lg border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] px-5 py-10 text-center">
              <MaterialSymbol icon="delete" size={30} className="text-[var(--nim-text-faint)]" />
              <p className="mt-2 mb-0 text-[13px] text-[var(--nim-text-muted)]">Trash is empty.</p>
            </div>
          ) : (
            <div className="rounded-lg border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] divide-y divide-[var(--nim-border)]">
              {trashedDocs.map((doc) => (
                <div key={doc.documentId} className="shared-docs-trash-row flex items-center gap-3 px-3 py-2.5">
                  <MaterialSymbol icon={iconForSharedDocument(doc)} size={18} className="text-[var(--nim-text-muted)]" />
                  <div className="flex-1 min-w-0">
                    <div className="truncate text-[13.5px] text-[var(--nim-text)]">{docName(doc)}</div>
                    <div className="text-[11.5px] text-[var(--nim-text-faint)]">
                      Trashed {getRelativeTimeString(doc.trashedAt ?? Date.now())}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="px-2.5 py-1 rounded border border-[var(--nim-border)] bg-transparent text-[12px] text-[var(--nim-text)] cursor-pointer hover:bg-[var(--nim-bg-hover)] disabled:opacity-50"
                    disabled={teamSyncStatus !== 'connected'}
                    onClick={() => restoreSharedDocument(doc.documentId)}
                  >
                    Restore
                  </button>
                  <button
                    type="button"
                    className="p-1 rounded border-none bg-transparent text-[var(--nim-danger)] cursor-pointer hover:bg-[var(--nim-bg-hover)] disabled:opacity-50"
                    disabled={teamSyncStatus !== 'connected'}
                    title="Delete permanently"
                    aria-label={`Delete ${docName(doc)} permanently`}
                    onClick={() => {
                      if (window.confirm(`Permanently delete "${docName(doc)}"? This cannot be undone.`)) {
                        removeSharedDocument(doc.documentId);
                      }
                    }}
                  >
                    <MaterialSymbol icon="delete_forever" size={18} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="shared-docs-home flex-1 overflow-y-auto px-8 py-6 select-text bg-nim">
      <div className="max-w-[860px] mx-auto">
        <div className="flex items-start justify-between gap-4 mb-5">
          <div>
            <h1 className="m-0 text-[20px] font-semibold text-[var(--nim-text)]">Shared documents</h1>
            <p className="mt-0.5 mb-0 text-[13px] text-[var(--nim-text-faint)]">
              Find, revisit, and catch up on what your team has been working on.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-[var(--nim-border)] bg-transparent text-[12px] text-[var(--nim-text-muted)] cursor-pointer hover:bg-[var(--nim-bg-hover)] disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={teamSyncStatus !== 'connected' || allDocs.length === 0 || cleanupProgress !== null}
              onClick={() => void handleCleanup()}
            >
              <MaterialSymbol icon="cleaning_services" size={17} />
              {cleanupProgress ? `${cleanupProgress.checked}/${cleanupProgress.total}` : 'Clean up empty docs'}
            </button>
            <button
              type="button"
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-[var(--nim-border)] bg-transparent text-[12px] text-[var(--nim-text-muted)] cursor-pointer hover:bg-[var(--nim-bg-hover)]"
              onClick={() => setView('trash')}
            >
              <MaterialSymbol icon="delete" size={17} />
              Trash{trashedDocs.length > 0 ? ` (${trashedDocs.length})` : ''}
            </button>
          </div>
        </div>

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
