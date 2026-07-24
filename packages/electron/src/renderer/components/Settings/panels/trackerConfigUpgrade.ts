import type { ConfirmDialogOptions } from '../../../contexts/DialogContext.types';
import type { TrackerSyncMode } from '@nimbalyst/runtime';

export const LOCAL_TRACKER_CONFIG_LOCATION = '.nimbalyst/trackers/*.yaml';
export const SHARED_TRACKER_CONFIG_LOCATION = 'the shared Cloudflare-hosted tracker database';

export function isSharedTrackerMode(mode: TrackerSyncMode): boolean {
  return mode === 'shared' || mode === 'hybrid';
}

export function requiresTrackerUpgradeConfirmation(
  currentMode: TrackerSyncMode,
  nextMode: TrackerSyncMode,
): boolean {
  return currentMode === 'local' && isSharedTrackerMode(nextMode);
}

export function canUpgradeTrackerMode(
  currentMode: TrackerSyncMode,
  nextMode: TrackerSyncMode,
  isAdmin: boolean,
): boolean {
  return !requiresTrackerUpgradeConfirmation(currentMode, nextMode) || isAdmin;
}

export function getTrackerStorageCopy(): string {
  return `Local tracker config is stored in ${LOCAL_TRACKER_CONFIG_LOCATION}. Shared tracker config is stored in ${SHARED_TRACKER_CONFIG_LOCATION}.`;
}

export function buildTrackerUpgradeConfirmOptions(
  trackerDisplayNamePlural: string,
  nextMode: TrackerSyncMode,
): ConfirmDialogOptions {
  const modeLabel = nextMode === 'hybrid' ? 'team-synced' : 'shared';

  return {
    title: `Upgrade ${trackerDisplayNamePlural} to ${modeLabel}?`,
    message: `${trackerDisplayNamePlural} currently use local YAML config from ${LOCAL_TRACKER_CONFIG_LOCATION}. Proceeding will move this tracker config into ${SHARED_TRACKER_CONFIG_LOCATION}. The resulting Kanban config will keep the union of every column already in use, and all tracker items will be preserved. Afterward, you can use your agent to move items, consolidate columns, and delete any extra columns.`,
    confirmLabel: 'Proceed',
    cancelLabel: 'Cancel',
  };
}
