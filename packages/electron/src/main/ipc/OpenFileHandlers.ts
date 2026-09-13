import { app, BrowserWindow, powerMonitor } from "electron";
import {
  addGitignoreBypass,
  removeGitignoreBypass,
  getStats,
} from "../file/WorkspaceEventBus";
import { safeHandle } from "../utils/ipcRegistry";
import { openFileReconciler } from "../file/OpenFileReconciler";
import { markRecentlyDeleted } from "../window/WindowManager";

/** File-scoped like read-file-content: explicitly opened paths can be outside any workspace. */
export function registerOpenFileHandlers(): void {
  const attached = new Set<number>();
  const bypasses = new Map<string, Map<string, () => void>>();
  const releaseToken = (owner: string, token: string) => {
    openFileReconciler.unregister(owner, token);
    const registrations = bypasses.get(owner);
    registrations?.get(token)?.();
    registrations?.delete(token);
    if (!registrations?.size) bypasses.delete(owner);
  };
  const releaseOwner = (owner: string) => {
    for (const token of [...(bypasses.get(owner)?.keys() ?? [])])
      releaseToken(owner, token);
    openFileReconciler.releaseOwner(owner);
  };
  safeHandle("file:register-open", (event, token: string, filePath: string) => {
    if (typeof token !== "string" || typeof filePath !== "string")
      throw new Error("Missing file registration");
    const sender = event.sender;
    const window = BrowserWindow.fromWebContents(sender);
    if (!window || sender.isDestroyed())
      throw new Error("File registration has no live window");
    const owner = String(sender.id);
    if (!attached.has(sender.id)) {
      attached.add(sender.id);
      const release = () => releaseOwner(owner);
      sender.once("destroyed", () => {
        release();
        attached.delete(sender.id);
      });
      sender.on("render-process-gone", release);
      sender.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
        if (mainFrame && !inPlace) release();
      });
    }
    openFileReconciler.register(owner, token, filePath, (result) => {
      if (sender.isDestroyed()) throw new Error("Renderer closed");
      if (result.status === "deleted") markRecentlyDeleted(filePath);
      sender.send("file:reconciled", { token, ...result });
    });
    const roots = getStats().workspaces.map((root) => root.workspacePath);
    const bypassOwner = `open:${owner}:${token}`;
    const owned = bypasses.get(owner) ?? new Map<string, () => void>();
    owned.get(token)?.();
    for (const root of roots) addGitignoreBypass(root, filePath, bypassOwner);
    owned.set(token, () => {
      for (const root of roots)
        removeGitignoreBypass(root, filePath, bypassOwner);
    });
    bypasses.set(owner, owned);
    return { success: true };
  });
  safeHandle("file:unregister-open", (event, token: string) => {
    if (typeof token !== "string")
      throw new Error("Missing file registration token");
    releaseToken(String(event.sender.id), token);
  });
  // Resource ownership is always sender-scoped; renderer arguments cannot inspect another window's files.
  safeHandle("file:reconcile-open", (event) =>
    openFileReconciler.reconcile(true, String(event.sender.id))
  );
  app.on("browser-window-focus", (_event, window) => {
    void openFileReconciler.reconcile(true, String(window.webContents.id));
  });
  powerMonitor.on("resume", () => {
    void openFileReconciler.reconcile(true);
  });
  app.once("before-quit", () => openFileReconciler.stop());
}
