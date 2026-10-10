import { errorNotificationService } from '../services/ErrorNotificationService';

/**
 * Archive or unarchive one session through the main process.
 * Returns true when the change was saved. When it was not, shows an error
 * so the click is never silent, and returns false. See #282.
 */
export async function saveSessionArchived(sessionId: string, isArchived: boolean): Promise<boolean> {
  const verb = isArchived ? 'archive' : 'unarchive';
  try {
    const result = await window.electronAPI.invoke('sessions:update-metadata', sessionId, { isArchived });
    if (result?.success === false) {
      errorNotificationService.showError(
        `Failed to ${verb} session`,
        result.error ? String(result.error) : `The backend rejected the ${verb} request.`,
      );
      return false;
    }
    return true;
  } catch (err) {
    errorNotificationService.showError(`Failed to ${verb} session`, err instanceof Error ? err.message : String(err));
    return false;
  }
}
