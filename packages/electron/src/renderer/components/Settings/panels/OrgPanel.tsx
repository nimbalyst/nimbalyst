/**
 * OrgPanel — Settings → Organization (Epic H1).
 *
 * The org-level management surface: members + org roles (owner/admin/member/
 * guest), and per-project access grants (project-admin/editor/viewer). This is
 * where the org is administered; billing / SSO / domain conceptually live here
 * too (surfaced as a note until those move over).
 *
 * Wires to the H1 REST surface via the preload `team` + `org` bridges:
 *   - team.findForWorkspace / listMembers / invite / removeMember / updateRole
 *   - org.listProjectAccess / grantProjectAccess / revokeProjectAccess
 *
 * The active org is derived from the active workspace's matched team (the same
 * way the Team panel resolves it). A full multi-org switcher lives in the
 * top-level OrgSwitcher; this panel administers one org at a time.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';

type OrgRole = 'owner' | 'admin' | 'member' | 'guest';
type ProjectRole = 'project-admin' | 'project-editor' | 'project-viewer';

const ORG_ROLES: OrgRole[] = ['owner', 'admin', 'member', 'guest'];
const PROJECT_ROLES: ProjectRole[] = ['project-admin', 'project-editor', 'project-viewer'];

interface OrgMember {
  memberId: string;
  email: string;
  name: string;
  status: string;
  role: string;
}

interface ResolvedOrg {
  orgId: string;
  name: string;
  teamProjectId: string | null;
  callerRole: string;
}

// The renderer reaches the main process through an untyped bridge (see other
// settings panels); cast once here.
const api = () => (window as { electronAPI?: any }).electronAPI;

export function OrgPanel({ workspacePath, orgId: orgScopeId }: { workspacePath?: string; orgId?: string }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [org, setOrg] = useState<ResolvedOrg | null>(null);
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [grants, setGrants] = useState<Map<string, ProjectRole>>(new Map());
  const [inviteEmail, setInviteEmail] = useState('');
  const [busyMemberId, setBusyMemberId] = useState<string | null>(null);

  const isAdmin = org?.callerRole === 'admin' || org?.callerRole === 'owner';

  const load = useCallback(async () => {
    if (!workspacePath && !orgScopeId) {
      setLoading(false);
      setOrg(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      // Epic H3 P3: Organization scope keys off the selected org id; otherwise
      // resolve the org from the active workspace's matched team (legacy).
      let team: { orgId: string; name: string; teamProjectId?: string | null; role?: string } | null = null;
      if (orgScopeId) {
        const listRes = await api()?.team?.list();
        team = (listRes?.teams || []).find((t: any) => t.orgId === orgScopeId) ?? null;
      } else {
        const found = await api()?.team?.findForWorkspace(workspacePath);
        team = found?.success ? found?.team ?? null : null;
      }
      if (!team?.orgId) {
        setOrg(null);
        setMembers([]);
        setGrants(new Map());
        return;
      }

      const membersRes = await api()?.team?.listMembers(team.orgId);
      const memberList: OrgMember[] = membersRes?.members || membersRes?.success && membersRes.members || [];
      const callerRole: string = membersRes?.callerRole || team.role || 'member';

      const resolved: ResolvedOrg = {
        orgId: team.orgId,
        name: team.name,
        teamProjectId: team.teamProjectId ?? null,
        callerRole,
      };
      setOrg(resolved);
      setMembers(Array.isArray(memberList) ? memberList : []);

      // Project-access grants (admin-gated server-side; non-admins get an error
      // we tolerate as "no visible grants").
      if (resolved.teamProjectId) {
        const grantRes = await api()?.org?.listProjectAccess(resolved.orgId, resolved.teamProjectId);
        const map = new Map<string, ProjectRole>();
        if (grantRes?.success) {
          for (const g of grantRes.grants || []) map.set(g.userId, g.projectRole);
        }
        setGrants(map);
      } else {
        setGrants(new Map());
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [workspacePath, orgScopeId]);

  useEffect(() => { void load(); }, [load]);

  const handleUpdateRole = async (memberId: string, role: OrgRole) => {
    if (!org) return;
    setBusyMemberId(memberId);
    try {
      await api()?.team?.updateRole(org.orgId, memberId, role);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyMemberId(null);
    }
  };

  const handleSetGrant = async (memberId: string, role: ProjectRole | 'none') => {
    if (!org?.teamProjectId) return;
    setBusyMemberId(memberId);
    try {
      if (role === 'none') {
        await api()?.org?.revokeProjectAccess(org.orgId, org.teamProjectId, memberId);
      } else {
        await api()?.org?.grantProjectAccess(org.orgId, org.teamProjectId, memberId, role);
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyMemberId(null);
    }
  };

  const handleInvite = async () => {
    if (!org || !inviteEmail.trim()) return;
    try {
      await api()?.team?.invite(org.orgId, inviteEmail.trim());
      setInviteEmail('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRemove = async (memberId: string) => {
    if (!org) return;
    const member = members.find((m) => m.memberId === memberId);
    const label = member?.email || member?.name || 'this member';
    const confirmed = window.confirm(
      `Remove ${label} from "${org.name}"? They will lose access to every project in this organization. This cannot be undone (you'd need to re-invite them).`
    );
    if (!confirmed) return;
    setBusyMemberId(memberId);
    try {
      await api()?.team?.removeMember(org.orgId, memberId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyMemberId(null);
    }
  };

  if (loading) {
    return (
      <div className="org-settings-panel p-4 text-[13px] text-[var(--nim-text-muted)]">
        Loading organization…
      </div>
    );
  }

  if (!org) {
    return (
      <div className="org-settings-panel p-4">
        <div className="flex items-start gap-3 p-3 bg-[var(--nim-bg-secondary)] rounded-lg">
          <MaterialSymbol icon="corporate_fare" size={18} className="text-[var(--nim-text-muted)] mt-0.5" />
          <div className="text-[13px] text-[var(--nim-text-muted)] leading-relaxed">
            This workspace isn’t linked to an organization yet. Create or join a team
            from the <span className="font-semibold text-[var(--nim-text)]">Team</span> panel;
            its members, roles, and project access will appear here.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="org-settings-panel p-1">
      {error && (
        <div className="mb-3 flex items-center gap-2 px-3 py-2 bg-[var(--nim-error-bg,#3b1f1f)] text-[var(--nim-error,#f87171)] rounded-md text-[12px]">
          <MaterialSymbol icon="error" size={14} />
          <span className="flex-1">{error}</span>
          <button className="opacity-70 hover:opacity-100" onClick={() => setError(null)}>
            <MaterialSymbol icon="close" size={14} />
          </button>
        </div>
      )}

      {/* Org header */}
      <div className="py-4 mb-2 border-b border-[var(--nim-border)]">
        <div className="flex items-center gap-3 p-3 bg-[var(--nim-bg-secondary)] rounded-lg">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-[#60a5fa] to-[#a78bfa] flex items-center justify-center shrink-0">
            <MaterialSymbol icon="corporate_fare" size={18} className="text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[14px] font-semibold text-[var(--nim-text)]">{org.name}</div>
            <div className="text-[11px] text-[var(--nim-text-faint)]">
              Your role: <span className="font-mono">{org.callerRole}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Members + roles + project access */}
      <div className="py-3">
        <h4 className="text-[15px] font-semibold mb-1 text-[var(--nim-text)]">Members &amp; access</h4>
        <p className="text-[12px] text-[var(--nim-text-muted)] mb-3 leading-relaxed">
          Org roles grant org-wide capability; owners and admins implicitly administer every
          project. Members and guests get exactly their per-project grant.
        </p>

        <div className="flex flex-col gap-1.5">
          {members.map((m) => {
            const orgRole = m.role as OrgRole;
            const implicitAdmin = orgRole === 'owner' || orgRole === 'admin';
            const grant = grants.get(m.memberId) ?? null;
            const busy = busyMemberId === m.memberId;
            return (
              <div
                key={m.memberId}
                className="org-member-row flex items-center gap-3 px-3 py-2 bg-[var(--nim-bg-secondary)] rounded-md"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] text-[var(--nim-text)] truncate">{m.email || m.name || m.memberId}</div>
                  {m.status && m.status !== 'active' && (
                    <div className="text-[10px] text-[var(--nim-text-faint)] uppercase tracking-wide">{m.status}</div>
                  )}
                </div>

                {/* Org role */}
                {isAdmin ? (
                  <select
                    className="text-[12px] bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded px-1.5 py-1 text-[var(--nim-text)]"
                    value={orgRole}
                    disabled={busy}
                    onChange={(e) => handleUpdateRole(m.memberId, e.target.value as OrgRole)}
                  >
                    {ORG_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                ) : (
                  <span className="text-[12px] font-mono text-[var(--nim-text-muted)]">{orgRole}</span>
                )}

                {/* Project grant */}
                {org.teamProjectId && (
                  implicitAdmin ? (
                    <span className="text-[11px] text-[var(--nim-text-faint)] italic w-[120px] text-right">implicit admin</span>
                  ) : isAdmin ? (
                    <select
                      className="text-[12px] bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded px-1.5 py-1 text-[var(--nim-text)] w-[120px]"
                      value={grant ?? 'none'}
                      disabled={busy}
                      onChange={(e) => handleSetGrant(m.memberId, e.target.value as ProjectRole | 'none')}
                    >
                      <option value="none">no access</option>
                      {PROJECT_ROLES.map((r) => <option key={r} value={r}>{r.replace('project-', '')}</option>)}
                    </select>
                  ) : (
                    <span className="text-[11px] text-[var(--nim-text-muted)] w-[120px] text-right">
                      {grant ? grant.replace('project-', '') : 'no access'}
                    </span>
                  )
                )}

                {/* Remove */}
                {isAdmin && (
                  <button
                    className="opacity-60 hover:opacity-100 text-[var(--nim-text-muted)] disabled:opacity-30"
                    disabled={busy}
                    title="Remove member"
                    onClick={() => handleRemove(m.memberId)}
                  >
                    <MaterialSymbol icon="person_remove" size={16} />
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {/* Invite */}
        {isAdmin && (
          <div className="mt-3 flex items-center gap-2">
            <input
              type="email"
              placeholder="Invite by email…"
              className="flex-1 text-[13px] bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded px-2.5 py-2 text-[var(--nim-text)]"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleInvite(); }}
            />
            <button
              className="text-[13px] px-3 py-2 bg-[var(--nim-accent,#3b82f6)] text-white rounded disabled:opacity-40"
              disabled={!inviteEmail.trim()}
              onClick={() => void handleInvite()}
            >
              Invite to org
            </button>
          </div>
        )}
      </div>

      {/* Billing / SSO / domain note */}
      <div className="py-3 border-t border-[var(--nim-border)]">
        <div className="flex items-start gap-2 text-[12px] text-[var(--nim-text-faint)] leading-relaxed">
          <MaterialSymbol icon="info" size={14} className="mt-0.5" />
          <span>Billing, SSO, and domain settings are managed at the organization level and will move here.</span>
        </div>
      </div>
    </div>
  );
}
