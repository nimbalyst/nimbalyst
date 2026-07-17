import React, { useState, useEffect, useCallback, useRef } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { useDialogState } from '../../../contexts/DialogContext';
import { DIALOG_IDS } from '../../../dialogs/registry';
import type { CreateTeamData } from '../../../dialogs/teamDialogs';
import { AlphaBadge, SETTINGS_ALPHA_TOOLTIP } from '../../common/AlphaBadge';
import { SecurityEncryptionSection } from './H2EncryptionMigration';
import { MoveProjectWizard } from './MoveProjectWizard';
import { MergeOrgWizard } from './MergeOrgWizard';
import { ProjectAccessEditor } from './ProjectAccessEditor';

// ============================================================================
// Types
// ============================================================================

interface TeamMember {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'member';
  status: 'pending' | 'active';
  avatarColor: string;
  isYou?: boolean;
  invitedAt?: string;
}

interface TeamData {
  orgId: string;
  name: string;
  gitRemote: string;
  gitRemoteHash: string | null;
  /** Epic H3 P0/A: the routing key of the project THIS workspace resolved to. */
  teamProjectId?: string | null;
  members: TeamMember[];
  callerRole: string;
  membershipType?: string;
  boundPersonalOrgId?: string;
  boundAccountEmail?: string | null;
}

interface PendingInvite {
  orgId: string;
  name: string;
  membershipType: string;
}

/** Epic H3 P0/A: one project in the active org's registry. */
interface OrgProjectSummary {
  projectId: string;
  teamProjectId: string;
  gitRemoteHash: string | null;
  slug: string | null;
  name: string | null;
}

interface WorkspaceProjectSharingPanelProps {
  workspacePath: string;
}

const AVATAR_COLORS = ['#60a5fa', '#a78bfa', '#4ade80', '#fbbf24', '#f472b6', '#34d399'];

function getAvatarColor(index: number): string {
  return AVATAR_COLORS[index % AVATAR_COLORS.length];
}

// ============================================================================
// Sub-components
// ============================================================================

function MemberAvatar({ name, email, color, isPending }: {
  name?: string;
  email: string;
  color: string;
  isPending?: boolean;
}) {
  if (isPending) {
    return (
      <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-faint)]">
        <MaterialSymbol icon="mail" size={14} />
      </div>
    );
  }

  const initial = (name?.[0] || email[0] || '?').toUpperCase();
  return (
    <div
      className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-[13px] font-semibold text-white"
      style={{ background: color }}
    >
      {initial}
    </div>
  );
}

function RoleBadge({ role, editable, onChange }: { role: 'admin' | 'member'; editable?: boolean; onChange?: (newRole: 'admin' | 'member') => void }) {
  const colorClass = role === 'admin'
    ? 'bg-[rgba(96,165,250,0.15)] text-[var(--nim-primary)]'
    : 'bg-[rgba(180,180,180,0.1)] text-[var(--nim-text-faint)]';

  if (editable && onChange) {
    return (
      <select
        value={role}
        onChange={(e) => onChange(e.target.value as 'admin' | 'member')}
        className={`${colorClass} px-[5px] py-[2px] rounded-[10px] text-[10px] font-semibold border-none cursor-pointer outline-none hover:ring-1 hover:ring-[var(--nim-primary)]`}
      >
        <option value="admin">Admin</option>
        <option value="member">Member</option>
      </select>
    );
  }

  return (
    <span className={`${colorClass} px-[7px] py-[2px] rounded-[10px] text-[10px] font-semibold`}>
      {role === 'admin' ? 'Admin' : 'Member'}
    </span>
  );
}

function PendingBadge() {
  return (
    <span className="inline-flex items-center gap-1 px-[7px] py-[2px] rounded-[10px] text-[10px] font-semibold bg-[rgba(251,191,36,0.15)] text-[var(--nim-warning)]">
      <MaterialSymbol icon="schedule" size={8} />
      Pending
    </span>
  );
}

function TeamPricingNotice() {
  return (
    <div className="mt-2.5 flex items-start gap-1.5 text-[12px] leading-relaxed text-[var(--nim-text-faint)]">
      <MaterialSymbol icon="info" size={13} className="mt-[2px] shrink-0" />
      <span>
        Nimbalyst Teams is <span className="text-[var(--nim-text-muted)]">free during alpha</span>. We plan to introduce a paid subscription tier for teams in the future; existing teams will get advance notice before any pricing change.
      </span>
    </div>
  );
}

function EncryptionCard() {
  return (
    <div className="p-3.5 bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded-lg">
      <div className="flex items-center gap-2 mb-2">
        <MaterialSymbol icon="lock" size={16} className="text-[var(--nim-success)]" />
        <span className="text-[13px] font-semibold text-[var(--nim-success)]">
          Encryption &amp; Privacy
        </span>
      </div>
      <p className="m-0 mb-2 text-[12px] text-[var(--nim-text-muted)] leading-relaxed">
        Team data (trackers and documents) is encrypted in transit and at rest and
        isolated per team. Depending on your team&apos;s setup, encryption keys are
        either held only by members&apos; devices, or managed by Nimbalyst so the
        team is reachable from the web, CLI, and cloud agents.
      </p>
      <ul className="m-0 pl-5 text-[12px] text-[var(--nim-text)] leading-7">
        <li>Only authorized team members can access shared data</li>
        <li>Your personal device sync (sessions, drafts, settings) stays zero-knowledge — keys never leave your devices</li>
        <li>Need true zero-knowledge for team data? Self-hosting is the answer</li>
      </ul>
    </div>
  );
}

function ErrorBanner({ error, onDismiss }: { error: string; onDismiss: () => void }) {
  return (
    <div className="flex items-center gap-2 p-2.5 mb-3 bg-[rgba(239,68,68,0.1)] border border-[rgba(239,68,68,0.3)] rounded-md">
      <MaterialSymbol icon="error" size={14} className="text-[var(--nim-error)] shrink-0" />
      <span className="flex-1 text-[12px] text-[var(--nim-error)]">{error}</span>
      <button
        onClick={onDismiss}
        className="shrink-0 bg-transparent border-none cursor-pointer text-[var(--nim-text-faint)]"
      >
        <MaterialSymbol icon="close" size={14} />
      </button>
    </div>
  );
}

// ============================================================================
// No Team State
// ============================================================================

function NoTeamState({ gitRemote, onCreateTeam, loading, adminOrgs, onAddToOrg, addingProject, hasGitRemote }: {
  gitRemote: string;
  onCreateTeam: () => void;
  loading?: boolean;
  adminOrgs: { orgId: string; name: string }[];
  onAddToOrg: (orgId: string) => void;
  addingProject?: boolean;
  hasGitRemote?: boolean;
}) {
  const [selectedOrgId, setSelectedOrgId] = useState<string>('');

  return (
    <>
      {/* CTA Card */}
      <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
        <div className="p-6 bg-[var(--nim-bg-secondary)] rounded-lg text-center">
          <div className="w-12 h-12 mx-auto mb-3 bg-[rgba(96,165,250,0.15)] rounded-xl flex items-center justify-center">
            <MaterialSymbol icon="group" size={24} className="text-[var(--nim-primary)]" />
          </div>
          <p className="text-[13px] text-[var(--nim-text-muted)] mb-4 leading-relaxed">
            This project is personal. Create a team to share tracker items, documents, and collaborate in real time.
          </p>
          <button
            onClick={onCreateTeam}
            disabled={loading}
            className={`inline-flex items-center gap-1.5 px-5 py-2 bg-[var(--nim-primary)] border-none rounded-md text-white text-[13px] font-medium ${
              loading ? 'cursor-wait opacity-70' : 'cursor-pointer'
            }`}
          >
            <MaterialSymbol icon="add" size={14} />
            {loading ? 'Creating...' : 'Create Team'}
          </button>
        </div>
      </div>

      {/* Epic H3 P0/A: Add this workspace to an EXISTING org as a new project. */}
      {adminOrgs.length > 0 && (
        <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
          <h4 className="provider-panel-section-title text-[15px] font-semibold mb-2 text-[var(--nim-text)]">
            Add to an existing organization
          </h4>
          <p className="text-[12px] text-[var(--nim-text-muted)] mb-3 leading-relaxed">
            Already have an organization? Add this repo as a new project under it instead of
            creating a separate team. It joins as its own tracker space, sharing the org&apos;s members and encryption.
          </p>
          {!hasGitRemote ? (
            <div className="flex items-center gap-2 px-3 py-2.5 bg-[var(--nim-bg-secondary)] rounded-md">
              <MaterialSymbol icon="link_off" size={14} className="text-[var(--nim-text-faint)] shrink-0" />
              <span className="text-[12px] text-[var(--nim-text-faint)]">
                This workspace has no git remote, so it can&apos;t be added as a project.
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <select
                value={selectedOrgId}
                onChange={(e) => setSelectedOrgId(e.target.value)}
                disabled={addingProject}
                className="flex-1 px-3 py-2 text-[12px] bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded-md text-[var(--nim-text)] cursor-pointer"
              >
                <option value="">Select an organization…</option>
                {adminOrgs.map((o) => (
                  <option key={o.orgId} value={o.orgId}>{o.name}</option>
                ))}
              </select>
              <button
                onClick={() => selectedOrgId && onAddToOrg(selectedOrgId)}
                disabled={!selectedOrgId || addingProject}
                className={`inline-flex items-center gap-1.5 px-4 py-2 border-none rounded-md text-white text-[12px] font-medium shrink-0 ${
                  !selectedOrgId || addingProject
                    ? 'bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-faint)] cursor-not-allowed'
                    : 'bg-[var(--nim-primary)] cursor-pointer'
                }`}
              >
                <MaterialSymbol icon="add" size={14} />
                {addingProject ? 'Adding…' : 'Add Project'}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Project Identity */}
      <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
        <h4 className="provider-panel-section-title text-[15px] font-semibold mb-2 text-[var(--nim-text)]">
          Project Identity
        </h4>
        <p className="text-[13px] leading-relaxed text-[var(--nim-text-muted)] mb-3">
          Teams are linked to a git remote, so any member who opens a clone of the same repo is automatically connected.
        </p>
        <div className="flex items-center gap-2 px-3 py-2.5 bg-[var(--nim-bg-secondary)] rounded-md">
          <MaterialSymbol icon="commit" size={16} className="text-[var(--nim-text-faint)]" />
          <span className="text-[12px] font-mono text-[var(--nim-text-muted)]">
            {gitRemote || 'No git remote detected'}
          </span>
        </div>
      </div>

      {/* Encryption Footer */}
      <div className="provider-panel-section py-4">
        <EncryptionCard />
      </div>
    </>
  );
}

// ============================================================================
// Team Exists State
// ============================================================================

// Exported for testing (NIM-1779/C2 guard: the reachable team surface must not
// present envelope-based trust badges or a "Re-share key" affordance).
export function ProjectScopedTeamExistsState({
  team,
  projects,
  workspacePath,
  adminOrgs,
  localGitRemote,
  onLinkProject,
  onUnlinkProject,
  onProjectMoved,
}: {
  team: TeamData;
  projects: OrgProjectSummary[];
  workspacePath: string;
  adminOrgs: { orgId: string; name: string }[];
  localGitRemote: string;
  onLinkProject: () => void;
  onUnlinkProject: () => void;
  onProjectMoved: () => void;
}) {
  const [moving, setMoving] = useState(false);
  const currentProject = team.teamProjectId
    ? projects.find((project) => project.teamProjectId === team.teamProjectId)
    : undefined;
  const isAdmin = team.callerRole === 'admin' || team.callerRole === 'owner';
  const destinationOrganizations = adminOrgs.filter((organization) => organization.orgId !== team.orgId);
  // Org administration opens in its own window (2026-07-17 decision-log correction).
  const openTeamSurface = () => {
    void (window as any).electronAPI?.team?.openManagementWindow({ orgId: team.orgId, workspacePath });
  };

  return (
    <div className="attached-project-sharing-state" data-testid="attached-project-sharing-state">
      <div className="project-identity-card rounded-lg border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] p-4" data-testid="project-identity-card">
        <div className="flex items-center gap-3"><MaterialSymbol icon="folder_shared" size={22} /><div className="min-w-0 flex-1"><div className="truncate text-sm font-semibold">{currentProject?.name || currentProject?.slug || team.name}</div><div className="truncate text-xs text-[var(--nim-text-muted)]">{team.name} · {team.callerRole || 'member'}</div></div></div>
        <div className="mt-3 flex items-center gap-2 rounded bg-[var(--nim-bg)] px-3 py-2"><MaterialSymbol icon={team.gitRemoteHash ? 'link' : 'link_off'} size={15} /><span className="min-w-0 flex-1 truncate select-text font-mono text-xs text-[var(--nim-text-muted)]">{localGitRemote || 'No git remote linked'}</span>{isAdmin && (team.gitRemoteHash ? <button type="button" className="text-xs text-[var(--nim-text-muted)]" onClick={onUnlinkProject}>Unlink</button> : localGitRemote ? <button type="button" className="text-xs text-[var(--nim-link)]" onClick={onLinkProject}>Relink</button> : null)}</div>
      </div>

      <div className="workspace-organization-account-chain mt-3 select-text rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg)] px-3 py-2 text-xs text-[var(--nim-text-muted)]" data-testid="workspace-organization-account-chain">
        {workspacePath.split(/[\\/]/).filter(Boolean).pop() ?? workspacePath} → {team.name} → {team.boundAccountEmail ?? team.boundPersonalOrgId ?? 'bound account'}
      </div>

      <div className="project-organization-links my-4 flex flex-wrap gap-2" data-testid="project-organization-links">
        <button type="button" className="rounded border border-[var(--nim-border)] px-3 py-1.5 text-xs hover:bg-[var(--nim-bg-hover)]" onClick={openTeamSurface}>Open Team</button>
      </div>

      {!currentProject ? (
        <div className="project-sharing-needs-attention rounded-lg border border-[var(--nim-warning)] bg-[rgba(251,191,36,0.08)] p-4" data-testid="project-sharing-needs-attention"><div className="text-sm font-semibold text-[var(--nim-warning)]">Project attachment needs attention</div><p className="m-0 mt-1 text-xs text-[var(--nim-text-muted)]">The organization is known, but this workspace did not resolve to an explicit project id. Access editing is disabled rather than falling back to another project.</p></div>
      ) : (
        <><h3 className="m-0 mb-2 text-sm font-semibold">People with access</h3><ProjectAccessEditor orgId={team.orgId} projectId={currentProject.projectId} /></>
      )}

      {isAdmin && currentProject && destinationOrganizations.length > 0 && (
        <div className="project-scoped-actions mt-4 border-t border-[var(--nim-border)] pt-4"><button type="button" className="rounded border border-[var(--nim-border)] px-3 py-1.5 text-xs hover:bg-[var(--nim-bg-hover)]" data-testid="move-current-project" onClick={() => setMoving(true)}>Move project…</button></div>
      )}
      {moving && currentProject && (
        <MoveProjectWizard srcOrgId={team.orgId} project={{ projectId: currentProject.projectId, name: currentProject.name || currentProject.slug || 'Untitled project' }} destCandidates={destinationOrganizations} onClose={() => setMoving(false)} onMoved={() => { setMoving(false); onProjectMoved(); }} onUpdateEncryption={openTeamSurface} />
      )}
    </div>
  );
}

// ============================================================================
// Invite Pending State
// ============================================================================

function InvitePendingState({ invite, onAccept, loading, gitRemote }: {
  invite: PendingInvite;
  onAccept: () => void;
  loading?: boolean;
  gitRemote: string;
}) {
  return (
    <>
      {/* Invite Card */}
      <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
        <div className="p-6 bg-[var(--nim-bg-secondary)] rounded-lg text-center">
          <div className="w-12 h-12 mx-auto mb-3 bg-[rgba(251,191,36,0.15)] rounded-xl flex items-center justify-center">
            <MaterialSymbol icon="mail" size={24} className="text-[var(--nim-warning)]" />
          </div>
          <div className="text-[15px] font-semibold text-[var(--nim-text)] mb-1">
            {invite.name}
          </div>
          <p className="text-[13px] text-[var(--nim-text-muted)] mb-4 leading-relaxed">
            You have been invited to join this team. Accept to collaborate on shared, encrypted tracker items and documents.
          </p>
          <button
            onClick={onAccept}
            disabled={loading}
            className={`inline-flex items-center gap-1.5 px-5 py-2 bg-[var(--nim-primary)] border-none rounded-md text-white text-[13px] font-medium ${
              loading ? 'cursor-wait opacity-70' : 'cursor-pointer'
            }`}
          >
            <MaterialSymbol icon="group_add" size={14} />
            {loading ? 'Joining...' : 'Join Team'}
          </button>
        </div>
      </div>

      {/* Project Identity */}
      <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
        <h4 className="provider-panel-section-title text-[15px] font-semibold mb-2 text-[var(--nim-text)]">
          Project Identity
        </h4>
        <p className="text-[13px] leading-relaxed text-[var(--nim-text-muted)] mb-3">
          Teams are linked to a git remote, so any member who opens a clone of the same repo is automatically connected.
        </p>
        <div className="flex items-center gap-2 px-3 py-2.5 bg-[var(--nim-bg-secondary)] rounded-md">
          <MaterialSymbol icon="commit" size={16} className="text-[var(--nim-text-faint)]" />
          <span className="text-[12px] font-mono text-[var(--nim-text-muted)]">
            {gitRemote || 'No git remote detected'}
          </span>
        </div>
      </div>

      {/* Encryption Footer */}
      <div className="provider-panel-section py-4">
        <EncryptionCard />
      </div>
    </>
  );
}

// ============================================================================
// WorkspaceProjectSharingPanel
// ============================================================================

export function WorkspaceProjectSharingPanel({ workspacePath }: WorkspaceProjectSharingPanelProps) {
  const [team, setTeam] = useState<TeamData | null>(null);
  const [pendingInvite, setPendingInvite] = useState<PendingInvite | null>(null);
  const [gitRemote, setGitRemote] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  // Epic H3 P0/A: projects in the active org, and the orgs the user can add
  // this workspace to as a NEW project (orgs where they are owner/admin).
  const [projects, setProjects] = useState<OrgProjectSummary[]>([]);
  const [adminOrgs, setAdminOrgs] = useState<{ orgId: string; name: string }[]>([]);
  const [addingProject, setAddingProject] = useState(false);
  const [stytchAuth, setStytchAuth] = useState<{
    isAuthenticated: boolean;
    user: { user_id: string; emails: Array<{ email: string }>; name?: { first_name?: string; last_name?: string } } | null;
  }>({ isAuthenticated: false, user: null });

  const createTeamDialog = useDialogState<CreateTeamData>(DIALOG_IDS.CREATE_TEAM);

  // Load Stytch auth state on mount
  useEffect(() => {
    if (!(window as any).electronAPI?.stytch) return;

    (window as any).electronAPI.stytch.getAuthState().then((state: any) => {
      setStytchAuth({ isAuthenticated: state.isAuthenticated, user: state.user });
      // Validate session is alive server-side; if dead, signOut broadcasts
      // auth state change and the listener below updates the UI
      if (state.isAuthenticated) {
        (window as any).electronAPI.stytch.refreshSession();
      }
    });

    // Subscribe to auth state changes
    (window as any).electronAPI.stytch.subscribeAuthState();
    const unsubscribe = (window as any).electronAPI.stytch.onAuthStateChange((state: any) => {
      setStytchAuth({ isAuthenticated: state.isAuthenticated, user: state.user });
    });

    return unsubscribe;
  }, []);

  // Load git remote on mount
  useEffect(() => {
    if (!workspacePath) return;
    (window as any).electronAPI.team.getGitRemote(workspacePath).then((result: any) => {
      if (result.success && result.remote) {
        setGitRemote(result.remote);
      }
    });
  }, [workspacePath]);

  // Epic H3 P0/A: load the orgs the user owns/admins, so a personal workspace can
  // be added to an existing org as a new project (vs only "create a new team").
  const loadAdminOrgs = useCallback(async () => {
    try {
      const result = await (window as any).electronAPI.team.list();
      if (result.success && Array.isArray(result.teams)) {
        const orgs = result.teams
          .filter((t: any) =>
            (!t.membershipType || t.membershipType === 'active_member') &&
            (t.role === 'admin' || t.role === 'owner'))
          .map((t: any) => ({ orgId: t.orgId, name: t.name }));
        setAdminOrgs(orgs);
      }
    } catch {
      // Non-fatal -- the "add to existing org" option just won't appear.
    }
  }, []);

  useEffect(() => {
    loadAdminOrgs();
  }, [loadAdminOrgs]);

  // Load team data for an orgId: fetch members and projects. Team custody is
  // server-managed, so there is no per-member key-envelope trust to compute
  // (NIM-1779/C2: the envelope-based trust + re-share UI was removed).
  const loadTeamDetails = useCallback(async (orgId: string, teamName: string, teamGitRemoteHash: string | null, teamProjectId?: string | null, boundPersonalOrgId?: string) => {
    const membersResult = await (window as any).electronAPI.team.listMembers(orgId);
    if (!membersResult.success) return;

    const currentUserId = membersResult.callerMemberId || '';

    const members: TeamMember[] = (membersResult.members || []).map((m: any, i: number) => ({
      id: m.memberId,
      name: m.name || '',
      email: m.email,
      role: m.role as 'admin' | 'member',
      status: m.status === 'pending' ? 'pending' as const : 'active' as const,
      avatarColor: getAvatarColor(i),
      isYou: m.memberId === currentUserId,
      invitedAt: m.status === 'pending' ? 'recently' : undefined,
    }));

    const accounts = await window.electronAPI.stytch.getAccounts();
    setTeam({
      orgId,
      name: teamName,
      gitRemote: gitRemote || teamGitRemoteHash || '',
      gitRemoteHash: teamGitRemoteHash,
      teamProjectId: teamProjectId ?? null,
      members,
      callerRole: membersResult.callerRole || 'member',
      boundPersonalOrgId,
      boundAccountEmail: accounts.find((account) => account.personalOrgId === boundPersonalOrgId)?.email ?? null,
    });

    // Epic H3 P0/A: list every project in this org (fire-and-forget).
    (window as any).electronAPI.team.listProjects(orgId).then((res: any) => {
      if (res?.success && Array.isArray(res.projects)) {
        setProjects(res.projects);
      } else {
        setProjects([]);
      }
    }).catch(() => setProjects([]));
  }, [gitRemote]);

  // Load team data -- find team matching this workspace's git remote, or fall back to listing all teams
  const loadTeamData = useCallback(async () => {
    try {
      // Find team by workspace git remote (per-project lookup).
      // This returns active teams OR pending invites that match this workspace.
      const findResult = await (window as any).electronAPI.team.findForWorkspace(workspacePath);
      console.log('[WorkspaceProjectSharingPanel] findForWorkspace result:', findResult);
      if (findResult.success && findResult.team) {
        const matchedTeam = findResult.team;
        const isPending = matchedTeam.membershipType && matchedTeam.membershipType !== 'active_member';

        if (isPending) {
          // Matched a pending invite for this workspace -- show join prompt
          setPendingInvite({
            orgId: matchedTeam.orgId,
            name: matchedTeam.name,
            membershipType: matchedTeam.membershipType,
          });
          setTeam(null);
          return;
        }

        // Active team match
        setPendingInvite(null);
        await loadTeamDetails(matchedTeam.orgId, matchedTeam.name, matchedTeam.gitRemoteHash, matchedTeam.teamProjectId, matchedTeam.boundPersonalOrgId);
        return;
      }

      // No git remote match -- check if user has any pending invites at all.
      // Only show pending invites (not unrelated active teams) since
      // showing an unrelated team is confusing.
      const listResult = await (window as any).electronAPI.team.list();
      console.log('[WorkspaceProjectSharingPanel] team.list result:', listResult);
      if (listResult.success && listResult.teams && listResult.teams.length > 0) {
        const pendingTeams = listResult.teams.filter((t: any) => t.membershipType && t.membershipType !== 'active_member');

        // Show a pending invite if one exists (user may need to join before project identity is linked)
        if (pendingTeams.length > 0) {
          const invite = pendingTeams[0];
          setPendingInvite({
            orgId: invite.orgId,
            name: invite.name,
            membershipType: invite.membershipType,
          });
          setTeam(null);
          return;
        }
      }

      console.log('[WorkspaceProjectSharingPanel] No matching organization for this workspace, showing create UI');
      setPendingInvite(null);
      setTeam(null);
    } catch (err) {
      console.error('[WorkspaceProjectSharingPanel] loadTeamData error:', err);
      setPendingInvite(null);
      setTeam(null);
    } finally {
      setInitialLoading(false);
    }
  }, [workspacePath, loadTeamDetails]);

  useEffect(() => {
    loadTeamData();
  }, [loadTeamData]);

  const handleCreateTeam = async () => {
    // Load accounts to show picker if multiple are signed in
    let accounts: Array<{ personalOrgId: string; email: string | null; isSyncAccount: boolean }> = [];
    try {
      accounts = await (window as any).electronAPI.stytch.getAccounts() || [];
    } catch {
      // Fall back to empty -- dialog will work without account picker
    }

    createTeamDialog.open({
      gitRemote: gitRemote || 'No git remote detected',
      suggestedName: workspacePath?.split('/').pop() || 'my-project',
      accounts,
      onCreateTeam: async (name: string, accountOrgId?: string) => {
        setLoading(true);
        setError(null);
        try {
          const result = await (window as any).electronAPI.team.create(name, workspacePath, accountOrgId);
          if (result.success) {
            await loadTeamData();
          } else {
            setError(result.error || 'Failed to create team');
          }
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Failed to create team');
        } finally {
          setLoading(false);
        }
      },
    });
  };

  // Epic H3 P0/A: attach the current workspace to an EXISTING org as a new
  // project (distinct from createTeam, which mints a brand-new org). After the
  // add, findForWorkspace resolves this workspace to the new project's room, so
  // reloading flips the panel into the team-exists state.
  const handleAddToOrg = async (orgId: string) => {
    if (!workspacePath) return;
    setAddingProject(true);
    setError(null);
    try {
      const result = await (window as any).electronAPI.team.addProject(orgId, workspacePath);
      if (result.success) {
        await loadTeamData();
        await loadAdminOrgs();
      } else {
        setError(result.error || 'Failed to add project to organization');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add project to organization');
    } finally {
      setAddingProject(false);
    }
  };

  const handleInvite = async (email: string) => {
    if (!team) return;
    setError(null);
    try {
      const result = await (window as any).electronAPI.team.invite(team.orgId, email);
      if (result.success) {
        // Optimistic update -- add pending member
        setTeam({
          ...team,
          members: [
            ...team.members,
            {
              id: `invite-${Date.now()}`,
              name: '',
              email,
              role: 'member',
              status: 'pending',
              avatarColor: getAvatarColor(team.members.length),
              invitedAt: 'just now',
            },
          ],
        });
        // Refresh from server after a short delay
        setTimeout(() => loadTeamData(), 2000);
      } else {
        setError(result.error || 'Failed to send invite');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send invite');
    }
  };

  const handleRemoveMember = async (memberId: string) => {
    if (!team) return;
    const member = team.members.find((m) => m.id === memberId);
    const label = member?.email || member?.name || 'this member';
    const isPending = member?.status === 'pending';
    const confirmed = window.confirm(
      isPending
        ? `Revoke the pending invite for ${label}?`
        : `Remove ${label} from "${team.name}"? They will lose access to this team's shared trackers and documents. This cannot be undone (you'd need to re-invite them).`
    );
    if (!confirmed) return;
    setError(null);
    try {
      const result = await (window as any).electronAPI.team.removeMember(team.orgId, memberId);
      if (result.success) {
        // Optimistic update
        setTeam({
          ...team,
          members: team.members.filter((m) => m.id !== memberId),
        });
      } else {
        setError(result.error || 'Failed to remove member');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove member');
    }
  };

  const handleAcceptInvite = async () => {
    if (!pendingInvite) return;
    setLoading(true);
    setError(null);
    try {
      const result = await (window as any).electronAPI.team.acceptInvite(pendingInvite.orgId);
      if (result.success) {
        setPendingInvite(null);
        await loadTeamData();
      } else {
        setError(result.error || 'Failed to join team');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to join team');
    } finally {
      setLoading(false);
    }
  };

  const handleLinkProject = async () => {
    if (!team || !workspacePath) return;
    setError(null);
    try {
      const result = await (window as any).electronAPI.team.setProjectIdentity(team.orgId, workspacePath);
      if (result.success) {
        await loadTeamData();
      } else {
        setError(result.error || 'Failed to link project');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to link project');
    }
  };

  const handleUnlinkProject = async () => {
    if (!team) return;
    const confirmed = window.confirm(
      `Stop syncing this project with "${team.name}"? Its trackers and documents will no longer sync to the team. You can re-link it later.`
    );
    if (!confirmed) return;
    setError(null);
    try {
      const result = await (window as any).electronAPI.team.clearProjectIdentity(team.orgId);
      if (result.success) {
        await loadTeamData();
      } else {
        setError(result.error || 'Failed to unlink project');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to unlink project');
    }
  };

  const handleUpdateRole = async (memberId: string, newRole: 'admin' | 'member') => {
    if (!team) return;
    setError(null);
    try {
      const result = await (window as any).electronAPI.team.updateRole(team.orgId, memberId, newRole);
      if (result.success) {
        // Optimistic update
        setTeam({
          ...team,
          members: team.members.map((m) =>
            m.id === memberId ? { ...m, role: newRole } : m
          ),
        });
      } else {
        setError(result.error || 'Failed to update role');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update role');
    }
  };

  const handleDeleteTeam = async () => {
    if (!team) return;
    const confirmed = window.confirm(
      `Permanently delete team "${team.name}"? This will remove all members, shared documents, and encryption keys. This action cannot be undone.`
    );
    if (!confirmed) return;
    setError(null);
    try {
      const result = await (window as any).electronAPI.team.deleteTeam(team.orgId);
      if (result.success) {
        setTeam(null);
      } else {
        setError(result.error || 'Failed to delete team');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete team');
    }
  };

  if (initialLoading) {
    return (
      <div
        className="workspace-project-sharing-panel provider-panel flex flex-col items-center justify-center py-12"
        data-component="WorkspaceProjectSharingPanel"
        data-testid="workspace-project-sharing-panel"
      >
        <span className="text-[13px] text-[var(--nim-text-muted)]">Loading team data...</span>
      </div>
    );
  }

  // Not authenticated - show sign-in prompt
  if (!stytchAuth.isAuthenticated) {
    return (
      <div
        className="workspace-project-sharing-panel provider-panel flex flex-col"
        data-component="WorkspaceProjectSharingPanel"
        data-testid="workspace-project-sharing-panel"
      >
        <div className="provider-panel-header mb-5 pb-4 border-b border-[var(--nim-border)]">
          <h3 className="provider-panel-title text-xl font-semibold leading-tight mb-1.5 text-[var(--nim-text)] flex items-center gap-2">
            Team
            <AlphaBadge size="sm" tooltip={SETTINGS_ALPHA_TOOLTIP} />
          </h3>
          <p className="provider-panel-description text-[13px] leading-relaxed text-[var(--nim-text-muted)]">
            Create a team to collaborate on shared, encrypted tracker items and documents.
          </p>
          <TeamPricingNotice />
        </div>
        <div className="p-6 bg-[var(--nim-bg-secondary)] rounded-lg text-center">
          <div className="w-12 h-12 mx-auto mb-3 bg-[rgba(96,165,250,0.15)] rounded-xl flex items-center justify-center">
            <MaterialSymbol icon="account_circle" size={24} className="text-[var(--nim-primary)]" />
          </div>
          <p className="text-[13px] text-[var(--nim-text-muted)] mb-2 leading-relaxed">
            Sign in to create or join a team.
          </p>
          <p className="text-[12px] text-[var(--nim-text-faint)] m-0">
            Go to <strong className="text-[var(--nim-text-muted)]">Account & Sync</strong> in the sidebar to sign in.
          </p>
        </div>
      </div>
    );
  }

  const userEmail = stytchAuth.user?.emails?.[0]?.email;
  const userName = stytchAuth.user?.name?.first_name
    ? `${stytchAuth.user.name.first_name} ${stytchAuth.user.name.last_name || ''}`.trim()
    : null;

  return (
    <div
      className="workspace-project-sharing-panel provider-panel flex flex-col"
      data-component="WorkspaceProjectSharingPanel"
      data-testid="workspace-project-sharing-panel"
    >
      {/* Header */}
      <div className="provider-panel-header mb-5 pb-4 border-b border-[var(--nim-border)]">
        <h3 className="provider-panel-title text-xl font-semibold leading-tight mb-1.5 text-[var(--nim-text)] flex items-center gap-2">
          Team
          <AlphaBadge size="sm" tooltip={SETTINGS_ALPHA_TOOLTIP} />
        </h3>
        <p className="provider-panel-description text-[13px] leading-relaxed text-[var(--nim-text-muted)]">
          Create a team to collaborate on shared, encrypted tracker items and documents.
        </p>
        <TeamPricingNotice />
        {userEmail && team && (
          <div className="flex items-center gap-1.5 mt-2 text-[12px] text-[var(--nim-text-faint)]">
            <MaterialSymbol icon="person" size={13} />
            <span>Signed in as <span className="text-[var(--nim-text-muted)]">{userName || userEmail}</span></span>
          </div>
        )}
      </div>

      {error && <ErrorBanner error={error} onDismiss={() => setError(null)} />}

      {team ? (
        <ProjectScopedTeamExistsState
          team={team}
          projects={projects}
          workspacePath={workspacePath}
          adminOrgs={adminOrgs}
          onLinkProject={handleLinkProject}
          onUnlinkProject={handleUnlinkProject}
          onProjectMoved={() => {
            // The moved project left this org; refresh the registry + candidate orgs.
            loadAdminOrgs();
            loadTeamDetails(team.orgId, team.name, team.gitRemoteHash, team.teamProjectId);
          }}
          localGitRemote={gitRemote}
        />
      ) : pendingInvite ? (
        <InvitePendingState
          invite={pendingInvite}
          onAccept={handleAcceptInvite}
          loading={loading}
          gitRemote={gitRemote}
        />
      ) : (
        <NoTeamState
          gitRemote={gitRemote}
          onCreateTeam={handleCreateTeam}
          loading={loading}
          adminOrgs={adminOrgs}
          onAddToOrg={handleAddToOrg}
          addingProject={addingProject}
          hasGitRemote={!!gitRemote}
        />
      )}
    </div>
  );
}
