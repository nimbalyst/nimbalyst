// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { handlers, write, readFailure, state } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  write: vi.fn(),
  readFailure: { code: null as string | null },
  state: { documentEdited: true },
}));
vi.mock("../../utils/ipcRegistry", () => ({
  safeHandle: (name: string, fn: any) => handlers.set(name, fn),
}));
vi.mock("../OpenFileHandlers", () => ({ registerOpenFileHandlers: vi.fn() }));
vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: () => ({}) },
  app: {},
  dialog: {},
}));
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    readFileSync: (...args: any[]) => {
      if (readFailure.code)
        throw Object.assign(new Error("read unavailable"), {
          code: readFailure.code,
        });
      return (actual.readFileSync as any)(...args);
    },
  };
});
vi.mock("../../window/WindowManager", () => ({
  getWindowId: () => 1,
  windowStates: new Map([[1, state]]),
  savingWindows: new Set(),
  recentlyDeletedFiles: new Map(),
  documentServices: new Map(),
}));
vi.mock("../../file/FileOperations", () => ({ saveFile: write }));
vi.mock("../../file/FileOpener", () => ({}));
vi.mock("../../file/FileWatcher", () => ({}));
vi.mock("../../utils/store", () => ({}));
vi.mock("../../utils/logger", () => ({
  logger: { main: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));
vi.mock("../../services/analytics/AnalyticsService", () => ({
  AnalyticsService: { getInstance: () => ({ sendEvent: vi.fn() }) },
}));
vi.mock("../../utils/workspaceDetection", () => ({}));
vi.mock("../../file/SessionFileWatcher", () => ({
  SessionFileWatcher: { markEditorSave: vi.fn() },
}));
vi.mock("../../file/WorkspaceEventBus", () => ({}));
vi.mock("../../services/DocSyncService", () => ({}));
vi.mock("../../file/WorkspaceWatcher", () => ({}));
vi.mock("../../utils/dialogPaths", () => ({}));
vi.mock(
  "@nimbalyst/runtime/ai/server/providers/claudeCode/claudeConfigDir",
  () => ({})
);

import { registerFileHandlers } from "../FileHandlers";

describe("save-file disk verification (#1499)", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nim-save-verification-"));
    file = join(dir, "note.md");
    writeFileSync(file, "external content");
    readFailure.code = null;
    state.documentEdited = true;
    write
      .mockReset()
      .mockImplementation((path, content) => writeFileSync(path, content));
    registerFileHandlers();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it.each(["EACCES", "EIO", "EMFILE"])(
    "never writes when verification fails with %s",
    async (code) => {
      readFailure.code = code;
      const result = await handlers.get("save-file")!(
        { sender: {} },
        "stale buffer",
        file,
        "old content",
        "auto"
      );
      expect(result).toMatchObject({ success: false, errorCode: code });
      expect(write).not.toHaveBeenCalled();
      readFailure.code = null;
      expect(readFileSync(file, "utf8")).toBe("external content");
      expect(state.documentEdited).toBe(true);
    }
  );

  it("preserves newer disk content when no watcher event was delivered", async () => {
    const result = await handlers.get("save-file")!(
      { sender: {} },
      "stale buffer",
      file,
      "old content",
      "auto"
    );
    expect(result).toMatchObject({
      success: false,
      conflict: true,
      diskContent: "external content",
    });
    expect(write).not.toHaveBeenCalled();
    readFailure.code = null;
    expect(readFileSync(file, "utf8")).toBe("external content");
  });
});
