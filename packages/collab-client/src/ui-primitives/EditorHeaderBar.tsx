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

export function EditorHeaderBar({
  breadcrumb,
  actions,
  className,
  testId,
}: {
  /** The left side. Usually `<EditorBreadcrumb>`; anything is allowed. */
  breadcrumb: React.ReactNode;
  /** The right side. Omitted entirely rather than rendered empty. */
  actions?: React.ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <header
      className={`unified-editor-header-bar flex h-9 min-h-9 shrink-0 items-center justify-between gap-3 border-b border-nim bg-nim px-3 ${className ?? ''}`}
      data-testid={testId}
    >
      {breadcrumb}
      {actions ? (
        // A sibling of the breadcrumb rather than a trailing crumb: the crumbs
        // ellipsize under pressure and the actions must not be what gets clipped.
        <div className="unified-header-actions flex shrink-0 items-center gap-1">{actions}</div>
      ) : null}
    </header>
  );
}

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
export function EditorBreadcrumb({
  crumbs,
  leading,
  className,
}: {
  crumbs: readonly BreadcrumbCrumb[];
  /** Rendered before the first crumb -- a tree-reveal toggle, typically. */
  leading?: React.ReactNode;
  className?: string;
}) {
  return (
    <nav
      className={`unified-header-breadcrumb flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden whitespace-nowrap text-[13px] text-nim-muted ${className ?? ''}`}
      aria-label="Breadcrumb"
    >
      {leading}
      {crumbs.map((crumb, index) => (
        <React.Fragment key={crumb.id}>
          {index > 0 ? (
            <span className="breadcrumb-separator shrink-0 text-[11px] text-nim-faint" aria-hidden="true">/</span>
          ) : null}
          {crumb.onClick ? (
            <button
              type="button"
              className="breadcrumb-segment breadcrumb-clickable -mx-1 -my-0.5 flex min-w-0 cursor-pointer items-center gap-1 overflow-hidden rounded border-none bg-transparent px-1 py-0.5 text-inherit transition-colors duration-150 hover:bg-nim-hover hover:text-nim"
              onClick={crumb.onClick}
              title={crumb.title ?? crumb.label}
            >
              {crumb.icon}
              <span className="min-w-0 overflow-hidden text-ellipsis">{crumb.label}</span>
            </button>
          ) : (
            <span
              className={`breadcrumb-segment flex min-w-0 items-center gap-1 overflow-hidden ${crumb.current ? 'breadcrumb-current font-semibold text-nim' : ''}`}
              title={crumb.title ?? crumb.label}
              aria-current={crumb.current ? 'page' : undefined}
            >
              {crumb.icon}
              <span className="min-w-0 overflow-hidden text-ellipsis">{crumb.label}</span>
            </span>
          )}
        </React.Fragment>
      ))}
    </nav>
  );
}

/**
 * The icon button in a header's action cluster, and in the pane headers that
 * flank it. Desktop's `unified-header-button` shape, named once.
 */
export const HeaderIconButton = React.forwardRef<
  HTMLButtonElement,
  {
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
  } & React.HTMLAttributes<HTMLButtonElement>
>(function HeaderIconButton(
  { label, onClick, active, haspopup, disabled, className, testId, children, ...rest },
  ref,
) {
  return (
    <button
      {...rest}
      ref={ref}
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-haspopup={haspopup ? 'menu' : undefined}
      aria-expanded={haspopup ? Boolean(active) : undefined}
      aria-pressed={!haspopup && active !== undefined ? active : undefined}
      data-testid={testId}
      className={`unified-header-button flex size-7 shrink-0 cursor-pointer items-center justify-center rounded border-none bg-transparent text-nim-muted transition-colors duration-150 hover:bg-nim-hover hover:text-nim disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent ${active ? 'bg-nim-tertiary text-nim' : ''} ${className ?? ''}`}
    >
      {children}
    </button>
  );
});
