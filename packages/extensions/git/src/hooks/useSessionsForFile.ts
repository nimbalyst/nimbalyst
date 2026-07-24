import { useEffect, useRef, useState } from 'react';

const ipc = (window as unknown as {
  electronAPI: {
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
    on?: (channel: string, listener: (...args: unknown[]) => void) => () => void;
  };
}).electronAPI;

export interface SessionEditEntry {
  sessionId: string;
  title: string;
  provider: string;
  lastEditAt: number;
  linesAdded: number;
  linesRemoved: number;
  editCount: number;
}

interface State {
  data: SessionEditEntry[];
  loading: boolean;
  error: string | null;
}

const EMPTY: State = { data: [], loading: false, error: null };

interface FileLinkRow {
  id: string;
  sessionId: string;
  filePath: string;
  linkType: string;
  timestamp: number;
  metadata?: Record<string, unknown> & {
    linesAdded?: number;
    linesRemoved?: number;
  };
}

interface SessionListEntry {
  id: string;
  title?: string;
  provider?: string;
  updatedAt?: number;
}

/**
 * Returns the list of AI sessions that have an "edited" FileLink for the given file.
 * Fetches session metadata + per-file edit aggregates. Auto-refreshes when any
 * session's file links change (`session-files:updated` broadcast).
 *
 * `absoluteFilePath` MUST be the absolute path on disk — that's the form the
 * attribution service stores in `session_files.file_path`.
 */
export function useSessionsForFile(
  workspacePath: string,
  absoluteFilePath: string | null,
): State {
  const [state, setState] = useState<State>(EMPTY);
  const requestRef = useRef(0);

  useEffect(() => {
    if (!absoluteFilePath) {
      setState(EMPTY);
      return;
    }

    let cancelled = false;
    const requestId = ++requestRef.current;

    const fetchAll = async (): Promise<void> => {
      setState(prev => ({ ...prev, loading: true, error: null }));

      try {
        // Step 1: which sessions have an "edited" link to this file
        const sessionsRes = await ipc.invoke(
          'session-files:get-sessions-by-file',
          workspacePath,
          absoluteFilePath,
          'edited',
        ) as { success: boolean; sessionIds: string[]; error?: string };

        if (!sessionsRes?.success) {
          throw new Error(sessionsRes?.error || 'Failed to fetch sessions for file');
        }

        const sessionIds = sessionsRes.sessionIds ?? [];
        if (sessionIds.length === 0) {
          if (!cancelled && requestId === requestRef.current) {
            setState({ data: [], loading: false, error: null });
          }
          return;
        }

        // Step 2: fetch session metadata via the workspace session list,
        // and file links in parallel.
        const [allSessions, linksRes] = await Promise.all([
          ipc.invoke('sessions:list', workspacePath, { includeArchived: true })
            .then(r => {
              const wrapped = r as { success?: boolean; sessions?: SessionListEntry[] } | SessionListEntry[] | null;
              if (Array.isArray(wrapped)) return wrapped;
              return wrapped?.sessions ?? [];
            })
            .catch(() => [] as SessionListEntry[]),
          ipc.invoke('session-files:get-by-sessions', sessionIds, 'edited')
            .then(r => r as { success: boolean; files: FileLinkRow[]; error?: string })
            .catch(() => ({ success: false, files: [] as FileLinkRow[], error: 'Fetch failed' })),
        ]);

        if (cancelled || requestId !== requestRef.current) return;

        const sessionById = new Map<string, SessionListEntry>(
          allSessions.map(s => [s.id, s]),
        );
        const links = linksRes?.success ? (linksRes.files ?? []) : [];

        // Aggregate per-session edits to the focused file
        const aggregates = new Map<string, { lastEditAt: number; added: number; removed: number; count: number }>();
        for (const link of links) {
          if (link.filePath !== absoluteFilePath) continue;
          const agg = aggregates.get(link.sessionId) ?? { lastEditAt: 0, added: 0, removed: 0, count: 0 };
          agg.count++;
          agg.added += link.metadata?.linesAdded ?? 0;
          agg.removed += link.metadata?.linesRemoved ?? 0;
          if (link.timestamp > agg.lastEditAt) agg.lastEditAt = link.timestamp;
          aggregates.set(link.sessionId, agg);
        }

        const entries: SessionEditEntry[] = sessionIds
          .map(id => {
            const meta = sessionById.get(id);
            if (!meta) return null;
            const agg = aggregates.get(id);
            return {
              sessionId: id,
              title: meta.title || 'Untitled session',
              provider: meta.provider || 'unknown',
              lastEditAt: agg?.lastEditAt ?? meta.updatedAt ?? 0,
              linesAdded: agg?.added ?? 0,
              linesRemoved: agg?.removed ?? 0,
              editCount: agg?.count ?? 0,
            };
          })
          .filter((e): e is SessionEditEntry => e !== null)
          .sort((a, b) => b.lastEditAt - a.lastEditAt);

        setState({ data: entries, loading: false, error: null });
      } catch (err) {
        if (cancelled || requestId !== requestRef.current) return;
        setState({
          data: [],
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    fetchAll();

    // Refetch on session-files:updated broadcasts
    let cleanup: (() => void) | null = null;
    if (typeof ipc.on === 'function') {
      cleanup = ipc.on('session-files:updated', () => {
        fetchAll();
      });
    }

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [workspacePath, absoluteFilePath]);

  return state;
}
