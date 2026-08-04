/**
 * Persistence for which sidebar extension panel (if any) is open, so it
 * survives a full window reload. Fullscreen and bottom-placement panels are
 * intentionally not restored -- only a `sidebar` panel is safe to reopen
 * automatically, since fullscreen panels replace the whole content area.
 */
interface WorkspaceState {
  activeExtensionPanel?: unknown;
  [key: string]: unknown;
}

/** Save the active sidebar extension panel id (or its absence) to workspace state. */
export async function persistActiveExtensionPanel(
  workspacePath: string,
  panelId: string | null,
): Promise<void> {
  try {
    await window.electronAPI?.invoke?.('workspace:update-state', workspacePath, {
      activeExtensionPanel: panelId,
    });
  } catch (err) {
    console.warn('[activeExtensionPanelPersistence] Failed to persist active extension panel:', err);
  }
}

/**
 * Load the persisted panel id. `isSidebarPanel` is called to confirm the
 * stored id still resolves to a registered `sidebar`-placement panel --
 * guards against a stale id from an extension that was since disabled,
 * removed, or changed placement.
 */
export async function loadActiveExtensionPanel(
  workspacePath: string,
  isSidebarPanel: (panelId: string) => boolean,
): Promise<string | null> {
  try {
    const state = (await window.electronAPI?.invoke?.(
      'workspace:get-state',
      workspacePath,
    )) as WorkspaceState | undefined;
    return resolveActiveExtensionPanel(state, isSidebarPanel);
  } catch {
    return null;
  }
}

/** Internal: decide whether the persisted id should be restored. Exported for tests. */
export function resolveActiveExtensionPanel(
  state: WorkspaceState | undefined,
  isSidebarPanel: (panelId: string) => boolean,
): string | null {
  const stored = state?.activeExtensionPanel;
  if (typeof stored !== 'string' || !stored) return null;
  return isSidebarPanel(stored) ? stored : null;
}
