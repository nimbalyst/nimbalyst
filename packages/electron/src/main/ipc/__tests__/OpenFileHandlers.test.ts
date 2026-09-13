// @vitest-environment node
import { EventEmitter } from "events";
import { afterEach, expect, it, vi } from "vitest";
const { handlers, roots, markDeleted } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  roots: ["/test/workspace"],
  markDeleted: vi.fn(),
}));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("events");
  return {
    app: new EventEmitter(),
    powerMonitor: new EventEmitter(),
    BrowserWindow: { fromWebContents: () => ({}) },
  };
});
vi.mock("../../utils/ipcRegistry", () => ({
  safeHandle: (channel: string, handler: any) => handlers.set(channel, handler),
}));
vi.mock("../../file/WorkspaceEventBus", () => ({
  addGitignoreBypass: vi.fn(),
  removeGitignoreBypass: vi.fn(),
  getStats: () => ({
    workspaces: roots.map((workspacePath) => ({ workspacePath })),
  }),
}));
vi.mock("../../window/WindowManager", () => ({
  markRecentlyDeleted: markDeleted,
}));
import { app, powerMonitor } from "electron";
import { registerOpenFileHandlers } from "../OpenFileHandlers";
import { openFileReconciler } from "../../file/OpenFileReconciler";
import { removeGitignoreBypass } from "../../file/WorkspaceEventBus";

afterEach(() => {
  openFileReconciler.stop();
  app.removeAllListeners();
  powerMonitor.removeAllListeners();
  vi.restoreAllMocks();
});

it("scopes tokens to senders, reconciles on focus/wake, and releases crash/navigation ownership", async () => {
  registerOpenFileHandlers();
  const first = Object.assign(new EventEmitter(), {
    id: 1,
    send: vi.fn(),
    isDestroyed: () => false,
  });
  const second = Object.assign(new EventEmitter(), {
    id: 2,
    send: vi.fn(),
    isDestroyed: () => false,
  });
  // Explicitly opened files outside roots use the same file-read boundary.
  handlers.get("file:register-open")!(
    { sender: first },
    "shared-token",
    "/outside/one.custom"
  );
  handlers.get("file:register-open")!(
    { sender: second },
    "shared-token",
    "/outside/two.md"
  );
  expect(openFileReconciler.getStats().registrations).toBe(2);
  const reconcile = vi
    .spyOn(openFileReconciler, "reconcile")
    .mockResolvedValue();
  app.emit("browser-window-focus", {}, { webContents: first });
  expect(reconcile).toHaveBeenLastCalledWith(true, "1");
  powerMonitor.emit("resume");
  expect(reconcile).toHaveBeenLastCalledWith(true);
  handlers.get("file:unregister-open")!({ sender: first }, "shared-token");
  expect(openFileReconciler.getStats().registrations).toBe(1);
  expect(removeGitignoreBypass).toHaveBeenCalledWith(
    "/test/workspace",
    "/outside/one.custom",
    "open:1:shared-token"
  );
  second.emit("render-process-gone");
  expect(openFileReconciler.getStats().registrations).toBe(0);
  handlers.get("file:register-open")!(
    { sender: first },
    "next",
    "/outside/one.custom"
  );
  first.emit("did-start-navigation", {}, "new-renderer", false, true);
  expect(openFileReconciler.getStats().registrations).toBe(0);
  handlers.get("file:register-open")!(
    { sender: first },
    "last",
    "/outside/one.custom"
  );
  first.emit("destroyed");
  expect(openFileReconciler.getStats().registrations).toBe(0);
  await Promise.resolve();
  expect(first.send).not.toHaveBeenCalled();
  expect(second.send).not.toHaveBeenCalled();
});

it("rejects virtual paths instead of registering them as disk files", () => {
  registerOpenFileHandlers();
  const sender = Object.assign(new EventEmitter(), {
    id: 3,
    send: vi.fn(),
    isDestroyed: () => false,
  });
  expect(() =>
    handlers.get("file:register-open")!(
      { sender },
      "token",
      "shared://document"
    )
  ).toThrow("Invalid open-file registration");
  expect(openFileReconciler.getStats().registrations).toBe(0);
});
