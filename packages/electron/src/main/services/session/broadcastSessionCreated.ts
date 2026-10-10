import { BrowserWindow } from 'electron';

/**
 * Tell every window a session row was created outside the renderer (meta-agent
 * spawns, extension-owned sessions) so the session list picks it up.
 *
 * `sessions:refresh-list` only updates the registry atom. Workstream surfaces
 * (tab strip, left tree) also read per-parent atoms that the registry refresh
 * does not touch, so a child filed under a container also gets the targeted
 * `sessions:child-added`.
 */
export function broadcastSessionCreated(args: {
  workspacePath: string;
  sessionId: string;
  parentSessionId?: string | null;
  worktreeId?: string | null;
}): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    window.webContents.send('sessions:refresh-list', {
      workspacePath: args.workspacePath,
      sessionId: args.sessionId,
    });
    if (args.worktreeId) {
      window.webContents.send('worktree:session-created', {
        sessionId: args.sessionId,
        worktreeId: args.worktreeId,
      });
    }
    if (args.parentSessionId) {
      window.webContents.send('sessions:child-added', {
        workspacePath: args.workspacePath,
        parentSessionId: args.parentSessionId,
        childSessionId: args.sessionId,
      });
    }
  }
}
