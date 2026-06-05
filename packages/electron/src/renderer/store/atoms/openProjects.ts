/**
 * Open Projects state
 *
 * Tracks the list of workspace projects warm in the multi-project rail and
 * which one is currently visible. The rail is opt-in: when
 * `multiProjectModeAtom` is `false`, the rail stays hidden and the host
 * window keeps the legacy "one project per window" behavior.
 *
 * `activeWorkspacePathAtom` is the single source of truth for the path
 * read by per-workspace atom families (agent layout, navigation history,
 * sidebar widths, etc.). It replaces the module-level `currentWorkspacePath`
 * variables that previously lived in `agentMode.ts` and
 * `navigationHistory.ts`.
 */

import { atom, type createStore } from 'jotai';
import { store } from '@nimbalyst/runtime/store';
import { clearWorkspaceActivityAtom } from './sessionActivity';
import { activeSessionIdAtom, selectedWorkstreamAtom } from './sessions';
import { workstreamActiveChildAtom } from './workstreamState';

type JotaiStore = ReturnType<typeof createStore>;

export interface OpenProject {
  /** Canonical absolute path; same key used by per-workspace atom families. */
  path: string;
  /** Display name. Derived from `path.basename(path)` on the renderer. */
  name: string;
  /** ms epoch when the project was added to the rail. */
  openedAt: number;
}

interface InitialWorkspaceWindowState {
  mode: 'workspace';
  workspacePath?: string;
  activeWorkspacePath?: string | null;
  openProjectPaths?: string[];
}

interface ResolveInitialOpenProjectsInput {
  persistedPaths: string[];
  persistedActivePath: string | null;
  restorePreviousProjects: boolean;
  windowState: InitialWorkspaceWindowState | null;
}

const MAX_OPEN_PROJECTS = 8;

/**
 * Path of the workspace currently visible in this window.
 *
 * Read by per-workspace atom families to resolve which workspace's state
 * to expose. Written when a workspace becomes the focused project — by
 * `initAgentModeLayout` / `initNavigationHistory` for single-project flow,
 * by the project rail click handler in multi-project mode.
 */
export const activeWorkspacePathAtom = atom<string | null>(null);

/**
 * Whether multi-project mode is enabled. When false, rail UI is hidden and
 * opening a new project spawns a fresh window (legacy behavior). When true,
 * opening a project adds it to the rail in the current window.
 *
 * Persisted via `app:set-multi-project-mode` IPC; seeded from store on
 * launch by an effect that reads `app:get-multi-project-mode`.
 */
export const multiProjectModeAtom = atom<boolean>(false);

/**
 * When true, the rail rehydrates with the projects that were open at last
 * app close. When false (default), the rail starts with only the project
 * the user picked from the launch screen; additional projects are added
 * explicitly via the `+` button.
 */
export const restorePreviousProjectsAtom = atom<boolean>(false);

/**
 * Ordered list of open projects in the rail. First entry is leftmost.
 *
 * Capped at `MAX_OPEN_PROJECTS` to bound memory of warm projects.
 */
export const openProjectsAtom = atom<OpenProject[]>([]);

/**
 * Convenience: the OpenProject record for the active workspace, if any.
 */
export const activeOpenProjectAtom = atom((get) => {
  const path = get(activeWorkspacePathAtom);
  if (!path) return null;
  return get(openProjectsAtom).find((p) => p.path === path) ?? null;
});

/**
 * Whether the rail is at the open-project cap. UI uses this to disable
 * the "+" button and show a hint to close a project first.
 */
export const isOpenProjectsAtCapAtom = atom((get) => {
  return get(openProjectsAtom).length >= MAX_OPEN_PROJECTS;
});

/**
 * Add a project to the rail. No-op if it already exists. When the rail
 * has reached the cap, returns without adding (caller should show a UI
 * hint via `isOpenProjectsAtCapAtom`).
 *
 * Activates the added project so the renderer immediately switches to it.
 */
export const addOpenProjectAtom = atom(
  null,
  (get, set, project: OpenProject) => {
    const current = get(openProjectsAtom);

    const existing = current.find((p) => p.path === project.path);
    if (existing) {
      set(activeWorkspacePathAtom, existing.path);
      return;
    }

    if (current.length >= MAX_OPEN_PROJECTS) {
      return;
    }

    set(openProjectsAtom, [...current, project]);
    set(activeWorkspacePathAtom, project.path);
  }
);

/**
 * Remove a project from the rail. If the closed project was active, the
 * adjacent project (next, then previous, then null) becomes active.
 *
 * Callers are responsible for any pre-close confirmation (e.g. when the
 * project has streaming sessions).
 */
export const closeOpenProjectAtom = atom(
  null,
  (get, set, pathToClose: string) => {
    const current = get(openProjectsAtom);
    const idx = current.findIndex((p) => p.path === pathToClose);
    if (idx === -1) return;

    const next = current.filter((p) => p.path !== pathToClose);
    set(openProjectsAtom, next);

    const activePath = get(activeWorkspacePathAtom);
    if (activePath === pathToClose) {
      const replacement = next[idx] ?? next[idx - 1] ?? next[0] ?? null;
      set(activeWorkspacePathAtom, replacement?.path ?? null);
    }

    // Drop the workspace's slot in the activity tracker. Other per-workspace
    // atom families (tabs slot, sidebar width, etc.) are pruned by the
    // `workspaceStatePruner` subscriber that watches `openProjectsAtom` —
    // keeping that logic outside this module avoids a cycle with the atom
    // files that already import `activeWorkspacePathAtom`.
    set(clearWorkspaceActivityAtom, pathToClose);
  }
);

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function basenameFromPath(p: string): string {
  // Match Node's path.basename behavior for both posix and win32 separators.
  const trimmed = p.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

function normalizeProjectPaths(paths: unknown): string[] {
  if (!Array.isArray(paths)) return [];

  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const path of paths) {
    if (typeof path !== 'string' || path.length === 0 || seen.has(path)) continue;
    seen.add(path);
    normalized.push(path);
    if (normalized.length >= MAX_OPEN_PROJECTS) break;
  }
  return normalized;
}

function getWindowBootstrapState(initialState: unknown): InitialWorkspaceWindowState | null {
  if (!initialState || typeof initialState !== 'object') return null;
  const candidate = initialState as InitialWorkspaceWindowState;
  if (candidate.mode !== 'workspace') return null;
  return candidate;
}

export function resolveInitialOpenProjectsState({
  persistedPaths,
  persistedActivePath,
  restorePreviousProjects,
  windowState,
}: ResolveInitialOpenProjectsInput): { paths: string[]; activePath: string | null } {
  const normalizedPersistedPaths = normalizeProjectPaths(persistedPaths);
  const normalizedWindowPaths = normalizeProjectPaths(windowState?.openProjectPaths ?? []);
  const normalizedWindowActivePath =
    windowState?.activeWorkspacePath && normalizedWindowPaths.includes(windowState.activeWorkspacePath)
      ? windowState.activeWorkspacePath
      : normalizedWindowPaths[0] ?? null;
  const windowHasLiveRailState =
    normalizedWindowPaths.length > 1 ||
    (windowState?.workspacePath != null &&
      normalizedWindowActivePath != null &&
      normalizedWindowActivePath !== windowState.workspacePath);

  if (windowHasLiveRailState) {
    return {
      paths: normalizedWindowPaths,
      activePath: normalizedWindowActivePath,
    };
  }

  if (restorePreviousProjects && normalizedPersistedPaths.length > 0) {
    return {
      paths: normalizedPersistedPaths,
      activePath:
        persistedActivePath && normalizedPersistedPaths.includes(persistedActivePath)
          ? persistedActivePath
          : normalizedPersistedPaths[0] ?? null,
    };
  }

  return {
    paths: normalizedWindowPaths,
    activePath: normalizedWindowActivePath,
  };
}

let initialized = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let unsubscribers: Array<() => void> = [];

/**
 * Load multi-project settings from disk and start persistence subscribers.
 *
 * Idempotent: subsequent calls are no-ops. Call once at renderer startup,
 * before the rail is rendered, so the first paint already has the correct
 * `multiProjectModeAtom` value.
 *
 * Returns once the initial state has been loaded.
 */
export async function initOpenProjects(): Promise<void> {
  if (initialized) return;
  initialized = true;

  if (!window.electronAPI?.invoke) return;

  try {
    const [mode, restorePrev, paths, activePath, initialState] = await Promise.all([
      window.electronAPI.invoke('app:get-multi-project-mode') as Promise<boolean>,
      window.electronAPI.invoke('app:get-restore-previous-projects') as Promise<boolean>,
      window.electronAPI.invoke('app:get-open-projects') as Promise<string[]>,
      window.electronAPI.invoke('app:get-active-project-path') as Promise<string | null>,
      window.electronAPI.getInitialState?.() ?? Promise.resolve(null),
    ]);

    store.set(multiProjectModeAtom, !!mode);
    store.set(restorePreviousProjectsAtom, !!restorePrev);

    const { paths: initialPaths, activePath: initialActivePath } = resolveInitialOpenProjectsState({
      persistedPaths: paths,
      persistedActivePath: activePath,
      restorePreviousProjects: !!restorePrev,
      windowState: getWindowBootstrapState(initialState),
    });

    if (initialPaths.length > 0) {
      const projects: OpenProject[] = initialPaths.map((path) => ({
        path,
        name: basenameFromPath(path),
        openedAt: Date.now(),
      }));
      store.set(openProjectsAtom, projects);

      if (initialActivePath && initialPaths.includes(initialActivePath)) {
        store.set(activeWorkspacePathAtom, initialActivePath);
      } else if (projects.length > 0) {
        store.set(activeWorkspacePathAtom, projects[0].path);
      }
    }
  } catch (err) {
    console.error('[openProjects] Failed to load multi-project state:', err);
  }

  // Subscribe for debounced writes back to disk.
  unsubscribers.push(
    store.sub(multiProjectModeAtom, () => {
      const mode = store.get(multiProjectModeAtom);
      window.electronAPI?.invoke?.('app:set-multi-project-mode', mode).catch((err: unknown) => {
        console.error('[openProjects] Failed to persist multiProjectMode:', err);
      });
    }),
    store.sub(restorePreviousProjectsAtom, () => {
      const value = store.get(restorePreviousProjectsAtom);
      window.electronAPI?.invoke?.('app:set-restore-previous-projects', value).catch((err: unknown) => {
        console.error('[openProjects] Failed to persist restorePreviousProjects:', err);
      });
    }),
    store.sub(openProjectsAtom, () => schedulePersistOpenProjects()),
    store.sub(activeWorkspacePathAtom, () => {
      schedulePersistActivePath();
      notifyMainSetActive();
    }),
    attachWorkspaceSwitchCleanup(store),
  );
}

/**
 * Attach a subscriber that keeps cross-workspace globals coherent when
 * `activeWorkspacePathAtom` flips. Synchronously rewrites
 * `activeSessionIdAtom` to the new workspace's selection — leaking the
 * previous workspace's session id is avoided AND the brief null window
 * between the subscriber firing and AgentMode's mount effect is closed.
 *
 * Resolution order matches AgentMode's own derivation
 * (`AgentMode.tsx:151-158`): activeChildId of the selected workstream
 * if any, otherwise the selection's own id, otherwise null. AgentMode
 * still re-asserts the same value on mount; the writes converge.
 *
 * Exported as a stand-alone unit so jotai-only tests can attach it to a
 * `createStore()` instance and assert the behavior without needing the
 * full `initOpenProjects` IPC bootstrap.
 */
export function attachWorkspaceSwitchCleanup(jotaiStore: JotaiStore): () => void {
  return jotaiStore.sub(activeWorkspacePathAtom, () => {
    const newPath = jotaiStore.get(activeWorkspacePathAtom);
    if (!newPath) {
      jotaiStore.set(activeSessionIdAtom, null);
      return;
    }
    const selection = jotaiStore.get(selectedWorkstreamAtom(newPath));
    const activeChildId = selection
      ? jotaiStore.get(workstreamActiveChildAtom(selection.id))
      : null;
    jotaiStore.set(activeSessionIdAtom, activeChildId || selection?.id || null);
  });
}

/**
 * Notify the main process about the new active workspace path so the
 * single-active-per-window resources (file watcher, runtime-global
 * FileSystemService) transition atomically. Centralized here so every
 * mutation of `activeWorkspacePathAtom` (rail click, replacement after
 * close, restore-on-launch, keyboard shortcut) goes through one path —
 * direct callers of `electronAPI.invoke('workspace:set-active', ...)`
 * are not necessary.
 */
function notifyMainSetActive(): void {
  const path = store.get(activeWorkspacePathAtom);
  if (!path) return;
  window.electronAPI?.invoke?.('workspace:set-active', { workspacePath: path }).catch((err: unknown) => {
    console.error('[openProjects] workspace:set-active failed:', err);
  });
}

function schedulePersistOpenProjects(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const projects = store.get(openProjectsAtom);
    const paths = projects.map((p) => p.path);
    window.electronAPI?.invoke?.('app:set-open-projects', paths).catch((err: unknown) => {
      console.error('[openProjects] Failed to persist openProjects:', err);
    });
  }, 300);
}

function schedulePersistActivePath(): void {
  const path = store.get(activeWorkspacePathAtom);
  // No debounce needed — switches are user-driven and infrequent.
  window.electronAPI?.invoke?.('app:set-active-project-path', path).catch((err: unknown) => {
    console.error('[openProjects] Failed to persist activeProjectPath:', err);
  });
}

/**
 * Tear down persistence subscribers (e.g. for tests). Resets `initialized`
 * so the next `initOpenProjects` call re-loads from disk.
 */
export function teardownOpenProjects(): void {
  unsubscribers.forEach((unsub) => unsub());
  unsubscribers = [];
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  initialized = false;
}
