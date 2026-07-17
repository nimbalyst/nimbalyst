import React from 'react';

import { SharedLinksPanel } from '../../GlobalSettings/panels/SharedLinksPanel';
import { SyncPanel } from '../../GlobalSettings/panels/SyncPanel';

export function AccountSettingsPanel() {
  return (
    <section className="account-settings-panel flex flex-col gap-8" data-testid="account-settings-panel" data-component="AccountSettingsPanel">
      <div className="account-settings-panel-header">
        <h2 className="m-0 text-lg font-semibold text-[var(--nim-text)]">Account</h2>
        <p className="m-0 mt-1 text-[13px] text-[var(--nim-text-muted)]">
          Signed-in accounts, personal sync, mobile pairing, devices, and links created by each account.
        </p>
      </div>
      <SyncPanel section="all" />
      <SharedLinksPanel />
    </section>
  );
}
