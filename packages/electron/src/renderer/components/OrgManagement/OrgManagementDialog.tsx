import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';

import { useOrgRoster } from '../../hooks/useOrgRoster';
import {
  isOrgAdminRole,
  visibleAdminTabs,
} from '../TeamMode/orgSidebarViewModel';
import type { AdminTab } from '../TeamMode/orgWindowState';
import { OrganizationBillingPanel } from '../Settings/panels/OrganizationBillingPanel';
import { OrganizationDangerZone } from '../Settings/panels/OrganizationDangerZone';
import { OrganizationMembersRolesPanel } from '../Settings/panels/OrganizationMembersRolesPanel';
import { OrganizationProjectsPanel } from '../Settings/panels/OrganizationProjectsPanel';
import { OrganizationSettingsPanel } from '../Settings/panels/OrganizationSettingsPanel';
import { ProjectSharingPanel } from '../Settings/panels/ProjectSharingPanel';

interface OrgIdentity {
  name: string | null;
  /** The account this organization is billed to / owned by. */
  boundEmail: string | null;
}

const UNRESOLVED_IDENTITY: OrgIdentity = { name: null, boundEmail: null };

/**
 * The organization's name and owning account.
 *
 * The organization window carries these down from its own directory read; a
 * dialog has no such host, so it reads the same two sources itself. `team:list`
 * is cached in main, so this is cheap enough to run per open.
 */
function useOrgIdentity(orgId: string): OrgIdentity {
  const [identity, setIdentity] = useState<OrgIdentity>(UNRESOLVED_IDENTITY);

  useEffect(() => {
    let cancelled = false;
    setIdentity(UNRESOLVED_IDENTITY);
    void Promise.all([
      window.electronAPI?.organization?.list?.(),
      window.electronAPI?.stytch?.getAccounts?.(),
    ]).then(([directory, accounts]) => {
      if (cancelled) return;
      const organizations = directory?.success && Array.isArray(directory.teams)
        ? directory.teams
        : [];
      const organization = organizations.find(
        (candidate: { orgId?: string }) => candidate.orgId === orgId,
      );
      if (!organization) return;
      const personalOrgId = organization.boundPersonalOrgId
        ?? organization.owningPersonalOrgId;
      const accountRows = Array.isArray(accounts) ? accounts : [];
      setIdentity({
        name: organization.name ?? null,
        boundEmail: accountRows.find(
          (account: { personalOrgId?: string | null }) =>
            account.personalOrgId === personalOrgId,
        )?.email ?? organization.sourceEmail ?? null,
      });
    }).catch(() => {
      // The panels below all read their own data and state their own errors;
      // an unresolved name is a missing subtitle, not a broken dialog.
    });
    return () => { cancelled = true; };
  }, [orgId]);

  return identity;
}

/**
 * Organization administration, in whichever window you already have open.
 *
 * Greg, 2026-07-31 (NIM-2322): "I think I also want to move org management into
 * a popup dialog that can run in the project window. It's just killing me,
 * starting new windows for this." The five panels, the tab list and the role
 * gating are the organization window's, unchanged — this is a second host for
 * them, not a second implementation, so the two surfaces cannot drift.
 */
export function OrgManagementDialog({
  isOpen,
  onClose,
  orgId,
  initialTab = 'members',
}: {
  isOpen: boolean;
  onClose: () => void;
  orgId: string;
  initialTab?: AdminTab;
}) {
  const roster = useOrgRoster(orgId);
  const identity = useOrgIdentity(orgId);
  const [renamedTo, setRenamedTo] = useState<string | null>(null);
  const [requestedTab, setRequestedTab] = useState<AdminTab>(initialTab);
  // Which organization project's access editor is open inside Projects, if any.
  const [accessProjectId, setAccessProjectId] = useState<string | null>(null);

  // Re-opening the dialog at another tab must land there, and another
  // organization is a different roster, name and project list entirely.
  useEffect(() => { setRequestedTab(initialTab); }, [initialTab, orgId]);
  useEffect(() => {
    setAccessProjectId(null);
    setRenamedTo(null);
  }, [orgId]);

  const isOrgAdmin = isOrgAdminRole(roster.callerRole);
  const tabs = useMemo(() => visibleAdminTabs(isOrgAdmin), [isOrgAdmin]);
  // Only once the roster resolved a role for *this* organization. While it is
  // unresolved — still loading, or a read that failed — an admin-only tab is
  // neither rendered nor redirected away from: guessing either way would show a
  // member the Danger zone or bounce an admin off their own Billing panel.
  const rosterResolved = !roster.loading && roster.callerRole !== null;
  const allowedTab = tabs.some((tab) => tab.id === requestedTab)
    ? requestedTab
    : rosterResolved
      ? tabs[0]?.id ?? null
      : null;

  const selectTab = useCallback((tab: AdminTab) => {
    setRequestedTab(tab);
    // The drill-down belongs to Projects; leaving and coming back lands on the
    // project list rather than on whichever project was last inspected.
    setAccessProjectId(null);
  }, []);

  if (!isOpen) return null;

  const orgName = renamedTo ?? identity.name;

  return (
    <div
      className="org-management-dialog-overlay fixed inset-0 z-[10000] flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      {/* `text-[var(--nim-text)]` is load-bearing, not decoration: `body` sets
          no colour, so each window root supplies one (the organization window's
          does). These panels were written under that root, so without it every
          heading and label that inherits rather than naming a colour renders
          black on a dark surface. */}
      <div
        className="org-management-dialog flex h-[80vh] max-h-[800px] w-[90vw] max-w-[1200px] flex-col overflow-hidden rounded-xl border border-[var(--nim-border)] bg-[var(--nim-bg)] text-[var(--nim-text)] shadow-[0_20px_60px_rgba(0,0,0,0.3)]"
        data-testid="org-management-dialog"
        data-component="OrgManagementDialog"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="org-management-dialog-header flex items-center justify-between border-b border-[var(--nim-border)] px-4 py-3">
          <div className="org-management-dialog-title flex min-w-0 flex-1 flex-col gap-0.5">
            <h2 className="m-0 overflow-hidden text-ellipsis whitespace-nowrap text-base font-semibold text-[var(--nim-text)]">
              {orgName ? `${orgName} · Organization` : 'Organization'}
            </h2>
            {identity.boundEmail && (
              <span className="org-management-dialog-account overflow-hidden text-ellipsis whitespace-nowrap text-[11px] text-[var(--nim-text-muted)]">
                {identity.boundEmail}
              </span>
            )}
          </div>
          <button
            type="button"
            className="org-management-dialog-close nim-btn-icon"
            aria-label="Close"
            data-testid="org-management-dialog-close"
            onClick={onClose}
          >
            <MaterialSymbol icon="close" size={20} />
          </button>
        </div>

        <div className="org-management-dialog-body flex min-h-0 flex-1">
          {/* Styled as `.settings-sidebar` is, down to the row states: this is
              the same kind of surface, and `--nim-bg-secondary` is *darker*
              than `--nim-bg` in the dark themes — a column painted with it
              reads as a black band beside the panels rather than as a nav. */}
          <nav
            className="org-management-dialog-tabs w-[200px] shrink-0 overflow-y-auto border-r border-[var(--nim-border)] bg-[var(--nim-bg)] p-3"
            data-testid="org-management-dialog-tabs"
          >
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={`org-management-tab org-management-tab-${tab.id} flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors ${
                  allowedTab === tab.id
                    ? 'bg-[var(--nim-bg-selected)] text-[var(--nim-text)]'
                    : 'bg-transparent text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)]'
                }`}
                data-testid={`org-management-tab-${tab.id}`}
                aria-current={allowedTab === tab.id ? 'page' : undefined}
                onClick={() => selectTab(tab.id)}
              >
                <span className="org-management-tab-icon flex size-5 shrink-0 items-center justify-center text-[var(--nim-text-muted)]">
                  <MaterialSymbol icon={tab.icon} size={16} />
                </span>
                <span className="min-w-0 flex-1 truncate">{tab.label}</span>
              </button>
            ))}
          </nav>

          <main
            className="org-management-dialog-content min-w-0 flex-1 overflow-y-auto p-6"
            data-testid="org-management-dialog-content"
          >
            {/* The same `max-w-[900px]` column the organization window reads
                these panels in, so a wider dialog does not stretch their forms
                across the whole screen. */}
            <div className="mx-auto max-w-[900px]">
              {allowedTab === null && (
                <p
                  className="org-management-dialog-resolving m-0 text-sm text-[var(--nim-text-muted)]"
                  data-testid="org-management-dialog-resolving"
                >
                  Loading organization…
                </p>
              )}
              {allowedTab === 'members' && (
                <OrganizationMembersRolesPanel
                  orgId={orgId}
                  allowOrganizationCreation={false}
                />
              )}
              {allowedTab === 'projects' && (
                accessProjectId
                  ? (
                    <div className="org-management-project-access">
                      <button
                        type="button"
                        className="org-management-project-access-back mb-4 flex items-center gap-1.5 text-xs text-[var(--nim-link)]"
                        data-testid="org-management-project-access-back"
                        onClick={() => setAccessProjectId(null)}
                      >
                        <MaterialSymbol icon="arrow_back" size={14} /> All projects
                      </button>
                      <ProjectSharingPanel
                        target={{
                          kind: 'organizationProject',
                          orgId,
                          projectId: accessProjectId,
                        }}
                      />
                    </div>
                  )
                  : (
                    <OrganizationProjectsPanel
                      orgId={orgId}
                      onManageAccess={(_orgId, projectId) => setAccessProjectId(projectId)}
                    />
                  )
              )}
              {allowedTab === 'settings' && (
                <OrganizationSettingsPanel
                  orgId={orgId}
                  orgName={orgName}
                  ownerEmail={identity.boundEmail}
                  callerRole={roster.callerRole}
                  onRenamed={setRenamedTo}
                />
              )}
              {allowedTab === 'billing' && <OrganizationBillingPanel />}
              {allowedTab === 'danger' && <OrganizationDangerZone orgId={orgId} />}
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
