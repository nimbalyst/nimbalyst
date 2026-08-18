import { app, type BrowserWindow } from "electron";
import * as fs from "fs/promises";
import * as path from "path";
import type {
  TutorialStartResult,
  TutorialStatusResult,
} from "../../../shared/tutorial";
import {
  addToRecentItems,
  getMultiProjectMode,
  getWorkspaceWindowState,
  saveAgentPermissions,
  setWorkspaceTrusted,
  updateWorkspaceState,
  type WorkspaceState,
} from "../../utils/store";
import {
  createWindow,
  findWindowByWorkspace,
  getMostRecentlyFocusedWorkspaceWindow,
} from "../../window/WindowManager";
import {
  RAIL_ADD_PROJECT_CHANNEL,
  resolveProjectOpenTarget,
} from "../../window/resolveProjectOpenTarget";
import { seedTutorialSessions } from "./TutorialSessionSeeder";
import {
  deleteTutorialTrackers,
  seedTutorialTrackers,
  type SeededTutorialTracker,
} from "./TutorialTrackerSeeder";
import { getTutorialTemplateDirectory } from "./tutorialTemplateDirectory";
import {
  TUTORIAL_MARKER_FILE,
  hasValidTutorialMarker,
} from "./tutorialMarker";
import {
  captureTutorialStarted,
  type TutorialEntryPoint,
} from "./tutorialAnalytics";

const TUTORIAL_DIRECTORY_NAME = "Nimbalyst Tutorial";
const TUTORIAL_TEMPLATE_VERSION = 1;
const TUTORIAL_README_TAB_ID = "tutorial-readme";
// Never copied into the user's project. `sessions` holds the raw transcript
// fixtures the seeder reads from the template — they would otherwise show up
// in the tutorial's file tree as two unexplained JSON files.
const TEMPLATE_ONLY_METADATA_FILES = new Set([
  "sessions",
  TUTORIAL_MARKER_FILE,
  ".nimbalyst-tutorial-template.json",
  "trackers.json",
]);

type WorkspaceStateUpdater = (state: WorkspaceState) => void | WorkspaceState;

export interface TutorialProjectServiceDependencies {
  getDocumentsDirectory: () => string;
  getTemplateDirectory: () => string;
  setWorkspaceTrusted: typeof setWorkspaceTrusted;
  saveAgentPermissions: typeof saveAgentPermissions;
  updateWorkspaceState: (
    workspacePath: string,
    updater: WorkspaceStateUpdater
  ) => WorkspaceState;
  getWorkspaceWindowState: typeof getWorkspaceWindowState;
  createWindow: typeof createWindow;
  findWindowByWorkspace: (workspacePath: string) => BrowserWindow | null;
  /** Multi-Project Mode: whether opening a project should add it to the
   *  focused window's rail instead of spawning a new window. */
  getMultiProjectMode: typeof getMultiProjectMode;
  getMostRecentlyFocusedWorkspaceWindow: typeof getMostRecentlyFocusedWorkspaceWindow;
  addToRecentItems: typeof addToRecentItems;
  closeWorkspaceManagerWindow: () => void;
  seedTutorialTrackers: (
    workspacePath: string
  ) => Promise<SeededTutorialTracker[]>;
  deleteTutorialTrackers: (
    workspacePath: string,
    items: SeededTutorialTracker[]
  ) => Promise<void>;
  seedTutorialSessions: (
    workspacePath: string,
    trackerReferences: SeededTutorialTracker[]
  ) => Promise<void>;
  captureTutorialStarted: (
    entryPoint: TutorialEntryPoint,
    reused: boolean
  ) => void;
}

const defaultDependencies: TutorialProjectServiceDependencies = {
  getDocumentsDirectory: () => app.getPath("documents"),
  getTemplateDirectory: getTutorialTemplateDirectory,
  setWorkspaceTrusted,
  saveAgentPermissions,
  updateWorkspaceState,
  getWorkspaceWindowState,
  createWindow,
  findWindowByWorkspace,
  getMultiProjectMode,
  getMostRecentlyFocusedWorkspaceWindow,
  addToRecentItems,
  closeWorkspaceManagerWindow: () => undefined,
  seedTutorialTrackers,
  deleteTutorialTrackers,
  seedTutorialSessions: async (workspacePath, trackerReferences) => {
    await seedTutorialSessions(workspacePath, { trackerReferences });
  },
  captureTutorialStarted,
};

interface DestinationResolution {
  workspacePath: string;
  reused: boolean;
}

export class TutorialProjectService {
  private readonly dependencies: TutorialProjectServiceDependencies;
  private startInFlight: Promise<TutorialStartResult> | null = null;

  constructor(dependencies: Partial<TutorialProjectServiceDependencies> = {}) {
    this.dependencies = {
      ...defaultDependencies,
      ...dependencies,
    };
  }

  async getStatus(): Promise<TutorialStatusResult> {
    try {
      const existingPath = await this.findExistingTutorialProject();
      return {
        success: true,
        exists: existingPath !== null,
        ...(existingPath ? { workspacePath: existingPath } : {}),
      };
    } catch (error) {
      return {
        success: false,
        exists: false,
        error: this.errorMessage(error),
      };
    }
  }

  async startTutorial(
    entryPoint: TutorialEntryPoint = "unknown"
  ): Promise<TutorialStartResult> {
    if (this.startInFlight) {
      return this.startInFlight;
    }

    this.startInFlight = this.startTutorialInternal(entryPoint).finally(() => {
      this.startInFlight = null;
    });
    return this.startInFlight;
  }

  private async startTutorialInternal(
    entryPoint: TutorialEntryPoint
  ): Promise<TutorialStartResult> {
    try {
      const templateDirectory = this.dependencies.getTemplateDirectory();
      await this.assertTemplateDirectory(templateDirectory);

      const destination = await this.resolveDestination();
      if (!destination.reused) {
        await this.materializeProject(
          templateDirectory,
          destination.workspacePath
        );
      }

      this.openProject(destination.workspacePath);
      this.dependencies.captureTutorialStarted(
        entryPoint,
        destination.reused
      );
      return {
        success: true,
        workspacePath: destination.workspacePath,
        reused: destination.reused,
      };
    } catch (error) {
      return {
        success: false,
        error: this.errorMessage(error),
      };
    }
  }

  private async assertTemplateDirectory(
    templateDirectory: string
  ): Promise<void> {
    let stats;
    try {
      stats = await fs.stat(templateDirectory);
    } catch {
      throw new Error(
        `Tutorial template directory does not exist: ${templateDirectory}`
      );
    }

    if (!stats.isDirectory()) {
      throw new Error(
        `Tutorial template directory is not a directory: ${templateDirectory}`
      );
    }

    try {
      await fs.access(path.join(templateDirectory, "README.md"));
    } catch {
      throw new Error(
        `Tutorial template README is missing: ${templateDirectory}`
      );
    }
  }

  private async findExistingTutorialProject(): Promise<string | null> {
    const documentsDirectory = this.dependencies.getDocumentsDirectory();
    for (let suffix = 1; ; suffix += 1) {
      const candidate = this.destinationForSuffix(documentsDirectory, suffix);
      if (!(await this.pathExists(candidate))) {
        return null;
      }
      if (await this.hasValidMarker(candidate)) {
        return candidate;
      }
    }
  }

  private async resolveDestination(): Promise<DestinationResolution> {
    const documentsDirectory = this.dependencies.getDocumentsDirectory();
    for (let suffix = 1; ; suffix += 1) {
      const candidate = this.destinationForSuffix(documentsDirectory, suffix);
      if (!(await this.pathExists(candidate))) {
        return { workspacePath: candidate, reused: false };
      }
      if (await this.hasValidMarker(candidate)) {
        return { workspacePath: candidate, reused: true };
      }
    }
  }

  private destinationForSuffix(
    documentsDirectory: string,
    suffix: number
  ): string {
    const directoryName =
      suffix === 1
        ? TUTORIAL_DIRECTORY_NAME
        : `${TUTORIAL_DIRECTORY_NAME} ${suffix}`;
    return path.join(documentsDirectory, directoryName);
  }

  private hasValidMarker(workspacePath: string): Promise<boolean> {
    return hasValidTutorialMarker(workspacePath);
  }

  private async pathExists(candidatePath: string): Promise<boolean> {
    try {
      await fs.access(candidatePath);
      return true;
    } catch {
      return false;
    }
  }

  private async materializeProject(
    templateDirectory: string,
    workspacePath: string
  ): Promise<void> {
    const documentsDirectory = this.dependencies.getDocumentsDirectory();
    const temporaryRoot = await fs.mkdtemp(
      path.join(documentsDirectory, ".nimbalyst-tutorial-")
    );
    const temporaryProject = path.join(temporaryRoot, "project");
    let renamedIntoPlace = false;
    let seededTrackers: SeededTutorialTracker[] = [];

    try {
      await fs.cp(templateDirectory, temporaryProject, {
        recursive: true,
        filter: (sourcePath) =>
          !TEMPLATE_ONLY_METADATA_FILES.has(path.basename(sourcePath)),
      });
      await fs.writeFile(
        path.join(temporaryProject, TUTORIAL_MARKER_FILE),
        `${JSON.stringify(
          { templateVersion: TUTORIAL_TEMPLATE_VERSION },
          null,
          2
        )}\n`,
        "utf8"
      );
      await fs.rename(temporaryProject, workspacePath);
      renamedIntoPlace = true;

      this.dependencies.setWorkspaceTrusted(workspacePath, true, "bypass-all");
      this.dependencies.saveAgentPermissions(workspacePath, {
        permissionMode: "bypass-all",
        allowAllUsesClassifier: true,
      });

      seededTrackers = await this.dependencies.seedTutorialTrackers(
        workspacePath
      );
      await this.materializeTrackerReferences(workspacePath, seededTrackers);

      const readmePath = path.join(workspacePath, "README.md");
      this.dependencies.updateWorkspaceState(workspacePath, (state) => {
        state.activeMode = "files";
        state.recentDocuments = [readmePath];
        state.tabs = {
          tabs: [
            {
              id: TUTORIAL_README_TAB_ID,
              filePath: readmePath,
              fileName: "README.md",
              isDirty: false,
              isPinned: false,
              isVirtual: false,
            },
          ],
          activeTabId: TUTORIAL_README_TAB_ID,
          tabOrder: [TUTORIAL_README_TAB_ID],
          closedTabs: [],
        };
      });

      await this.dependencies.seedTutorialSessions(
        workspacePath,
        seededTrackers
      );
    } catch (error) {
      if (seededTrackers.length > 0) {
        await this.dependencies.deleteTutorialTrackers(
          workspacePath,
          seededTrackers
        );
      }
      if (renamedIntoPlace) {
        await fs.rm(workspacePath, { recursive: true, force: true });
      }
      throw error;
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  }

  private async materializeTrackerReferences(
    workspacePath: string,
    trackers: SeededTutorialTracker[]
  ): Promise<void> {
    const trackersByKey = new Map(
      trackers.map((tracker) => [tracker.key, tracker])
    );
    const readmePath = path.join(workspacePath, "README.md");
    const readme = await fs.readFile(readmePath, "utf8");
    const materialized = readme.replace(
      /\{\{TRACKER_ISSUE_KEY:([A-Z0-9_]+)\}\}/g,
      (_placeholder, key: string) => {
        const tracker = trackersByKey.get(key);
        if (!tracker) {
          throw new Error(
            `Tutorial README references unknown tracker key: ${key}`
          );
        }
        return tracker.issueKey ?? tracker.id;
      }
    );
    await fs.writeFile(readmePath, materialized, "utf8");
  }

  private openProject(workspacePath: string): void {
    // The tutorial can be started repeatedly (Help menu, Workspace Manager),
    // so focus the window that already has it rather than opening a
    // duplicate. Mirrors `openOrFocusWorkspaceWindow`'s decision (inlined
    // via the shared pure resolver, not imported directly, to avoid a
    // circular import -- WorkspaceManagerWindow already imports this class).
    const existingWindow =
      this.dependencies.findWindowByWorkspace(workspacePath);
    const target = resolveProjectOpenTarget({
      workspacePath,
      multiProjectModeEnabled: this.dependencies.getMultiProjectMode(),
      existingWindowForPath:
        existingWindow && !existingWindow.isDestroyed() ? existingWindow : null,
      focusedWorkspaceWindow: existingWindow
        ? null
        : this.dependencies.getMostRecentlyFocusedWorkspaceWindow(),
    });

    if (target.kind === "focus-existing") {
      target.window.focus();
    } else if (target.kind === "add-to-rail") {
      target.window.focus();
      target.window.webContents.send(RAIL_ADD_PROJECT_CHANNEL, {
        workspacePath,
      });
    } else {
      const savedState =
        this.dependencies.getWorkspaceWindowState(workspacePath);
      this.dependencies.createWindow(
        false,
        true,
        workspacePath,
        savedState?.bounds
      );
    }

    this.dependencies.addToRecentItems(
      "workspaces",
      workspacePath,
      path.basename(workspacePath)
    );
    this.dependencies.closeWorkspaceManagerWindow();
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
