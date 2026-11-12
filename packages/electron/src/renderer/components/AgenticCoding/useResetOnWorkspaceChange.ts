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

export interface WorkspaceGuardedRequest<T> {
  isCurrent: () => boolean;
  request: () => Promise<T>;
  onResult?: (result: T) => void | Promise<void>;
  onError?: (error: unknown) => void;
  onSettled?: () => void;
}

/**
 * Runs `request` and applies onResult / onError / onSettled only while `isCurrent`
 * (from `trackRequest`) still says the workspace has not changed. A throwing onResult
 * is routed to onError.
 */
export async function runWorkspaceGuardedRequest<T>(opts: WorkspaceGuardedRequest<T>): Promise<void> {
  try {
    const result = await opts.request();
    if (!opts.isCurrent()) return;
    await opts.onResult?.(result);
  } catch (error) {
    if (!opts.isCurrent()) return;
    opts.onError?.(error);
  } finally {
    if (opts.isCurrent()) opts.onSettled?.();
  }
}
