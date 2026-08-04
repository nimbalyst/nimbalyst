import React, { useEffect, useMemo, useState } from 'react';
import { useAtom, useAtomValue } from 'jotai';
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

import {
  ProfileMenuDivider,
  ProfileMenuOrgChip,
  ProfileMenuRow,
  PROFILE_MENU_ROW_CLASS,
} from '../Accounts/profileMenuRows';
import { dialogRef } from '../../contexts/DialogContext';
import { DIALOG_IDS } from '../../dialogs/registry';
import { settingAtom } from '../../store/atoms/settingAtomFamily';
import { teamInboxSnapshotAtom } from '../../store/atoms/teamInbox';
import { connectionSummary } from './orgWindowRailViewModel';

interface AccountInfo {
  personalOrgId: string;
  email: string | null;
  userName?: string;
  isSyncAccount: boolean;
  sessionStatus: 'active' | 'expired';
}

function initialsForIdentity(name: string | null | undefined, email: string | null | undefined): string {
  const source = name?.trim() || email?.trim() || 'User';
  const parts = source.includes('@')
    ? [source.slice(0, 1)]
    : source.split(/\s+/).filter(Boolean).slice(0, 2);
  return parts.map((part) => part.slice(0, 1).toUpperCase()).join('') || 'U';
}

/**
 * The signed-in identity for the organization currently in view.
 *
 * It lives at the bottom of the OrgSidebar — never in the org rail. Identity is
 * per-organization (Stytch gives a different member id per org), and the
 * sidebar is the per-organization pane; the rail is the window-level switcher.
 *
 * Reads the inbox snapshot itself rather than taking it as a prop: it is the
 * only part of the window's chrome that has to repaint on connection and
 * presence changes, and passing it down forced every host above it to
 * re-render on the same traffic.
 *
 * The popover follows the project window's `AccountInspectorPopover` row
 * grammar — settings rows, organization row, account row at the bottom — so the
 * two bottom-left profile menus read the same (NIM-2322). The organization row
 * opens the org-management dialog in *this* window: the sidebar stays purely
 * messaging, so this menu is the only management entry point here. "Account
 * settings" still bounces to the project window because the org window has no
 * settings surface of its own.
 */
export function OrgUserIndicator({
  selectedOrgId,
  selectedTeamMemberId,
  selectedEmail,
  onOpenWebConsole,
  onOpenPreferences,
  placement = 'top-start',
}: {
  selectedOrgId?: string | null;
  selectedTeamMemberId?: string | null;
  selectedEmail: string | null;
  onOpenWebConsole: () => void;
  onOpenPreferences: () => void;
  placement?: 'right-end' | 'top-start';
}) {
  const [open, setOpen] = useState(false);
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [orgName, setOrgName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inboxSnapshot = useAtomValue(teamInboxSnapshotAtom);
  const [desiredPresence, setDesiredPresence] = useAtom(
    settingAtom('team.presence.status'),
  );
  const summary = connectionSummary(inboxSnapshot);
  const ownPresence = selectedOrgId && selectedTeamMemberId
    ? inboxSnapshot.presence?.[selectedOrgId]?.[selectedTeamMemberId] ?? null
    : null;
  const effectivePresence = ownPresence?.status
    ?? (summary.allReady ? desiredPresence : 'offline');
  const account = useMemo(() => {
    return accounts.find((item) => item.email === selectedEmail)
      ?? accounts.find((item) => item.isSyncAccount)
      ?? accounts[0]
      ?? null;
  }, [accounts, selectedEmail]);
  const email = selectedEmail ?? account?.email ?? null;
  const name = account?.userName ?? email?.split('@')[0] ?? 'Signed in';
  const initials = initialsForIdentity(name, email);
  const expired = account?.sessionStatus === 'expired';

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.stytch.getAccounts()
      .then((next: AccountInfo[]) => {
        if (!cancelled) setAccounts(Array.isArray(next) ? next : []);
      })
      .catch(() => {
        if (!cancelled) setAccounts([]);
      });
    return () => { cancelled = true; };
  }, []);

  // The organization row names the org it manages. Resolved here rather than
  // taken as a prop so the menu stays self-contained in both of its hosts;
  // `team:list` is cached in main, so this costs one hit per mount.
  useEffect(() => {
    if (!selectedOrgId) {
      setOrgName(null);
      return;
    }
    let cancelled = false;
    void window.electronAPI.organization.list()
      .then((result: { success?: boolean; teams?: Array<{ orgId: string; name?: string }> }) => {
        if (cancelled) return;
        const match = result?.teams?.find((team) => team.orgId === selectedOrgId);
        setOrgName(match?.name ?? null);
      })
      .catch(() => {
        if (!cancelled) setOrgName(null);
      });
    return () => { cancelled = true; };
  }, [selectedOrgId]);

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement,
    middleware: [offset(8), flip({ padding: 8 }), shift({ padding: 8 }), windowControlsClearance()],
    whileElementsMounted: autoUpdate,
  });
  const { getReferenceProps, getFloatingProps } = useInteractions([
    useClick(context),
    useDismiss(context),
    useRole(context, { role: 'menu' }),
  ]);

  const dotClass = presenceDotClass(effectivePresence);
  const presenceLabel = effectivePresence === 'online'
    ? 'Online'
    : effectivePresence === 'away'
      ? 'Away'
      : 'Offline';
  const connectionLine = `${summary.orgCount} ${summary.orgCount === 1 ? 'org' : 'orgs'} · ${summary.reconnectingCount} reconnecting`;

  return (
    <div
      className="org-user-indicator org-user-indicator-sidebar border-t border-[var(--nim-border)] p-3"
      data-testid="org-user-indicator"
      data-component="OrgUserIndicator"
    >
      <button
        ref={refs.setReference}
        {...getReferenceProps()}
        type="button"
        className="org-user-indicator-button org-window-no-drag flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-[var(--nim-bg-hover)] bg-[var(--nim-bg-secondary)] text-[var(--nim-text)]"
        data-testid="org-user-indicator-button"
        aria-label="Account and connection status"
      >
        <span className="org-user-indicator-avatar relative flex size-8 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--nim-primary)_62%,var(--nim-bg))] text-[11px] font-semibold text-[var(--nim-on-primary)]">
          {initials}
          <span
            className={`org-user-indicator-dot absolute bottom-0 right-0 size-2.5 rounded-full border-2 border-[var(--nim-bg-secondary)] ${dotClass}`}
            aria-hidden="true"
          />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12px] font-medium">{name}</span>
          <span className="block truncate text-[11px] text-[var(--nim-text-muted)]">{connectionLine}</span>
        </span>
      </button>

      {open && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            {...getFloatingProps()}
            className="org-user-popover org-window-no-drag z-[1000] w-[300px] overflow-hidden rounded-lg border border-[var(--nim-border)] bg-[var(--nim-bg)] text-[var(--nim-text)] shadow-2xl"
            data-testid="org-user-popover"
            data-component="OrgUserIndicatorPopover"
          >
            {/* Settings-style rows, matching the project window's popover. */}
            <div className="org-user-popover-actions">
              <ProfileMenuRow
                icon="tune"
                label="Organization Preferences"
                testId="org-user-popover-preferences"
                className="org-user-popover-action"
                onClick={() => {
                  setOpen(false);
                  onOpenPreferences();
                }}
              />
              <ProfileMenuRow
                icon="open_in_new"
                label="Web Console"
                testId="org-user-popover-web-console"
                className="org-user-popover-action"
                onClick={() => {
                  setOpen(false);
                  onOpenWebConsole();
                }}
              />
              <ProfileMenuRow
                icon={desiredPresence === 'away' ? 'check_circle' : 'schedule'}
                label={desiredPresence === 'away' ? 'Set yourself online' : 'Set yourself away'}
                testId="org-user-popover-presence-extension"
                className="org-user-popover-action"
                chevron={false}
                onClick={() => {
                  void setDesiredPresence(
                    desiredPresence === 'away' ? 'online' : 'away',
                  );
                }}
              />
            </div>

            {/* Organization row → the management dialog, opened in this window
                through the shared registry rather than a new OS window. */}
            {selectedOrgId && (
              <>
                <ProfileMenuDivider />
                <button
                  type="button"
                  className={`${PROFILE_MENU_ROW_CLASS} org-user-popover-organization py-2`}
                  data-testid="org-user-popover-organization-row"
                  onClick={() => {
                    setOpen(false);
                    dialogRef.current?.open(DIALOG_IDS.ORG_MANAGEMENT, { orgId: selectedOrgId });
                  }}
                >
                  <ProfileMenuOrgChip name={orgName ?? 'Organization'} />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {orgName ?? 'Organization'}
                  </span>
                  <MaterialSymbol icon="chevron_right" size={18} className="text-[var(--nim-text-faint)]" />
                </button>
              </>
            )}

            <ProfileMenuDivider />

            {/* Account row (bottom). No settings surface exists in this window,
                so it bounces to the project window's Account screen. */}
            <button
              type="button"
              className={`${PROFILE_MENU_ROW_CLASS} org-user-popover-account`}
              data-testid="org-user-popover-account-row"
              onClick={() => {
                setError(null);
                void window.electronAPI.openAccountSettings()
                  .then((result) => {
                    if (!result?.success) setError(result?.error ?? 'Could not open account settings.');
                    else setOpen(false);
                  })
                  .catch((reason) => setError(String(reason)));
              }}
            >
              <span className={`org-user-popover-avatar relative flex size-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${expired ? 'bg-[var(--nim-bg-tertiary)] text-[var(--nim-warning)]' : 'bg-[color-mix(in_srgb,var(--nim-primary)_62%,var(--nim-bg))] text-[var(--nim-on-primary)]'}`}>
                {initials}
                <span
                  className={`org-user-popover-dot absolute bottom-0 right-0 size-2.5 rounded-full border-2 border-[var(--nim-bg)] ${dotClass}`}
                  aria-hidden="true"
                />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[10px] font-semibold uppercase tracking-wide text-[var(--nim-text-faint)]">Account</span>
                <span className="block truncate text-sm font-medium">{email ?? name}</span>
                <span className={`block truncate text-[11px] ${expired ? 'text-[var(--nim-warning)]' : 'text-[var(--nim-text-muted)]'}`}>
                  {expired ? 'Session expired — reconnect' : `${presenceLabel} · ${connectionLine}`}
                </span>
              </span>
              <MaterialSymbol icon="chevron_right" size={18} className="text-[var(--nim-text-faint)]" />
            </button>
            {error && (
              <div className="org-user-popover-error border-t border-[var(--nim-border)] px-3 py-2 text-xs text-[var(--nim-error)]">
                {error}
              </div>
            )}
          </div>
        </FloatingPortal>
      )}
    </div>
  );
}

function presenceDotClass(status: 'online' | 'away' | 'offline'): string {
  if (status === 'online') return 'bg-[var(--nim-success)]';
  if (status === 'away') return 'bg-[var(--nim-warning)]';
  return 'bg-[var(--nim-text-disabled)]';
}
