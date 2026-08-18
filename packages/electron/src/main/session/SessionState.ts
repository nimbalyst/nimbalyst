import { BrowserWindow } from 'electron';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { windows, windowStates, createWindow, windowFocusOrder, windowDevToolsState, getWindowId } from '../window/WindowManager';
import { loadFileIntoWindow } from '../file/FileOperations';
import { getSessionState, saveSessionState as saveToStore, SessionState, SessionWindow, clearSessionState, getMultiProjectMode } from '../utils/store';
import { startWorkspaceWatcher } from '../file/WorkspaceWatcher.ts';
import { getFolderContents } from '../utils/FileTree';
import { basename } from 'path';
import { logger } from '../utils/logger';
import { AnalyticsService } from '../services/analytics/AnalyticsService';
import { GitStatusService } from '../services/GitStatusService';
import { autoMatchTeamForWorkspace } from '../services/TeamService';
import { updateTrackerSchemaWorkspace } from '../services/TrackerSchemaService';
import { onStartupActivated } from '../window/StartupActivation';
import { shouldSuppressSafeModeSessionSave } from './safeModeSessionState';
import { setPendingRailSeeds } from '../window/railSeeding';

/**
 * Mirrors the renderer's `MAX_OPEN_PROJECTS` (`store/atoms/openProjects.ts`).
 * Main cannot import that constant (renderer -> main import), so the value
 * is duplicated here; keep the two in sync if the renderer cap changes. Used
 * only to bound how many rail seeds `computeSessionRestorePlan` hands out at
 * once -- the renderer's own cap is still the source of truth for what it
 * will actually accept (a mismatch here just means an extra, harmless
 * `'at-cap'` ack from `seedProjectIntoWindow` rather than data loss).
 */
export const SESSION_RESTORE_RAIL_CAP = 12;

/**
 * Pure restore-shape decision for `restoreSessionState`. Given the saved
 * windows (already sorted by focusOrder, ascending) and whether Multi-Project
 * Mode is on, decides which saved windows become real `BrowserWindow`s and
 * which saved workspace paths instead join the rail of the one restored
 * workspace window.
 *
 * No Electron / fs imports -- callers own existence checks (a saved path
 * may no longer exist on disk) and side effects (createWindow, IPC sends).
 */
export interface SessionRestorePlan {
  /** Saved windows that should become real BrowserWindows, in the same
   *  relative order as the input. When Multi-Project Mode is off (or there
   *  is at most one saved workspace window), this is the input array
   *  unchanged -- byte-for-byte identical restore behavior. */
  windowsToCreate: SessionWindow[];
  /** Saved workspace paths that should join the rail of the restored
   *  primary workspace window instead of getting a window of their own.
   *  Deduped, and capped at `SESSION_RESTORE_RAIL_CAP - 1` (the primary
   *  itself occupies the remaining rail slot). Empty unless Multi-Project
   *  Mode is on and there is more than one candidate path. */
  railPathsToSeed: string[];
  /** The workspace path that was previously active/visible and should stay
   *  so after restore -- the saved workspace window with the highest
   *  `focusOrder` ("higher = more recently focused", per `SessionWindow`).
   *  `null` when no saved window is workspace-mode. */
  activeWorkspacePath: string | null;
  /** Count of candidate rail paths dropped because they exceeded the rail
   *  cap. 0 when nothing overflowed. Callers should report this ONCE (e.g.
   *  a single log line / toast) rather than once per dropped path -- each
   *  path landing at the renderer's own cap independently would otherwise
   *  produce a toast per refusal. */
  overflowCount: number;
}

export function computeSessionRestorePlan(
  sessionWindows: SessionWindow[],
  multiProjectModeEnabled: boolean,
): SessionRestorePlan {
  const workspaceEntries = sessionWindows.filter(
    (w): w is SessionWindow & { workspacePath: string } => w.mode === 'workspace' && !!w.workspacePath,
  );

  if (workspaceEntries.length === 0) {
    // No saved workspace windows (empty list, or document-only restore) --
    // document-mode restore is unaffected by Multi-Project Mode either way.
    return { windowsToCreate: sessionWindows, railPathsToSeed: [], activeWorkspacePath: null, overflowCount: 0 };
  }

  let primary = workspaceEntries[0];
  for (const entry of workspaceEntries) {
    if ((entry.focusOrder ?? 0) > (primary.focusOrder ?? 0)) {
      primary = entry;
    }
  }

  if (!multiProjectModeEnabled) {
    return { windowsToCreate: sessionWindows, railPathsToSeed: [], activeWorkspacePath: primary.workspacePath, overflowCount: 0 };
  }

  // Gather every candidate rail path from BOTH restore shapes:
  //  (a) legacy: every OTHER saved workspace window's own `workspacePath`
  //      (pre-single-window saves, one BrowserWindow per project).
  //  (b) current: any saved window's `additionalWorkspacePaths` -- the rail
  //      contents that were live in that window's `WindowState` at save
  //      time (see `saveSessionState`). Old saved sessions have no such
  //      field; `?? []` treats that as "nothing recorded", never a crash.
  // Deduped in encounter order so the same path saved both ways (or saved
  // on more than one window) is only seeded once.
  const seen = new Set<string>();
  const candidates: string[] = [];
  const addCandidate = (path: string | undefined | null) => {
    if (!path || path === primary.workspacePath || seen.has(path)) return;
    seen.add(path);
    candidates.push(path);
  };

  for (const entry of workspaceEntries) {
    if (entry !== primary) addCandidate(entry.workspacePath);
  }
  for (const entry of workspaceEntries) {
    for (const additional of entry.additionalWorkspacePaths ?? []) {
      addCandidate(additional);
    }
  }

  if (candidates.length === 0) {
    // Nothing to collapse or seed either way -- avoid a pointless IPC
    // round trip and keep `windowsToCreate` referentially the input array.
    return { windowsToCreate: sessionWindows, railPathsToSeed: [], activeWorkspacePath: primary.workspacePath, overflowCount: 0 };
  }

  // Collapse every saved workspace window except `primary` into a single
  // window; document-mode windows are untouched and keep their relative
  // position.
  const windowsToCreate = sessionWindows.filter((w) => w.mode !== 'workspace' || w === primary);

  // The primary itself occupies one of the rail's slots, so only
  // `SESSION_RESTORE_RAIL_CAP - 1` more can be seeded -- the same
  // `MAX_OPEN_PROJECTS - 1` reservation the renderer's own restore path uses
  // for its persisted `openProjects` list (`store/atoms/openProjects.ts`,
  // the `normalizedPersistedPaths.slice(0, MAX_OPEN_PROJECTS - 1)` case).
  const seedCap = Math.max(0, SESSION_RESTORE_RAIL_CAP - 1);
  const railPathsToSeed = candidates.slice(0, seedCap);
  const overflowCount = candidates.length - railPathsToSeed.length;

  return { windowsToCreate, railPathsToSeed, activeWorkspacePath: primary.workspacePath, overflowCount };
}

// Save session state
export async function saveSessionState() {
    const sessionWindows: any[] = [];

    for (const [windowId, window] of windows) {
        const state = windowStates.get(windowId);
        if (!state || window.isDestroyed()) continue;

        // Don't save untitled empty documents
        if (state.mode === 'document' && !state.filePath && !state.documentEdited) {
            continue;
        }

        const bounds = {
            ...window.getBounds(),
            isMaximized: window.isMaximized(),
        };
        const focusOrder = windowFocusOrder.get(windowId) || 0;
        const devToolsOpen = windowDevToolsState.get(windowId) || false;
        const sessionWindow: any = {
            mode: state.mode,
            bounds,
            focusOrder,
            devToolsOpen
        };

        if (state.filePath) {
            sessionWindow.filePath = state.filePath;
        }
        if (state.workspacePath) {
            sessionWindow.workspacePath = state.workspacePath;
        }
        if (state.additionalWorkspacePaths && state.additionalWorkspacePaths.length > 0) {
            sessionWindow.additionalWorkspacePaths = [...state.additionalWorkspacePaths];
        }

        sessionWindows.push(sessionWindow);
    }

    const sessionState: SessionState = {
        windows: sessionWindows,
        lastUpdated: Date.now()
    };

    if (shouldSuppressSafeModeSessionSave(sessionWindows)) {
        logger.session.info('[SAFE MODE] Preserving the saved restoration state while Workspace Manager is open');
        return;
    }

    logger.session.debug(`[SAVE] Saving session state: ${sessionWindows.length} window(s): ${sessionWindows.map((w) => w.workspacePath || w.filePath || w.mode).join(', ')}`);
    saveToStore(sessionState);

    // Verify the save by reading it back
    const verified = getSessionState();
    logger.session.debug(`[SAVE] Verified session state: ${verified?.windows?.length ?? 0} window(s)`);
}

/**
 * Fire the `workspace_opened` analytics event for a restored/seeded
 * workspace path. Project-scoped (not window-scoped): called once per
 * project regardless of whether that project gets its own restored window
 * or joins another window's rail as a Multi-Project Mode seed, because both
 * are "a workspace was opened at startup" from the analytics consumer's
 * point of view. Extracted from the inline block that used to run only for
 * windows the loop itself created, so it can also run for rail-seeded paths.
 */
async function trackWorkspaceOpenedAnalytics(workspacePath: string): Promise<void> {
    try {
        // Count files and check for subfolders
        let fileCount = 0;
        let hasSubfolders = false;
        try {
            const entries = readdirSync(workspacePath, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isFile()) {
                    fileCount++;
                } else if (entry.isDirectory() && !entry.name.startsWith('.')) {
                    hasSubfolders = true;
                }
            }
        } catch (error) {
            // Ignore count errors
        }

        // Bucket file count
        let fileCountBucket = '1-10';
        if (fileCount > 100) fileCountBucket = '100+';
        else if (fileCount > 50) fileCountBucket = '51-100';
        else if (fileCount > 10) fileCountBucket = '11-50';

        // Check git repository status (defaults to false if git not available)
        let isGitRepository = false;
        let isGitHub = false;

        try {
            const gitStatusService = new GitStatusService();
            isGitRepository = await gitStatusService.isGitRepo(workspacePath);
            if (isGitRepository) {
                isGitHub = await gitStatusService.hasGitHubRemote(workspacePath);
            }
        } catch (gitError) {
            // Git checks failed - continue with defaults (false, false)
            logger.session.error('Error checking git status:', gitError);
        }

        const analytics = AnalyticsService.getInstance();
        analytics.sendEvent('workspace_opened', {
            fileCount: fileCountBucket,
            hasSubfolders,
            source: 'startup_restore',
            isGitRepository,
            isGitHub,
        });
    } catch (error) {
        logger.session.error('Error tracking workspace_opened event:', error);
    }
}

/**
 * Kick off the project-scoped side effects a restored/seeded workspace path
 * needs, independent of whether it got its own window: team auto-match and
 * tracker schema sync key off the path, not the window. Fire-and-forget,
 * deferred a tick so it never competes with the startup paint.
 */
function scheduleWorkspaceProjectSideEffects(workspacePath: string): void {
    setTimeout(() => {
        void autoMatchTeamForWorkspace(workspacePath).catch(() => {});
        updateTrackerSchemaWorkspace(workspacePath);
    }, 0);
}

/**
 * Seed the remaining saved workspace paths into `window`'s project rail
 * (Multi-Project Mode) via `seedProjectIntoWindow` (`window/railSeeding.ts`)
 * -- the same ack-aware wrapper around the `rail:add-project` contract used
 * by "Merge All Windows" (`consolidateWorkspaceWindows.ts`), so a seed that
 * never lands (renderer never acked, rail was already at cap, window closed
 * mid-seed) is observable instead of silently dropped. Waits for
 * `did-finish-load` -- the convention this codebase already relies on to
 * mean "the renderer's IPC listeners are registered" (see the devtools and
 * `loadFileIntoWindow` restores below) -- since a message sent earlier is
 * silently dropped.
 *
 * Every seed here is a non-primary path (`computeSessionRestorePlan` already
 * excluded the primary), so every seed is sent with `activate: false`:
 * `addOpenProjectAtom` (renderer) only flips `activeWorkspacePathAtom` when
 * asked to, so these paths join the rail without disturbing which project is
 * actually visible -- previously (before `activate` existed on this
 * contract) the window's visible project was whichever seed's
 * `workspace:register-additional` round trip happened to resolve last, not
 * the restored primary.
 *
 * Seeded sequentially (not `Promise.all`) so outcomes log in a stable,
 * readable order; restore is not latency-sensitive enough to need
 * parallelism here.
 *
 * `computeSessionRestorePlan`'s cap only bounds how many paths this
 * function is ASKED to seed -- the live rail can still be fuller than that
 * plan assumed (e.g. `restorePreviousProjectsOnLaunch` already rehydrated
 * projects into it before this seeding runs). If the renderer ever acks
 * `'at-cap'`, every further path in `railPaths` would refuse too, and each
 * refusal that actually reaches the renderer fires its own rail-full toast
 * (`railProjectListeners.ts`'s `showRailFullNotification()`, unconditional
 * on `activate`). So the first `'at-cap'` stops sending entirely --
 * mirroring `consolidateWorkspaceWindows.ts`'s `capReached` short-circuit --
 * and the shortfall is reported ONCE via `logger.session.warn` instead of
 * cascading into a toast per remaining path.
 */
/**
 * Park the restored rail paths for the renderer to collect.
 *
 * This deliberately does NOT push `rail:add-project` at `did-finish-load`.
 * The renderer registers that handler in `initRailProjectListeners()`, from a
 * React effect that runs after mount -- strictly later than
 * `did-finish-load`, and on a cold start later by seconds. A push there lands
 * with no listener attached and is dropped, the ack times out, and the
 * project is lost from the rail. Worse, because it never reached
 * `WindowState.additionalWorkspacePaths`, the next `saveSessionState()`
 * persisted no rail either -- so a single dropped seed compounded across
 * every subsequent restart. Observed in a real profile before this changed.
 *
 * The renderer pulls instead (`rail:take-pending-seeds`), asking at the exact
 * moment its listener exists. See `main/window/railSeeding.ts`.
 */
function seedRailProjects(windowId: number, railPaths: string[]): void {
    const existing = railPaths.filter((railPath) => {
        if (existsSync(railPath)) return true;
        logger.session.warn(`[RESTORE] Rail-seed workspace path no longer exists, skipping: ${railPath}`);
        return false;
    });

    if (existing.length === 0) {
        setPendingRailSeeds(windowId, []);
        return;
    }

    setPendingRailSeeds(windowId, existing);
    logger.session.info(
        `[RESTORE] Parked ${existing.length} rail project(s) for the renderer to collect: ${existing.join(', ')}`
    );

    // Project-scoped side effects don't depend on the rail add landing -- they
    // key off the workspace path, and the renderer will register each path as
    // it collects them.
    for (const railPath of existing) {
        void trackWorkspaceOpenedAnalytics(railPath);
        scheduleWorkspaceProjectSideEffects(railPath);
    }
}

// Restore session state
// Returns true if windows were restored, false otherwise.
// All restored windows use showInactive() so no single window takes focus back
// mid-load; StartupActivation foregrounds the app once when the last one is up.
export async function restoreSessionState(): Promise<boolean> {
    // In test mode (PLAYWRIGHT=1), always clear and skip session restoration
    // Tests that want to test restoration will not set PLAYWRIGHT env var at all
    if (process.env.PLAYWRIGHT === '1') {
        logger.session.info('Test mode: clearing and skipping session restoration');
        clearSessionState();
        return false;
    }

    const sessionState = getSessionState();

    // logger.session.info('[RESTORE] Retrieved session state:', JSON.stringify(sessionState, null, 2));

    if (!sessionState || !sessionState.windows || sessionState.windows.length === 0) {
        logger.session.info('[RESTORE] No session state to restore (empty or missing)');
        return false;
    }

    // logger.session.info(`[RESTORE] Restoring session with ${sessionState.windows.length} window(s)`);

    // Sort windows by focus order - LOWEST first, HIGHEST last
    // Windows are shown in creation order, and macOS will naturally focus the last shown window
    const sortedWindows = [...sessionState.windows].sort((a, b) => {
        const aOrder = a.focusOrder || 0;
        const bOrder = b.focusOrder || 0;
        return aOrder - bOrder;
    });

    logger.session.info(`Window creation order (by focusOrder):`, sortedWindows.map((w, i) =>
        `${i}: ${w.mode} focusOrder=${w.focusOrder}`
    ));

    // With Multi-Project Mode on and more than one saved workspace window,
    // collapse the extra workspace windows into rail seeds for the one
    // restored primary window instead of a BrowserWindow each. Off (or with
    // at most one saved workspace window), `plan.windowsToCreate` is the
    // input array unchanged -- byte-for-byte identical to today.
    const plan = computeSessionRestorePlan(sortedWindows, getMultiProjectMode());
    if (plan.railPathsToSeed.length > 0) {
        logger.session.info(
            `[RESTORE] Multi-Project Mode: restoring one window for ${plan.activeWorkspacePath}, seeding rail with ${plan.railPathsToSeed.length} more: ${plan.railPathsToSeed.join(', ')}`
        );
    }
    // Reported once here, not once per dropped path -- each seed hitting the
    // renderer's own cap independently would otherwise fire a toast per
    // refusal (a toast storm at startup) instead of one summary.
    if (plan.overflowCount > 0) {
        logger.session.warn(
            `[RESTORE] Multi-Project Mode: ${plan.overflowCount} saved project(s) did not fit in the rail and were not restored.`
        );
    }

    // Restore each window in order
    // Use async creation to ensure windows are created sequentially
    // Every window is shown inactive so a late ready-to-show event cannot
    // foreground Nimbalyst after the user has switched applications. Each
    // registration claims `startupFrontmost`, so the last window created here —
    // the one with the highest focusOrder — is the one brought to the front.
    for (const sessionWindow of plan.windowsToCreate) {

        // Wait for previous window to be ready before creating next
        await new Promise<void>((resolve) => {
            setTimeout(async () => {
                let window: BrowserWindow | null = null;

                if (sessionWindow.mode === 'workspace' && sessionWindow.workspacePath) {
                    // Check if workspace path still exists
                    if (existsSync(sessionWindow.workspacePath)) {
                        // Track workspace opened from startup restore
                        await trackWorkspaceOpenedAnalytics(sessionWindow.workspacePath);

                        window = createWindow(false, true, sessionWindow.workspacePath, sessionWindow.bounds, {
                            showInactive: true,
                            startupReveal: true,
                            startupFrontmost: true,
                        });
                        logger.session.info(`Restored workspace window: ${sessionWindow.workspacePath}`);

                        scheduleWorkspaceProjectSideEffects(sessionWindow.workspacePath);

                        if (
                            window &&
                            plan.railPathsToSeed.length > 0 &&
                            sessionWindow.workspacePath === plan.activeWorkspacePath
                        ) {
                            // Park before the renderer mounts -- it collects
                            // them itself once its listeners are registered.
                            // `== null` on purpose: catches undefined too, so a
                            // missing id can never be parked as a map key.
                            const restoredWindowId = getWindowId(window);
                            if (restoredWindowId != null) {
                                seedRailProjects(restoredWindowId, plan.railPathsToSeed);
                            } else {
                                logger.session.error(
                                    '[RESTORE] Could not resolve window id; rail projects not parked'
                                );
                            }
                        }

                        // Note: Workspace tabs will be restored by the workspace's own tab state management
                        // We don't manually open files here to avoid interfering with tab restoration
                    } else {
                        logger.session.warn(`Workspace path no longer exists: ${sessionWindow.workspacePath}`);
                    }
                } else if (sessionWindow.mode === 'document' && sessionWindow.filePath) {
                    // Check if file still exists
                    if (existsSync(sessionWindow.filePath)) {
                        window = createWindow(true, false, undefined, sessionWindow.bounds, {
                            showInactive: true,
                            startupReveal: true,
                            startupFrontmost: true,
                        });
                        if (window) {
                            window.once('ready-to-show', () => {
                                loadFileIntoWindow(window!, sessionWindow.filePath!);
                            });
                            logger.session.info(`Restored document window: ${sessionWindow.filePath}`);
                        }
                    } else {
                        logger.session.warn(`File no longer exists: ${sessionWindow.filePath}`);
                    }
                }

                // Restore dev tools state
                if (window && sessionWindow.devToolsOpen) {
                    // Wait for window to be ready before opening dev tools
                    // Detached dev tools activate the app, so wait for the
                    // single startup foregrounding rather than racing it.
                    window.webContents.once('did-finish-load', () => {
                        onStartupActivated(() => {
                            if (!window.isDestroyed()) window.webContents.openDevTools();
                        });
                    });
                }

                resolve();
            }, 300); // 300ms delay between each window creation
        });
    }

    return true;
}
