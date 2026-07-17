import React, { useCallback, useEffect, useState } from 'react';

interface AccessGrant { userId: string; projectRole: string }
interface Member { memberId: string; email: string; name: string; role: string }

export function ProjectAccessEditor({ orgId, projectId }: { orgId: string; projectId: string }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [grants, setGrants] = useState<AccessGrant[]>([]);
  const [callerRole, setCallerRole] = useState('member');

  const refresh = useCallback(async () => {
    const [roster, access] = await Promise.all([
      window.electronAPI.organization.listMembers(orgId),
      window.electronAPI.invoke('org:list-project-access', orgId, projectId),
    ]);
    setMembers(roster?.members ?? []);
    setCallerRole(roster?.callerRole ?? 'member');
    setGrants(access?.grants ?? []);
  }, [orgId, projectId]);
  useEffect(() => { void refresh(); }, [refresh]);
  const canAdminister = callerRole === 'owner' || callerRole === 'admin';

  return (
    <div className="project-access-editor flex flex-col gap-2" data-testid="project-access-editor">
      {members.map((member) => {
        const inherited = member.role === 'owner' || member.role === 'admin';
        const grant = grants.find((entry) => entry.userId === member.memberId);
        return (
          <div key={member.memberId} className="project-access-row flex items-center gap-3 rounded-lg border border-[var(--nim-border)] p-3" data-testid="project-access-row">
            <div className="min-w-0 flex-1"><div className="truncate text-sm">{member.name || member.email}</div><div className="truncate text-xs text-[var(--nim-text-muted)]">{inherited ? `${member.role} · inherited project admin` : member.email}</div></div>
            <select
              value={inherited ? 'project-admin' : grant?.projectRole ?? ''}
              disabled={!canAdminister || inherited}
              className="project-access-role rounded border border-[var(--nim-border)] bg-[var(--nim-bg-tertiary)] px-2 py-1 text-xs disabled:opacity-60"
              data-testid="project-access-role"
              onChange={(event) => {
                const role = event.target.value;
                const promise = role
                  ? window.electronAPI.invoke('org:grant-project-access', orgId, projectId, member.memberId, role)
                  : window.electronAPI.invoke('org:revoke-project-access', orgId, projectId, member.memberId);
                void promise.then(refresh);
              }}
            >
              <option value="">No project access</option>
              <option value="project-viewer">Viewer</option>
              <option value="project-editor">Editor</option>
              <option value="project-admin">Project admin</option>
            </select>
          </div>
        );
      })}
      {!canAdminister && <p className="text-xs text-[var(--nim-text-faint)]">Read-only. An organization owner or admin manages project access.</p>}
    </div>
  );
}
