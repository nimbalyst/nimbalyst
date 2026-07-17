import React from 'react';
import { SyncPanel } from '../../GlobalSettings/panels/SyncPanel';

export function PersonalMobileAppPanel() {
  return (
    <section className="personal-mobile-app-panel" data-testid="personal-mobile-app-panel" data-component="PersonalMobileAppPanel">
      <SyncPanel section="mobile" />
    </section>
  );
}
