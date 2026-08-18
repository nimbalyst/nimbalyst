// Indirection so modules that only need to *trigger* a menu rebuild do not
// have to import `menu/ApplicationMenu` directly. That module pulls in the
// AI usage-report window and the autoUpdater singleton, so a static import
// from an IPC handler evaluates that whole graph at module load -- which
// breaks unrelated suites in vitest's node environment (the same failure
// mode `mcpConfigServiceRef.ts` exists to avoid).
//
// `index.ts` already owns the menu and registers the refresher at startup;
// everyone else calls `refreshApplicationMenu()`.

type Refresher = () => void | Promise<void>;

let refresher: Refresher | null = null;

export function setApplicationMenuRefresher(fn: Refresher): void {
  refresher = fn;
}

/**
 * Rebuild the application menu if a refresher has been registered.
 * Fire-and-forget: callers are settings handlers that must not block on
 * menu construction, and a rebuild failure must not fail the setting write.
 */
export function refreshApplicationMenu(): void {
  if (!refresher) return;
  void Promise.resolve(refresher()).catch(() => {
    // A menu rebuild failure must never break the action that triggered it.
  });
}
