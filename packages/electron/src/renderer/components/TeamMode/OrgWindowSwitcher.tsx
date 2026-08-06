/**
 * Organization identity and switcher at the top of the org window's left nav.
 *
 * This row *is* the window's org header (2026-07-28 layout decision): the org
 * avatar, name and alpha chip live here rather than in a band above the
 * sidebar/content split, and the menu carries both the org switch and the
 * "Open web console" escape hatch that band used to hold.
 *
 * The menu lists every ACTIVE membership across all signed-in logins (pending
 * invites are excluded — they cannot be administered). Selecting one just moves
 * `selectedOrgIdAtom`; the window retargets from that atom and `getOrgScopedJwt`
 * resolves the owning account per org, so nothing here touches auth.
 */

import React, { useState } from 'react';
import {
  FloatingPortal,
  autoUpdate,
  flip,
  offset,
  shift,
  useClick,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from '@floating-ui/react';
import { windowControlsClearance } from '@nimbalyst/runtime/ui/floating/windowControlsClearance';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';

import { AlphaBadge } from '../common/AlphaBadge';
import { TEAM_ALPHA_TOOLTIP } from '../common/TeamAlphaNotice';
import { activeOrganizations, type OrgChoice } from './defaultOrg';

export function OrgWindowSwitcher({
  organizations,
  selectedOrgId,
  selectedOrgName,
  onSelect,
  onOpenWebConsole,
}: {
  organizations: OrgChoice[];
  selectedOrgId: string | null;
  /**
   * The name of the organization this window is bound to. Preferred over the
   * directory entry so a rename shows immediately, and so an org resolved from
   * the workspace still has an identity when the directory has not listed it.
   */
  selectedOrgName?: string | null;
  onSelect: (orgId: string) => void;
  /** Absent on surfaces with no bound organization to open a console for. */
  onOpenWebConsole?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const choices = activeOrganizations(organizations);
  const selected = choices.find((organization) => organization.orgId === selectedOrgId);
  const name = selectedOrgName?.trim() || selected?.name?.trim() || '';

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: 'bottom-start',
    middleware: [offset(4), flip({ padding: 8 }), shift({ padding: 8 }), windowControlsClearance()],
    whileElementsMounted: autoUpdate,
  });
  const { getReferenceProps, getFloatingProps } = useInteractions([
    useClick(context),
    useDismiss(context),
    useRole(context, { role: 'menu' }),
  ]);

  // Nothing to identify and nothing to switch to. (With no org bound, a single
  // choice is still worth offering — that is the escape hatch from the unbound
  // surface.)
  if (!name && choices.length === 0) return null;

  const switchable = choices.filter(
    (organization) => organization.orgId !== selectedOrgId,
  ).length > 0 || !selectedOrgId;

  return (
    <div className="org-window-switcher mb-2" data-testid="org-window-switcher">
      <button
        ref={refs.setReference}
        {...getReferenceProps()}
        type="button"
        className="org-window-switcher-button flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-[var(--nim-bg-hover)]"
        data-testid="org-window-switcher-button"
        aria-label={name ? `Organization: ${name}` : 'Select organization'}
      >
        {name && (
          <span
            className="org-window-switcher-avatar flex size-7 shrink-0 items-center justify-center rounded-lg bg-[var(--nim-primary)] text-[11px] font-semibold text-[var(--nim-on-primary)]"
            aria-hidden="true"
          >
            {name.slice(0, 2).toUpperCase()}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="org-window-switcher-name block truncate text-[13px] font-semibold text-[var(--nim-text)]">
            {name || 'Select organization'}
          </span>
        </span>
        {name && <AlphaBadge size="xs" tooltip={TEAM_ALPHA_TOOLTIP} />}
        <MaterialSymbol icon="unfold_more" size={16} className="shrink-0 text-[var(--nim-text-muted)]" />
      </button>

      {open && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            {...getFloatingProps()}
            className="org-window-switcher-menu z-[1000] min-w-[240px] rounded-lg border border-[var(--nim-border)] bg-[var(--nim-bg)] py-1 shadow-lg"
            data-testid="org-window-switcher-menu"
          >
            {switchable && choices.map((organization) => (
              <button
                key={organization.orgId}
                type="button"
                onClick={() => {
                  setOpen(false);
                  if (organization.orgId !== selectedOrgId) onSelect(organization.orgId);
                }}
                className={`org-window-switcher-item flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[var(--nim-bg-secondary)] ${
                  organization.orgId === selectedOrgId ? 'bg-[var(--nim-bg-secondary)]' : ''
                }`}
                data-testid="org-window-switcher-item"
                data-org-id={organization.orgId}
              >
                <span className="min-w-0 flex-1 truncate text-[var(--nim-text)]">{organization.name}</span>
                {organization.role && (
                  <span className="shrink-0 rounded-full bg-[var(--nim-bg-tertiary)] px-1.5 py-0.5 text-[10px] font-semibold capitalize text-[var(--nim-text-muted)]">
                    {organization.role}
                  </span>
                )}
                {organization.orgId === selectedOrgId && (
                  <MaterialSymbol icon="check" size={14} className="shrink-0 text-[var(--nim-text-muted)]" />
                )}
              </button>
            ))}
            {onOpenWebConsole && (
              <>
                {switchable && choices.length > 0 && (
                  <div className="org-window-switcher-separator my-1 border-t border-[var(--nim-border)]" />
                )}
                <button
                  type="button"
                  className="org-window-switcher-console flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-[var(--nim-text)] hover:bg-[var(--nim-bg-secondary)]"
                  data-testid="org-window-switcher-console"
                  onClick={() => {
                    setOpen(false);
                    onOpenWebConsole();
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">Open web console</span>
                  <MaterialSymbol icon="open_in_new" size={14} className="shrink-0 text-[var(--nim-text-muted)]" />
                </button>
              </>
            )}
          </div>
        </FloatingPortal>
      )}
    </div>
  );
}
