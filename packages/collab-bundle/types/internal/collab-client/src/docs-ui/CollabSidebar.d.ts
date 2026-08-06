import React from 'react';
export interface CollabSidebarProps {
    activeDocumentId?: string | null;
    /** Open the discovery hub (center pane). Shown as a Home action. */
    onShowHome?: () => void;
    /** Highlight the Home action when the hub is the active surface. */
    homeActive?: boolean;
    /** Host-owned scope label and path chrome; sidebar actions remain shared. */
    scopeName?: React.ReactNode;
    scopePath?: React.ReactNode;
    headerActions?: React.ReactNode;
    /**
     * Hosts where a folder is an addressable surface (the browser console routes
     * `/docs/folder/:folderId`). Desktop leaves this unset, so a folder click
     * stays a pure expand/select there.
     */
    onSelectFolder?: (folderId: string | null) => void;
}
export declare const CollabSidebar: React.FC<CollabSidebarProps>;
