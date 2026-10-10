import { useEffect, useMemo, useState } from 'react';
import {
  mergeGitOperationEntries,
  normalizeGitOperationEntry,
  selectLatestRunningGitOperation,
  selectLatestTerminalGitOperation,
  selectRunningGitOperations,
  type GitOperationLogEvent,
  type GitOperationLogWireEntry,
} from '@nimbalyst/extension-sdk/git-operation-log';

export type GitActivityEntry = GitOperationLogWireEntry & {
  /** The repository whose journal the entry belongs to. */
  repoPath: string;
};

export interface GitActivity {
  /** Every Git command still in flight in the watched repositories, oldest first. */
  runningEntries: GitActivityEntry[];
  /** The one a single-line indicator should name, or undefined when idle. */
  latestRunningEntry: GitActivityEntry | undefined;
  /** The most recently settled command, for post-run feedback. */
  latestTerminalEntry: GitActivityEntry | undefined;
}

const EMPTY_ACTIVITY: GitActivity = {
  runningEntries: [],
  latestRunningEntry: undefined,
  latestTerminalEntry: undefined,
};

/**
 * Project the main-process Git operation journal for the active workspace.
 *
 * This is the same journal the Git extension's Output tab renders, deliberately:
 * before this existed the title bar tracked its own `busyAction` flag, so a push
 * started from the Git panel was invisible up top and the two surfaces could
 * disagree about whether anything was running. Both now read one source.
 *
 * The journal is kept per repository, keyed by the path a command ran in. A
 * workspace spanning several repositories (attached folders, repositories
 * cloned inside it) passes all of them; watching only the root missed every
 * command run in the others.
 *
 * Works with the Git extension disabled -- the journal and its IPC are core
 * services, not extension-owned.
 */
export function useGitActivity(repoPaths: string | readonly string[] | null | undefined): GitActivity {
  const paths = typeof repoPaths === 'string' ? [repoPaths] : (repoPaths ?? []);
  // A stable key, so a fresh array with the same repositories does not resubscribe
  const reposKey = [...new Set(paths.filter(Boolean))].join('\n');
  const [entriesByRepo, setEntriesByRepo] = useState<Record<string, GitActivityEntry[]>>({});

  useEffect(() => {
    // Clear first: without this the previous workspace's running command stays
    // on screen for the length of the new workspace's hydration round-trip.
    setEntriesByRepo({});
    const repos = reposKey ? reposKey.split('\n') : [];
    if (repos.length === 0) return;
    const watched = new Set(repos);
    const tag = (repoPath: string, entry: GitOperationLogWireEntry): GitActivityEntry =>
      ({ ...normalizeGitOperationEntry(entry), repoPath });

    let disposed = false;
    const unsubscribe = window.electronAPI?.on?.(
      'git:operation-log-changed',
      (data: unknown) => {
        if (disposed) return;
        const event = data as GitOperationLogEvent;
        const repoPath = event.workspacePath;
        if (!watched.has(repoPath)) return;
        if (event.type === 'clear') {
          // A cleared journal is one repository's; the others keep their entries
          setEntriesByRepo((current) => {
            const { [repoPath]: _cleared, ...rest } = current;
            return rest;
          });
          return;
        }
        setEntriesByRepo((current) => ({
          ...current,
          [repoPath]: mergeGitOperationEntries(current[repoPath] ?? [], [tag(repoPath, event.entry)]),
        }));
      },
    );

    for (const repoPath of repos) {
      void window.electronAPI
        ?.invoke('git:operation-log:get', repoPath)
        .then((result: unknown) => {
          if (disposed) return;
          const hydrated = (result as GitOperationLogWireEntry[]).map((entry) => tag(repoPath, entry));
          // Live events that landed while the read was in flight are newer than
          // anything it can contain, so they win the merge rather than being
          // overwritten by the older snapshot.
          setEntriesByRepo((current) => ({
            ...current,
            [repoPath]: mergeGitOperationEntries(hydrated, current[repoPath] ?? []),
          }));
        })
        .catch((error: unknown) => {
          console.error('[GitActivity] Failed to hydrate Git operation activity:', error);
        });
    }

    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [reposKey]);

  return useMemo(() => {
    const entries = Object.values(entriesByRepo).flat();
    if (entries.length === 0) return EMPTY_ACTIVITY;
    return {
      runningEntries: selectRunningGitOperations(entries),
      latestRunningEntry: selectLatestRunningGitOperation(entries),
      latestTerminalEntry: selectLatestTerminalGitOperation(entries),
    };
  }, [entriesByRepo]);
}
