/**
 * SharedDocsListView — the redesigned Shared Docs Home (NIM-1790).
 *
 * A sortable list view rendered inside a singleton virtual tab (see
 * sharedHomeTab.ts). Replaces the old card-grid discovery hub. Segment tabs
 * (All / Favorites / Needs my review / Recently opened / Shared with me /
 * Shared by me) narrow the set; sortable columns (Name, Type, Created by,
 * Last edited, Viewed by me, Folder, Needs review) order it. Needs-review is
 * the default sort.
 *
 * Purely presentational over the existing discovery + unread atoms; opening a
 * row hands off to CollabMode via `pendingCollabDocumentAtom` (the same signal
 * deep links and quick-open use), so this view stays decoupled from the tab
 * machinery.
 *
 * Deferred to later slices (out of scope here): Type/People/Folder filter
 * dropdowns, the New menu + team switcher, a real grid view, per-row hover
 * quick actions beyond open/copy-link, and persisting the chosen sort/segment.
 */

import React, { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import {
  useFloating,
  offset,
  flip,
  shift,
  autoUpdate,
  FloatingPortal,
  useClick,
  useDismiss,
  useRole,
  useInteractions,
} from '@floating-ui/react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { UserAvatar } from '@nimbalyst/runtime/plugins/TrackerPlugin/components/UserAvatar';
import {
  sharedDocumentsAtom,
  sharedFoldersAtom,
  activeTeamUserIdAtom,
  activeTeamOrgIdAtom,
  pendingCollabDocumentAtom,
  buildSharedDocumentDeepLink,
  type SharedDocument,
  type SharedFolder,
} from '../../store/atoms/collabDocuments';
import {
  collabFavoritesAtom,
  changedDocIdsAtom,
  docOpenedAtAtom,
  toggleFavoriteDoc,
} from '../../store/atoms/collabDiscovery';
import { docReceiptsAtom } from '../../store/atoms/docUnread';
import { useDocUnread } from '../../hooks/useDocUnread';
import { getCollabNodeName } from './collabTree';
import { getRelativeTimeString } from '../../utils/dateFormatting';
import { getCollaborativeDocumentTypeCatalog } from '../../services/CollaborativeDocumentTypeCatalog';
import { resolveSharedDocumentTypePresentation } from '../../utils/sharedDocumentTypeMetadata';
import { sharedDocTypeColor, resolveMyMemberIds } from './sharedHomeTab';

interface SharedDocsListViewProps {
  workspacePath: string;
}

type Segment = 'all' | 'favorites' | 'review' | 'recent' | 'sharedWithMe' | 'sharedByMe';
type SortColumn =
  | 'name'
  | 'type'
  | 'createdBy'
  | 'lastEdited'
  | 'viewedByMe'
  | 'folder'
  | 'needsReview';
type SortDirection = 'asc' | 'desc';

interface MemberInfo {
  name?: string;
  email?: string;
}

interface FacetOption {
  value: string;
  label: string;
  color?: string;
}

const SEGMENTS: Array<{ id: Segment; label: string; icon: string }> = [
  { id: 'all', label: 'All', icon: 'apps' },
  { id: 'favorites', label: 'Favorites', icon: 'star' },
  { id: 'review', label: 'Unread', icon: 'mark_email_unread' },
  { id: 'recent', label: 'Recently opened', icon: 'history' },
  { id: 'sharedWithMe', label: 'Shared with me', icon: 'call_received' },
  { id: 'sharedByMe', label: 'Shared by me', icon: 'call_made' },
];

/** Columns whose natural first click sorts high-to-low (time, flags). */
const DESC_FIRST_COLUMNS: ReadonlySet<SortColumn> = new Set<SortColumn>([
  'lastEdited',
  'viewedByMe',
  'needsReview',
]);

function docName(doc: SharedDocument): string {
  return getCollabNodeName(doc.title) || doc.title || 'Untitled';
}

/**
 * Resolve a member id to a display name, with 'You' for the current user.
 *
 * `myIds` is the set of member ids that resolve to the current user. The
 * team-org member id on a doc's `createdBy` can differ from the personal
 * member id the config reports (Stytch gives a different member id per org),
 * so identity is matched by a set joined on email rather than a single id.
 */
function memberName(
  id: string | null | undefined,
  members: Map<string, MemberInfo>,
  myIds: ReadonlySet<string>,
): string {
  if (!id) return 'Unknown';
  if (myIds.has(id)) return 'You';
  const info = members.get(id);
  if (info?.name) return info.name;
  if (info?.email) return info.email.split('@')[0];
  return 'Unknown';
}

export const SharedDocsListView: React.FC<SharedDocsListViewProps> = ({ workspacePath: _workspacePath }) => {
  // Keep read receipts flowing even when the sidebar (which also mounts this
  // hook) is collapsed/unmounted. Idempotent double-mount is harmless.
  useDocUnread();

  const catalog = getCollaborativeDocumentTypeCatalog();
  const catalogRevision = useSyncExternalStore(
    catalog.subscribe,
    catalog.getSnapshot,
    catalog.getSnapshot,
  );

  const allDocs = useAtomValue(sharedDocumentsAtom);
  const folders = useAtomValue(sharedFoldersAtom);
  const favorites = useAtomValue(collabFavoritesAtom);
  const unreadIds = useAtomValue(changedDocIdsAtom);
  const openedAt = useAtomValue(docOpenedAtAtom);
  const receipts = useAtomValue(docReceiptsAtom);
  const currentUserId = useAtomValue(activeTeamUserIdAtom);
  const orgId = useAtomValue(activeTeamOrgIdAtom);
  const setPendingDoc = useSetAtom(pendingCollabDocumentAtom);

  const favoriteSet = useMemo(() => new Set(favorites), [favorites]);
  const folderNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const f of folders as SharedFolder[]) {
      map.set(f.folderId, f.decryptFailed ? 'Locked' : f.name);
    }
    return map;
  }, [folders]);

  const [segment, setSegment] = useState<Segment>('all');
  const [query, setQuery] = useState('');
  const [sortColumn, setSortColumn] = useState<SortColumn>('needsReview');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('list');
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set());
  const [selectedPeople, setSelectedPeople] = useState<Set<string>>(new Set());
  const [selectedFolders, setSelectedFolders] = useState<Set<string>>(new Set());

  // --- Team member directory (createdBy / last-edited resolution) ---
  const [members, setMembers] = useState<Map<string, MemberInfo>>(new Map());
  useEffect(() => {
    if (!orgId) {
      setMembers(new Map());
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const result = await window.electronAPI?.invoke?.('team:list-members', orgId);
        if (cancelled) return;
        const next = new Map<string, MemberInfo>();
        if (result?.success && Array.isArray(result.members)) {
          for (const m of result.members) {
            if (m?.memberId) next.set(m.memberId, { name: m.name, email: m.email });
          }
        }
        setMembers(next);
      } catch {
        if (!cancelled) setMembers(new Map());
      }
    })();
    return () => { cancelled = true; };
  }, [orgId]);

  // --- Current user's email, used to join to the team member id(s) that
  // represent "me" (the config userId is the personal member id and does not
  // match the team-org createdBy ids). ---
  const [currentEmail, setCurrentEmail] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const account = await window.electronAPI?.invoke?.('stytch:get-sync-account');
        if (!cancelled) setCurrentEmail(account?.email ?? null);
      } catch {
        if (!cancelled) setCurrentEmail(null);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const myMemberIds = useMemo(
    () => resolveMyMemberIds(members, currentUserId, currentEmail),
    [members, currentUserId, currentEmail],
  );

  // --- Cmd+K focuses search ---
  const searchRef = React.useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const typePresentation = useCallback(
    (doc: SharedDocument) => resolveSharedDocumentTypePresentation(doc, catalog),
    // catalogRevision forces re-resolution when extensions (un)load.
    [catalog, catalogRevision],
  );

  // --- Segment filtering ---
  const segmentDocs = useMemo(() => {
    const openable = allDocs.filter((d) => !d.decryptFailed);
    switch (segment) {
      case 'favorites':
        return openable.filter((d) => favoriteSet.has(d.documentId));
      case 'review':
        return openable.filter((d) => unreadIds.has(d.documentId));
      case 'recent':
        return openable.filter((d) => (openedAt[d.documentId] ?? 0) > 0);
      case 'sharedWithMe':
        return openable.filter((d) => d.createdBy && !myMemberIds.has(d.createdBy));
      case 'sharedByMe':
        return openable.filter((d) => d.createdBy && myMemberIds.has(d.createdBy));
      default:
        return openable;
    }
  }, [allDocs, segment, favoriteSet, unreadIds, openedAt, myMemberIds]);

  const reviewCount = useMemo(
    () => allDocs.filter((d) => !d.decryptFailed && unreadIds.has(d.documentId)).length,
    [allDocs, unreadIds],
  );

  // --- Facet filter options (derived from all openable docs so options stay
  // stable as the user narrows) ---
  const ROOT_FOLDER = '__root__';
  const openableDocs = useMemo(() => allDocs.filter((d) => !d.decryptFailed), [allDocs]);

  const typeOptions = useMemo<FacetOption[]>(() => {
    const map = new Map<string, FacetOption>();
    for (const doc of openableDocs) {
      const label = typePresentation(doc).typeLabel;
      if (!map.has(label)) {
        map.set(label, { value: label, label, color: sharedDocTypeColor(label, doc.documentType) });
      }
    }
    return [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [openableDocs, typePresentation]);

  const peopleOptions = useMemo<FacetOption[]>(() => {
    const map = new Map<string, FacetOption>();
    for (const doc of openableDocs) {
      if (!doc.createdBy) continue;
      if (!map.has(doc.createdBy)) {
        map.set(doc.createdBy, { value: doc.createdBy, label: memberName(doc.createdBy, members, myMemberIds) });
      }
    }
    return [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [openableDocs, members, myMemberIds]);

  const folderOptions = useMemo<FacetOption[]>(() => {
    const map = new Map<string, FacetOption>();
    for (const doc of openableDocs) {
      const value = doc.parentFolderId ?? ROOT_FOLDER;
      if (!map.has(value)) {
        const label = doc.parentFolderId ? folderNames.get(doc.parentFolderId) ?? 'Unknown folder' : 'No folder';
        map.set(value, { value, label });
      }
    }
    return [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [openableDocs, folderNames]);

  // --- Facet + search filtering ---
  const trimmedQuery = query.trim().toLowerCase();
  const filteredDocs = useMemo(() => {
    return segmentDocs.filter((d) => {
      if (trimmedQuery && !docName(d).toLowerCase().includes(trimmedQuery)) return false;
      if (selectedTypes.size > 0 && !selectedTypes.has(typePresentation(d).typeLabel)) return false;
      if (selectedPeople.size > 0 && !(d.createdBy && selectedPeople.has(d.createdBy))) return false;
      if (selectedFolders.size > 0 && !selectedFolders.has(d.parentFolderId ?? ROOT_FOLDER)) return false;
      return true;
    });
  }, [segmentDocs, trimmedQuery, selectedTypes, selectedPeople, selectedFolders, typePresentation]);

  const toggleFacet = useCallback(
    (setter: React.Dispatch<React.SetStateAction<Set<string>>>, value: string) => {
      setter((prev) => {
        const next = new Set(prev);
        if (next.has(value)) next.delete(value);
        else next.add(value);
        return next;
      });
    },
    [],
  );

  // --- Sorting ---
  const sortedDocs = useMemo(() => {
    const dir = sortDirection === 'asc' ? 1 : -1;
    const value = (doc: SharedDocument): string | number => {
      switch (sortColumn) {
        case 'name':
          return docName(doc).toLowerCase();
        case 'type':
          return typePresentation(doc).typeLabel.toLowerCase();
        case 'createdBy':
          return memberName(doc.createdBy, members, myMemberIds).toLowerCase();
        case 'lastEdited':
          return doc.updatedAt ?? 0;
        case 'viewedByMe':
          return receipts.get(doc.documentId)?.lastViewedAt ?? 0;
        case 'folder':
          return (doc.parentFolderId ? folderNames.get(doc.parentFolderId) ?? '' : '').toLowerCase();
        case 'needsReview':
          return unreadIds.has(doc.documentId) ? 1 : 0;
        default:
          return 0;
      }
    };
    return [...filteredDocs].sort((a, b) => {
      const va = value(a);
      const vb = value(b);
      let cmp: number;
      if (typeof va === 'number' && typeof vb === 'number') {
        cmp = va - vb;
      } else {
        cmp = String(va).localeCompare(String(vb));
      }
      // Stable tiebreak on recency so equal keys read newest-first.
      if (cmp === 0) cmp = (a.updatedAt ?? 0) - (b.updatedAt ?? 0);
      return cmp * dir;
    });
  }, [filteredDocs, sortColumn, sortDirection, typePresentation, members, myMemberIds, receipts, folderNames, unreadIds]);

  const handleSort = useCallback((column: SortColumn) => {
    setSortColumn((prevColumn) => {
      if (prevColumn === column) {
        setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
        return column;
      }
      setSortDirection(DESC_FIRST_COLUMNS.has(column) ? 'desc' : 'asc');
      return column;
    });
  }, []);

  const openDoc = useCallback((doc: SharedDocument) => {
    setPendingDoc({
      documentId: doc.documentId,
      documentType: doc.documentType,
      ...(doc.metadataVersion === 2
        ? { metadataVersion: 2 as const, fileExtension: doc.fileExtension, editorId: doc.editorId }
        : {}),
    });
  }, [setPendingDoc]);

  const copyLink = useCallback((doc: SharedDocument) => {
    if (!orgId) return;
    void navigator.clipboard?.writeText(buildSharedDocumentDeepLink(doc.documentId, orgId));
  }, [orgId]);

  const totalOpenable = allDocs.filter((d) => !d.decryptFailed).length;
  const sortLabel = SORT_LABELS[sortColumn];

  return (
    <div className="shared-docs-list-view h-full flex flex-col min-h-0 bg-nim select-text">
      {/* Header */}
      <div className="shared-docs-list-header flex items-center gap-3 px-4 py-2.5 border-b border-nim shrink-0">
        <div className="flex items-center gap-2 shrink-0">
          <MaterialSymbol icon="groups" size={20} className="text-[var(--nim-text-muted)]" />
          <span className="text-[15px] font-semibold text-[var(--nim-text)]">Shared</span>
        </div>
        <div className="shared-docs-list-search flex items-center gap-2 flex-1 max-w-[520px] mx-auto rounded-md px-3 py-1.5 bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] focus-within:border-[var(--nim-primary)]">
          <MaterialSymbol icon="search" size={17} className="text-[var(--nim-text-muted)]" />
          <input
            ref={searchRef}
            className="flex-1 bg-transparent border-none outline-none text-[13px] text-[var(--nim-text)] placeholder:text-[var(--nim-text-faint)]"
            placeholder="Search shared documents"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search shared documents"
          />
          <kbd className="shrink-0 text-[10.5px] text-[var(--nim-text-faint)] border border-[var(--nim-border)] rounded px-1 py-0.5">⌘K</kbd>
        </div>
        <div className="shared-docs-view-toggle flex items-center rounded-md border border-[var(--nim-border)] overflow-hidden shrink-0">
          <button
            type="button"
            className={`flex items-center justify-center px-1.5 py-1 border-none cursor-pointer ${viewMode === 'list' ? 'bg-[var(--nim-bg-active)] text-[var(--nim-text)]' : 'bg-transparent text-[var(--nim-text-muted)]'}`}
            onClick={() => setViewMode('list')}
            title="List view"
            aria-label="List view"
            aria-pressed={viewMode === 'list'}
          >
            <MaterialSymbol icon="format_list_bulleted" size={17} />
          </button>
          <button
            type="button"
            className="flex items-center justify-center px-1.5 py-1 border-none cursor-not-allowed bg-transparent text-[var(--nim-text-faint)] opacity-50"
            title="Grid view (coming soon)"
            aria-label="Grid view (coming soon)"
            disabled
          >
            <MaterialSymbol icon="grid_view" size={17} />
          </button>
        </div>
      </div>

      {/* Segment tabs + facet filters */}
      <div className="shared-docs-segments flex items-center gap-2 px-4 py-2 border-b border-nim shrink-0">
        <div className="flex items-center gap-1.5 flex-1 min-w-0 overflow-x-auto">
          {SEGMENTS.map((seg) => {
            const active = segment === seg.id;
            return (
              <button
                key={seg.id}
                type="button"
                className={`shared-docs-segment flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12.5px] cursor-pointer border whitespace-nowrap ${
                  active
                    ? 'bg-[var(--nim-bg-active)] text-[var(--nim-text)] border-[var(--nim-border)]'
                    : 'bg-transparent text-[var(--nim-text-muted)] border-transparent hover:bg-[var(--nim-bg-hover)]'
                }`}
                onClick={() => setSegment(seg.id)}
                aria-pressed={active}
                data-segment={seg.id}
              >
                <MaterialSymbol icon={seg.icon} size={15} fill={seg.id === 'favorites' && active} />
                {seg.label}
                {seg.id === 'review' && reviewCount > 0 && (
                  <span className="shared-docs-segment-badge text-[10.5px] font-semibold rounded-full px-1.5 py-px bg-[var(--nim-primary)] text-white">
                    {reviewCount}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <FacetDropdown
            label="Type"
            icon="category"
            options={typeOptions}
            selected={selectedTypes}
            onToggle={(v) => toggleFacet(setSelectedTypes, v)}
            onClear={() => setSelectedTypes(new Set())}
          />
          <FacetDropdown
            label="People"
            icon="group"
            options={peopleOptions}
            selected={selectedPeople}
            onToggle={(v) => toggleFacet(setSelectedPeople, v)}
            onClear={() => setSelectedPeople(new Set())}
          />
          <FacetDropdown
            label="Folder"
            icon="folder"
            options={folderOptions}
            selected={selectedFolders}
            onToggle={(v) => toggleFacet(setSelectedFolders, v)}
            onClear={() => setSelectedFolders(new Set())}
          />
        </div>
      </div>

      {/* Table */}
      <div className="shared-docs-table flex-1 overflow-y-auto min-h-0">
        {sortedDocs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center px-6 py-16">
            <MaterialSymbol icon="folder_shared" size={34} className="text-[var(--nim-text-faint)]" />
            <p className="mt-2 mb-0 text-[13px] text-[var(--nim-text-muted)]">
              {trimmedQuery
                ? `No shared documents match “${query.trim()}”.`
                : 'No shared documents here yet.'}
            </p>
          </div>
        ) : (
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="shared-docs-thead sticky top-0 z-10 bg-nim border-b border-nim text-[11px] uppercase tracking-wide text-[var(--nim-text-muted)]">
                <HeaderCell label="Unread" column="needsReview" icon="mark_email_unread" sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} className="w-8" />
                <th className="w-8 px-2 py-2" />
                <HeaderCell label="Name" column="name" sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                <HeaderCell label="Type" column="type" sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                <HeaderCell label="Created by" column="createdBy" sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                <HeaderCell label="Last edited" column="lastEdited" sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                <HeaderCell label="Viewed by me" column="viewedByMe" sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                <HeaderCell label="Folder" column="folder" sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
              </tr>
            </thead>
            <tbody>
              {sortedDocs.map((doc) => {
                const pres = typePresentation(doc);
                const color = sharedDocTypeColor(pres.typeLabel, doc.documentType);
                const favorited = favoriteSet.has(doc.documentId);
                const needsReview = unreadIds.has(doc.documentId);
                const lastWriter = doc.lastWriterUserId;
                const viewedAt = receipts.get(doc.documentId)?.lastViewedAt ?? 0;
                const folderName = doc.parentFolderId ? folderNames.get(doc.parentFolderId) : undefined;
                return (
                  <tr
                    key={doc.documentId}
                    className="shared-docs-row group cursor-pointer border-b border-[var(--nim-border)] hover:bg-[var(--nim-bg-hover)]"
                    onClick={() => openDoc(doc)}
                    data-document-id={doc.documentId}
                  >
                    {/* Unread (skinny, icon-only) */}
                    <td className="px-2 py-2 align-middle text-center">
                      {needsReview ? (
                        <span
                          className="shared-docs-review-dot inline-block w-2 h-2 rounded-full bg-[var(--nim-primary)] align-middle"
                          title="Changed since you last viewed"
                          aria-label="Unread"
                        />
                      ) : null}
                    </td>
                    {/* Favorite */}
                    <td className="px-2 py-2 align-middle">
                      <button
                        type="button"
                        className={`shared-docs-star flex items-center justify-center bg-transparent border-none cursor-pointer p-0.5 rounded transition-opacity ${
                          favorited
                            ? 'text-[var(--nim-warning)] opacity-100'
                            : 'text-[var(--nim-text-faint)] opacity-0 group-hover:opacity-80 hover:!opacity-100'
                        }`}
                        title={favorited ? 'Unfavorite' : 'Favorite'}
                        aria-label={favorited ? 'Unfavorite' : 'Favorite'}
                        aria-pressed={favorited}
                        onClick={(e) => { e.stopPropagation(); toggleFavoriteDoc(doc.documentId); }}
                      >
                        <MaterialSymbol icon="star" size={16} fill={favorited} />
                      </button>
                    </td>
                    {/* Name */}
                    <td className="px-2 py-2 align-middle">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span className="shrink-0 w-6 h-6 rounded-md flex items-center justify-center" style={{ color, backgroundColor: `color-mix(in srgb, ${color} 14%, transparent)` }}>
                          <MaterialSymbol icon={pres.icon} size={16} />
                        </span>
                        <span className="truncate text-[13.5px] text-[var(--nim-text)]">{docName(doc)}</span>
                        {/* Row hover quick actions */}
                        <span className="shared-docs-row-actions ml-auto flex items-center gap-0.5 opacity-0 group-hover:opacity-100 pl-2">
                          <RowAction icon="open_in_new" title="Open" onClick={(e) => { e.stopPropagation(); openDoc(doc); }} />
                          <RowAction icon="link" title="Copy link" onClick={(e) => { e.stopPropagation(); copyLink(doc); }} />
                        </span>
                      </div>
                    </td>
                    {/* Type chip */}
                    <td className="px-2 py-2 align-middle whitespace-nowrap">
                      <span
                        className="shared-docs-type-chip inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] font-medium"
                        style={{ color, backgroundColor: `color-mix(in srgb, ${color} 14%, transparent)` }}
                      >
                        <MaterialSymbol icon={pres.icon} size={13} />
                        {pres.typeLabel}
                      </span>
                    </td>
                    {/* Created by */}
                    <td className="px-2 py-2 align-middle whitespace-nowrap">
                      <UserAvatar identity={memberName(doc.createdBy, members, myMemberIds)} showName size={20} />
                    </td>
                    {/* Last edited */}
                    <td className="px-2 py-2 align-middle whitespace-nowrap text-[12.5px] text-[var(--nim-text-muted)]">
                      {doc.updatedAt ? (
                        <span>
                          {getRelativeTimeString(doc.updatedAt)}
                          {lastWriter && (
                            <span className="text-[var(--nim-text-faint)]"> · {memberName(lastWriter, members, myMemberIds)}</span>
                          )}
                        </span>
                      ) : (
                        <span className="text-[var(--nim-text-faint)]">—</span>
                      )}
                    </td>
                    {/* Viewed by me */}
                    <td className="px-2 py-2 align-middle whitespace-nowrap text-[12.5px]">
                      {viewedAt > 0 ? (
                        <span className="text-[var(--nim-text-muted)]">{getRelativeTimeString(viewedAt)}</span>
                      ) : (
                        <span className="flex items-center gap-1 text-[var(--nim-warning)]">
                          <MaterialSymbol icon="visibility_off" size={14} />
                          Never
                        </span>
                      )}
                    </td>
                    {/* Folder */}
                    <td className="px-2 py-2 align-middle whitespace-nowrap">
                      {folderName ? (
                        <span className="shared-docs-folder-chip inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] text-[var(--nim-text-muted)] bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)]">
                          <MaterialSymbol icon="folder" size={13} />
                          {folderName}
                        </span>
                      ) : (
                        <span className="text-[var(--nim-text-faint)] text-[12px]">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Footer */}
      <div className="shared-docs-list-footer flex items-center gap-2 px-4 py-1.5 border-t border-nim shrink-0 text-[11.5px] text-[var(--nim-text-muted)]">
        <span>{sortedDocs.length} of {totalOpenable} documents</span>
        {reviewCount > 0 && (
          <>
            <span className="text-[var(--nim-text-faint)]">·</span>
            <span>{reviewCount} unread</span>
          </>
        )}
        <span className="text-[var(--nim-text-faint)]">·</span>
        <span>Sorted by {sortLabel}</span>
      </div>
    </div>
  );
};

const SORT_LABELS: Record<SortColumn, string> = {
  name: 'name',
  type: 'type',
  createdBy: 'created by',
  lastEdited: 'last edited',
  viewedByMe: 'viewed by me',
  folder: 'folder',
  needsReview: 'unread',
};

const HeaderCell: React.FC<{
  label: string;
  column: SortColumn;
  sortColumn: SortColumn;
  sortDirection: SortDirection;
  onSort: (column: SortColumn) => void;
  align?: 'left' | 'right';
  /** When set, render an icon instead of the text label (skinny columns). */
  icon?: string;
  className?: string;
}> = ({ label, column, sortColumn, sortDirection, onSort, align = 'left', icon, className }) => {
  const active = sortColumn === column;
  const sortIcon = active ? (sortDirection === 'asc' ? 'arrow_upward' : 'arrow_downward') : 'unfold_more';
  return (
    <th className={`px-2 py-2 font-medium ${align === 'right' ? 'text-right' : 'text-left'} ${className ?? ''}`}>
      <button
        type="button"
        className={`shared-docs-th-btn inline-flex items-center gap-1 bg-transparent border-none cursor-pointer uppercase tracking-wide text-[11px] ${
          active ? 'text-[var(--nim-primary)]' : 'text-[var(--nim-text-muted)] hover:text-[var(--nim-text)]'
        } ${align === 'right' ? 'flex-row-reverse' : ''}`}
        onClick={() => onSort(column)}
        title={icon ? `Sort by ${label}` : undefined}
        aria-label={icon ? `Sort by ${label}` : undefined}
      >
        {icon ? (
          <MaterialSymbol icon={icon} size={15} fill={active} />
        ) : (
          <>
            {label}
            <MaterialSymbol icon={sortIcon} size={14} />
          </>
        )}
        {icon && active && <MaterialSymbol icon={sortDirection === 'asc' ? 'arrow_upward' : 'arrow_downward'} size={11} />}
      </button>
    </th>
  );
};

const FacetDropdown: React.FC<{
  label: string;
  icon: string;
  options: FacetOption[];
  selected: Set<string>;
  onToggle: (value: string) => void;
  onClear: () => void;
}> = ({ label, icon, options, selected, onToggle, onClear }) => {
  const [open, setOpen] = useState(false);
  const count = selected.size;

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: 'bottom-end',
    middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });
  const click = useClick(context);
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: 'menu' });
  const { getReferenceProps, getFloatingProps } = useInteractions([click, dismiss, role]);

  return (
    <>
      <button
        ref={refs.setReference}
        {...getReferenceProps()}
        type="button"
        className={`shared-docs-facet flex items-center gap-1 px-2.5 py-1 rounded-md text-[12px] cursor-pointer border whitespace-nowrap ${
          count > 0
            ? 'bg-[var(--nim-bg-active)] text-[var(--nim-text)] border-[var(--nim-border)]'
            : 'bg-transparent text-[var(--nim-text-muted)] border-[var(--nim-border)] hover:bg-[var(--nim-bg-hover)]'
        }`}
        data-facet={label.toLowerCase()}
        aria-label={`Filter by ${label}`}
      >
        <MaterialSymbol icon={icon} size={15} />
        {label}
        {count > 0 && (
          <span className="shared-docs-facet-count text-[10.5px] font-semibold rounded-full px-1.5 py-px bg-[var(--nim-primary)] text-white">
            {count}
          </span>
        )}
        <MaterialSymbol icon="expand_more" size={15} />
      </button>
      {open && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            {...getFloatingProps()}
            className="shared-docs-facet-menu z-50 min-w-[200px] max-h-[320px] overflow-y-auto rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] shadow-lg py-1"
          >
            <div className="flex items-center justify-between px-3 py-1.5">
              <span className="text-[11px] uppercase tracking-wide text-[var(--nim-text-muted)]">{label}</span>
              {count > 0 && (
                <button
                  type="button"
                  className="text-[11px] text-[var(--nim-primary)] bg-transparent border-none cursor-pointer hover:underline"
                  onClick={onClear}
                >
                  Clear
                </button>
              )}
            </div>
            {options.length === 0 ? (
              <div className="px-3 py-2 text-[12px] text-[var(--nim-text-faint)]">No options</div>
            ) : (
              options.map((opt) => {
                const checked = selected.has(opt.value);
                return (
                  <button
                    key={opt.value}
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={checked}
                    className="shared-docs-facet-option w-full flex items-center gap-2 px-3 py-1.5 text-left text-[12.5px] bg-transparent border-none cursor-pointer text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]"
                    onClick={() => onToggle(opt.value)}
                  >
                    <span className={`shrink-0 w-4 h-4 rounded border flex items-center justify-center ${checked ? 'bg-[var(--nim-primary)] border-[var(--nim-primary)]' : 'border-[var(--nim-border)]'}`}>
                      {checked && <MaterialSymbol icon="check" size={12} className="text-white" />}
                    </span>
                    {opt.color && (
                      <span className="shrink-0 w-2 h-2 rounded-full" style={{ backgroundColor: opt.color }} />
                    )}
                    <span className="truncate">{opt.label}</span>
                  </button>
                );
              })
            )}
          </div>
        </FloatingPortal>
      )}
    </>
  );
};

const RowAction: React.FC<{
  icon: string;
  title: string;
  onClick: (e: React.MouseEvent) => void;
}> = ({ icon, title, onClick }) => (
  <button
    type="button"
    className="flex items-center justify-center p-1 rounded bg-transparent border-none cursor-pointer text-[var(--nim-text-muted)] hover:text-[var(--nim-text)] hover:bg-[var(--nim-bg-active)]"
    title={title}
    aria-label={title}
    onClick={onClick}
  >
    <MaterialSymbol icon={icon} size={15} />
  </button>
);
