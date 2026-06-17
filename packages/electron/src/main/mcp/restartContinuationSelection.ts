/**
 * Pure selection for restart-continuation (NIM-813).
 *
 * `restart_nimbalyst` saves the sessions to auto-resume after the app comes back.
 * Resuming EVERY running/streaming session at once re-creates the thundering herd
 * we fixed at launch (each genuine CLI fires an upstream request, stampeding the
 * subscription rate cap). Instead we resume only the session the FOCUSED window
 * is actively viewing, so /restart continues just the one the user was working
 * in; the rest stay paused until the user interacts.
 *
 * Kept dependency-free so the BrowserWindow / ipcMain round-trip that produces
 * `viewingBySession` is the only untested seam.
 */

/**
 * Keep only the running/streaming session(s) the focused window is viewing.
 * `viewingBySession` maps each candidate id -> whether the focused window is
 * currently viewing it (a window views exactly one agent session, so the result
 * is 0 or 1 id). Returns `[]` when there is no focused window / no match.
 */
export function selectFocusedRestartSessions(
  runningSessionIds: string[],
  viewingBySession: Record<string, boolean>,
): string[] {
  return runningSessionIds.filter((id) => viewingBySession[id] === true);
}
