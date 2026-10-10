/**
 * A Pages section's Search: every page, and every typed page of a type placed
 * in the section's tree, as one table, laid out like the old Shared Home list (header with the search box,
 * a row of filter pills, the table, a footer count). The omnibox searches
 * titles here and page text through the section's search index, and turns a
 * field name into a filter clause (type, tags, author, updated, and the
 * chosen type's own fields).
 *
 * The whole state is one `pagesSearchQuery` string the host keeps: the web
 * console keeps it in the URL, the desktop in the tab. Rows come from the
 * host's pages and the tracker records under its `TrackersUIProvider`.
 */
import React from 'react';
import type { PageSearchRequest, PageSearchResponse } from '@nimbalyst/collab-protocol';
import { type PagesSearchPageInput } from './pagesSearch';
export type PagesSearchLane = 'team' | 'personal';
/** How an open was asked for, so a host can open in a new tab on Cmd/Ctrl. */
export interface PagesOpenOptions {
    newTab: boolean;
}
export interface PagesSearchViewProps {
    lane: PagesSearchLane;
    /** The project name, or a project switcher, in the header. */
    title?: React.ReactNode;
    /** The section's pages, as its docs session lists them. */
    pages: readonly PagesSearchPageInput[];
    /** The types placed in the section's tree; only their typed pages are listed. */
    typePlacements: ReadonlyArray<{
        typeId: string;
    }>;
    /** A member id's email, so pages and typed pages share one Author filter. */
    memberEmail?: (memberId: string) => string | null | undefined;
    /** Who an author value (an email or member id) is, for the column and the filter. */
    authorLabel: (author: string) => string;
    /** The current user's email, for "is me" author filters. */
    me?: string | null;
    /** The current state, as a `pagesSearchQuery` string. */
    search: string;
    onSearchChange: (search: string, options: {
        replace: boolean;
    }) => void;
    /** The section's page-text search (the docs session's `searchPages`); absent hides body matches. */
    searchPages?: (query: PageSearchRequest) => Promise<PageSearchResponse | null>;
    /** `newTab`: Cmd/Ctrl was held on the click. */
    onOpenPage: (documentId: string, options: PagesOpenOptions) => void;
    onOpenItem: (itemId: string, options: PagesOpenOptions) => void;
    /** Host controls beside the search box. */
    headerActions?: React.ReactNode;
}
export declare function PagesSearchView({ lane, title, pages, typePlacements, memberEmail, authorLabel, me, search, onSearchChange, searchPages, onOpenPage, onOpenItem, headerActions, }: PagesSearchViewProps): React.JSX.Element;
