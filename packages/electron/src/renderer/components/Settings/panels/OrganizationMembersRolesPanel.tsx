import React, { useCallback, useEffect, useState } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { useAtomValue } from 'jotai';
import { ActionGuard } from './ActionGuard';
import { AlphaBadge } from '../../common/AlphaBadge';
import { TEAM_ALPHA_TOOLTIP, TeamAlphaNotice } from '../../common/TeamAlphaNotice';
import {
  bucketMemberCount,
  categorizeTeamAnalyticsError,
  normalizeTeamAnalyticsCallerRole,
} from '../../../../shared/analytics/teamAnalytics';
import { trackTeamAnalyticsEvent } from '../../../utils/teamAnalytics';
import { organizationCreationEnabled } from '../../../store/atoms/settingsDomains';
import { teamPresenceAtomFamily } from '../../../store/atoms/teamPresence';
// Narrow imports: the `dialogs` barrel would drag every dialog component into
// this panel's module graph.
import { DIALOG_IDS } from '../../../dialogs/registry';
import { dialogRef } from '../../../contexts/DialogContext';
import { queueOrgWindowGeneralRoute } from '../../TeamMode/onboarding/orgOnboardingStorage';

interface Member {
  memberId: string;
  email: string;
  name: string;
  status: string;
  role: string;
}

interface OrganizationSummary {
  orgId: string;
  name: string;
  role: string;
  membershipType?: string;
  sourceEmail?: string | null;
}

export function OrganizationMembersRolesPanel({
  orgId,
  readOnlyRoles = false,
  // Invite-only alpha: the create-org card only renders in dev builds.
  allowOrganizationCreation = organizationCreationEnabled,
}: {
  orgId?: string;
  readOnlyRoles?: boolean;
  allowOrganizationCreation?: boolean;
}) {
  const [organizations, setOrganizations] = useState<OrganizationSummary[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [callerRole, setCallerRole] = useState('member');
  const [inviteEmail, setInviteEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    const directory = await window.electronAPI.organization.list();
    const teams = directory?.success && Array.isArray(directory.teams) ? directory.teams : [];
    setOrganizations(teams);
    if (!orgId) return;
    const roster = await window.electronAPI.organization.listMembers(orgId);
    if (roster?.success) {
      setMembers(roster.members ?? []);
      setCallerRole(roster.callerRole ?? teams.find((team: OrganizationSummary) => team.orgId === orgId)?.role ?? 'member');
    }
  }, [orgId]);

  useEffect(() => { void refresh().catch((reason) => setError(String(reason))); }, [refresh]);
  const canAdminister = callerRole === 'owner' || callerRole === 'admin';
  const analyticsCallerRole = normalizeTeamAnalyticsCallerRole(callerRole);
  const selected = organizations.find((organization) => organization.orgId === orgId);
  const pending = organizations.filter((organization) => organization.membershipType && organization.membershipType !== 'active_member');

  return (
    <section className="organization-members-roles-panel" data-testid="organization-members-roles-panel" data-component="OrganizationMembersRolesPanel">
      <header className="mb-5 border-b border-[var(--nim-border)] pb-4">
        <h2 className="m-0 flex items-center gap-2 text-xl font-semibold">
          Members &amp; Roles
          <AlphaBadge size="sm" tooltip={TEAM_ALPHA_TOOLTIP} />
        </h2>
        <p className="m-0 mt-1 text-sm text-[var(--nim-text-muted)]">
          {selected ? `${selected.name} · ${callerRole}${selected.sourceEmail ? ` · ${selected.sourceEmail}` : ''}` : 'Choose an organization.'}
        </p>
      </header>

      {pending.length > 0 && (
        <div className="organization-invitation-inbox mb-5" data-testid="organization-invitation-inbox">
          <h3 className="m-0 mb-2 text-sm font-semibold">Pending invitations</h3>
          <div className="flex flex-col gap-2">
            {pending.map((invitation) => (
              <article key={`${invitation.orgId}:${invitation.sourceEmail ?? ''}`} className="pending-invitation-card flex items-center gap-3 rounded-lg border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] p-3" data-testid="pending-invitation-card">
                <MaterialSymbol icon="mail" size={18} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{invitation.name}</div>
                  <div className="text-xs text-[var(--nim-text-muted)]">Invited account: {invitation.sourceEmail ?? 'signed-in account'}</div>
                </div>
                <button
                  type="button"
                  className="pending-invitation-accept rounded-md bg-[var(--nim-primary)] px-3 py-1.5 text-xs font-semibold text-white"
                  data-testid="pending-invitation-accept"
                  onClick={() => void window.electronAPI.organization.acceptInvitation(invitation.orgId)
                    .then(async (result) => {
                      if (result?.success === false) throw new Error(result.error ?? 'Could not accept invitation');
                      trackTeamAnalyticsEvent('team_invitation_accepted', {
                        surface: 'desktop',
                        entryPoint: 'organization_manager',
                        projectMatched: false,
                      });
                      // Land the new member in the organization on #general
                      // rather than leaving them looking at a settings list.
                      if (!(await queueOrgWindowGeneralRoute(invitation.orgId))) {
                        throw new Error(
                          'Invitation accepted, but the organization destination could not be saved. Try again.',
                        );
                      }
                      void window.electronAPI?.team?.openManagementWindow?.({ orgId: invitation.orgId });
                      return refresh();
                    })
                    .catch((reason) => {
                      trackTeamAnalyticsEvent('team_operation_failed', {
                        surface: 'desktop',
                        operation: 'accept_invitation',
                        entryPoint: 'organization_manager',
                        callerRole: analyticsCallerRole,
                        errorCategory: categorizeTeamAnalyticsError('organization', reason),
                      });
                      setError(String(reason));
                    })}
                >
                  Accept
                </button>
              </article>
            ))}
          </div>
        </div>
      )}

      {allowOrganizationCreation && (
        <div className="new-organization-card mb-5 rounded-lg border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] p-3" data-testid="new-organization-card">
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold">New organization</div>
              <div className="mt-0.5 text-xs text-[var(--nim-text-muted)]">Name it, invite your team, and pick starting rooms.</div>
            </div>
            <button
              type="button"
              className="new-organization-launch rounded bg-[var(--nim-primary)] px-3 py-2 text-sm font-semibold text-white"
              data-testid="new-organization-launch"
              onClick={() => dialogRef.current?.open(DIALOG_IDS.ORG_CREATION_WIZARD, {
                onOrganizationCreated: () => { void refresh(); },
              })}
            >
              Create organization
            </button>
          </div>
          <TeamAlphaNotice className="mt-3" />
        </div>
      )}

      {orgId && (
        <>
          <div className="organization-roster flex flex-col gap-2" data-testid="organization-roster">
            {members.map((member) => (
              <div key={member.memberId} className="member-row flex items-center gap-3 rounded-lg border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] p-3" data-testid="organization-member-row">
                <MemberPresenceDot orgId={orgId} memberId={member.memberId} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{member.name || member.email}</div>
                  <div className="truncate text-xs text-[var(--nim-text-muted)]">{member.email}</div>
                </div>
                {readOnlyRoles ? (
                  <span className="member-role-badge rounded-full bg-[var(--nim-bg-tertiary)] px-2.5 py-1 text-xs capitalize text-[var(--nim-text-muted)]">
                    {member.role}
                  </span>
                ) : <select
                  value={member.role}
                  disabled={!canAdminister}
                  className="member-role-select rounded border border-[var(--nim-border)] bg-[var(--nim-bg-tertiary)] px-2 py-1 text-xs disabled:cursor-not-allowed"
                  data-testid="member-role-select"
                  onChange={(event) => {
                    const nextRole = event.target.value;
                    void window.electronAPI.organization.updateMemberRole(orgId, member.memberId, nextRole)
                      .then((result) => {
                        if (result?.success === false) throw new Error(result.error ?? 'Could not update member role');
                        trackTeamAnalyticsEvent('team_member_role_changed', {
                          surface: 'desktop',
                          callerRole: analyticsCallerRole,
                          fromRole: normalizeTeamAnalyticsCallerRole(member.role),
                          toRole: normalizeTeamAnalyticsCallerRole(nextRole),
                        });
                        return refresh();
                      })
                      .catch((reason) => {
                        trackTeamAnalyticsEvent('team_operation_failed', {
                          surface: 'desktop',
                          operation: 'change_member_role',
                          entryPoint: 'organization_manager',
                          callerRole: analyticsCallerRole,
                          errorCategory: categorizeTeamAnalyticsError('organization', reason),
                        });
                        setError(String(reason));
                      });
                  }}
                >
                  <option value="viewer">Viewer</option>
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                  <option value="owner">Owner</option>
                </select>}
              </div>
            ))}
          </div>

          <ActionGuard allowed={canAdminister} reason="An organization owner or admin is required to invite members.">
            <form
              className="organization-invite-form mt-4 flex gap-2"
              data-testid="organization-invite-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (!inviteEmail.trim()) return;
                void window.electronAPI.organization.inviteMember(orgId, inviteEmail.trim())
                  .then((result) => {
                    if (result?.success === false) throw new Error(result.error ?? 'Could not send invitation');
                    trackTeamAnalyticsEvent('team_invitation_sent', {
                      surface: 'desktop',
                      entryPoint: 'organization_manager',
                      callerRole: analyticsCallerRole,
                      memberCountBucket: bucketMemberCount(members.length + 1),
                    });
                    setInviteEmail('');
                    return refresh();
                  })
                  .catch((reason) => {
                    trackTeamAnalyticsEvent('team_operation_failed', {
                      surface: 'desktop',
                      operation: 'send_invitation',
                      entryPoint: 'organization_manager',
                      callerRole: analyticsCallerRole,
                      errorCategory: categorizeTeamAnalyticsError('organization', reason),
                    });
                    setError(String(reason));
                  });
              }}
            >
              <input className="min-w-0 flex-1 rounded border border-[var(--nim-border)] bg-[var(--nim-bg)] px-3 py-2 text-sm" type="email" value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} placeholder="teammate@example.com" />
              <button className="rounded bg-[var(--nim-primary)] px-3 py-2 text-sm font-semibold text-white" type="submit">Invite</button>
            </form>
          </ActionGuard>
        </>
      )}
      {error && <p className="select-text text-sm text-[var(--nim-error)]">{error}</p>}
    </section>
  );
}

function MemberPresenceDot({
  orgId,
  memberId,
}: {
  orgId: string;
  memberId: string;
}) {
  const presence = useAtomValue(teamPresenceAtomFamily({
    orgId,
    teamMemberId: memberId,
  }));
  const status = presence?.status ?? 'offline';
  const color = status === 'online'
    ? 'bg-[var(--nim-success)]'
    : status === 'away'
      ? 'bg-[var(--nim-warning)]'
      : 'bg-[var(--nim-text-disabled)]';
  return (
    <span
      className={`member-presence-dot size-2.5 shrink-0 rounded-full ${color}`}
      aria-label={status}
    />
  );
}
