/**
 * Shared workspace-window resolution for queued-prompt delivery.
 *
 * The mobile *sync* path already auto-opened a window for an incoming prompt;
 * the mobile *control-message* path did not — it just returned `false` into a
 * caller that discarded it, which is where iOS-triggered prompts died (#962).
 * Both paths (and the queue driver) now go through this one resolver so they
 * behave identically.
 *
 * Pure module — Electron is injected — so the auto-open policy is unit
 * testable without a main process.
 */

/** At most one auto-open per workspace per this window, so a burst of mobile
 *  prompts across projects can't open a wall of windows. */
export const AUTO_OPEN_COOLDOWN_MS = 30_000;

export type WorkspaceWindowResolution<W> =
  | { kind: 'window'; window: W; opened: boolean }
  | { kind: 'deferred'; reason: 'no-window' }
  | { kind: 'terminal'; reason: 'workspace-missing' };

export interface WorkspaceWindowResolverDeps<W> {
  findWindow(workspacePath: string): W | null | undefined;
  isDestroyed(window: W): boolean;
  /** Does the project folder still exist on disk? */
  workspaceExists(workspacePath: string): boolean;
  /**
   * Open `workspacePath` when no live window has it -- focuses an existing
   * workspace window and adds the project to its rail (Multi-Project Mode),
   * or spawns a brand-new window. `isNewWindow` tells the resolver whether
   * the window still needs to finish loading: an add-to-rail window is
   * already loaded, so `waitForLoad` would never resolve for it.
   */
  openWorkspace(workspacePath: string): { window: W; isNewWindow: boolean };
  /** Resolve once a newly-created window's renderer has finished loading. */
  waitForLoad(window: W): Promise<void>;
  isQuitting(): boolean;
  now(): number;
  logInfo(message: string): void;
  logWarn(message: string): void;
}

export interface ResolveOptions {
  /** Set false to never create a window (caller policy / user setting). */
  allowAutoOpen?: boolean;
}

export interface WorkspaceWindowResolver<W> {
  resolve(workspacePath: string, options?: ResolveOptions): Promise<WorkspaceWindowResolution<W>>;
}

export function createWorkspaceWindowResolver<W>(
  deps: WorkspaceWindowResolverDeps<W>,
): WorkspaceWindowResolver<W> {
  const lastAutoOpenAt = new Map<string, number>();
  const openInFlight = new Map<string, Promise<W | null>>();

  const liveWindow = (workspacePath: string): W | null => {
    const found = deps.findWindow(workspacePath);
    if (!found || deps.isDestroyed(found)) return null;
    return found;
  };

  return {
    async resolve(workspacePath, options): Promise<WorkspaceWindowResolution<W>> {
      const existing = liveWindow(workspacePath);
      if (existing) {
        return { kind: 'window', window: existing, opened: false };
      }

      if (!deps.workspaceExists(workspacePath)) {
        // The project folder is gone. Deferring forever would leave the prompt
        // invisible; the caller marks the row failed instead.
        return { kind: 'terminal', reason: 'workspace-missing' };
      }

      if (options?.allowAutoOpen === false || deps.isQuitting()) {
        return { kind: 'deferred', reason: 'no-window' };
      }

      // A second prompt arriving while the first is still opening must join
      // that open, not start another.
      const pending = openInFlight.get(workspacePath);
      if (pending) {
        const window = await pending;
        return window && !deps.isDestroyed(window)
          ? { kind: 'window', window, opened: true }
          : { kind: 'deferred', reason: 'no-window' };
      }

      const lastOpen = lastAutoOpenAt.get(workspacePath);
      if (lastOpen !== undefined && deps.now() - lastOpen < AUTO_OPEN_COOLDOWN_MS) {
        deps.logInfo(
          `[QueueDelivery] auto-open cooldown active for ${workspacePath}; deferring until a window appears`,
        );
        return { kind: 'deferred', reason: 'no-window' };
      }

      lastAutoOpenAt.set(workspacePath, deps.now());
      deps.logInfo(`[QueueDelivery] opening workspace window for queued prompt: ${workspacePath}`);

      const openPromise = (async () => {
        try {
          const { window: created, isNewWindow } = deps.openWorkspace(workspacePath);
          if (isNewWindow) {
            await deps.waitForLoad(created);
          }
          return created;
        } catch (error) {
          deps.logWarn(
            `[QueueDelivery] failed to auto-open workspace ${workspacePath}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return null;
        } finally {
          openInFlight.delete(workspacePath);
        }
      })();
      openInFlight.set(workspacePath, openPromise);

      const created = await openPromise;
      if (!created || deps.isDestroyed(created)) {
        return { kind: 'deferred', reason: 'no-window' };
      }
      return { kind: 'window', window: created, opened: true };
    },
  };
}
