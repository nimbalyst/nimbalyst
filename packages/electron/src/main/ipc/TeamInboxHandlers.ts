import { BrowserWindow } from 'electron';

import { getTeamInboxService } from '../services/TeamInboxService';
import { safeHandle } from '../utils/ipcRegistry';

export function registerTeamInboxHandlers(): void {
  const service = getTeamInboxService();
  service.subscribe((snapshot) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('team-inbox:state-changed', snapshot);
      }
    }
  });

  safeHandle('team-inbox:start', async () => service.start());
  safeHandle('team-inbox:refresh', async () => service.refresh());
  safeHandle('team-inbox:get-snapshot', () => service.getSnapshot());
  safeHandle(
    'team-inbox:mark-read',
    async (_event, deliveryIds: string[]) => {
      await service.markRead(deliveryIds);
      return { success: true };
    },
  );
  safeHandle(
    'team-inbox:dismiss',
    async (_event, deliveryId: string) => {
      await service.dismiss(deliveryId);
      return { success: true };
    },
  );
}
