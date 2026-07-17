import React from 'react';
import { SecurityEncryptionSection } from './H2EncryptionMigration';

export function OrganizationSecurityPanel({ orgId }: { orgId?: string }) {
  return (
    <section className="organization-security-panel" data-testid="organization-security-panel" data-component="OrganizationSecurityPanel">
      <header className="mb-5 border-b border-[var(--nim-border)] pb-4"><h2 className="m-0 text-xl font-semibold">Security</h2><p className="m-0 mt-1 text-sm text-[var(--nim-text-muted)]">Organization collaboration encryption status.</p></header>
      {orgId ? <SecurityEncryptionSection orgId={orgId} isAdmin={false} /> : <p className="text-sm text-[var(--nim-text-muted)]">Choose an organization.</p>}
    </section>
  );
}
