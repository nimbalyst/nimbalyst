/**
 * Promise-based ack for the `rail:add-project` contract.
 *
 * `rail:add-project` (see `resolveProjectOpenTarget.ts`) is a main -> renderer
 * fire-and-forget message. Some callers (session restore, "Merge All
 * Windows") need to know what actually happened -- registered and added,
 * already open, refused at the rail's cap, or never acknowledged at all --
 * before deciding whether it's safe to close a donor window or seed the next
 * path. `seedProjectIntoWindow` wraps the send in a promise that resolves
 * once the renderer's `rail:add-project` listener
 * (`store/listeners/railProjectListeners.ts`) reports back on
 * `rail:add-project-result` with the matching `requestId`.
 *
 * A single `safeOn` listener is registered once for the process lifetime and
 * dispatches every ack by `requestId` -- registering per-call would either
 * violate `safeOn`'s duplicate-registration guard (same channel, same
 * function identity requirement) or leak a distinct listener per call.
 */

import { BrowserWindow } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import { randomUUID } from 'crypto';
import { safeOn, safeHandle } from '../utils/ipcRegistry';
import { logger } from '../utils/logger';
import { getWindowIdForWindow } from './windowState';
import { RAIL_ADD_PROJECT_CHANNEL } from './resolveProjectOpenTarget';

export const RAIL_ADD_PROJECT_RESULT_CHANNEL = 'rail:add-project-result';

/** Renderer-reported outcomes, plus `'timeout'` for "no ack landed in time"
 *  (ack timeout, or the target window was destroyed before one arrived). */
export type RailSeedOutcome = 'added' | 'already-open' | 'at-cap' | 'timeout';

const DEFAULT_SEED_TIMEOUT_MS = 2000;

interface PendingSeed {
  resolve: (outcome: RailSeedOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
  onWindowClosed: () => void;
  window: BrowserWindow;
}

const pending = new Map<string, PendingSeed>();

function settle(requestId: string, outcome: RailSeedOutcome): void {
  const entry = pending.get(requestId);
  if (!entry) return;
  pending.delete(requestId);
  clearTimeout(entry.timer);
  entry.window.removeListener('closed', entry.onWindowClosed);
  entry.resolve(outcome);
}

// Registered once at module load -- the single main-process listener for
// every `seedProjectIntoWindow` ack, dispatched by `requestId`. Uses
// `safeOn` (never raw `ipcMain`) per the main-process init rules.
safeOn(
  RAIL_ADD_PROJECT_RESULT_CHANNEL,
  (_event: IpcMainEvent, data: { requestId?: string; workspacePath?: string; outcome?: RailSeedOutcome }) => {
    if (!data?.requestId || !data.outcome) return;
    settle(data.requestId, data.outcome);
  },
);

export interface SeedProjectIntoWindowOptions {
  /** Forwarded to the renderer's `rail:add-project` payload. Defaults to
   *  `true` so callers that don't care about activation get today's
   *  behavior; pass `false` to append without stealing focus from
   *  whatever is currently visible in `window`. */
  activate?: boolean;
  /** How long to wait for the ack before resolving `'timeout'`. */
  timeoutMs?: number;
}

/**
 * Send `rail:add-project` to `window` for `workspacePath` and resolve once
 * the renderer acks on `rail:add-project-result`, or `'timeout'` if no ack
 * lands within `timeoutMs`, or the window is destroyed first.
 *
 * Never leaves a dangling pending entry: the timer and the window's
 * `'closed'` listener are both cleaned up on ack, on timeout, and on window
 * destruction (whichever happens first settles the promise and clears the
 * other two).
 */
export function seedProjectIntoWindow(
  window: BrowserWindow,
  workspacePath: string,
  options: SeedProjectIntoWindowOptions = {},
): Promise<RailSeedOutcome> {
  const { activate = true, timeoutMs = DEFAULT_SEED_TIMEOUT_MS } = options;

  if (window.isDestroyed()) {
    return Promise.resolve('timeout');
  }

  const requestId = randomUUID();

  return new Promise<RailSeedOutcome>((resolve) => {
    const onWindowClosed = () => {
      logger.main.warn(
        '[RailSeeding] target window closed before rail:add-project-result ack:',
        workspacePath,
      );
      settle(requestId, 'timeout');
    };

    const timer = setTimeout(() => {
      logger.main.warn(
        '[RailSeeding] timed out waiting for rail:add-project-result ack:',
        workspacePath,
      );
      settle(requestId, 'timeout');
    }, timeoutMs);

    pending.set(requestId, { resolve, timer, onWindowClosed, window });
    window.once('closed', onWindowClosed);

    window.webContents.send(RAIL_ADD_PROJECT_CHANNEL, { workspacePath, activate, requestId });
  });
}

/** Test-only: number of acks/timeouts still awaited. Used to assert no leak. */
export function getPendingSeedCountForTests(): number {
  return pending.size;
}

// ---------------------------------------------------------------------------
// Pending seeds for a window that is still starting up (renderer PULL)
// ---------------------------------------------------------------------------

/**
 * Why session restore does NOT use `seedProjectIntoWindow` above.
 *
 * Pushing requires main to guess when the renderer is listening. The only
 * signal main has is `did-finish-load`, but the renderer registers its
 * `rail:add-project` handler in `initRailProjectListeners()`, called from a
 * React effect in `App.tsx` that runs after mount -- strictly later, and on a
 * cold start (large DB, extension loading) later by seconds. A push at
 * `did-finish-load` lands in a window with no listener attached and is
 * silently dropped; the ack then times out and the project is lost from the
 * rail. Observed in the wild:
 *
 *   [RESTORE] … seeding rail with 1 more: /…/wine-cellar/
 *   [RailSeeding] timed out waiting for rail:add-project-result ack: /…/wine-cellar/
 *
 * and, because the path never reached `WindowState.additionalWorkspacePaths`,
 * the NEXT `saveSessionState()` persisted no rail at all -- so the loss
 * compounded across restarts.
 *
 * Raising the timeout would only make the race rarer. Instead the renderer
 * PULLS: main parks the paths here, and `initRailProjectListeners()` -- the
 * exact point that proves the handler is registered -- asks for them. There is
 * no ordering to get wrong.
 *
 * The push path above is still correct for "Merge All Windows", where the
 * target window is already live and listening.
 */
export const RAIL_TAKE_PENDING_SEEDS_CHANNEL = 'rail:take-pending-seeds';

const pendingSeedsByWindowId = new Map<number, string[]>();

/** Park rail paths for a window that hasn't mounted its listeners yet. */
export function setPendingRailSeeds(windowId: number, workspacePaths: string[]): void {
  if (workspacePaths.length === 0) {
    pendingSeedsByWindowId.delete(windowId);
    return;
  }
  pendingSeedsByWindowId.set(windowId, [...workspacePaths]);
}

/**
 * Drop a window's parked seeds. Called when the window closes so the map
 * can't grow across a long session.
 */
export function clearPendingRailSeeds(windowId: number): void {
  pendingSeedsByWindowId.delete(windowId);
}

/**
 * Hand a window its parked seeds exactly once. Clearing on read is what makes
 * a renderer reload (which re-runs `initRailProjectListeners`) a no-op rather
 * than a duplicate add.
 */
export function takePendingRailSeeds(windowId: number): string[] {
  const paths = pendingSeedsByWindowId.get(windowId) ?? [];
  pendingSeedsByWindowId.delete(windowId);
  return paths;
}

/** Test-only: how many windows still have parked seeds. */
export function getPendingRailSeedWindowCountForTests(): number {
  return pendingSeedsByWindowId.size;
}

// Registered once at module load, like the ack listener above.
safeHandle(RAIL_TAKE_PENDING_SEEDS_CHANNEL, (event: IpcMainInvokeEvent) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  const windowId = getWindowIdForWindow(window);
  if (windowId === null) return [];

  const paths = takePendingRailSeeds(windowId);
  if (paths.length > 0) {
    logger.main.info(
      `[RailSeeding] renderer took ${paths.length} pending rail seed(s):`,
      paths.join(', '),
    );
  }
  return paths;
});
