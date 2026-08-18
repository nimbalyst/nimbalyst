/**
 * "Merge All Windows" executor for Multi-Project Mode.
 *
 * Folds every open workspace window into the most-recently-focused one:
 * seeds each donor window's paths into the target's project rail via the
 * existing `rail:add-project` channel (see `resolveProjectOpenTarget.ts`,
 * `store/listeners/railProjectListeners.ts` in the renderer, and
 * `railSeeding.ts` for the ack wrapper), then closes the drained donor
 * windows.
 *
 * Ordering is load-bearing: a donor window must not be closed before its
 * paths are confirmed registered in the target, or the `closed` handler in
 * WindowManager.ts frees that path's DocumentService/FileSystemService
 * (no window would reference it in the gap between close and re-seed). A
 * donor is also not closed before it confirms its dirty editors are flushed
 * to disk (`flushWindowBeforeClose.ts`) -- `windowState.documentEdited` is
 * decorative and cannot be relied on to stop that, see that module's doc.
 *
 * Every seed is sent with `activate: false` — the target's visible project
 * must not change out from under the user just because their other windows
 * got folded in. There is therefore nothing to restore afterwards: unlike
 * the old poll-based implementation (which flipped `activeWorkspacePath` on
 * every seed and explicitly reset it at the end), the target's active path
 * is never touched by this module at all.
 *
 * Planning is delegated to the pure `planWindowConsolidation` — this module
 * is the Electron-dependent shell around it (window lookups, IPC sends,
 * `.close()`), intentionally kept out of the pure module so the planner
 * stays unit-testable without Electron.
 */

import type { BrowserWindow } from 'electron';
import { windows, windowStates } from './windowState';
import { getMostRecentlyFocusedWorkspaceWindow, getWindowId } from './WindowManager';
import { getMultiProjectMode } from '../utils/store';
import { seedProjectIntoWindow, type RailSeedOutcome } from './railSeeding';
import { flushWindowBeforeClose } from './flushWindowBeforeClose';
import {
  planWindowConsolidation,
  collectWindowPaths,
  type ConsolidationWindowInput,
  type WindowConsolidationPlan,
} from './planWindowConsolidation';
import { logger } from '../utils/logger';

/** How long to wait for each seed's `rail:add-project-result` ack. */
const SEED_ACK_TIMEOUT_MS = 2000;
/** How long to wait for a donor's `window:flush-before-close-result` ack. */
const FLUSH_ACK_TIMEOUT_MS = 5000;

export interface ConsolidationResult {
  plan: WindowConsolidationPlan | null;
  /** Paths confirmed registered (and appended to the rail) in the target
   *  window -- sent with `activate: false`, so these are NOT necessarily
   *  the target's visible/active project; see the module doc comment. */
  seeded: string[];
  /** Paths that did not land in the target: a renderer-reported `'at-cap'`
   *  outcome (the rail's `MAX_OPEN_PROJECTS` cap -- once seen, every
   *  remaining path in the plan is refused without even being sent, since
   *  they would all refuse too), or a `'timeout'` outcome (no ack landed in
   *  time -- e.g. `workspace:register-additional` itself failed, or a slow
   *  renderer; refuses only that one path, does not cascade). Their donor
   *  windows are left open either way. */
  refused: string[];
  closedWindowIds: number[];
  /** Donor windows left open: unsaved changes at plan time, went dirty
   *  mid-run, or one of their paths was refused. */
  skippedWindowIds: number[];
}

const NO_OP_RESULT: ConsolidationResult = {
  plan: null,
  seeded: [],
  refused: [],
  closedWindowIds: [],
  skippedWindowIds: [],
};

function snapshotWindowInputs(): ConsolidationWindowInput[] {
  const inputs: ConsolidationWindowInput[] = [];
  for (const [windowId, state] of windowStates) {
    inputs.push({
      windowId,
      mode: state.mode,
      workspacePath: state.workspacePath,
      additionalWorkspacePaths: state.additionalWorkspacePaths ?? [],
      documentEdited: state.documentEdited === true,
    });
  }
  return inputs;
}

/**
 * Fold every open workspace window into the most-recently-focused one.
 * Safe to call when there is nothing to consolidate (returns a no-op
 * result) -- callers should still gate the menu item on
 * `getMultiProjectMode()` + window count so the command isn't visible when
 * it can't do anything, but this function re-validates independently since
 * that gate is computed once at menu-build time.
 */
export async function consolidateWorkspaceWindows(): Promise<ConsolidationResult> {
  const target: BrowserWindow | null = getMostRecentlyFocusedWorkspaceWindow();
  if (!target || target.isDestroyed()) return NO_OP_RESULT;

  const targetWindowId = getWindowId(target);
  if (targetWindowId === null) return NO_OP_RESULT;

  const inputsAtPlanTime = snapshotWindowInputs();
  const plan = planWindowConsolidation(inputsAtPlanTime, {
    multiProjectModeEnabled: getMultiProjectMode(),
    targetWindowId,
  });
  if (!plan) return NO_OP_RESULT;

  const targetStateAtPlanTime = windowStates.get(targetWindowId);
  const targetPathsAtPlanTime = new Set(
    collectWindowPaths(
      inputsAtPlanTime.find((w) => w.windowId === targetWindowId) ?? {
        windowId: targetWindowId,
        mode: targetStateAtPlanTime?.mode ?? 'workspace',
        workspacePath: targetStateAtPlanTime?.workspacePath ?? null,
        additionalWorkspacePaths: targetStateAtPlanTime?.additionalWorkspacePaths ?? [],
      },
    ),
  );

  const seeded: string[] = [];
  const refused: string[] = [];

  // Seed sequentially so a donor is only closed once every path it
  // contributed is confirmed -- never before. `activate: false` means the
  // target's visible project is never touched by seeding, so unlike the
  // cap check below there is no "one refusal implies the rest will refuse
  // too" signal to derive from an ordinary ack timeout -- only a literal
  // `'at-cap'` outcome means that. Short-circuit on that signal alone so a
  // transient per-path timeout (e.g. `workspace:register-additional`
  // rejecting, or a slow renderer) doesn't cascade into refusing every
  // remaining path.
  let capReached = false;
  for (const path of plan.pathsToSeed) {
    if (target.isDestroyed()) break;

    if (capReached) {
      refused.push(path);
      continue;
    }

    const outcome: RailSeedOutcome = await seedProjectIntoWindow(target, path, {
      activate: false,
      timeoutMs: SEED_ACK_TIMEOUT_MS,
    });

    if (outcome === 'added' || outcome === 'already-open') {
      seeded.push(path);
    } else if (outcome === 'at-cap') {
      refused.push(path);
      capReached = true;
      logger.main.warn('[ConsolidateWindows] rail at cap, refusing remaining paths:', path);
    } else {
      refused.push(path);
      logger.main.warn(
        '[ConsolidateWindows] rail did not confirm seeded path within timeout:',
        path,
      );
    }
  }

  // If the target itself died mid-merge, `windowStates.delete(targetWindowId)`
  // (WindowManager.ts's `closed` handler) has already run, so
  // `targetPathsAtPlanTime` / `seededSet` no longer reflect anything the
  // target actually still references. Closing donors against that stale
  // picture would free every path's services with nothing left to serve
  // them from -- worse than doing nothing. Bail out and leave every donor
  // open instead.
  if (target.isDestroyed() || !windowStates.has(targetWindowId)) {
    logger.main.error(
      '[ConsolidateWindows] target window died mid-merge; leaving all donor windows open',
    );
    return {
      plan,
      seeded,
      refused,
      closedWindowIds: [],
      skippedWindowIds: [...plan.windowsToClose, ...plan.windowsSkippedUnsaved],
    };
  }

  const closedWindowIds: number[] = [];
  const skippedWindowIds: number[] = [...plan.windowsSkippedUnsaved];
  const seededSet = new Set(seeded);

  for (const windowId of plan.windowsToClose) {
    const donorInput = inputsAtPlanTime.find((w) => w.windowId === windowId);
    const donorPaths = donorInput ? collectWindowPaths(donorInput) : [];
    const fullyMigrated = donorPaths.every(
      (path) => targetPathsAtPlanTime.has(path) || seededSet.has(path),
    );

    if (!fullyMigrated) {
      skippedWindowIds.push(windowId);
      logger.main.warn(
        '[ConsolidateWindows] leaving donor window open, not all paths landed in target:',
        windowId,
        donorPaths.filter((path) => !targetPathsAtPlanTime.has(path) && !seededSet.has(path)),
      );
      continue;
    }

    const donorWindow = windows.get(windowId);
    if (!donorWindow || donorWindow.isDestroyed()) continue;

    // Re-check immediately before closing -- a buffer can go dirty during
    // the awaits above. WindowManager's own `close` listener also guards
    // `documentEdited`, but it does so via `event.preventDefault()` while a
    // second `close` listener still runs and deletes `windowStates` for the
    // window regardless (see report: this is a latent bug in
    // WindowManager.ts, out of this module's ownership). Checking here
    // means this module never calls `.close()` on a dirty window in the
    // first place, so that path is never exercised by consolidation.
    //
    // `documentEdited` itself is decorative -- nothing in the codebase ever
    // sets it `true` (see `flushWindowBeforeClose.ts`'s module doc) -- so
    // this check alone would never actually catch a dirty donor. The
    // `flushWindowBeforeClose` call below is the real guard: it asks the
    // donor to flush every dirty editor to disk and only proceeds to
    // `.close()` once that is confirmed.
    if (windowStates.get(windowId)?.documentEdited) {
      skippedWindowIds.push(windowId);
      continue;
    }

    const flushOutcome = await flushWindowBeforeClose(donorWindow, {
      timeoutMs: FLUSH_ACK_TIMEOUT_MS,
    });
    if (flushOutcome !== 'flushed') {
      skippedWindowIds.push(windowId);
      logger.main.warn(
        '[ConsolidateWindows] leaving donor window open, flush before close did not confirm:',
        windowId,
        flushOutcome,
      );
      continue;
    }

    // The flush await gave the donor time to run arbitrary renderer code
    // (save writes, etc.) -- re-check destruction before touching it again.
    if (donorWindow.isDestroyed()) continue;

    donorWindow.close();
    closedWindowIds.push(windowId);
  }

  return { plan, seeded, refused, closedWindowIds, skippedWindowIds };
}
