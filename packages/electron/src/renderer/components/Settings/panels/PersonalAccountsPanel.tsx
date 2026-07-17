import React from 'react';
import { SyncPanel } from '../../GlobalSettings/panels/SyncPanel';

export function PersonalAccountsPanel() {
  return (
    <section className="personal-accounts-panel" data-testid="personal-accounts-panel" data-component="PersonalAccountsPanel">
      <SyncPanel section="accounts" />
    </section>
  );
}
