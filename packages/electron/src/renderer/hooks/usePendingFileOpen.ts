import { useEffect, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import { useTabsActions, useTabsHydrated } from '../contexts/TabsContext';
import { pendingFileOpensAtom, refreshPendingFileOpens, acknowledgePendingFileOpen } from '../store/listeners/fileOpenListeners';
import { handleWorkspaceFileSelect } from '../utils/workspaceFileOperations';

/** Mounted by the real Files editor, after App's workspace/extension gate. */
export function usePendingFileOpen(workspacePath: string, revealFiles: () => void): void {
  const requests = useAtomValue(pendingFileOpensAtom);
  const hydrated = useTabsHydrated();
  const tabs = useTabsActions();
  const current = useRef({ tabs, revealFiles, workspacePath });
  current.current = { tabs, revealFiles, workspacePath };
  const [loadedWorkspace, setLoadedWorkspace] = useState<string | null>(null);
  const request = requests.find(candidate => !candidate.workspacePath || candidate.workspacePath === workspacePath);

  useEffect(() => {
    let cancelled = false;
    setLoadedWorkspace(null);
    // Pull only after the listener exists; merging IDs covers a live delivery
    // concurrent with the snapshot. Wait for this pull to preserve FIFO order.
    refreshPendingFileOpens(workspacePath, () => !cancelled)
      .catch(error => console.error('[FileOpen] Failed to recover pending opens:', error))
      // A failed pull still has to unblock live opens for this workspace.
      .then(() => { if (!cancelled) setLoadedWorkspace(workspacePath); });
    return () => { cancelled = true; };
  }, [workspacePath]);

  useEffect(() => {
    if (!hydrated || loadedWorkspace !== workspacePath || !request) return;
    let cancelled = false;
    const actions = current.current.tabs;
    const snapshot = actions.getSnapshot();
    void (async () => {
      let opened = false;
      try {
        opened = await handleWorkspaceFileSelect({
          filePath: request.path,
          currentFilePath: null,
          tabs: { ...actions, tabs: snapshot.tabOrder.map(id => snapshot.tabs.get(id)) },
          isInitializedRef: { current: false },
          // An async disk read must not add to a different workspace's mutable
          // tabs slot after a rail switch or editor unmount.
          isCurrent: () => !cancelled && current.current.workspacePath === workspacePath,
        });
      } catch (error) {
        console.error('[FileOpen] Failed to open pending file:', error);
      }
      if (cancelled || current.current.workspacePath !== workspacePath) return;
      if (opened) current.current.revealFiles();
      // A reported failure is terminal too; it must not block later requests.
      await acknowledgePendingFileOpen(request, workspacePath);
    })().catch(error => console.error('[FileOpen] Failed to acknowledge pending file open:', error));
    return () => { cancelled = true; };
  }, [hydrated, loadedWorkspace, workspacePath, request]);
}
