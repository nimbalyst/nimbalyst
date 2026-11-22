/**
 * Central listener for projects dragged out of this window's rail.
 *
 * When another window's rail takes a dropped project, or the project is torn
 * off into a new window, main sends `workspace:rail-release-project` to the
 * window the drag started in. The project leaves this rail; its sessions keep
 * running in main and pick up in the window that now hosts it.
 */

import { store } from '../index';
import { removeProjectFromRail } from '../actions/railProjects';

export function initRailProjectListeners(): () => void {
  return window.electronAPI.on('workspace:rail-release-project', (data: { workspacePath: string }) => {
    if (!data?.workspacePath) return;
    void removeProjectFromRail(store, data.workspacePath);
  });
}
