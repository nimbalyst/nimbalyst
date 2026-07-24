export interface TrackerPersonalStateDto {
  userEmail: string;
  scope: string;
  itemId: string;
  isFavorite: boolean;
  favoriteUpdatedAt: number;
  lastOpenedAt: number | null;
  /** Epoch ms until which the triage inbox hides this item; null = not snoozed. */
  snoozedUntil: number | null;
  updatedAt: number;
}

export interface TrackerPersonalStateHydration {
  scope: string;
  rows: TrackerPersonalStateDto[];
}

interface IPCResponse<T> { success: boolean; data?: T; error?: string }

function unwrap<T>(response: IPCResponse<T>, label: string): T {
  if (!response?.success || response.data === undefined) {
    throw new Error(response?.error || `${label} failed`);
  }
  return response.data;
}

export const trackerPersonalStateService = {
  async getForScope(workspacePath: string): Promise<TrackerPersonalStateHydration> {
    return unwrap(await window.electronAPI.invoke('tracker-personal-state:get-for-scope', workspacePath), 'get tracker personal state');
  },
  async setFavorite(input: { itemId: string; isFavorite: boolean; favoriteUpdatedAt: number; workspacePath: string }): Promise<TrackerPersonalStateDto | null> {
    const { workspacePath, ...payload } = input;
    return unwrap(await window.electronAPI.invoke('tracker-personal-state:set-favorite', payload, workspacePath), 'set tracker favorite');
  },
  async recordOpened(input: { itemId: string; lastOpenedAt: number; workspacePath: string }): Promise<TrackerPersonalStateDto | null> {
    const { workspacePath, ...payload } = input;
    return unwrap(await window.electronAPI.invoke('tracker-personal-state:record-opened', payload, workspacePath), 'record tracker open');
  },
  async setSnooze(input: { itemId: string; snoozedUntil: number | null; workspacePath: string }): Promise<TrackerPersonalStateDto | null> {
    const { workspacePath, ...payload } = input;
    return unwrap(await window.electronAPI.invoke('tracker-personal-state:set-snooze', payload, workspacePath), 'snooze tracker item');
  },
};
