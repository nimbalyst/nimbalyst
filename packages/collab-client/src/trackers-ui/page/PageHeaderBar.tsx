/**
 * The header strip of a page in Pages: the same 36px `EditorHeaderBar` every
 * document tab has, so a plain page, a typed page and a type page all read
 * the same at the top. The path on the left opens each page above this one;
 * on the right sit the host's status (sync, presence), History in the same
 * place on every page, and the page's ⋯ menu.
 */
import React from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { globalRegistry } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import { EditorBreadcrumb, EditorHeaderBar, HeaderIconButton, type BreadcrumbCrumb } from '../../ui-primitives/EditorHeaderBar';
import { FloatingPortal, useFloatingMenu } from '../../ui-primitives/useFloatingMenu';
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

const PLAIN_PAGE_ICON = 'description';

/** The icon a page shows in a crumb: its type's for a typed page or a type. */
export function pageAncestorIcon(ancestor: Pick<PageTreeAncestor, 'kind' | 'id' | 'typeId'>): string {
  if (ancestor.kind === 'type') return globalRegistry.get(ancestor.id)?.icon || 'table';
  if (ancestor.kind === 'item') return globalRegistry.get(ancestor.typeId ?? '')?.icon || PLAIN_PAGE_ICON;
  return PLAIN_PAGE_ICON;
}

const crumbIcon = (icon: string) => (
  <span aria-hidden="true" className="flex shrink-0">
    <MaterialSymbol icon={icon} size={14} className="breadcrumb-icon opacity-70" />
  </span>
);

export function pageHeaderCrumbs(
  section: string | null | undefined,
  path: readonly PageTreeAncestor[],
  title: string,
  onOpenAncestor?: (ancestor: PageTreeAncestor) => void,
  titleIcon: string = PLAIN_PAGE_ICON,
): BreadcrumbCrumb[] {
  return [
    ...(section ? [{ id: 'section', label: section }] : []),
    ...path.map((ancestor) => ({
      id: `${ancestor.kind}:${ancestor.id}`,
      label: ancestor.name,
      icon: crumbIcon(pageAncestorIcon(ancestor)),
      onClick: onOpenAncestor ? () => onOpenAncestor(ancestor) : undefined,
    })),
    { id: 'current', label: title.trim() || 'Untitled', current: true, icon: crumbIcon(titleIcon) },
  ];
}

export const PageHeaderBar: React.FC<PageHeaderBarProps> = ({
  section,
  path,
  title,
  titleIcon,
  onOpenAncestor,
  status,
  actions,
  onShowHistory,
  menuItems,
  testId = 'page-header-bar',
}) => {
  const menu = useFloatingMenu({ placement: 'bottom-end' });
  const hasMenu = (menuItems?.length ?? 0) > 0;
  return (
    <EditorHeaderBar
      testId={testId}
      className="page-header-bar"
      breadcrumb={<EditorBreadcrumb crumbs={pageHeaderCrumbs(section, path, title, onOpenAncestor, titleIcon)} />}
      actions={(
        <>
          {status}
          {actions}
          {onShowHistory && (
            <HeaderIconButton label="Page history" onClick={onShowHistory} testId="page-history-button">
              <MaterialSymbol icon="history" size={16} />
            </HeaderIconButton>
          )}
          {hasMenu && (
            <>
              <HeaderIconButton
                ref={menu.refs.setReference}
                label="More actions"
                haspopup
                active={menu.isOpen}
                onClick={() => menu.setIsOpen(!menu.isOpen)}
                testId="page-header-more"
                {...menu.getReferenceProps()}
              >
                <MaterialSymbol icon="more_horiz" size={16} />
              </HeaderIconButton>
              {menu.isOpen && (
                <FloatingPortal>
                  <div
                    ref={menu.refs.setFloating}
                    style={menu.floatingStyles}
                    className="page-header-menu z-[1000] min-w-[200px] rounded-md border border-nim bg-nim py-1 shadow-[0_4px_12px_rgba(0,0,0,0.3)]"
                    {...menu.getFloatingProps()}
                  >
                    {menuItems!.map((item, index) => (
                      <React.Fragment key={item.id}>
                      {item.dividerBefore && index > 0 && <div className="page-header-menu-divider my-1 h-px bg-[var(--nim-border)]" />}
                      <button
                        type="button"
                        role="menuitem"
                        className={`page-header-menu-item flex w-full cursor-pointer items-center gap-2.5 border-none bg-transparent px-3 py-2 text-left text-[13px] hover:bg-nim-hover ${item.destructive ? 'text-[var(--nim-error)]' : 'text-nim'}`}
                        data-testid={`page-header-menu-${item.id}`}
                        onClick={() => {
                          menu.setIsOpen(false);
                          item.onSelect();
                        }}
                      >
                        <MaterialSymbol icon={item.icon} size={16} className="opacity-70" />
                        {item.label}
                      </button>
                      </React.Fragment>
                    ))}
                  </div>
                </FloatingPortal>
              )}
            </>
          )}
        </>
      )}
    />
  );
};
