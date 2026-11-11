// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createRequire } from "module";

const require_ = createRequire(import.meta.url);
const afterAllArtifactBuild = require_("../afterAllArtifactBuild.js")
  .default as (buildResult: { artifactPaths: string[] }) => Promise<string[]>;

const createdDirectories: string[] = [];

function createBuildResult(artifactNames: string[]): {
  directory: string;
  buildResult: { artifactPaths: string[] };
} {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nim-artifacts-"));
  createdDirectories.push(directory);
  const artifactPaths = artifactNames.map((name) => {
    const filePath = path.join(directory, name);
    fs.writeFileSync(filePath, `stub payload for ${name}`);
    return filePath;
  });
  return { directory, buildResult: { artifactPaths } };
}

afterEach(() => {
  while (createdDirectories.length > 0) {
    fs.rmSync(createdDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("afterAllArtifactBuild", () => {
  // The unsuffixed name is what every published download link points at, and
  // on Linux it has always been the x64 build.
  it("copies the x64 Linux artifacts to their unsuffixed names", async () => {
    const { directory, buildResult } = createBuildResult([
      "Nimbalyst-Linux-x64.AppImage",
      "Nimbalyst-Linux-x64.deb",
    ]);

    await afterAllArtifactBuild(buildResult);

    expect(fs.existsSync(path.join(directory, "Nimbalyst-Linux.AppImage"))).toBe(
      true
    );
    expect(fs.existsSync(path.join(directory, "Nimbalyst-Linux.deb"))).toBe(
      true
    );
  });

  // Both arches copying to the same unsuffixed name would race and leave
  // whichever ran last, so only the historical one is copied.
  it("leaves arm64 Linux artifacts alone", async () => {
    const { directory, buildResult } = createBuildResult([
      "Nimbalyst-Linux-arm64.AppImage",
    ]);

    const result = await afterAllArtifactBuild(buildResult);

    expect(fs.existsSync(path.join(directory, "Nimbalyst-Linux.AppImage"))).toBe(
      false
    );
    expect(result).toEqual(buildResult.artifactPaths);
  });

  it("still copies arm64 macOS artifacts, where arm64 owns the unsuffixed name", async () => {
    const { directory, buildResult } = createBuildResult([
      "Nimbalyst-macOS-arm64.dmg",
      "Nimbalyst-macOS-x64.dmg",
    ]);

    await afterAllArtifactBuild(buildResult);

    expect(fs.existsSync(path.join(directory, "Nimbalyst-macOS.dmg"))).toBe(
      true
    );
    expect(
      fs.readFileSync(path.join(directory, "Nimbalyst-macOS.dmg"), "utf8")
    ).toBe("stub payload for Nimbalyst-macOS-arm64.dmg");
  });

  it("skips blockmaps, which are architecture-specific checksums", async () => {
    const { directory, buildResult } = createBuildResult([
      "Nimbalyst-Linux-x64.AppImage.blockmap",
    ]);

    await afterAllArtifactBuild(buildResult);

    expect(
      fs.existsSync(path.join(directory, "Nimbalyst-Linux.AppImage.blockmap"))
    ).toBe(false);
  });

  it("returns the copies alongside the originals for publishing", async () => {
    const { directory, buildResult } = createBuildResult([
      "Nimbalyst-Linux-x64.AppImage",
    ]);

    const result = await afterAllArtifactBuild(buildResult);

    expect(result).toEqual([
      path.join(directory, "Nimbalyst-Linux-x64.AppImage"),
      path.join(directory, "Nimbalyst-Linux.AppImage"),
    ]);
  });

  it("ignores platforms that never had an unsuffixed name", async () => {
    const { directory, buildResult } = createBuildResult([
      "Nimbalyst-Windows-x64.exe",
    ]);

    await afterAllArtifactBuild(buildResult);

    expect(fs.existsSync(path.join(directory, "Nimbalyst-Windows.exe"))).toBe(
      false
    );
  });
});
