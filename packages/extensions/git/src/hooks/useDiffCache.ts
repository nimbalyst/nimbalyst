import { useEffect, useRef, useState } from 'react';

const ipc = (window as unknown as {
  electronAPI: {
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  };
}).electronAPI;

export type DiffGroup = 'staged' | 'unstaged' | 'untracked' | 'conflicted';

interface DiffCacheEntry {
  diff: string;
  isBinary: boolean;
  fetchedAt: number;
}

interface DiffState {
  diff: string;
  isBinary: boolean;
  loading: boolean;
  error: string | null;
}

const EMPTY: DiffState = { diff: '', isBinary: false, loading: false, error: null };

function cacheKey(workspacePath: string, group: DiffGroup, path: string): string {
  return `${workspacePath}|${group}|${path}`;
}

export function useDiffCache(
  workspacePath: string,
  target: { path: string; group: DiffGroup } | null,
  invalidationToken: number,
): DiffState {
  const [state, setState] = useState<DiffState>(EMPTY);
  const cacheRef = useRef<Map<string, DiffCacheEntry>>(new Map());
  const requestRef = useRef(0);

  // Invalidate the entire cache when the token changes (e.g. git status changed).
  useEffect(() => {
    cacheRef.current.clear();
  }, [invalidationToken]);

  useEffect(() => {
    if (!target) {
      setState(EMPTY);
      return;
    }

    const key = cacheKey(workspacePath, target.group, target.path);
    const cached = cacheRef.current.get(key);
    if (cached) {
      setState({ diff: cached.diff, isBinary: cached.isBinary, loading: false, error: null });
      return;
    }

    const requestId = ++requestRef.current;
    setState({ diff: '', isBinary: false, loading: true, error: null });

    ipc.invoke('git:file-diff', workspacePath, { path: target.path, group: target.group })
      .then((res) => {
        if (requestId !== requestRef.current) return;
        const result = res as { unifiedDiff: string; isBinary: boolean };
        cacheRef.current.set(key, {
          diff: result.unifiedDiff,
          isBinary: result.isBinary,
          fetchedAt: Date.now(),
        });
        setState({
          diff: result.unifiedDiff,
          isBinary: result.isBinary,
          loading: false,
          error: null,
        });
      })
      .catch((err) => {
        if (requestId !== requestRef.current) return;
        setState({
          diff: '',
          isBinary: false,
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }, [workspacePath, target?.path, target?.group, invalidationToken]);

  return state;
}
