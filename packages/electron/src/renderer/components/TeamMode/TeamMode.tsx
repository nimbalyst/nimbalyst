import React, { useEffect, useState } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { useAtomValue } from 'jotai';

import { OrganizationBillingPanel } from '../Settings/panels/OrganizationBillingPanel';
import { OrganizationDangerZone } from '../Settings/panels/OrganizationDangerZone';
import { OrganizationMembersRolesPanel } from '../Settings/panels/OrganizationMembersRolesPanel';
import { OrganizationProjectsPanel } from '../Settings/panels/OrganizationProjectsPanel';
import { ProjectSharingPanel } from '../Settings/panels/ProjectSharingPanel';
import { selectedOrgIdAtom } from '../../store/atoms/orgScope';

// Workstream F will replace this interim destination with the shipped console route.
export const TEAM_CONSOLE_URL = 'https://console.nimbalyst.com';

type AdminTab = 'members' | 'projects' | 'billing' | 'danger';

const ADMIN_TABS: Array<{ id: AdminTab; label: string; icon: string }> = [
  { id: 'members', label: 'Members', icon: 'groups' },
  { id: 'projects', label: 'Projects', icon: 'folder' },
  { id: 'billing', label: 'Billing', icon: 'credit_card' },
  { id: 'danger', label: 'Danger zone', icon: 'warning' },
];

interface TeamSummary {
  orgId: string;
  name: string;
  boundPersonalOrgId?: string;
  sourceEmail?: string | null;
  owningPersonalOrgId?: string | null;
  membershipType?: string;
}

export function TeamMode({ workspacePath, isActive = true }: { workspacePath?: string; isActive?: boolean }) {
  const selectedOrgId = useAtomValue(selectedOrgIdAtom);
  const [team, setTeam] = useState<TeamSummary | null>(null);
  const [boundEmail, setBoundEmail] = useState<string | null>(null);
  const [tab, setTab] = useState<AdminTab>('members');
  // Which org project's access editor is open inside the Projects tab, if any.
  const [accessProjectId, setAccessProjectId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isActive) return;
    setLoading(true);
    let cancelled = false;
    void Promise.all([
      // Only the workspace-hosted surface falls back to the workspace's team.
      // The standalone org window always targets an explicitly selected org.
      workspacePath
        ? window.electronAPI.team.findForWorkspace(workspacePath)
        : Promise.resolve(null),
      window.electronAPI.stytch.getAccounts(),
      selectedOrgId
        ? window.electronAPI.organization.list()
        : Promise.resolve(null),
    ]).then(([result, accounts, directory]) => {
      if (cancelled) return;
      const workspaceTeam = result?.team ?? result ?? null;
      const organizations: TeamSummary[] = directory?.success && Array.isArray(directory.teams)
        ? directory.teams
        : [];
      const selectedTeam = selectedOrgId
        ? organizations.find((organization) =>
          organization.orgId === selectedOrgId
          && (!organization.membershipType || organization.membershipType === 'active_member')) ?? null
        : null;
      const found = selectedOrgId ? selectedTeam : workspaceTeam;
      setTeam(found?.orgId ? found : null);
      const personalOrgId = found?.boundPersonalOrgId ?? found?.owningPersonalOrgId;
      setBoundEmail(accounts.find((account) => account.personalOrgId === personalOrgId)?.email ?? found?.sourceEmail ?? null);
      setLoading(false);
    }).catch(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [isActive, selectedOrgId, workspacePath]);

  // Reset the per-project access editor whenever the org or tab changes.
  useEffect(() => { setAccessProjectId(null); }, [team?.orgId, tab]);

  if (loading) {
    return <div className="team-mode-loading flex flex-1 items-center justify-center text-sm text-[var(--nim-text-muted)]">Loading organization…</div>;
  }

  // No org resolved: offer to create one (or accept a pending invite).
  if (!team) {
    return (
      <section className="team-mode team-mode-unbound flex h-full flex-col overflow-hidden" data-component="TeamMode">
        <header className="team-mode-header border-b border-[var(--nim-border)] px-6 py-5">
          <h1 className="m-0 text-xl font-semibold text-[var(--nim-text)]">Organizations</h1>
          <p className="m-0 mt-1 text-sm text-[var(--nim-text-muted)]">Create an organization to collaborate with a team, or accept a pending invitation.</p>
        </header>
        <main className="team-mode-content flex-1 overflow-y-auto p-6">
          <div className="mx-auto max-w-[900px]"><OrganizationMembersRolesPanel orgId="" /></div>
        </main>
      </section>
    );
  }

  return (
    <section className="team-mode flex h-full flex-col overflow-hidden" data-testid="team-mode" data-component="TeamMode">
      <header className="team-mode-header flex items-center gap-4 border-b border-[var(--nim-border)] px-6 py-4">
        <div className="team-mode-avatar flex size-11 shrink-0 items-center justify-center rounded-xl bg-[var(--nim-primary)] text-base font-semibold text-[var(--nim-on-primary)]">
          {team.name.slice(0, 2).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1 select-text">
          <p className="m-0 text-[11px] font-semibold uppercase tracking-wide text-[var(--nim-text-faint)]">Administer organization</p>
          <h1 className="m-0 truncate text-xl font-semibold text-[var(--nim-text)]">{team.name}</h1>
          {boundEmail && <p className="m-0 mt-0.5 truncate text-xs text-[var(--nim-text-muted)]">Owned by {boundEmail}</p>}
        </div>
        <button
          type="button"
          className="team-console-link flex items-center gap-1.5 rounded-md border border-[var(--nim-border)] bg-transparent px-3 py-2 text-xs text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]"
          onClick={() => window.electronAPI.openExternal(TEAM_CONSOLE_URL)}
        >
          Open web console <MaterialSymbol icon="open_in_new" size={14} />
        </button>
      </header>

      <div className="team-mode-body flex min-h-0 flex-1">
        <nav className="team-mode-nav flex w-[200px] shrink-0 flex-col gap-1 border-r border-[var(--nim-border)] p-3">
          {ADMIN_TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              data-testid={`team-tab-${item.id}`}
              className={`team-mode-tab flex items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm ${
                tab === item.id
                  ? 'bg-[var(--nim-bg-active)] font-medium text-[var(--nim-text)]'
                  : 'bg-transparent text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)]'
              }`}
            >
              <MaterialSymbol icon={item.icon} size={18} fill={tab === item.id} />
              {item.label}
            </button>
          ))}
        </nav>

        <main className="team-mode-content min-w-0 flex-1 overflow-y-auto p-6">
          <div className="mx-auto max-w-[900px]">
            {tab === 'members' && <OrganizationMembersRolesPanel orgId={team.orgId} allowOrganizationCreation={false} />}
            {tab === 'projects' && (
              accessProjectId
                ? (
                  <div className="team-project-access">
                    <button
                      type="button"
                      className="team-project-access-back mb-4 flex items-center gap-1.5 text-xs text-[var(--nim-link)]"
                      onClick={() => setAccessProjectId(null)}
                    >
                      <MaterialSymbol icon="arrow_back" size={14} /> All projects
                    </button>
                    <ProjectSharingPanel target={{ kind: 'organizationProject', orgId: team.orgId, projectId: accessProjectId }} />
                  </div>
                )
                : <OrganizationProjectsPanel orgId={team.orgId} onManageAccess={(_orgId, projectId) => setAccessProjectId(projectId)} />
            )}
            {tab === 'billing' && <OrganizationBillingPanel />}
            {tab === 'danger' && <OrganizationDangerZone orgId={team.orgId} />}
          </div>
        </main>
      </div>
    </section>
  );
}
