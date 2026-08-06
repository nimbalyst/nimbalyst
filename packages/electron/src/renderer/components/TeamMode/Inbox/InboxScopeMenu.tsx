import React from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';

import { FloatingPortal, useFloatingMenu } from '../../../hooks/useFloatingMenu';
import { toggleScopeValue } from './inboxViewModel';
import type { InboxScope, InboxScopeOptions } from './inboxTypes';

/**
 * Org / project scope. Orthogonal to the filter bar: a scope narrows *where*
 * deliveries come from, the filters narrow why they arrived and what kind of
 * thing they point at, and all of them compose.
 *
 * Source type used to live here too. It moved out to visible chips because it
 * is a triage axis, not a scoping one — buried in a menu labelled by its own
 * empty state, nobody knew the Inbox could filter by type at all.
 */
export function InboxScopeMenu({
  scope,
  options,
  disabled,
  onChange,
}: {
  scope: InboxScope;
  options: InboxScopeOptions;
  disabled: boolean;
  onChange: (scope: InboxScope) => void;
}) {
  const menu = useFloatingMenu({ placement: 'bottom-end' });
  // Only the axes this menu owns. The source-kind axis lives in the type chips,
  // so it must not light this trigger up or be swept away by "Reset scope".
  const active = !!(scope.orgIds || scope.projectIds);

  const orgIds = options.orgs.map((org) => org.id);
  const projectIds = options.projects.map((project) => project.id);

  const summary = () => {
    if (!active) return 'All orgs & projects';
    const parts: string[] = [];
    if (scope.orgIds) parts.push(`${scope.orgIds.length} org${scope.orgIds.length === 1 ? '' : 's'}`);
    if (scope.projectIds) parts.push(`${scope.projectIds.length} project${scope.projectIds.length === 1 ? '' : 's'}`);
    return parts.join(', ');
  };

  const renderCheck = (checked: boolean, label: string, onClick: () => void, key: string) => (
    <button
      key={key}
      type="button"
      className="inbox-scope-option flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]"
      onClick={onClick}
    >
      <MaterialSymbol icon={checked ? 'check_box' : 'check_box_outline_blank'} size={16} />
      <span className="truncate">{label}</span>
    </button>
  );

  return (
    <>
      <button
        ref={menu.refs.setReference}
        {...menu.getReferenceProps()}
        type="button"
        disabled={disabled}
        data-testid="inbox-scope-trigger"
        onClick={() => menu.setIsOpen(!menu.isOpen)}
        className={`inbox-scope-trigger org-window-no-drag flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1 text-[12px] ${
          disabled
            ? 'cursor-not-allowed border-[var(--nim-border)] text-[var(--nim-text-disabled)]'
            : active
              ? 'border-[var(--nim-primary)] text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]'
              : 'border-[var(--nim-border)] text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-hover)]'
        }`}
      >
        <MaterialSymbol icon="filter_alt" size={14} />
        <span className="inbox-scope-summary truncate">{summary()}</span>
        <MaterialSymbol icon="expand_more" size={14} />
      </button>

      {menu.isOpen && (
        <FloatingPortal>
          <div
            ref={menu.refs.setFloating}
            style={menu.floatingStyles}
            {...menu.getFloatingProps()}
            className="inbox-scope-menu org-window-no-drag z-[10000] min-w-[240px] overflow-y-auto rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg)] p-1 shadow-[0_4px_12px_rgba(0,0,0,0.15)]"
            data-testid="inbox-scope-menu"
          >
            {options.orgs.length > 1 && (
              <>
                <div className="inbox-scope-section-label px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--nim-text-faint)]">Organization</div>
                {options.orgs.map((org) => renderCheck(
                  !scope.orgIds || scope.orgIds.includes(org.id),
                  org.name,
                  () => onChange({ ...scope, orgIds: toggleScopeValue(scope.orgIds, org.id, orgIds) }),
                  `org-${org.id}`,
                ))}
              </>
            )}

            {options.projects.length > 0 && (
              <>
                <div className="inbox-scope-section-label px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--nim-text-faint)]">Project</div>
                {options.projects.map((project) => renderCheck(
                  !scope.projectIds || scope.projectIds.includes(project.id),
                  project.name,
                  () => onChange({ ...scope, projectIds: toggleScopeValue(scope.projectIds, project.id, projectIds) }),
                  `project-${project.id}`,
                ))}
              </>
            )}

            {active && (
              <>
                <div className="inbox-scope-separator mx-1 my-1 h-px bg-[var(--nim-border)]" />
                <button
                  type="button"
                  className="inbox-scope-reset flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] text-[var(--nim-link)] hover:bg-[var(--nim-bg-hover)]"
                  data-testid="inbox-scope-reset"
                  onClick={() => onChange({ ...scope, orgIds: null, projectIds: null })}
                >
                  <MaterialSymbol icon="restart_alt" size={16} /> Reset scope
                </button>
              </>
            )}
          </div>
        </FloatingPortal>
      )}
    </>
  );
}
