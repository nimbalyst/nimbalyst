interface RestartShutdownDependencies {
  beginRestart(): void;
  stopExternalSessions(): Promise<void>;
  saveSessionState(): Promise<void>;
  flushPendingBackups(): Promise<void>;
  quit(): void;
}

/** Own the restart's before-quit passes, including repeated quit requests. */
export function createRestartShutdown(deps: RestartShutdownDependencies) {
  let pending = false;
  let readyToQuit = false;

  return async (event: { preventDefault(): void }): Promise<void> => {
    if (readyToQuit) return;
    // Electron does not await before-quit listeners. Keep windows alive through
    // the snapshot and all cleanup, including if another quit arrives meanwhile.
    event.preventDefault();
    if (pending) return;
    pending = true;
    try {
      deps.beginRestart();
      await Promise.all([deps.stopExternalSessions(), deps.saveSessionState()]);
      await deps.flushPendingBackups();
      readyToQuit = true;
      deps.quit();
    } finally {
      pending = false;
    }
  };
}
