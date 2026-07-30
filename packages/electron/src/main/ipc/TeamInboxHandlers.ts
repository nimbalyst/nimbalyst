import { BrowserWindow } from 'electron';

import { createTeamInboxNotificationService } from '../services/TeamInboxNativeNotification';
import {
  getTeamInboxService,
  shutdownTeamInboxService,
} from '../services/TeamInboxService';
import { getSettingsService } from '../services/SettingsService';
import { safeHandle } from '../utils/ipcRegistry';
import { logger } from '../utils/logger';

export interface TeamInboxHandlerDependencies {
  openInboxSource: (url: string) => Promise<boolean>;
}

let cleanupSubscriptions: (() => void) | null = null;

export function registerTeamInboxHandlers(
  dependencies: TeamInboxHandlerDependencies,
): void {
  if (cleanupSubscriptions) return;
  const service = getTeamInboxService();
  const unsubscribeSettings = getSettingsService().subscribe((key, value) => {
    if (key !== 'team.presence.status') return;
    if (value === 'online' || value === 'away') {
      service.setPresenceStatus(value);
    }
  });
  const notificationService = createTeamInboxNotificationService(
    dependencies.openInboxSource,
  );
  const unsubscribeDeliveries = service.subscribeNewDelivery((delivery) => {
    void notificationService.notify(delivery).catch((error) => {
      logger.main.warn(
        '[TeamInboxNotification] Failed to process live delivery:',
        error,
      );
    });
  });
  const unsubscribeSnapshots = service.subscribe((snapshot) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('team-inbox:state-changed', snapshot);
      }
    }
  });
  cleanupSubscriptions = () => {
    unsubscribeSnapshots();
    unsubscribeDeliveries();
    unsubscribeSettings();
  };

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

export function shutdownTeamInboxHandlers(): void {
  cleanupSubscriptions?.();
  cleanupSubscriptions = null;
  shutdownTeamInboxService();
}
