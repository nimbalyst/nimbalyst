import { activateRailProject } from '../store/actions/activateRailProject';

const WORKSPACE_POLL_MS = 50;

/**
 * Open a file for the extension_test_open_file tool through App's
 * `__handleWorkspaceFileSelect`, which switches to Files mode, loads the file,
 * and creates a tab with the right extension editor.
 *
 * Main routes the request to the window whose rail holds `workspacePath`, which
 * may be showing another rail project. The rail switches first, then this waits
 * for App to re-expose the handler for that project; calling the handler
 * captured before the switch would open the file under the old project.
 */
export async function selectFileForExtensionTest(
  filePath: string,
  workspacePath: string | undefined,
  timeoutMs: number,
): Promise<void> {
  if (workspacePath) {
    if (!(await activateRailProject(workspacePath))) {
      throw new Error(`Could not switch this window to ${workspacePath}.`);
    }
    const startTime = Date.now();
    while ((window as any).__workspacePath !== workspacePath) {
      if (Date.now() - startTime >= timeoutMs) {
        throw new Error(`Timed out waiting for this window to show ${workspacePath}.`);
      }
      await new Promise(resolve => setTimeout(resolve, WORKSPACE_POLL_MS));
    }
  }

  const handler = (window as any).__handleWorkspaceFileSelect;
  if (!handler) {
    console.warn('[ExtensionSystem] __handleWorkspaceFileSelect not available');
    return;
  }
  await handler(filePath);
}
