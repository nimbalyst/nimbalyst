/**
 * The organizations a single signed-in login belongs to, rendered inline under
 * its account row in Account settings. This is the one place that answers
 * "which organizations am I in, and under which login?" — and the universal
 * entry point into the org management window for any of them.
 *
 * Data comes from `groupOrganizationsByAccount`; this component only renders and
 * dispatches actions (no IPC subscriptions — the central Stytch listener owns
 * the atoms, see IPC_LISTENERS.md).
 */

import React, { useState } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';

import { AlphaBadge } from '../../common/AlphaBadge';
import { TEAM_ALPHA_TOOLTIP } from '../../common/TeamAlphaNotice';
import type { AccountOrganizationEntry, AccountOrganizationGroup } from './accountOrganizations';

function openOrgWindow(orgId?: string) {
  void window.electronAPI?.team?.openManagementWindow(orgId ? { orgId } : undefined);
}

/** Tell the app the directory changed so the central listener re-runs team:list. */
function announceOrganizationsChanged() {
  window.dispatchEvent(new CustomEvent('nimbalyst:organizations-changed'));
}

function RoleBadge({ role }: { role: string }) {
  const normalized = (role || 'member').toLowerCase();
  const isPrivileged = normalized === 'owner' || normalized === 'admin';
  return (
    <span
      className={`account-org-role-badge rounded-full px-1.5 py-0.5 text-[10px] font-semibold capitalize ${
        isPrivileged
          ? 'bg-[color-mix(in_srgb,var(--nim-primary)_16%,transparent)] text-[var(--nim-primary)]'
          : 'bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-muted)]'
      }`}
      data-testid="account-org-role-badge"
    >
      {normalized}
    </span>
  );
}

function AccountOrgRow({ organization }: { organization: AccountOrganizationEntry }) {
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleAccept = async () => {
    setAccepting(true);
    setError(null);
    try {
      const result = await window.electronAPI?.team?.acceptInvite(organization.orgId);
      if (result?.success) {
        announceOrganizationsChanged();
      } else {
        setError(result?.error || 'Could not accept the invitation');
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setAccepting(false);
    }
  };

  return (
    <article
      className="account-org-row flex items-center gap-2 rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg)] px-2.5 py-1.5"
      data-testid="account-org-row"
      data-org-id={organization.orgId}
    >
      <MaterialSymbol icon="corporate_fare" size={16} className="shrink-0 text-[var(--nim-text-muted)]" />
      <div className="account-org-summary min-w-0 flex-1 select-text">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[13px] text-[var(--nim-text)]">{organization.name}</span>
          <RoleBadge role={organization.role} />
          {organization.isPending && (
            <span
              className="account-org-pending-badge rounded-full bg-[color-mix(in_srgb,var(--nim-warning)_16%,transparent)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--nim-warning)]"
              data-testid="account-org-pending-badge"
            >
              Invite pending
            </span>
          )}
        </div>
        <div className="mt-0.5 truncate text-[11px] text-[var(--nim-text-muted)]">
          {organization.isPending
            ? 'Accept to join this organization'
            : organization.projectCount === undefined
              ? 'Active member'
              : `${organization.projectCount} ${organization.projectCount === 1 ? 'project' : 'projects'}`}
          {organization.alsoReachableBy.length > 0 && ` · also signed in as ${organization.alsoReachableBy.join(', ')}`}
        </div>
        {error && <div className="mt-0.5 text-[11px] text-[var(--nim-error)]">{error}</div>}
      </div>
      {/*
        Accept is the only action on a pending row: the org window resolves its
        target against active memberships only, so a Manage button there would
        drop the user on the generic unbound surface.
      */}
      <div className="account-org-actions flex shrink-0 items-center gap-1.5">
        {organization.isPending ? (
          <button
            type="button"
            onClick={handleAccept}
            disabled={accepting}
            className="rounded border border-[var(--nim-primary)] bg-transparent px-2.5 py-1 text-[11px] text-[var(--nim-primary)] hover:bg-[var(--nim-bg-hover)] disabled:opacity-60"
            data-testid="account-org-accept-invite"
          >
            {accepting ? 'Accepting…' : 'Accept'}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => openOrgWindow(organization.orgId)}
            className="rounded border border-[var(--nim-border)] bg-transparent px-2.5 py-1 text-[11px] text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]"
            data-testid="account-org-manage"
          >
            Manage
          </button>
        )}
      </div>
    </article>
  );
}

export function AccountOrgList({ group }: { group: AccountOrganizationGroup }) {
  return (
    <div className="account-org-list mt-2 flex flex-col gap-1.5 pl-3" data-testid="account-org-list">
      {group.organizations.map((organization) => (
        <AccountOrgRow key={organization.orgId} organization={organization} />
      ))}
      {group.organizations.length === 0 && (
        <p className="account-org-empty m-0 text-[11px] text-[var(--nim-text-muted)]" data-testid="account-org-empty">
          No organizations
        </p>
      )}
      <div className="account-org-new-row flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => openOrgWindow()}
          className="account-org-new self-start rounded border border-dashed border-[var(--nim-border)] bg-transparent px-2.5 py-1 text-[11px] text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)]"
          data-testid="account-org-new"
        >
          New organization
        </button>
        <AlphaBadge size="xs" tooltip={TEAM_ALPHA_TOOLTIP} />
      </div>
    </div>
  );
}
