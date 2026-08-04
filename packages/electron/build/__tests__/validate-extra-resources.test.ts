// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createRequire } from "module";

const require_ = createRequire(import.meta.url);
const { validatePackagedTutorialProject } = require_(
  "../validate-extra-resources.js"
);

const createdDirectories: string[] = [];

function createResourcesDirectory(): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "nim-tutorial-output-")
  );
  createdDirectories.push(directory);
  return directory;
}

afterEach(() => {
  while (createdDirectories.length > 0) {
    fs.rmSync(createdDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("validatePackagedTutorialProject", () => {
  it("rejects packaged output that omitted the tutorial project", () => {
    const resourcesDirectory = createResourcesDirectory();

    expect(() => validatePackagedTutorialProject(resourcesDirectory)).toThrow(
      /packaged tutorial project is missing/i
    );
  });

  it("accepts packaged output containing the tutorial README", () => {
    const resourcesDirectory = createResourcesDirectory();
    const tutorialDirectory = path.join(resourcesDirectory, "tutorial-project");
    fs.mkdirSync(tutorialDirectory);
    fs.writeFileSync(path.join(tutorialDirectory, "README.md"), "# Welcome");

    expect(() =>
      validatePackagedTutorialProject(resourcesDirectory)
    ).not.toThrow();
  });
});
