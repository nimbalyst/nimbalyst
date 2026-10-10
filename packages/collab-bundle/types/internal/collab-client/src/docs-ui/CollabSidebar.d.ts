import React from 'react';
import './collabSidebarTree.css';
import { type SharedDocument, type CollabTypeTreeResolver } from '../docs/index';
import { type CollabSectionMenuItem } from './CollabSectionRoot';
import { type CollabPageActionRequest } from './usePageActionRequest';
export interface CollabSidebarProps {
    activeDocumentId?: string | null;
    /** The open typed page (item id) or type page (type id), highlighted like the open page. */
    activeItemId?: string | null;
    activeTypeId?: string | null;
    /** Fixed rows above the tree (the section's Home, Search and Types: `PagesSectionEntries`). */
    sectionEntries?: React.ReactNode;
    /** Host-owned scope label and path chrome; sidebar actions remain shared. */
    scopeName?: React.ReactNode;
    scopePath?: React.ReactNode;
    headerActions?: React.ReactNode;
    /** Host entries appended to the section's right-click menu. */
    extraSectionMenuItems?: readonly CollabSectionMenuItem[];
    /**
     * Hosts where a folder is an addressable surface (the browser console routes
     * `/docs/folder/:folderId`). Desktop leaves this unset, so a folder click
     * stays a pure expand/select there.
     */
    onSelectFolder?: (folderId: string | null) => void;
    /**
     * Publishes this tree's create menu to a host outside it (the desktop title
     * bar's create control). The list is built here because the catalog filtering
     * that decides which types are shareable at all lives here; a second copy in
     * the host would drift from it.
     */
    registerCreateMenu?: (menu: CollabSidebarCreateMenu | null) => void;
    /**
     * Names placed tracker types and lists their items. Hosts without tracker
     * data omit it, and the tree then shows no type nodes.
     */
    typeResolver?: CollabTypeTreeResolver;
    /**
     * Archive a typed page (the tracker's own archive, which keeps its comments
     * and sessions). Typed pages never go to Wiki Trash; hosts without tracker
     * writes omit it and the row offers no Archive.
     */
    onArchiveItem?: (itemId: string) => Promise<void>;
    /**
     * Shows this tree as one section of a stacked sidebar ("Team", "Personal"):
     * a compact section header replaces the scope summary header.
     */
    sectionTitle?: string;
    /**
     * Section only: with `onToggleCollapsed` the title row becomes a toggle, and
     * a collapsed section renders that row alone (no filters, search or tree).
     */
    collapsed?: boolean;
    onToggleCollapsed?: () => void;
    /**
     * Page tree only: turn a plain page into a typed page in place. Without it
     * the menu's "Set type" entry is shown disabled.
     */
    onSetPageType?: (document: SharedDocument) => void;
    /** A page action from outside the tree (the page's header menu); `onPageActionHandled` clears it. */
    pageActionRequest?: CollabPageActionRequest | null;
    onPageActionHandled?: () => void;
}
export interface CollabSidebarCreateMenu {
    items: Array<{
        id: string;
        label: string;
        icon: string;
        onSelect: () => void;
    }>;
    /** Folder the new document lands in, or null for the space root. */
    destination: string | null;
    /** Default action: a shared Markdown doc. */
    onPrimary: () => void;
    /** Extension the default action produces, shown beside it. */
    primaryTrailing?: string;
    onNewFolder: () => void;
    /** True when this tree has pages instead of folders (no "New folder"). */
    pageTree?: boolean;
}
export declare const CollabSidebar: React.FC<CollabSidebarProps>;
