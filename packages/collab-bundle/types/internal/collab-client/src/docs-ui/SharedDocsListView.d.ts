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
import React from 'react';
export interface SharedDocsListViewProps {
    /**
     * Render only one folder's direct children. Hosts that address a folder by
     * route (the browser console's `/docs/folder/:folderId`) pass it here so the
     * URL and the list agree; desktop leaves it unset and the folder facet stays
     * the only filter.
     */
    folderId?: string | null;
}
export declare const SharedDocsListView: React.FC<SharedDocsListViewProps>;
