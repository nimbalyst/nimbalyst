import React, { useEffect, useState } from 'react';
import { ActionGuard } from './ActionGuard';
import { MergeOrgWizard } from './MergeOrgWizard';

export function OrganizationDangerZone({ orgId }: { orgId?: string }) {
  const [role, setRole] = useState('member');
  const [confirmation, setConfirmation] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [organizationName, setOrganizationName] = useState('');
  const [mergeCandidates, setMergeCandidates] = useState<Array<{ orgId: string; name: string }>>([]);
  const [projectCount, setProjectCount] = useState(0);
  const [memberCount, setMemberCount] = useState(0);
  const [showMerge, setShowMerge] = useState(false);
  useEffect(() => {
    if (!orgId) return;
    void Promise.all([
      window.electronAPI.organization.list(),
      window.electronAPI.organization.listMembers(orgId),
      window.electronAPI.organization.listProjects(orgId),
    ]).then(([directory, roster, projects]) => {
      const organizations = directory?.teams ?? [];
      const current = organizations.find((organization: { orgId: string }) => organization.orgId === orgId);
      setOrganizationName(current?.name ?? orgId);
      setRole(roster?.callerRole ?? 'member');
      setMemberCount(roster?.members?.length ?? 0);
      setProjectCount(projects?.projects?.length ?? 0);
      setMergeCandidates(organizations
        .filter((organization: { orgId: string; role: string; membershipType?: string }) =>
          organization.orgId !== orgId &&
          (!organization.membershipType || organization.membershipType === 'active_member') &&
          (organization.role === 'owner' || organization.role === 'admin'))
        .map((organization: { orgId: string; name: string }) => ({ orgId: organization.orgId, name: organization.name })));
    });
  }, [orgId]);
  const canDelete = role === 'owner' || role === 'admin';
  return (
    <section className="organization-danger-zone" data-testid="organization-danger-zone" data-component="OrganizationDangerZone">
      <h2 className="m-0 text-xl font-semibold text-[var(--nim-error)]">Danger Zone</h2>
      <p className="text-sm text-[var(--nim-text-muted)]">Leaving, ownership transfer, consolidation, and deletion are organization-scoped actions.</p>
      <div className="mt-4 rounded-lg border border-[var(--nim-border)] p-4">
        <h3 className="m-0 text-sm font-semibold">Leave organization</h3>
        <p className="text-xs text-[var(--nim-text-muted)]">Your access to every organization project will be removed. Last-owner constraints are enforced by the server.</p>
        <ActionGuard allowed={false} reason="Leave is disabled until the collaboration server enforces last-owner invariants.">
          <button type="button" disabled className="organization-leave rounded border border-[var(--nim-border)] px-3 py-2 text-sm disabled:opacity-40" data-testid="organization-leave">Leave organization</button>
        </ActionGuard>
      </div>
      <div className="mt-4 rounded-lg border border-[var(--nim-border)] p-4">
        <h3 className="m-0 text-sm font-semibold">Merge organization</h3>
        <p className="text-xs text-[var(--nim-text-muted)]">Move every project and merge the roster into another organization you administer.</p>
        <ActionGuard allowed={canDelete && mergeCandidates.length > 0} reason="An admin role in this organization and another destination organization is required.">
          <button type="button" className="organization-merge rounded border border-[var(--nim-border)] px-3 py-2 text-sm" data-testid="organization-merge" onClick={() => setShowMerge(true)}>Merge into another organization…</button>
        </ActionGuard>
      </div>
      <div className="mt-4 rounded-lg border border-[var(--nim-border)] p-4">
        <h3 className="m-0 text-sm font-semibold">Transfer ownership</h3>
        <p className="text-xs text-[var(--nim-text-muted)]">Choose another active member before leaving or deleting an organization you own.</p>
        <ActionGuard allowed={false} reason="Ownership transfer is disabled until the collaboration server enforces last-owner invariants.">
          <button type="button" disabled className="rounded border border-[var(--nim-border)] px-3 py-2 text-sm disabled:opacity-40" data-testid="organization-transfer-ownership">Transfer ownership</button>
        </ActionGuard>
      </div>
      <div className="mt-4 rounded-lg border border-[var(--nim-error)] p-4">
        <h3 className="m-0 text-sm font-semibold">Delete organization</h3>
        <p className="text-xs text-[var(--nim-text-muted)]">Type the organization id to confirm. Server ownership and data constraints are enforced before deletion.</p>
        <ActionGuard allowed={Boolean(orgId) && canDelete} reason="An organization owner or admin is required.">
          <div className="flex gap-2"><input className="min-w-0 flex-1 rounded border border-[var(--nim-border)] bg-[var(--nim-bg)] px-3 py-2 text-sm" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /><button type="button" disabled={!orgId || confirmation !== orgId} className="rounded bg-[var(--nim-error)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-40" onClick={() => orgId && void window.electronAPI.organization.deleteOrganization(orgId).then((result) => {
            if (result?.success) {
              setMessage('Organization deleted.');
              // Refresh every org-directory surface so the deleted org stops
              // lingering in the switcher/roster (settings review finding).
              window.dispatchEvent(new CustomEvent('nimbalyst:organizations-changed'));
            } else {
              setMessage(result?.error ?? 'Delete failed');
            }
          })}>Delete</button></div>
        </ActionGuard>
      </div>
      {message && <p className="select-text text-sm">{message}</p>}
      {showMerge && orgId && (
        <MergeOrgWizard
          drainedOrg={{ orgId, name: organizationName || orgId }}
          survivorCandidates={mergeCandidates}
          projectCount={projectCount}
          memberCount={memberCount}
          onClose={() => setShowMerge(false)}
          onMerged={() => {
            setShowMerge(false);
            setMessage('Organization merge finished.');
            window.dispatchEvent(new CustomEvent('nimbalyst:organizations-changed'));
          }}
        />
      )}
    </section>
  );
}
