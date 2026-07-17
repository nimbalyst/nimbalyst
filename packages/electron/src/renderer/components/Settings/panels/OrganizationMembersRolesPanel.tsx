import React, { useCallback, useEffect, useState } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { ActionGuard } from './ActionGuard';

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

interface PersonalAccount {
  personalOrgId: string;
  email: string | null;
}

export function OrganizationMembersRolesPanel({
  orgId,
  readOnlyRoles = false,
  allowOrganizationCreation = true,
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
  const [accounts, setAccounts] = useState<PersonalAccount[]>([]);
  const [newOrganizationName, setNewOrganizationName] = useState('');
  const [sourcePersonalOrgId, setSourcePersonalOrgId] = useState('');

  const refresh = useCallback(async () => {
    const directory = await window.electronAPI.organization.list();
    const teams = directory?.success && Array.isArray(directory.teams) ? directory.teams : [];
    setOrganizations(teams);
    const accountResult = await window.electronAPI.stytch.getAccounts();
    const accountRows = Array.isArray(accountResult) ? accountResult : [];
    setAccounts(accountRows);
    setSourcePersonalOrgId((current) => current || accountRows[0]?.personalOrgId || '');
    if (!orgId) return;
    const roster = await window.electronAPI.organization.listMembers(orgId);
    if (roster?.success) {
      setMembers(roster.members ?? []);
      setCallerRole(roster.callerRole ?? teams.find((team: OrganizationSummary) => team.orgId === orgId)?.role ?? 'member');
    }
  }, [orgId]);

  useEffect(() => { void refresh().catch((reason) => setError(String(reason))); }, [refresh]);
  const canAdminister = callerRole === 'owner' || callerRole === 'admin';
  const selected = organizations.find((organization) => organization.orgId === orgId);
  const pending = organizations.filter((organization) => organization.membershipType && organization.membershipType !== 'active_member');

  return (
    <section className="organization-members-roles-panel" data-testid="organization-members-roles-panel" data-component="OrganizationMembersRolesPanel">
      <header className="mb-5 border-b border-[var(--nim-border)] pb-4">
        <h2 className="m-0 text-xl font-semibold">Members &amp; Roles</h2>
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
                  onClick={() => void window.electronAPI.organization.acceptInvitation(invitation.orgId).then(refresh)}
                >
                  Accept
                </button>
              </article>
            ))}
          </div>
        </div>
      )}

      {allowOrganizationCreation && <details className="new-organization-card mb-5 rounded-lg border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] p-3" data-testid="new-organization-card">
        <summary className="cursor-pointer text-sm font-semibold">New organization</summary>
        <form
          className="mt-3 flex flex-col gap-2"
          data-testid="new-organization-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!newOrganizationName.trim()) return;
            void window.electronAPI.organization.create({
              name: newOrganizationName.trim(),
              sourcePersonalOrgId: sourcePersonalOrgId || undefined,
            }).then((result) => {
              if (!result?.success) throw new Error(result?.error ?? 'Could not create organization');
              setNewOrganizationName('');
              return refresh();
            }).catch((reason) => setError(String(reason)));
          }}
        >
          {accounts.length > 1 && (
            <label className="text-xs text-[var(--nim-text-muted)]">Owning personal account<select className="mt-1 block w-full rounded border border-[var(--nim-border)] bg-[var(--nim-bg)] px-2 py-2 text-sm text-[var(--nim-text)]" value={sourcePersonalOrgId} onChange={(event) => setSourcePersonalOrgId(event.target.value)}>{accounts.map((account) => <option key={account.personalOrgId} value={account.personalOrgId}>{account.email ?? account.personalOrgId}</option>)}</select></label>
          )}
          <div className="flex gap-2"><input className="min-w-0 flex-1 rounded border border-[var(--nim-border)] bg-[var(--nim-bg)] px-3 py-2 text-sm" value={newOrganizationName} onChange={(event) => setNewOrganizationName(event.target.value)} placeholder="Organization name" /><button className="rounded bg-[var(--nim-primary)] px-3 py-2 text-sm font-semibold text-white" type="submit">Create</button></div>
        </form>
      </details>}

      {orgId && (
        <>
          <div className="organization-roster flex flex-col gap-2" data-testid="organization-roster">
            {members.map((member) => (
              <div key={member.memberId} className="member-row flex items-center gap-3 rounded-lg border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] p-3" data-testid="organization-member-row">
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
                  onChange={(event) => void window.electronAPI.organization.updateMemberRole(orgId, member.memberId, event.target.value).then(refresh)}
                >
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
                  .then(() => { setInviteEmail(''); return refresh(); })
                  .catch((reason) => setError(String(reason)));
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
