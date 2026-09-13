import { useEffect, useMemo, useState } from 'react';
import {
  findExistingEmbedFilePath,
  getEmbedFilePathCandidates,
} from '@nimbalyst/runtime/editor/plugins/EmbedPlugin/embedFilePaths';

export function useEmbedFilePath(src: string, documentDir: string | null, workspacePath: string | null) {
  const candidates = useMemo(
    () => getEmbedFilePathCandidates(src, documentDir, workspacePath),
    [src, documentDir, workspacePath],
  );
  const [resolved, setResolved] = useState<{
    candidates: string[];
    path: string | null;
    error: string | null;
  } | null>(null);

  useEffect(() => {
    if (candidates.length < 2) return;
    let cancelled = false;
    void findExistingEmbedFilePath(candidates, async (path) => {
      if (!window.electronAPI?.invoke) throw new Error('File lookup IPC not available');
      return await window.electronAPI.invoke('file:exists', path) === true;
    }).then(path => {
      // Keep the preferred path for the normal missing-file error UI.
      if (!cancelled) setResolved({ candidates, path: path ?? candidates[0], error: null });
    }).catch((error: unknown) => {
      if (!cancelled) setResolved({ candidates, path: null, error: String(error) });
    });
    return () => { cancelled = true; };
  }, [candidates]);

  if (candidates.length < 2) return { path: candidates[0] ?? null, pending: false, error: null };
  // Never expose the previous document's target while resolving a new link.
  if (resolved?.candidates !== candidates) return { path: null, pending: true, error: null };
  return { path: resolved.path, pending: false, error: resolved.error };
}
