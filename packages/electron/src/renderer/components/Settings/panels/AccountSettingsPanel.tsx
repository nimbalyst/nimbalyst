import React from 'react';

import { SharedLinksPanel } from '../../GlobalSettings/panels/SharedLinksPanel';
import { SyncPanel } from '../../GlobalSettings/panels/SyncPanel';

/**
 * One Account nav item, one panel. These used to be a single stacked panel
 * (SyncPanel section="all" + SharedLinksPanel) behind every account route,
 * which double-headed the screen ("Account" over "Account & Sync"). Each panel
 * below renders exactly one section and `SyncPanel` supplies its own title.
 */

export function AccountSettingsPanel() {
  return (
    <section className="account-settings-panel" data-testid="account-settings-panel" data-component="AccountSettingsPanel">
      <SyncPanel section="accounts" />
    </section>
  );
}

export function MobileAppSettingsPanel() {
  return (
    <section className="mobile-app-settings-panel" data-testid="mobile-app-settings-panel" data-component="MobileAppSettingsPanel">
      <SyncPanel section="mobile" />
    </section>
  );
}

export function AccountDevicesSettingsPanel() {
  return (
    <section className="account-devices-settings-panel" data-testid="account-devices-settings-panel" data-component="AccountDevicesSettingsPanel">
      <SyncPanel section="devices" />
    </section>
  );
}

export function AccountSharedLinksSettingsPanel() {
  return (
    <section className="account-shared-links-settings-panel" data-testid="account-shared-links-settings-panel" data-component="AccountSharedLinksSettingsPanel">
      <SharedLinksPanel />
    </section>
  );
}
