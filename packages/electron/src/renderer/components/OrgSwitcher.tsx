/**
 * OrgSwitcher — the org-level nav element that sits above the project rail
 * (Epic H1). Shows the organization the active workspace belongs to and lets
 * the user see every org they're a member of, jumping to Settings → Org to
 * administer one.
 *
 * Orgs come from the organization directory. Personal sync accounts are never
 * organization entries.
 * The active org is resolved from the active workspace's matched team. This is
 * a 2-level model (Org → Project); "team" is the paid org flavor.
 *
 * Positioning uses @floating-ui/react + FloatingPortal per the project rule —
 * no manual fixed-coordinate math.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import {
  useFloating, offset, flip, shift, autoUpdate,
  FloatingPortal, useClick, useDismiss, useRole, useInteractions,
} from '@floating-ui/react';
import { windowControlsClearance } from '@nimbalyst/runtime/ui/floating/windowControlsClearance';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { activeWorkspacePathAtom } from '../store/atoms/openProjects';
import { organizationCreationEnabled } from '../store/atoms/settingsDomains';
import { dialogRef } from '../contexts/DialogContext';
// The registry/context directly rather than the `dialogs` barrel, which would
// pull every dialog component into this rail element.
import { DIALOG_IDS } from '../dialogs/registry';
import type { AdminTab } from './TeamMode/orgWindowState';
import { teamInboxSnapshotAtom } from '../store/atoms/teamInbox';
import {
  formatUnreadCount,
  selectProjectWindowUnreadSummary,
} from '../store/projectWindowUnreadViewModel';
import './OrgSwitcher.css';

interface OrgEntry {
  orgId: string;
  name: string;
  role: string;
}

const api = () => (window as { electronAPI?: any }).electronAPI;

function initials(name: string): string {
  const words = (name || '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 'O';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

export function OrgSwitcher() {
  const activePath = useAtomValue(activeWorkspacePathAtom);
  const inboxSnapshot = useAtomValue(teamInboxSnapshotAtom);

  const [orgs, setOrgs] = useState<OrgEntry[]>([]);
  const [activeOrgId, setActiveOrgId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [pendingInviteCount, setPendingInviteCount] = useState(0);
  const [pendingOrgId, setPendingOrgId] = useState<string | null>(null);

  const [directoryNonce, setDirectoryNonce] = useState(0);
  // Re-fetch the org directory when another surface mutates it (e.g. a delete
  // or merge in the Danger Zone), so a removed org doesn't linger in the
  // switcher until a manual reload (settings review finding).
  useEffect(() => {
    const onChanged = () => setDirectoryNonce((n) => n + 1);
    window.addEventListener('nimbalyst:organizations-changed', onChanged);
    return () => window.removeEventListener('nimbalyst:organizations-changed', onChanged);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const teamsRes = await api()?.organization?.list();
        const teams: Array<{ orgId: string; name: string; role?: string; membershipType?: string }> =
          teamsRes?.teams || (Array.isArray(teamsRes) ? teamsRes : []);
        const entries: OrgEntry[] = teams
          .filter((team) => !team.membershipType || team.membershipType === 'active_member')
          .map((team) => ({ orgId: team.orgId, name: team.name, role: team.role || 'member' }));
        const pending = teams.filter((team) => team.membershipType && team.membershipType !== 'active_member');
        if (!cancelled) {
          setPendingInviteCount(pending.length);
          setPendingOrgId(pending[0]?.orgId ?? null);
        }
        if (!cancelled) setOrgs(entries);

        if (activePath) {
          const found = await api()?.team?.findForWorkspace(activePath);
          if (!cancelled) setActiveOrgId(found?.team?.orgId ?? null);
        } else if (!cancelled) {
          setActiveOrgId(entries[0]?.orgId ?? null);
        }
      } catch {
        if (!cancelled) {
          setOrgs([]);
          setActiveOrgId(null);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [activePath, directoryNonce]);

  const activeOrg = useMemo(
    () => orgs.find((o) => o.orgId === activeOrgId) ?? orgs[0] ?? null,
    [orgs, activeOrgId],
  );
  const unreadSummary = useMemo(
    () => selectProjectWindowUnreadSummary(inboxSnapshot),
    [inboxSnapshot],
  );
  const unreadByOrg = useMemo(
    () => new Map(unreadSummary.orgs.map((org) => [org.orgId, org.unreadCount])),
    [unreadSummary.orgs],
  );

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: 'right-start',
    middleware: [offset(8), flip({ padding: 8 }), shift({ padding: 8 }), windowControlsClearance()],
    whileElementsMounted: autoUpdate,
  });
  const click = useClick(context);
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: 'menu' });
  const { getReferenceProps, getFloatingProps } = useInteractions([click, dismiss, role]);

  // Only meaningful once collaboration/orgs exist; hide if there's nothing but
  // the personal org and no teams (keeps the rail clean for solo users).
  if (orgs.length === 0 && pendingInviteCount === 0) return null;

  // The rows above the divider are this menu's unread list: they open the
  // organization's messages, which is what the organization window now is.
  const openOrgMessages = (orgId?: string) => {
    setOpen(false);
    const target = orgId ?? activeOrg?.orgId;
    if (!target) return;
    void api()?.team?.openManagementWindow({ orgId: target, workspacePath: activePath ?? undefined });
  };

  // Administration is a dialog in this window rather than a second one
  // (NIM-2322).
  const openOrgManagement = (orgId?: string, initialTab?: AdminTab) => {
    setOpen(false);
    const target = orgId ?? activeOrg?.orgId;
    if (!target) return;
    dialogRef.current?.open(DIALOG_IDS.ORG_MANAGEMENT, { orgId: target, initialTab });
  };

  return (
    <>
      <button
        ref={refs.setReference}
        {...getReferenceProps()}
        className="org-switcher-button w-10 h-10 mx-auto mt-2 mb-1 rounded-lg bg-gradient-to-br from-[#60a5fa] to-[#a78bfa] text-white text-[12px] font-semibold flex items-center justify-center shadow-sm hover:brightness-110 transition"
        data-testid="org-switcher"
        title={activeOrg ? `Organization: ${activeOrg.name}` : 'Organization'}
        aria-label="Switch organization"
      >
        {activeOrg ? initials(activeOrg.name) : <MaterialSymbol icon="corporate_fare" size={18} />}
        {unreadSummary.totalUnread > 0 && (
          <span
            className="org-switcher-unread-badge"
            data-testid="org-switcher-unread-badge"
            aria-label={`${unreadSummary.totalUnread} unread across organizations`}
          >
            {formatUnreadCount(unreadSummary.totalUnread)}
          </span>
        )}
      </button>

      {open && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            {...getFloatingProps()}
            className="org-switcher-menu z-[1000] min-w-[260px] bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded-lg shadow-lg py-1.5"
          >
            <div className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-[var(--nim-text-faint)]">
              Unread messages
            </div>
            {orgs.map((o) => (
              <button
                key={o.orgId}
                className={`org-switcher-item w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-[var(--nim-bg-secondary)] ${o.orgId === activeOrgId ? 'bg-[var(--nim-bg-secondary)]' : ''}`}
                data-testid={`org-switcher-org-row-${o.orgId}`}
                onClick={() => openOrgMessages(o.orgId)}
              >
                <span className="org-switcher-org-avatar w-6 h-6 rounded bg-gradient-to-br from-[#60a5fa] to-[#a78bfa] text-white text-[10px] font-semibold flex items-center justify-center shrink-0">
                  {initials(o.name)}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-[13px] text-[var(--nim-text)] truncate">{o.name}</span>
                  <span className="block text-[10px] text-[var(--nim-text-faint)]">
                    {(unreadByOrg.get(o.orgId) ?? 0) > 0
                      ? `${unreadByOrg.get(o.orgId)} unread`
                      : 'No unread messages'}
                  </span>
                </span>
                {(unreadByOrg.get(o.orgId) ?? 0) > 0 ? (
                  <span className="org-switcher-row-unread-pill">
                    {formatUnreadCount(unreadByOrg.get(o.orgId) ?? 0)}
                  </span>
                ) : (
                  o.orgId === activeOrgId && <MaterialSymbol icon="check" size={14} className="text-[var(--nim-text-muted)]" />
                )}
              </button>
            ))}
            {pendingInviteCount > 0 && (
              <button className="org-switcher-pending-invites w-full px-3 py-2 text-left text-xs text-[var(--nim-link)] hover:bg-[var(--nim-bg-secondary)]" data-testid="org-switcher-pending-invites" onClick={() => {
                setOpen(false);
                // An invitation is acted on in the Members panel, so this lands
                // on that tab rather than the organization's default one.
                if (pendingOrgId) openOrgManagement(pendingOrgId, 'members');
              }}>
                {pendingInviteCount} pending invitation{pendingInviteCount === 1 ? '' : 's'}
              </button>
            )}
            <div className="border-t border-[var(--nim-border)] mt-1 pt-1">
              <button
                className="w-full flex items-center gap-2 px-3 py-2 text-[12px] text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-secondary)]"
                data-testid="org-switcher-manage-organization"
                onClick={() => openOrgManagement()}
              >
                <MaterialSymbol icon="settings" size={14} />
                Manage organization…
              </button>
              {/* Opening the org window untargeted dumped the user on a create
                  card in a window for an organization that does not exist yet.
                  The wizard is the one place an org is created, and it starts
                  in this window. */}
              {organizationCreationEnabled && (
                <button
                  className="org-switcher-new-organization w-full flex items-center gap-2 px-3 py-2 text-[12px] text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-secondary)]"
                  data-testid="org-switcher-new-organization"
                  onClick={() => {
                    setOpen(false);
                    dialogRef.current?.open(DIALOG_IDS.ORG_CREATION_WIZARD, {
                      onOrganizationCreated: () => setDirectoryNonce((nonce) => nonce + 1),
                    });
                  }}
                >
                  <MaterialSymbol icon="add" size={14} />
                  New organization
                </button>
              )}
            </div>
          </div>
        </FloatingPortal>
      )}
    </>
  );
}
