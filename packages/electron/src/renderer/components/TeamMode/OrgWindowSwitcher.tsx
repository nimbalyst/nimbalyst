/**
 * Organization switcher at the top of the org window's left nav.
 *
 * Lists every ACTIVE membership across all signed-in logins (pending invites are
 * excluded — they cannot be administered). Selecting one just moves
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
import { MaterialSymbol } from '@nimbalyst/runtime';

import { activeOrganizations, type OrgChoice } from './defaultOrg';

export function OrgWindowSwitcher({
  organizations,
  selectedOrgId,
  onSelect,
}: {
  organizations: OrgChoice[];
  selectedOrgId: string | null;
  onSelect: (orgId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const choices = activeOrganizations(organizations);
  const selected = choices.find((organization) => organization.orgId === selectedOrgId);

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: 'bottom-start',
    middleware: [offset(4), flip({ padding: 8 }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });
  const { getReferenceProps, getFloatingProps } = useInteractions([
    useClick(context),
    useDismiss(context),
    useRole(context, { role: 'menu' }),
  ]);

  // Nothing to switch to: no orgs at all, or the only one is already open.
  // (With no org selected, a single choice is still worth offering — that is
  // the escape hatch from the unbound surface.)
  if (choices.length === 0) return null;
  if (choices.length === 1 && choices[0].orgId === selectedOrgId) return null;

  return (
    <div className="org-window-switcher mb-2" data-testid="org-window-switcher">
      <button
        ref={refs.setReference}
        {...getReferenceProps()}
        type="button"
        className="org-window-switcher-button flex w-full items-center gap-2 rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] px-2.5 py-2 text-left text-sm hover:bg-[var(--nim-bg-hover)]"
        data-testid="org-window-switcher-button"
      >
        <span className="min-w-0 flex-1 truncate text-[var(--nim-text)]">
          {selected?.name ?? 'Select organization'}
        </span>
        <MaterialSymbol icon="unfold_more" size={16} className="shrink-0 text-[var(--nim-text-muted)]" />
      </button>

      {open && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            {...getFloatingProps()}
            className="org-window-switcher-menu z-[1000] min-w-[220px] rounded-lg border border-[var(--nim-border)] bg-[var(--nim-bg)] py-1 shadow-lg"
            data-testid="org-window-switcher-menu"
          >
            {choices.map((organization) => (
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
          </div>
        </FloatingPortal>
      )}
    </div>
  );
}
