import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  TutorialProjectService,
  type TutorialProjectServiceDependencies,
} from "../TutorialProjectService";
import type { SeededTutorialTracker } from "../TutorialTrackerSeeder";

const createdDirectories: string[] = [];
const EXAMPLE_BUG: SeededTutorialTracker = {
  key: "EXAMPLE_BUG",
  id: "tk_tutorial_example_bug",
  issueKey: "NIM-6",
  type: "bug",
  title: "Export remains disabled after changing the date range",
};

async function createTempDirectory(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  createdDirectories.push(directory);
  return directory;
}

async function createHarness() {
  const root = await createTempDirectory("nimbalyst-tutorial-service-");
  const documentsDirectory = path.join(root, "Documents");
  const templateDirectory = path.join(root, "template");
  await fs.mkdir(documentsDirectory);
  await fs.mkdir(templateDirectory);
  await fs.writeFile(
    path.join(templateDirectory, "README.md"),
    "# Welcome to Nimbalyst\n\nOpen the [example bug](nimbalyst://{{TRACKER_ISSUE_KEY:EXAMPLE_BUG}}).\n"
  );
  await fs.writeFile(
    path.join(templateDirectory, ".nimbalyst-tutorial-template.json"),
    JSON.stringify({ authoringOnly: true })
  );
  await fs.writeFile(
    path.join(templateDirectory, "trackers.json"),
    JSON.stringify([{ authoringOnly: true }])
  );

  const workspaceStates = new Map<string, Record<string, unknown>>();
  const dependencies: TutorialProjectServiceDependencies = {
    getDocumentsDirectory: () => documentsDirectory,
    getTemplateDirectory: () => templateDirectory,
    setWorkspaceTrusted: vi.fn(),
    saveAgentPermissions: vi.fn(),
    updateWorkspaceState: vi.fn((workspacePath, updater) => {
      const state = workspaceStates.get(workspacePath) ?? {};
      updater(state as never);
      workspaceStates.set(workspacePath, state);
      return state as never;
    }),
    getWorkspaceWindowState: vi.fn(() => undefined),
    createWindow: vi.fn(),
    findWindowByWorkspace: vi.fn(() => null),
    getMultiProjectMode: vi.fn(() => false),
    getMostRecentlyFocusedWorkspaceWindow: vi.fn(() => null),
    addToRecentItems: vi.fn(),
    closeWorkspaceManagerWindow: vi.fn(),
    seedTutorialTrackers: vi.fn(async () => [EXAMPLE_BUG]),
    deleteTutorialTrackers: vi.fn(async () => undefined),
    seedTutorialSessions: vi.fn(async () => undefined),
    captureTutorialStarted: vi.fn(),
  };

  return {
    documentsDirectory,
    templateDirectory,
    workspaceStates,
    dependencies,
    service: new TutorialProjectService(dependencies),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  await Promise.all(
    createdDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  );
});

describe("TutorialProjectService", () => {
  it("materializes the template and seeds trust, document mode, and the README tab", async () => {
    const harness = await createHarness();

    const result = await harness.service.startTutorial();

    expect(result).toMatchObject({ success: true, reused: false });
    if (!result.success) throw new Error(result.error);

    const readmePath = path.join(result.workspacePath, "README.md");
    await expect(fs.readFile(readmePath, "utf8")).resolves.toContain(
      "nimbalyst://NIM-6"
    );
    await expect(
      fs.access(
        path.join(result.workspacePath, ".nimbalyst-tutorial-template.json")
      )
    ).rejects.toThrow();
    await expect(
      fs.access(path.join(result.workspacePath, "trackers.json"))
    ).rejects.toThrow();
    expect(harness.dependencies.setWorkspaceTrusted).toHaveBeenCalledWith(
      result.workspacePath,
      true,
      "bypass-all"
    );
    expect(harness.dependencies.saveAgentPermissions).toHaveBeenCalledWith(
      result.workspacePath,
      {
        permissionMode: "bypass-all",
        allowAllUsesClassifier: true,
      }
    );

    const state = harness.workspaceStates.get(result.workspacePath);
    expect(state).toMatchObject({
      activeMode: "files",
      tabs: {
        activeTabId: "tutorial-readme",
        tabOrder: ["tutorial-readme"],
        tabs: [
          {
            id: "tutorial-readme",
            filePath: readmePath,
            fileName: "README.md",
          },
        ],
      },
    });
    expect(harness.dependencies.seedTutorialTrackers).toHaveBeenCalledWith(
      result.workspacePath
    );
    expect(harness.dependencies.seedTutorialSessions).toHaveBeenCalledWith(
      result.workspacePath,
      [EXAMPLE_BUG]
    );
    expect(harness.dependencies.createWindow).toHaveBeenCalledWith(
      false,
      true,
      result.workspacePath,
      undefined
    );
    expect(harness.dependencies.addToRecentItems).toHaveBeenCalledWith(
      "workspaces",
      result.workspacePath,
      "Nimbalyst Tutorial"
    );
    expect(
      harness.dependencies.closeWorkspaceManagerWindow
    ).toHaveBeenCalledOnce();
  });

  it("reuses a marked tutorial project on a second start without copying or reseeding it", async () => {
    const harness = await createHarness();
    const first = await harness.service.startTutorial();
    if (!first.success) throw new Error(first.error);

    const userFile = path.join(first.workspacePath, "user-notes.md");
    await fs.writeFile(userFile, "Keep this edit");
    vi.clearAllMocks();

    const second = await harness.service.startTutorial();

    expect(second).toEqual({
      success: true,
      workspacePath: first.workspacePath,
      reused: true,
    });
    await expect(fs.readFile(userFile, "utf8")).resolves.toBe("Keep this edit");
    expect(harness.dependencies.setWorkspaceTrusted).not.toHaveBeenCalled();
    expect(harness.dependencies.saveAgentPermissions).not.toHaveBeenCalled();
    expect(harness.dependencies.updateWorkspaceState).not.toHaveBeenCalled();
    expect(harness.dependencies.seedTutorialSessions).not.toHaveBeenCalled();
    expect(harness.dependencies.seedTutorialTrackers).not.toHaveBeenCalled();
    expect(harness.dependencies.createWindow).toHaveBeenCalledOnce();
  });

  it("focuses the existing window instead of opening a duplicate when the tutorial is already open", async () => {
    const harness = await createHarness();
    const first = await harness.service.startTutorial();
    if (!first.success) throw new Error(first.error);

    const focus = vi.fn();
    vi.clearAllMocks();
    vi.mocked(harness.dependencies.findWindowByWorkspace).mockReturnValue({
      isDestroyed: () => false,
      focus,
    } as never);

    const second = await harness.service.startTutorial();

    expect(second).toMatchObject({ success: true, reused: true });
    expect(focus).toHaveBeenCalledOnce();
    expect(harness.dependencies.createWindow).not.toHaveBeenCalled();
  });

  it("adds the tutorial project to the focused window's rail in Multi-Project Mode instead of opening a new window", async () => {
    const harness = await createHarness();
    const focus = vi.fn();
    const send = vi.fn();
    vi.mocked(harness.dependencies.getMultiProjectMode).mockReturnValue(true);
    vi.mocked(
      harness.dependencies.getMostRecentlyFocusedWorkspaceWindow
    ).mockReturnValue({
      isDestroyed: () => false,
      focus,
      webContents: { send },
    } as never);

    const result = await harness.service.startTutorial();
    if (!result.success) throw new Error(result.error);

    expect(harness.dependencies.createWindow).not.toHaveBeenCalled();
    expect(focus).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith("rail:add-project", {
      workspacePath: result.workspacePath,
    });
  });

  it("fails loudly when the template directory is missing and leaves no project behind", async () => {
    const harness = await createHarness();
    await fs.rm(harness.templateDirectory, { recursive: true });

    const result = await harness.service.startTutorial();

    expect(result).toMatchObject({ success: false });
    if (result.success) throw new Error("Expected tutorial start to fail");
    expect(result.error).toMatch(/template directory.*does not exist/i);
    await expect(
      fs.access(path.join(harness.documentsDirectory, "Nimbalyst Tutorial"))
    ).rejects.toThrow();
    expect(harness.dependencies.createWindow).not.toHaveBeenCalled();
  });

  it("uses a numbered destination when the default folder is not a tutorial project", async () => {
    const harness = await createHarness();
    await fs.mkdir(path.join(harness.documentsDirectory, "Nimbalyst Tutorial"));
    await fs.writeFile(
      path.join(harness.documentsDirectory, "Nimbalyst Tutorial", "README.md"),
      "Existing user project"
    );

    const result = await harness.service.startTutorial();

    expect(result).toMatchObject({
      success: true,
      workspacePath: path.join(
        harness.documentsDirectory,
        "Nimbalyst Tutorial 2"
      ),
      reused: false,
    });
  });

  it("removes the destination when workspace initialization fails", async () => {
    const harness = await createHarness();
    vi.mocked(harness.dependencies.saveAgentPermissions).mockImplementation(
      () => {
        throw new Error("Workspace state unavailable");
      }
    );

    const result = await harness.service.startTutorial();

    expect(result).toEqual({
      success: false,
      error: "Workspace state unavailable",
    });
    await expect(
      fs.access(path.join(harness.documentsDirectory, "Nimbalyst Tutorial"))
    ).rejects.toThrow();
    expect(harness.dependencies.createWindow).not.toHaveBeenCalled();
  });

  it("removes seeded tracker rows when session seeding fails", async () => {
    const harness = await createHarness();
    vi.mocked(harness.dependencies.seedTutorialSessions).mockRejectedValue(
      new Error("Session fixture unavailable")
    );

    const result = await harness.service.startTutorial();

    expect(result).toEqual({
      success: false,
      error: "Session fixture unavailable",
    });
    expect(harness.dependencies.deleteTutorialTrackers).toHaveBeenCalledWith(
      path.join(harness.documentsDirectory, "Nimbalyst Tutorial"),
      [EXAMPLE_BUG]
    );
    await expect(
      fs.access(path.join(harness.documentsDirectory, "Nimbalyst Tutorial"))
    ).rejects.toThrow();
  });
});
