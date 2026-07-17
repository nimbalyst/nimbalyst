import { useCallback, useEffect, useState } from 'react';

const ipc = (window as unknown as {
  electronAPI: {
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  };
}).electronAPI;

export interface OperationLogEntry {
  id: string;
  timestamp: Date;
  updatedAt: number;
  command: string;
  executable: 'git';
  args: string[];
  cwd: string;
  status: 'running' | 'success' | 'error' | 'interrupted';
  output: string;
  stdout: string;
  stderr: string;
  error?: string;
  suggestion?: string;
  exitCode?: number;
  durationMs?: number;
}

interface WireOperationLogEntry extends Omit<OperationLogEntry, 'timestamp' | 'suggestion'> {
  timestamp: number;
}

type OperationLogEvent =
  | { workspacePath: string; type: 'upsert'; entry: WireOperationLogEntry }
  | { workspacePath: string; type: 'clear' };

type WorkspaceEventSubscriber = (
  event: string,
  callback: (data: unknown) => void,
) => () => void;

function normalizeEntry(entry: WireOperationLogEntry): OperationLogEntry {
  return {
    ...entry,
    timestamp: new Date(entry.timestamp),
    suggestion: entry.error ? getSuggestionForError(entry.error) : undefined,
  };
}

export function mergeOperationEntries(
  current: OperationLogEntry[],
  incoming: OperationLogEntry[],
): OperationLogEntry[] {
  const byId = new Map(current.map(entry => [entry.id, entry]));
  for (const entry of incoming) {
    const existing = byId.get(entry.id);
    if (!existing || entry.updatedAt >= existing.updatedAt) {
      byId.set(entry.id, entry);
    }
  }
  return Array.from(byId.values()).sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
}

/** Main-process journal projection. Renderer reloads cannot lose Git output. */
export function useOperationLog(
  workspacePath: string,
  subscribeToWorkspaceEvent: WorkspaceEventSubscriber,
) {
  const [entries, setEntries] = useState<OperationLogEntry[]>([]);

  useEffect(() => {
    let disposed = false;
    setEntries([]);
    const unsubscribe = subscribeToWorkspaceEvent('git:operation-log-changed', data => {
      if (disposed) return;
      const event = data as OperationLogEvent;
      if (event.type === 'clear') {
        setEntries([]);
        return;
      }
      setEntries(current => mergeOperationEntries(current, [normalizeEntry(event.entry)]));
    });

    void ipc.invoke('git:operation-log:get', workspacePath)
      .then(result => {
        if (disposed) return;
        const hydrated = (result as WireOperationLogEntry[]).map(normalizeEntry);
        // Preserve live events that arrived while the initial read was in flight.
        setEntries(current => mergeOperationEntries(hydrated, current));
      })
      .catch(error => {
        console.error('[GitOperationLog] Failed to hydrate operation history:', error);
      });

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [workspacePath, subscribeToWorkspaceEvent]);

  const clearLog = useCallback(async () => {
    setEntries([]);
    await ipc.invoke('git:operation-log:clear', workspacePath);
  }, [workspacePath]);

  /** Existing call-site compatibility; recording now happens in Electron main. */
  const withLog = useCallback(async <T>(
    _command: string,
    operation: () => Promise<T>,
    _opts?: {
      formatOutput?: (result: T) => string | undefined;
      formatSuggestion?: (result: T) => string | undefined;
      isError?: (result: T) => boolean;
      getError?: (result: T) => string | undefined;
    },
  ): Promise<T> => operation(), []);

  return { entries, clearLog, withLog };
}

/** Map common git errors to actionable suggestions */
export function getSuggestionForError(error: string): string | undefined {
  const lower = error.toLowerCase();

  if (lower.includes('non-fast-forward') || lower.includes('rejected')) {
    return 'Pull changes first, then push again.';
  }
  if (lower.includes('uncommitted changes') || lower.includes('your local changes')) {
    return 'Commit or stash your changes first.';
  }
  if (lower.includes('authentication') || lower.includes('permission denied') || lower.includes('could not read from remote')) {
    return 'Check your credentials or SSH key configuration.';
  }
  if (lower.includes('lock') || lower.includes('index.lock')) {
    return 'Another git process may be running. If not, remove the lock file.';
  }
  if (lower.includes('conflict')) {
    return 'Resolve the conflicts, then continue or abort the operation.';
  }
  if (lower.includes('detached head')) {
    return 'Create a branch to save your work.';
  }
  return undefined;
}
