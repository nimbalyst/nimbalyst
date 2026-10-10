/**
 * The one header strip that sits above editor content in every Nimbalyst host.
 *
 * Desktop's `UnifiedEditorHeaderBar` invented this shape -- a 36px row, the
 * breadcrumb on the left taking all the pressure, a fixed-size action cluster on
 * the right -- and the web console then hand-wrote four near-identical copies of
 * it under `.console-breadcrumb-header`. The copies had already drifted: only
 * one of them carried actions at all, so a shared document in the browser had no
 * presence, no copy-link and no overflow menu, while the same document in the
 * desktop had all three.
 *
 * So the chrome lives here and both hosts render it. What goes *in* the action
 * cluster stays host-owned -- desktop can export a PDF and open Finder, a
 * browser tab cannot -- which is the same split `TrackerItemActionsMenu` draws.
 *
 * Sizes are the desktop's, not approximations: `h-9` is its 36px row, `size-7`
 * its icon buttons, `text-[13px]` its breadcrumb.
 */
import React from 'react';
export declare function EditorHeaderBar({ breadcrumb, actions, className, testId, }: {
    /** The left side. Usually `<EditorBreadcrumb>`; anything is allowed. */
    breadcrumb: React.ReactNode;
    /** The right side. Omitted entirely rather than rendered empty. */
    actions?: React.ReactNode;
    className?: string;
    testId?: string;
}): React.JSX.Element;
/** One crumb. `current` is the thing being looked at; `onClick` makes it a link. */
export interface BreadcrumbCrumb {
    /** Stable across renders; the label alone repeats in nested folders. */
    id: string;
    label: string;
    onClick?: () => void;
    /** The last crumb: darker, semibold, never a link. */
    current?: boolean;
    title?: string;
    /** Drawn before the label, as a file crumb draws its folder or file icon. */
    icon?: React.ReactNode;
}
/**
 * The crumb trail, ellipsizing as a whole rather than per crumb, so a long
 * document title shortens instead of pushing the actions off the row.
 */
export declare function EditorBreadcrumb({ crumbs, leading, className, }: {
    crumbs: readonly BreadcrumbCrumb[];
    /** Rendered before the first crumb -- a tree-reveal toggle, typically. */
    leading?: React.ReactNode;
    className?: string;
}): React.JSX.Element;
/**
 * The icon button in a header's action cluster, and in the pane headers that
 * flank it. Desktop's `unified-header-button` shape, named once.
 */
export declare const HeaderIconButton: React.ForwardRefExoticComponent<{
    label: string;
    onClick?: () => void;
    /** Renders the pressed fill, and reports `aria-pressed`/`aria-expanded`. */
    active?: boolean;
    /** A menu trigger rather than a toggle: reports `aria-expanded` instead. */
    haspopup?: boolean;
    disabled?: boolean;
    className?: string;
    testId?: string;
    children: React.ReactNode;
} & React.HTMLAttributes<HTMLButtonElement> & React.RefAttributes<HTMLButtonElement>>;
