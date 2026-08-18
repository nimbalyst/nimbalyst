/**
 * Pure planning for "Merge All Windows" (Multi-Project Mode).
 *
 * Phase 1 of the single-window-multi-project plan only changes how *newly
 * opened* projects route and how the *next launch* restores. Windows that
 * are already open stay open until the user quits and relaunches. This
 * module is the decision logic for a "consolidate now" command that folds
 * every open workspace window into one, so the user gets relief without
 * restarting the app.
 *
 * No Electron imports here, and none should be added — this module must
 * stay safe to unit-test with a plain Node environment (no jsdom, no
 * Electron mocks) and reusable from anywhere in the main process.
 */

const WORKSPACE_MODES = new Set(['workspace', 'agentic-coding']);

export interface ConsolidationWindowInput {
  windowId: number;
  /** Only 'workspace' and 'agentic-coding' are eligible; any other mode
   *  (e.g. 'document') is ignored by the planner entirely. */
  mode: string;
  workspacePath: string | null;
  additionalWorkspacePaths?: string[] | null;
  /** Unsaved editor changes. A window with this set true is left alone —
   *  neither seeded from nor closed — so a merge never silently destroys
   *  unsaved work. See WindowManager.ts's `documentEdited`-gated close
   *  guard, which this planner defers to rather than duplicates. */
  documentEdited?: boolean;
}

export interface PlanWindowConsolidationOptions {
  multiProjectModeEnabled: boolean;
  /** The window every other workspace window's projects fold into. Chosen
   *  by the caller (e.g. `getMostRecentlyFocusedWorkspaceWindow()`) — kept
   *  out of this pure module so tests don't need to reimplement focus-order
   *  tracking. Must be the id of one of the workspace windows in `windows`
   *  or the whole call is a no-op. */
  targetWindowId: number;
}

export interface WindowConsolidationPlan {
  targetWindowId: number;
  /** Deduplicated paths to seed into the target's rail, in donor order,
   *  excluding paths the target already references and excluding paths
   *  contributed by more than one donor (first donor wins; later donors
   *  sharing the path are still safe to close once it lands). */
  pathsToSeed: string[];
  /** Donor windows (not the target) with no unsaved changes — safe to seed
   *  from and close once their paths are confirmed in the target. */
  windowsToClose: number[];
  /** Donor windows excluded entirely because `documentEdited` was true at
   *  plan time. Neither seeded from nor closed. */
  windowsSkippedUnsaved: number[];
}

function isWorkspaceWindow(w: ConsolidationWindowInput): boolean {
  return WORKSPACE_MODES.has(w.mode);
}

/**
 * Every workspace path a window references — primary plus rail-warm
 * additional paths. Exported so the executor can recompute "does this
 * donor's full path set actually live in the target now?" after seeding,
 * without re-deriving the rule.
 */
export function collectWindowPaths(w: ConsolidationWindowInput): string[] {
  const paths: string[] = [];
  if (w.workspacePath) paths.push(w.workspacePath);
  for (const path of w.additionalWorkspacePaths ?? []) {
    if (path) paths.push(path);
  }
  return paths;
}

/**
 * Decide how to fold every open workspace window into one.
 *
 * Returns null when there is nothing to do: mode is off, fewer than two
 * workspace windows are open, or `targetWindowId` doesn't resolve to an
 * open workspace window.
 */
export function planWindowConsolidation(
  windows: ConsolidationWindowInput[],
  options: PlanWindowConsolidationOptions,
): WindowConsolidationPlan | null {
  if (!options.multiProjectModeEnabled) return null;

  const workspaceWindows = windows.filter(isWorkspaceWindow);
  if (workspaceWindows.length < 2) return null;

  const target = workspaceWindows.find((w) => w.windowId === options.targetWindowId);
  if (!target) return null;

  const targetPaths = new Set(collectWindowPaths(target));
  const pathsToSeed: string[] = [];
  const windowsToClose: number[] = [];
  const windowsSkippedUnsaved: number[] = [];

  for (const donor of workspaceWindows) {
    if (donor.windowId === target.windowId) continue;

    if (donor.documentEdited) {
      windowsSkippedUnsaved.push(donor.windowId);
      continue;
    }

    for (const path of collectWindowPaths(donor)) {
      if (!targetPaths.has(path)) {
        targetPaths.add(path);
        pathsToSeed.push(path);
      }
    }
    windowsToClose.push(donor.windowId);
  }

  if (windowsToClose.length === 0 && windowsSkippedUnsaved.length === 0) {
    return null;
  }

  return {
    targetWindowId: target.windowId,
    pathsToSeed,
    windowsToClose,
    windowsSkippedUnsaved,
  };
}
