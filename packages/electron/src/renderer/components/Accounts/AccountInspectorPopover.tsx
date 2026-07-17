import React, { useEffect } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import {
  FloatingPortal,
  autoUpdate,
  flip,
  offset,
  shift,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from '@floating-ui/react';

import type { PersonalAccountSummary } from '../../store/atoms/settingsDomains';

/** The organization the active project belongs to, resolved by the gutter. */
export interface ProjectOrganization {
  orgId: string;
  name: string;
}

interface AccountInspectorPopoverProps {
  accounts: PersonalAccountSummary[];
  /** Organization for the active project, or null when it has none. */
  projectOrg: ProjectOrganization | null;
  anchorEl: HTMLElement | null;
  onClose: () => void;
  /** Open the Account screen (sign-in / account management). */
  onOpenAccount: () => void;
  /** Open the org-management window for an organization (omit orgId to create one). */
  onManageOrganization: (orgId?: string) => void;
}

/** Row height/shape shared by the Account and Organization entries. */
const ROW_CLASS =
  'account-inspector-row flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-[var(--nim-bg-hover)]';

export function AccountInspectorPopover({
  accounts,
  projectOrg,
  anchorEl,
  onClose,
  onOpenAccount,
  onManageOrganization,
}: AccountInspectorPopoverProps) {
  const { refs, floatingStyles, context } = useFloating({
    open: true,
    onOpenChange: (open) => { if (!open) onClose(); },
    placement: 'right-end',
    middleware: [offset(8), flip({ padding: 8 }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: 'menu' });
  const { getFloatingProps } = useInteractions([dismiss, role]);

  useEffect(() => {
    if (anchorEl) refs.setReference(anchorEl);
  }, [anchorEl, refs]);

  // The active account is the sync account (matches the gutter avatar), falling
  // back to the first signed-in account.
  const activeAccount = accounts.find((account) => account.isSyncAccount) ?? accounts[0] ?? null;
  const email = activeAccount?.email ?? activeAccount?.personalOrgId ?? null;
  const expired = activeAccount?.sessionStatus === 'expired';

  return (
    <FloatingPortal>
      <section
        ref={refs.setFloating}
        style={floatingStyles}
        {...getFloatingProps()}
        className="account-inspector-popover z-[10000] w-[300px] overflow-hidden rounded-lg border border-[var(--nim-border)] bg-[var(--nim-bg)] text-[var(--nim-text)] shadow-2xl"
        data-component="AccountInspectorPopover"
        data-testid="account-inspector-popover"
      >
        {/* Account row → Account screen (sign-in / manage). */}
        <button
          type="button"
          className={ROW_CLASS}
          data-testid="account-inspector-account-row"
          onClick={onOpenAccount}
        >
          <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white ${expired ? 'bg-[var(--nim-bg-tertiary)] text-[var(--nim-warning)]' : 'bg-[var(--nim-primary)]'}`}>
            {email ? (email[0] ?? '?').toUpperCase() : <MaterialSymbol icon="person" size={18} />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[10px] font-semibold uppercase tracking-wide text-[var(--nim-text-faint)]">Account</span>
            <span className="block truncate text-sm font-medium">{email ?? 'Sign in'}</span>
            <span className={`block text-[11px] ${expired ? 'text-[var(--nim-warning)]' : 'text-[var(--nim-text-muted)]'}`}>
              {email ? (expired ? 'Session expired — reconnect' : 'Manage account & sign-in') : 'Sign in to sync and collaborate'}
            </span>
          </span>
          <MaterialSymbol icon="chevron_right" size={18} className="text-[var(--nim-text-faint)]" />
        </button>

        <div className="border-t border-[var(--nim-border)]" />

        {/* Organization row → org-management window for the active project's org. */}
        <button
          type="button"
          className={ROW_CLASS}
          data-testid="account-inspector-organization-row"
          onClick={() => onManageOrganization(projectOrg?.orgId)}
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-[#60a5fa] to-[#a78bfa] text-xs font-semibold text-white">
            {projectOrg ? projectOrg.name.slice(0, 2).toUpperCase() : <MaterialSymbol icon="corporate_fare" size={18} />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[10px] font-semibold uppercase tracking-wide text-[var(--nim-text-faint)]">Organization</span>
            <span className="block truncate text-sm font-medium">{projectOrg?.name ?? 'No organization'}</span>
            <span className="block text-[11px] text-[var(--nim-text-muted)]">
              {projectOrg ? 'Manage members, projects & billing' : 'Set up an organization for this project'}
            </span>
          </span>
          <MaterialSymbol icon="chevron_right" size={18} className="text-[var(--nim-text-faint)]" />
        </button>
      </section>
    </FloatingPortal>
  );
}
