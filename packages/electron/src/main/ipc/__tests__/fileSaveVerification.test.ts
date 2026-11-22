// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { handlers, write, readFailure, state, documentServices, pushFileToIndex, addWorkspaceRecentFile } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  write: vi.fn(),
  readFailure: { code: null as string | null },
  state: { documentEdited: true } as Record<string, any>,
  documentServices: new Map<string, { refreshFileMetadata: (path: string) => Promise<void> }>(),
  pushFileToIndex: vi.fn(async () => {}),
  addWorkspaceRecentFile: vi.fn(),
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
  documentServices,
}));
vi.mock("../../file/FileOperations", () => ({ saveFile: write }));
vi.mock("../../file/FileOpener", () => ({}));
vi.mock("../../file/FileWatcher", () => ({}));
vi.mock("../../utils/store", () => ({ addWorkspaceRecentFile }));
vi.mock("../../utils/logger", () => ({
  logger: { main: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));
vi.mock("../../services/analytics/AnalyticsService", () => ({
  AnalyticsService: { getInstance: () => ({ sendEvent: vi.fn() }) },
}));
vi.mock("../../utils/workspaceDetection", () => vi.importActual("../../utils/workspaceDetection"));
vi.mock("../../file/SessionFileWatcher", () => ({
  SessionFileWatcher: { markEditorSave: vi.fn() },
}));
vi.mock("../../file/WorkspaceEventBus", () => ({}));
vi.mock("../../services/DocSyncService", () => ({ pushFileToIndex }));
vi.mock("../../file/WorkspaceWatcher", () => ({ pushNewDocumentToSync: vi.fn() }));
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

describe("rail windows act on the project the file belongs to", () => {
  let projectA: string;
  let projectB: string;
  beforeEach(() => {
    projectA = mkdtempSync(join(tmpdir(), "nim-rail-a-"));
    projectB = mkdtempSync(join(tmpdir(), "nim-rail-b-"));
    // The window was opened on A; the user switched the rail to B.
    Object.assign(state, {
      mode: "workspace",
      documentEdited: true,
      workspacePath: projectA,
      additionalWorkspacePaths: [projectB],
      activeWorkspacePath: projectB,
    });
    write
      .mockReset()
      .mockImplementation((path, content) => writeFileSync(path, content));
    pushFileToIndex.mockClear();
    addWorkspaceRecentFile.mockClear();
    documentServices.clear();
    registerFileHandlers();
  });
  afterEach(() => {
    for (const key of ["mode", "workspacePath", "additionalWorkspacePaths", "activeWorkspacePath"]) delete state[key];
    documentServices.clear();
    rmSync(projectA, { recursive: true, force: true });
    rmSync(projectB, { recursive: true, force: true });
  });

  it("save-file refreshes and indexes the second rail project's file under that project", async () => {
    const refreshA = vi.fn(async () => {});
    const refreshB = vi.fn(async () => {});
    documentServices.set(projectA, { refreshFileMetadata: refreshA });
    documentServices.set(projectB, { refreshFileMetadata: refreshB });
    const file = join(projectB, "plan.md");
    writeFileSync(file, "old");

    vi.useFakeTimers();
    try {
      const result = await handlers.get("save-file")!({ sender: {} }, "new", file, "old", "manual");
      expect(result).toMatchObject({ success: true });
      await vi.advanceTimersByTimeAsync(100);
    } finally {
      vi.useRealTimers();
    }

    expect(refreshB).toHaveBeenCalledWith(file);
    expect(refreshA).not.toHaveBeenCalled();
    expect(pushFileToIndex).toHaveBeenCalledWith(file, projectB);
  });

  it("create-document creates the file in the active rail project, not the first one", async () => {
    const result = await handlers.get("create-document")!({ sender: {} }, "notes/new.md", "# hi");

    expect(result).toMatchObject({ success: true, filePath: join(projectB, "notes/new.md") });
    expect(readFileSync(join(projectB, "notes/new.md"), "utf8")).toBe("# hi");
    expect(addWorkspaceRecentFile).toHaveBeenCalledWith(projectB, join(projectB, "notes/new.md"));
    expect(pushFileToIndex).toHaveBeenCalledWith(join(projectB, "notes/new.md"), projectB);
  });
});
