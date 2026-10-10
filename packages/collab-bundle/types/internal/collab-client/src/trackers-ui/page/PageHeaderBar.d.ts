/**
 * The header strip of a page in Pages: the same 36px `EditorHeaderBar` every
 * document tab has, so a plain page, a typed page and a type page all read
 * the same at the top. The path on the left opens each page above this one;
 * on the right sit the host's status (sync, presence), History in the same
 * place on every page, and the page's ⋯ menu.
 */
import React from 'react';
import { type BreadcrumbCrumb } from '../../ui-primitives/EditorHeaderBar';
import type { PageTreeAncestor } from '../embed/pageTreeAncestors';
export interface PageHeaderMenuItem {
    id: string;
    label: string;
    icon: string;
    onSelect: () => void;
    destructive?: boolean;
    /** Starts a new group: a rule above it. */
    dividerBefore?: boolean;
}
export interface PageHeaderBarProps {
    /** A leading section name ("Personal") that is not itself a page. */
    section?: string | null;
    /** The pages above this one, root first. */
    path: readonly PageTreeAncestor[];
    /** This page's own name: the last, current crumb. */
    title: string;
    /** This page's icon (its type's); a plain page's by default. */
    titleIcon?: string;
    onOpenAncestor?: (ancestor: PageTreeAncestor) => void;
    /** Sync and presence, before the buttons. */
    status?: React.ReactNode;
    /** Host buttons before History (the table of contents, the session chip). */
    actions?: React.ReactNode;
    /** Absent while the page has no history to show. */
    onShowHistory?: () => void;
    menuItems?: readonly PageHeaderMenuItem[];
    testId?: string;
}
/** The icon a page shows in a crumb: its type's for a typed page or a type. */
export declare function pageAncestorIcon(ancestor: Pick<PageTreeAncestor, 'kind' | 'id' | 'typeId'>): string;
export declare function pageHeaderCrumbs(section: string | null | undefined, path: readonly PageTreeAncestor[], title: string, onOpenAncestor?: (ancestor: PageTreeAncestor) => void, titleIcon?: string): BreadcrumbCrumb[];
export declare const PageHeaderBar: React.FC<PageHeaderBarProps>;
