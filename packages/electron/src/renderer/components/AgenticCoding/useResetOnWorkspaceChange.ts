import { useCallback, useEffect, useRef } from 'react';

/**
 * Calls `reset` when the workspace path changes after mount. The component using
 * this is not remounted on a workspace switch, so per-workspace state (like a
 * search query) has to be cleared explicitly.
 *
 * Returns `trackRequest`: call it before an await, and call the function it returns
 * after the await to learn whether the workspace is still the one the request started in.
 */
export function useResetOnWorkspaceChange(workspacePath: string, reset: () => void): () => () => boolean {
  const previousPath = useRef(workspacePath);
  const generation = useRef(0);
  const resetRef = useRef(reset);
  resetRef.current = reset;

  useEffect(() => {
    if (previousPath.current === workspacePath) return;
    previousPath.current = workspacePath;
    generation.current++;
    resetRef.current();
  }, [workspacePath]);

  return useCallback(() => {
    const started = generation.current;
    return () => generation.current === started;
  }, []);
}
