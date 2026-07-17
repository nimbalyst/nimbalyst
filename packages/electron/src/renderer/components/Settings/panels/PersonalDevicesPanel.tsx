import React from 'react';
import { SyncPanel } from '../../GlobalSettings/panels/SyncPanel';

export function PersonalDevicesPanel() {
  return (
    <section className="personal-devices-panel" data-testid="personal-devices-panel" data-component="PersonalDevicesPanel">
      <SyncPanel section="devices" />
    </section>
  );
}
