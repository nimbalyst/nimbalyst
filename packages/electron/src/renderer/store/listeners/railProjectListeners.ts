/**
 * Central Rail-Add-Project Listener
 *
 * Subscribes to `rail:add-project` ONCE. Main sends this when Multi-Project
 * Mode is on and the user opens a project that has no window of its own yet
 * (deep link, notification click, Open Recent, tutorial, MCP `workspace_open`,
 * restore-time rail seeding, "Merge All Windows", ...) -- the project joins
 * THIS window's rail instead of a new window spawning.
 *
 * ORDERING IS LOAD-BEARING (NIM-757 / #548 / reopened #441): main cannot
 * register the workspace itself (`workspace:register-additional` is a
 * renderer -> main `safeHandle`), so the renderer must, in this order:
 *
 *   1. `invoke('workspace:register-additional', ...)` -- so main's per-window
 *      `additionalWorkspacePaths` and per-path services exist BEFORE
 *   2. `set(addOpenProjectAtom, ...)` -- which flips `activeWorkspacePathAtom`
 *      (unless the message explicitly asked not to -- see `activate` below)
 *
 * Flipping the active path first makes the `workspace:set-active` subscriber
 * race main with a path it doesn't know about yet, and `workspace:set-active`
 * silently no-ops for an unregistered path -- pinning path-scoped IPC to the
 * window's original project. `store/actions/sessionNotificationNavigation.ts`
 * (`activateWorkspace`) is the reference implementation this mirrors.
 *
 * Payload fields, all but `workspacePath` optional so existing fire-and-forget
 * senders (`WorkspaceManagerWindow.ts`, `AIService.ts`, `TutorialProjectService.ts`,
 * ...) are unaffected:
 *   - `activate` (default `true`) -- when `false`, the project is registered
 *     and appended to the rail WITHOUT touching `activeWorkspacePathAtom`.
 *     Used when seeding several projects into one window at once (session
 *     restore, "Merge All Windows") so only the intended primary ends up
 *     visible regardless of which seed's round trip resolves last.
 *   - `requestId` -- when present, an ack is sent back to main on
 *     `rail:add-project-result` with `{ requestId, workspacePath, outcome }`
 *     once the add resolves (see `main/window/railSeeding.ts`).
 *
 * Call initRailProjectListeners() once at app startup.
 */

import { store } from '@nimbalyst/runtime/store';
import { addOpenProjectAtom, openProjectsAtom, type AddOpenProjectOutcome } from '../atoms/openProjects';
import { showRailFullNotification } from '../actions/railFullNotification';

const RAIL_ADD_PROJECT_RESULT_CHANNEL = 'rail:add-project-result';
const RAIL_TAKE_PENDING_SEEDS_CHANNEL = 'rail:take-pending-seeds';

interface RailAddProjectPayload {
  workspacePath: string;
  activate?: boolean;
  requestId?: string;
}

let initialized = false;

function basenameFromPath(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

export function initRailProjectListeners(): () => void {
  if (initialized) {
    return () => {};
  }
  initialized = true;

  const unsubscribe = window.electronAPI?.on?.(
    'rail:add-project',
    (data: RailAddProjectPayload) => {
      void addProjectToRail(data?.workspacePath, data?.activate, data?.requestId);
    },
  );

  return () => {
    initialized = false;
    if (typeof unsubscribe === 'function') {
      unsubscribe();
    }
  };
}

/**
 * Pull the rail projects main parked for us during session restore and add
 * them without stealing focus. Main clears the list as it hands it over, so a
 * renderer reload re-runs this harmlessly.
 *
 * Call this only once the app is ready to HOST a project -- i.e. at the same
 * point the window's primary project is added (`App.tsx`'s `loadInitialState`).
 * Adding to `openProjectsAtom` re-subscribes session state for that workspace
 * (`store/sessionStateListeners.ts`), which writes workstream state, which
 * throws "Cannot persist - initWorkstreamState not called" if the workspace's
 * state has not been initialized yet. Calling this from listener registration
 * was early enough to hit exactly that, crashing the window into the error
 * boundary on launch (it recovered on "Try again", which remounted later).
 *
 * Parking means there is no race in waiting: the seeds sit in main until asked.
 */
export async function collectPendingRailSeeds(): Promise<void> {
  if (!window.electronAPI?.invoke) return;

  let paths: string[] = [];
  try {
    // Validate the shape rather than trusting the channel: `?? []` only
    // guards null/undefined, so any other value (an older main process, or a
    // test whose generic `invoke` mock answers every channel) reaches the
    // loop below and throws "paths is not iterable" as an unhandled
    // rejection -- which fails the whole suite even though every test passed.
    const result: unknown = await window.electronAPI.invoke(RAIL_TAKE_PENDING_SEEDS_CHANNEL);
    paths = Array.isArray(result) ? result.filter((p): p is string => typeof p === 'string') : [];
  } catch (err) {
    console.error('[railProjectListeners] take-pending-seeds failed:', err);
    return;
  }

  // Sequential, not parallel: each add reads `openProjectsAtom` to decide
  // whether it is already open, and concurrent adds would race that check.
  for (const workspacePath of paths) {
    await addProjectToRail(workspacePath, false, undefined);
  }
}

function sendAck(requestId: string | undefined, workspacePath: string, outcome: AddOpenProjectOutcome): void {
  if (!requestId) return;
  window.electronAPI?.send?.(RAIL_ADD_PROJECT_RESULT_CHANNEL, { requestId, workspacePath, outcome });
}

async function addProjectToRail(
  workspacePath: string | undefined,
  activate: boolean | undefined,
  requestId: string | undefined,
): Promise<void> {
  if (!workspacePath) return;
  const shouldActivate = activate !== false;

  const alreadyOpen = store
    .get(openProjectsAtom)
    .some((project) => project.path === workspacePath);

  if (!alreadyOpen) {
    try {
      const registration = await window.electronAPI.invoke(
        'workspace:register-additional',
        { workspacePath },
      );
      if (!registration?.success) {
        console.error('[railProjectListeners] register-additional failed:', workspacePath, registration);
        // No ack on registration failure: main's ack-waiter (`railSeeding.ts`)
        // treats a missing ack as its own distinct 'timeout' outcome rather
        // than conflating it with the rail's 'at-cap' outcome.
        return;
      }
    } catch (err) {
      console.error('[railProjectListeners] register-additional threw:', workspacePath, err);
      return;
    }
  }

  const outcome = store.set(
    addOpenProjectAtom,
    {
      path: workspacePath,
      name: basenameFromPath(workspacePath),
      openedAt: Date.now(),
    },
    { activate: shouldActivate },
  );

  // This is the ONE add path with no `+` button to disable -- the project was
  // opened from main (deep link, notification, Open Recent, tutorial, MCP
  // `workspace_open`). At the cap the user would otherwise see nothing happen
  // at all, so surface the same toast the rail's own `+` button uses.
  if (outcome === 'at-cap') {
    console.warn('[railProjectListeners] rail at cap, refusing:', workspacePath);
    showRailFullNotification();
  }

  sendAck(requestId, workspacePath, outcome);
}
