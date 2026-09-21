import { safeHandle } from '../utils/ipcRegistry';
import type { OrganizationDirectoryEntry, OrganizationDirectoryResult } from '../../shared/organizationDirectory';

export function registerOrganizationDirectoryHandler(
  list: (options?: { forceFresh?: boolean }) => Promise<{ teams: OrganizationDirectoryEntry[]; complete: boolean }>,
  invalidate: () => void,
): void {
  safeHandle('team:list', async (_event, options?: { forceRefresh?: boolean }): Promise<OrganizationDirectoryResult> => {
    try {
      // Manual refresh must not join a request issued before a membership change.
      if (options?.forceRefresh) invalidate();
      const directory = await list(options?.forceRefresh ? { forceFresh: true } : undefined);
      return directory.complete
        ? { success: true, complete: true, teams: directory.teams }
        : { success: false, complete: false, teams: directory.teams, retryable: true,
          error: 'Some organizations could not be loaded. Retrying may restore the list.' };
    } catch (error) {
      return { success: false, complete: false, teams: [], retryable: true,
        error: error instanceof Error ? error.message : String(error) };
    }
  });
}
