import { useEffect, useRef } from 'react';

/**
 * Calls `reset` when the workspace path changes after mount. The component using
 * this is not remounted on a workspace switch, so per-workspace state (like a
 * search query) has to be cleared explicitly.
 */
export function useResetOnWorkspaceChange(workspacePath: string, reset: () => void): void {
  const previousPath = useRef(workspacePath);
  const resetRef = useRef(reset);
  resetRef.current = reset;

  useEffect(() => {
    if (previousPath.current === workspacePath) return;
    previousPath.current = workspacePath;
    resetRef.current();
  }, [workspacePath]);
}
