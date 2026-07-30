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
import { MaterialSymbol } from '@nimbalyst/runtime';

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

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement,
    middleware: [offset(8), flip({ padding: 8 }), shift({ padding: 8 })],
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
            className="org-user-popover org-window-no-drag z-[1000] w-[270px] overflow-hidden rounded-lg border border-[var(--nim-border)] bg-[var(--nim-bg)] shadow-lg"
            data-testid="org-user-popover"
            data-component="OrgUserIndicatorPopover"
          >
            <div className="org-user-popover-identity flex items-center gap-2.5 border-b border-[var(--nim-border)] px-3 py-3">
              <span className="relative flex size-9 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--nim-primary)_62%,var(--nim-bg))] text-xs font-semibold text-[var(--nim-on-primary)]">
                {initials}
                <span className={`absolute bottom-0 right-0 size-2.5 rounded-full border-2 border-[var(--nim-bg)] ${dotClass}`} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-[var(--nim-text)]">{name}</span>
                <span className="block truncate text-xs text-[var(--nim-text-muted)]">{email ?? 'No email available'}</span>
              </span>
            </div>
            <div className="org-user-popover-status flex items-center gap-2 border-b border-[var(--nim-border)] px-3 py-2 text-xs text-[var(--nim-text-muted)]">
              <span className={`size-2 rounded-full ${dotClass}`} />
              <span className="min-w-0 flex-1 truncate">{presenceLabel}</span>
              <span className="shrink-0">{connectionLine}</span>
            </div>
            <div className="org-user-popover-actions py-1">
              <button
                type="button"
                className="org-user-popover-action flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]"
                data-testid="org-user-popover-preferences"
                onClick={() => {
                  setOpen(false);
                  onOpenPreferences();
                }}
              >
                <MaterialSymbol icon="tune" size={15} />
                <span className="min-w-0 flex-1 truncate">Preferences…</span>
              </button>
              <button
                type="button"
                className="org-user-popover-action flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]"
                data-testid="org-user-popover-web-console"
                onClick={() => {
                  setOpen(false);
                  onOpenWebConsole();
                }}
              >
                <MaterialSymbol icon="open_in_new" size={15} />
                <span className="min-w-0 flex-1 truncate">Open web console</span>
              </button>
              <button
                type="button"
                className="org-user-popover-action flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]"
                data-testid="org-user-popover-manage-accounts"
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
                <MaterialSymbol icon="manage_accounts" size={15} />
                <span className="min-w-0 flex-1 truncate">Manage accounts…</span>
              </button>
              <button
                type="button"
                className="org-user-popover-action flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]"
                data-testid="org-user-popover-presence-extension"
                onClick={() => {
                  void setDesiredPresence(
                    desiredPresence === 'away' ? 'online' : 'away',
                  );
                }}
              >
                <MaterialSymbol
                  icon={desiredPresence === 'away' ? 'check_circle' : 'schedule'}
                  size={15}
                />
                <span className="min-w-0 flex-1 truncate">
                  {desiredPresence === 'away'
                    ? 'Set yourself online'
                    : 'Set yourself away'}
                </span>
              </button>
            </div>
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
