/**
 * Console links main hands to this window instead of the browser
 * (`main/services/consoleLinks/consoleLinkRouter.ts`). The window opens the
 * target when it can and always answers, so main knows whether to fall back
 * to the browser. Also installs the link new typed-page references are
 * written with.
 */
import { errorNotificationService } from '../../services/ErrorNotificationService';
import { installTrackerReferenceLinks, openConsoleLinkInWindow } from '../../utils/openConsoleLink';

interface ConsoleLinkOpenRequest {
  requestId: string;
  url: string;
  fromDeepLink: boolean;
}

export function initConsoleLinkListeners(): () => void {
  const uninstallReferenceLinks = installTrackerReferenceLinks();
  const unsubscribe = window.electronAPI.on('console-link:open', (request: ConsoleLinkOpenRequest) => {
    let handled = false;
    try {
      handled = openConsoleLinkInWindow(request.url);
    } catch (error) {
      console.error('[ConsoleLinks] Failed to open console link:', request.url, error);
    }
    if (!handled && request.fromDeepLink) {
      // From the console, so the browser has already declined it.
      errorNotificationService.showWarning(
        'Not in this project',
        'Open the project this link belongs to, then try the link again.',
        { duration: 6000 },
      );
    }
    window.electronAPI.send('console-link:result', { requestId: request.requestId, handled });
  });
  return () => {
    unsubscribe();
    uninstallReferenceLinks();
  };
}
