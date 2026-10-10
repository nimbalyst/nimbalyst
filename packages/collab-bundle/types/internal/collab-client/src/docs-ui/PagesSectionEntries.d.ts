/**
 * The fixed rows at the top of a Pages section, above its tree: Home (the
 * section's editable Home page), Search (every page and typed page as a
 * table) and Types (the map of the section's types). Rows use the tree's
 * classes so they read as part of it; the host opens each surface.
 */
import React from 'react';
export type PagesSectionEntry = 'home' | 'search' | 'types';
/** `newTab`: Cmd/Ctrl was held on the click. */
export type PagesSectionEntryOpen = (options: {
    newTab: boolean;
}) => void;
export interface PagesSectionEntriesProps {
    /** The entry whose surface is open, if any. */
    active: PagesSectionEntry | null;
    /** Absent when the section has no Home page (it was deleted). */
    onOpenHome?: PagesSectionEntryOpen;
    onOpenSearch: PagesSectionEntryOpen;
    onOpenTypes: PagesSectionEntryOpen;
}
export declare const PagesSectionEntries: React.FC<PagesSectionEntriesProps>;
