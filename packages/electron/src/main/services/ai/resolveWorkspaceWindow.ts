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
export const WORKSPACE_WINDOW_LOAD_TIMEOUT_MS = 15_000;

interface LoadEventSource {
  isDestroyed(): boolean;
  once(event: string, listener: (...args: never[]) => void): unknown;
  removeListener(event: string, listener: (...args: never[]) => void): unknown;
}

export interface WorkspaceWindowLoadTarget extends LoadEventSource {
  webContents: LoadEventSource;
}

export interface WorkspaceWindowLoadTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/**
 * Wait for a newly-created workspace window to become dispatchable. Every
 * terminal route removes every listener and the timeout, so an opening window
 * can never strand the resolver or retain stale wakeups.
 */
export function waitForWorkspaceWindowLoad(
  window: WorkspaceWindowLoadTarget,
  timers: WorkspaceWindowLoadTimers = {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timeoutHandle: unknown | null = null;
    const listeners: Array<{
      source: LoadEventSource;
      event: string;
      listener: (...args: never[]) => void;
    }> = [];

    const cleanup = () => {
      if (timeoutHandle !== null) {
        timers.clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      for (const { source, event, listener } of listeners) {
        source.removeListener(event, listener);
      }
      listeners.length = 0;
    };

    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const failLoad = () => settle(new Error('Workspace window failed to load'));
    const lostWindow = () => settle(new Error('Workspace window closed before load'));
    const listen = (
      source: LoadEventSource,
      event: string,
      listener: (...args: never[]) => void,
    ) => {
      listeners.push({ source, event, listener });
      source.once(event, listener);
    };

    if (window.isDestroyed() || window.webContents.isDestroyed()) {
      lostWindow();
      return;
    }

    listen(window.webContents, 'did-finish-load', () => settle());
    listen(window.webContents, 'did-fail-load', failLoad);
    listen(window.webContents, 'render-process-gone', failLoad);
    listen(window.webContents, 'destroyed', lostWindow);
    listen(window, 'close', lostWindow);
    listen(window, 'closed', lostWindow);
    timeoutHandle = timers.setTimeout(
      () => settle(new Error('Workspace window load timed out')),
      WORKSPACE_WINDOW_LOAD_TIMEOUT_MS,
    );
  });
}

export type WorkspaceWindowResolution<W> =
  | { kind: 'window'; window: W; opened: boolean }
  | { kind: 'deferred'; reason: 'no-window' }
  | { kind: 'terminal'; reason: 'workspace-missing' };

export interface WorkspaceWindowResolverDeps<W> {
  findWindow(workspacePath: string): W | null | undefined;
  isDestroyed(window: W): boolean;
  /** Does the project folder still exist on disk? */
  workspaceExists(workspacePath: string): boolean;
  createWindow(workspacePath: string): W;
  /** Resolve once the new window's renderer has finished loading. */
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
      // A second prompt arriving while the first is still opening must join
      // that open, not start another.
      const pending = openInFlight.get(workspacePath);
      if (pending) {
        const window = await pending;
        const ready = window && !deps.isDestroyed(window) ? window : liveWindow(workspacePath);
        return ready
          ? { kind: 'window', window: ready, opened: true }
          : { kind: 'deferred', reason: 'no-window' };
      }

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
          const created = deps.createWindow(workspacePath);
          await deps.waitForLoad(created);
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
      const ready = created && !deps.isDestroyed(created) ? created : liveWindow(workspacePath);
      if (!ready) {
        return { kind: 'deferred', reason: 'no-window' };
      }
      return { kind: 'window', window: ready, opened: true };
    },
  };
}
