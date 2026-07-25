import React from 'react';

import type {
  OrganizationDirectoryEntry,
  PersonalAccountSummary,
} from '../../store/atoms/settingsDomains';

export function AccountExpiryBanner({
  accounts,
  organizations,
  onReconnect,
}: {
  accounts: PersonalAccountSummary[];
  organizations: OrganizationDirectoryEntry[];
  onReconnect: (account: PersonalAccountSummary) => void;
}) {
  const expiredAccount = accounts.find((account) => account.sessionStatus === 'expired');
  if (!expiredAccount) return null;
  const affectedOrganizations = organizations
    .filter((organization) => organization.sourcePersonalOrgId === expiredAccount.personalOrgId
      || organization.owningPersonalOrgId === expiredAccount.personalOrgId)
    .map((organization) => organization.name);
  const email = expiredAccount.email ?? expiredAccount.personalOrgId;

  return (
    <aside className="account-expiry-banner flex items-center justify-between gap-3 border-b border-[var(--nim-warning)] bg-[color-mix(in_srgb,var(--nim-warning)_10%,var(--nim-bg))] px-4 py-2.5" data-component="AccountExpiryBanner" data-testid="account-expiry-banner">
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--nim-bg-tertiary)] text-xs font-semibold">{(email[0] ?? '?').toUpperCase()}</span>
        <div className="min-w-0">
          <p className="m-0 truncate select-text text-xs"><strong>{email}</strong>&apos;s session expired</p>
          <p className="m-0 mt-0.5 truncate text-[11px] text-[var(--nim-warning)]">
            {affectedOrganizations.length > 0
              ? `Team collaboration for ${affectedOrganizations.join(', ')} is paused until you reconnect.`
              : 'Account access is paused until you reconnect.'}
          </p>
        </div>
      </div>
      <button type="button" aria-label={`Reconnect ${email}`} className="shrink-0 rounded-md bg-[var(--nim-warning)] px-3 py-1.5 text-xs font-semibold text-neutral-950" onClick={() => onReconnect(expiredAccount)}>Reconnect</button>
    </aside>
  );
}
