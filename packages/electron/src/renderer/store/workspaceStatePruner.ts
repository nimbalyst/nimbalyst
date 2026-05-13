/**
 * Workspace state pruner
 *
 * Subscribes to `openProjectsAtom` and, whenever a project is removed
 * (closed from the rail), drops every per-workspace cache that would
 * otherwise grow unbounded. Lives in its own module so the per-atom prune
 * helpers (which import `activeWorkspacePathAtom` from `openProjects.ts`)
 * stay leaf modules and don't pull in their dependent atoms.
 *
 * Call `initWorkspaceStatePruner()` once at renderer startup, after
 * `initOpenProjects()` has hydrated the rail.
 */
import { store } from '@nimbalyst/runtime/store';
import { openProjectsAtom } from './atoms/openProjects';
import { pruneAgentModeWorkspaceState } from './atoms/agentMode';
import { pruneNavigationHistoryWorkspaceState } from './atoms/navigationHistory';
import { pruneWorkspaceLayout } from './atoms/workspaceLayout';
import { pruneCollabDocumentsWorkspaceState } from './atoms/collabDocuments';
import { pruneFileMentionWorkspaceState } from './atoms/fileMention';
import { pruneGitOperationsWorkspaceState } from './atoms/gitOperations';
import { pruneTabsSlot } from '../contexts/TabsContext';

let initialized = false;
let lastSeenPaths = new Set<string>();
let unsubscribe: (() => void) | null = null;

function snapshotPaths(): Set<string> {
  return new Set(store.get(openProjectsAtom).map((p) => p.path));
}

function pruneWorkspace(path: string): void {
  pruneAgentModeWorkspaceState(path);
  pruneNavigationHistoryWorkspaceState(path);
  pruneWorkspaceLayout(path);
  pruneCollabDocumentsWorkspaceState(path);
  pruneFileMentionWorkspaceState(path);
  pruneGitOperationsWorkspaceState(path);
  pruneTabsSlot(path);
}

export function initWorkspaceStatePruner(): void {
  if (initialized) return;
  initialized = true;
  lastSeenPaths = snapshotPaths();

  unsubscribe = store.sub(openProjectsAtom, () => {
    const current = snapshotPaths();
    for (const path of lastSeenPaths) {
      if (!current.has(path)) {
        pruneWorkspace(path);
      }
    }
    lastSeenPaths = current;
  });
}

/** Tear down the subscriber (mostly for tests). */
export function teardownWorkspaceStatePruner(): void {
  unsubscribe?.();
  unsubscribe = null;
  initialized = false;
  lastSeenPaths = new Set();
}
