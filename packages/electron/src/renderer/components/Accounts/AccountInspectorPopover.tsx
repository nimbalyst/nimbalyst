import React, { useEffect } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
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
import { windowControlsClearance } from '@nimbalyst/runtime/ui/floating/windowControlsClearance';

import type { PersonalAccountSummary } from '../../store/atoms/settingsDomains';
import { formatUnreadCount } from '../../store/projectWindowUnreadViewModel';

/** The organization the active project belongs to, resolved by the gutter. */
export interface ProjectOrganization {
  orgId: string;
  name: string;
}

interface AccountInspectorPopoverProps {
  accounts: PersonalAccountSummary[];
  /** Organization for the active project, or null when it has none. */
  projectOrg: ProjectOrganization | null;
  /** True while the organization lookup is still in flight. */
  projectOrgLoading?: boolean;
  anchorEl: HTMLElement | null;
  onClose: () => void;
  /** Open the Account screen (sign-in / account management). */
  onOpenAccount: () => void;
  /** Open the org-management window for an organization (omit orgId to create one). */
  onManageOrganization: (orgId?: string) => void;
  /** Unread inbox deliveries in the active project's organization. */
  messagesUnreadCount?: number;
  /** Open the organization inbox (the org window). Only used when there's an org. */
  onOpenMessages?: (orgId: string) => void;
  /** Open the global Application settings. */
  onOpenApplicationSettings: () => void;
  /** Open the current project's settings. */
  onOpenProjectSettings: () => void;
}

/** Row height/shape shared by the settings, Account and Organization entries. */
const ROW_CLASS =
  'account-inspector-row flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-[var(--nim-bg-hover)]';

export function AccountInspectorPopover({
  accounts,
  projectOrg,
  projectOrgLoading = false,
  anchorEl,
  onClose,
  onOpenAccount,
  onManageOrganization,
  onOpenApplicationSettings,
  onOpenProjectSettings,
  messagesUnreadCount = 0,
  onOpenMessages,
}: AccountInspectorPopoverProps) {
  const { refs, floatingStyles, context } = useFloating({
    open: true,
    onOpenChange: (open) => { if (!open) onClose(); },
    placement: 'right-end',
    middleware: [offset(8), flip({ padding: 8 }), shift({ padding: 8 }), windowControlsClearance()],
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
        {/* Settings shortcuts → the Application and Project settings screens. */}
        <button
          type="button"
          className={ROW_CLASS}
          data-testid="account-inspector-application-settings-row"
          onClick={onOpenApplicationSettings}
        >
          <MaterialSymbol icon="settings" size={20} className="shrink-0 text-[var(--nim-text-muted)]" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">Application Settings</span>
          <MaterialSymbol icon="chevron_right" size={18} className="text-[var(--nim-text-faint)]" />
        </button>
        <button
          type="button"
          className={ROW_CLASS}
          data-testid="account-inspector-project-settings-row"
          onClick={onOpenProjectSettings}
        >
          <MaterialSymbol icon="tune" size={20} className="shrink-0 text-[var(--nim-text-muted)]" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">Project Settings</span>
          <MaterialSymbol icon="chevron_right" size={18} className="text-[var(--nim-text-faint)]" />
        </button>

        <div className="border-t border-[var(--nim-border)]" />

        {/* Messages → the organization inbox, which is what the org window is
            since NIM-2322 moved administration into a dialog. Kept separate from
            the Organization row below so administration and messaging stay
            apart, and only shown when there is an org whose inbox to open. */}
        {projectOrg && onOpenMessages && (
          <button
            type="button"
            className={ROW_CLASS}
            data-testid="account-inspector-messages-row"
            aria-label={
              messagesUnreadCount > 0
                ? `Messages, ${messagesUnreadCount} unread`
                : 'Messages'
            }
            onClick={() => onOpenMessages(projectOrg.orgId)}
          >
            <MaterialSymbol icon="forum" size={20} className="shrink-0 text-[var(--nim-text-muted)]" />
            <span className="min-w-0 flex-1 truncate text-sm font-medium">Messages</span>
            {messagesUnreadCount > 0 && (
              <span
                className="shrink-0 rounded-full bg-[var(--nim-error)] px-1.5 text-[10px] font-bold leading-[18px] text-white"
                data-testid="account-inspector-messages-unread"
              >
                {formatUnreadCount(messagesUnreadCount)}
              </span>
            )}
            <MaterialSymbol icon="chevron_right" size={18} className="text-[var(--nim-text-faint)]" />
          </button>
        )}

        {/* Organization row → org-management window for the active project's org.
            A single compact line whether or not the project has an org. An
            unfinished lookup gets its own row: "No organization — Set up" reads
            as an answer, and offering setup to someone who already has an org
            is how a completed sign-up looked like it had failed. */}
        {projectOrgLoading ? (
          <div
            className="account-inspector-row flex w-full items-center gap-3 px-4 py-2 text-left"
            data-testid="account-inspector-organization-loading"
          >
            <MaterialSymbol icon="corporate_fare" size={20} className="shrink-0 text-[var(--nim-text-faint)]" />
            <span className="min-w-0 flex-1 truncate text-sm text-[var(--nim-text-muted)]">Loading organization…</span>
          </div>
        ) : projectOrg ? (
          <button
            type="button"
            className={`${ROW_CLASS} py-2`}
            data-testid="account-inspector-organization-row"
            onClick={() => onManageOrganization(projectOrg.orgId)}
          >
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-gradient-to-br from-[#60a5fa] to-[#a78bfa] text-[10px] font-semibold text-white">
              {projectOrg.name.slice(0, 2).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{projectOrg.name}</span>
            <MaterialSymbol icon="chevron_right" size={18} className="text-[var(--nim-text-faint)]" />
          </button>
        ) : (
          <button
            type="button"
            className={`${ROW_CLASS} py-2`}
            data-testid="account-inspector-organization-row"
            onClick={() => onManageOrganization(undefined)}
          >
            <MaterialSymbol icon="corporate_fare" size={20} className="shrink-0 text-[var(--nim-text-muted)]" />
            <span className="min-w-0 flex-1 truncate text-sm">No organization</span>
            <span className="shrink-0 text-[11px] text-[var(--nim-text-muted)]">Set up</span>
            <MaterialSymbol icon="chevron_right" size={18} className="text-[var(--nim-text-faint)]" />
          </button>
        )}

        <div className="border-t border-[var(--nim-border)]" />

        {/* Account row (bottom) → Account screen (sign-in / manage). */}
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
      </section>
    </FloatingPortal>
  );
}
