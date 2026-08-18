/**
 * Shared "project rail is full" toast.
 *
 * Lives outside `ProjectRail.tsx` because the rail is not the only way a
 * project reaches the rail: `rail:add-project` arrives from the main process
 * (deep link, notification click, Open Recent, tutorial, MCP `workspace_open`)
 * and has no `+` button to disable, so `store/listeners/railProjectListeners.ts`
 * needs the same feedback. Importing it from the component would drag the whole
 * rail component tree into a listener module.
 */

import { errorNotificationService } from '../../services/ErrorNotificationService';
import { MAX_OPEN_PROJECTS } from '../atoms/openProjects';

/**
 * `allowDuplicate` bypasses the service's 5s dedup window so a second attempt
 * at the cap still produces feedback rather than appearing to do nothing.
 */
export function showRailFullNotification(): void {
  errorNotificationService.showWarning(
    'Project rail is full',
    `You can have at most ${MAX_OPEN_PROJECTS} projects open in this window. Close one from the rail, or open this project in a new window.`,
    { duration: 6000, allowDuplicate: true }
  );
}
