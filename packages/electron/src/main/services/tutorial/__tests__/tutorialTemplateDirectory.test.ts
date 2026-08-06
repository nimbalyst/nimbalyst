import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const electronState = vi.hoisted(() => ({
  isPackaged: false,
  appPath: "",
}));

vi.mock("electron", () => ({
  app: {
    get isPackaged() {
      return electronState.isPackaged;
    },
    getAppPath: () => electronState.appPath,
  },
}));

import { getTutorialTemplateDirectory } from "../tutorialTemplateDirectory";

const originalResourcesPathDescriptor = Object.getOwnPropertyDescriptor(
  process,
  "resourcesPath"
);

let packageRoot: string;

beforeEach(() => {
  electronState.isPackaged = false;
  // A real package root on disk: getPackageRoot() walks up from the app path
  // looking for package.json, so this cannot be faked with a string alone.
  packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nimbalyst-tutorial-"));
  fs.writeFileSync(path.join(packageRoot, "package.json"), "{}", "utf8");
  electronState.appPath = packageRoot;
});

afterEach(() => {
  electronState.isPackaged = false;
  electronState.appPath = "";
  fs.rmSync(packageRoot, { recursive: true, force: true });
  if (originalResourcesPathDescriptor) {
    Object.defineProperty(
      process,
      "resourcesPath",
      originalResourcesPathDescriptor
    );
  } else {
    Reflect.deleteProperty(process, "resourcesPath");
  }
});

describe("getTutorialTemplateDirectory", () => {
  it("resolves the in-repo resource directory in development", () => {
    expect(getTutorialTemplateDirectory()).toBe(
      path.join(packageRoot, "resources", "tutorial-project")
    );
  });

  it("resolves the package root when the app path is the vite out directory", () => {
    // Under the dev build app.getAppPath() is <packageRoot>/out/main, so a
    // naive join would produce <packageRoot>/out/main/resources/tutorial-project
    // and the template would never be found.
    const outMain = path.join(packageRoot, "out", "main");
    fs.mkdirSync(outMain, { recursive: true });
    electronState.appPath = outMain;

    expect(getTutorialTemplateDirectory()).toBe(
      path.join(packageRoot, "resources", "tutorial-project")
    );
  });

  it("resolves the package root for an alternate out directory (dev:user2)", () => {
    const outMain = path.join(packageRoot, "out2", "main");
    fs.mkdirSync(outMain, { recursive: true });
    electronState.appPath = outMain;

    expect(getTutorialTemplateDirectory()).toBe(
      path.join(packageRoot, "resources", "tutorial-project")
    );
  });

  it("resolves the copied resources directory in packaged builds", () => {
    electronState.isPackaged = true;
    Object.defineProperty(process, "resourcesPath", {
      configurable: true,
      value: path.join("bundle", "resources"),
    });

    expect(getTutorialTemplateDirectory()).toBe(
      path.join("bundle", "resources", "tutorial-project")
    );
  });
});
