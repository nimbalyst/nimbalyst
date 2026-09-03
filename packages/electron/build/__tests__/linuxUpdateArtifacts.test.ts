// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createRequire } from "module";

const require_ = createRequire(import.meta.url);
const { collectLinuxArtifacts, buildLinuxChannelYaml } = require_(
  "../linuxUpdateArtifacts.js"
);

interface LinuxArtifact {
  url: string;
  sha512: string;
  size: number;
}

const createdDirectories: string[] = [];

function createReleaseDirectory(artifactNames: string[]): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nim-linux-channel-"));
  createdDirectories.push(directory);
  for (const name of artifactNames) {
    fs.writeFileSync(path.join(directory, name), `stub payload for ${name}`);
  }
  return directory;
}

afterEach(() => {
  while (createdDirectories.length > 0) {
    fs.rmSync(createdDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("collectLinuxArtifacts", () => {
  // electron-updater picks its artifact out of latest-linux.yml by extension,
  // so a .deb install with no `.deb` entry silently never updates (#1430).
  it("lists every published package type, AppImage first", () => {
    const releaseDir = createReleaseDirectory([
      "Nimbalyst-Linux.deb",
      "Nimbalyst-Linux.AppImage",
    ]);

    const artifacts: LinuxArtifact[] = collectLinuxArtifacts(
      releaseDir,
      "Nimbalyst"
    );

    expect(artifacts.map((artifact) => artifact.url)).toEqual([
      "Nimbalyst-Linux.AppImage",
      "Nimbalyst-Linux.deb",
    ]);
  });

  it("skips package types this build did not produce", () => {
    const releaseDir = createReleaseDirectory(["Nimbalyst-Linux.AppImage"]);

    const artifacts: LinuxArtifact[] = collectLinuxArtifacts(
      releaseDir,
      "Nimbalyst"
    );

    expect(artifacts.map((artifact) => artifact.url)).toEqual([
      "Nimbalyst-Linux.AppImage",
    ]);
  });

  it("hashes and sizes each artifact independently", () => {
    const releaseDir = createReleaseDirectory([
      "Nimbalyst-Linux.AppImage",
      "Nimbalyst-Linux.deb",
    ]);

    const [appImage, deb]: LinuxArtifact[] = collectLinuxArtifacts(
      releaseDir,
      "Nimbalyst"
    );

    expect(appImage.sha512).not.toEqual(deb.sha512);
    expect(appImage.size).toBe(
      fs.statSync(path.join(releaseDir, "Nimbalyst-Linux.AppImage")).size
    );
    expect(deb.size).toBe(
      fs.statSync(path.join(releaseDir, "Nimbalyst-Linux.deb")).size
    );
  });
});

describe("buildLinuxChannelYaml", () => {
  const artifacts: LinuxArtifact[] = [
    { url: "Nimbalyst-Linux.AppImage", sha512: "appimage-hash", size: 11 },
    { url: "Nimbalyst-Linux.deb", sha512: "deb-hash", size: 22 },
  ];

  it("emits one files entry per artifact", () => {
    const yaml: string = buildLinuxChannelYaml(
      "1.2.3",
      artifacts,
      "2026-09-02T00:00:00.000Z"
    );

    expect(yaml).toContain("  - url: Nimbalyst-Linux.AppImage\n    sha512: appimage-hash\n    size: 11\n");
    expect(yaml).toContain("  - url: Nimbalyst-Linux.deb\n    sha512: deb-hash\n    size: 22\n");
  });

  // Clients installed before the .deb existed read the top-level path/sha512,
  // so those must keep pointing at the AppImage.
  it("keeps the top-level path and sha512 on the first artifact", () => {
    const yaml: string = buildLinuxChannelYaml(
      "1.2.3",
      artifacts,
      "2026-09-02T00:00:00.000Z"
    );

    expect(yaml).toContain("path: Nimbalyst-Linux.AppImage\n");
    expect(yaml).toContain("sha512: appimage-hash\nreleaseDate:");
  });

  it("refuses to write a channel file with no artifacts", () => {
    expect(() =>
      buildLinuxChannelYaml("1.2.3", [], "2026-09-02T00:00:00.000Z")
    ).toThrow(/at least one artifact/);
  });
});
