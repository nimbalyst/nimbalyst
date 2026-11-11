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
  arch?: string;
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
      "Nimbalyst-Linux-x64.deb",
      "Nimbalyst-Linux-x64.AppImage",
    ]);

    const artifacts: LinuxArtifact[] = collectLinuxArtifacts(
      releaseDir,
      "Nimbalyst"
    );

    expect(artifacts.map((artifact) => artifact.url)).toEqual([
      "Nimbalyst-Linux-x64.AppImage",
      "Nimbalyst-Linux-x64.deb",
    ]);
  });

  // An arm64 install matches on `arch`; with no arm64 entry it either never
  // updates or is offered the x64 binary, which will not run.
  it("lists every published architecture, x64 first within a package type", () => {
    const releaseDir = createReleaseDirectory([
      "Nimbalyst-Linux-arm64.AppImage",
      "Nimbalyst-Linux-x64.AppImage",
    ]);

    const artifacts: LinuxArtifact[] = collectLinuxArtifacts(
      releaseDir,
      "Nimbalyst"
    );

    expect(artifacts.map((artifact) => [artifact.url, artifact.arch])).toEqual([
      ["Nimbalyst-Linux-x64.AppImage", "x64"],
      ["Nimbalyst-Linux-arm64.AppImage", "arm64"],
    ]);
  });

  it("orders by package type before architecture", () => {
    const releaseDir = createReleaseDirectory([
      "Nimbalyst-Linux-x64.AppImage",
      "Nimbalyst-Linux-x64.deb",
      "Nimbalyst-Linux-arm64.AppImage",
      "Nimbalyst-Linux-arm64.deb",
    ]);

    const artifacts: LinuxArtifact[] = collectLinuxArtifacts(
      releaseDir,
      "Nimbalyst"
    );

    expect(artifacts.map((artifact) => artifact.url)).toEqual([
      "Nimbalyst-Linux-x64.AppImage",
      "Nimbalyst-Linux-arm64.AppImage",
      "Nimbalyst-Linux-x64.deb",
      "Nimbalyst-Linux-arm64.deb",
    ]);
  });

  // The top-level path/sha512 fallback must stay on an AppImage, so an
  // AppImage of any architecture outranks a .deb of any architecture.
  it("keeps an AppImage first even when only the .deb is x64", () => {
    const releaseDir = createReleaseDirectory([
      "Nimbalyst-Linux-x64.deb",
      "Nimbalyst-Linux-arm64.AppImage",
    ]);

    const artifacts: LinuxArtifact[] = collectLinuxArtifacts(
      releaseDir,
      "Nimbalyst"
    );

    expect(artifacts[0].url).toBe("Nimbalyst-Linux-arm64.AppImage");
  });

  it("skips package types and architectures this build did not produce", () => {
    const releaseDir = createReleaseDirectory([
      "Nimbalyst-Linux-arm64.AppImage",
    ]);

    const artifacts: LinuxArtifact[] = collectLinuxArtifacts(
      releaseDir,
      "Nimbalyst"
    );

    expect(artifacts.map((artifact) => artifact.url)).toEqual([
      "Nimbalyst-Linux-arm64.AppImage",
    ]);
  });

  it("hashes and sizes each artifact independently", () => {
    const releaseDir = createReleaseDirectory([
      "Nimbalyst-Linux-x64.AppImage",
      "Nimbalyst-Linux-x64.deb",
    ]);

    const [appImage, deb]: LinuxArtifact[] = collectLinuxArtifacts(
      releaseDir,
      "Nimbalyst"
    );

    expect(appImage.sha512).not.toEqual(deb.sha512);
    expect(appImage.size).toBe(
      fs.statSync(path.join(releaseDir, "Nimbalyst-Linux-x64.AppImage")).size
    );
    expect(deb.size).toBe(
      fs.statSync(path.join(releaseDir, "Nimbalyst-Linux-x64.deb")).size
    );
  });

  it("gives artifacts of different architectures distinct hashes", () => {
    const releaseDir = createReleaseDirectory([
      "Nimbalyst-Linux-x64.AppImage",
      "Nimbalyst-Linux-arm64.AppImage",
    ]);

    const [x64, arm64]: LinuxArtifact[] = collectLinuxArtifacts(
      releaseDir,
      "Nimbalyst"
    );

    expect(x64.sha512).not.toEqual(arm64.sha512);
  });
});

describe("buildLinuxChannelYaml", () => {
  const artifacts: LinuxArtifact[] = [
    {
      url: "Nimbalyst-Linux-x64.AppImage",
      sha512: "appimage-x64-hash",
      size: 11,
      arch: "x64",
    },
    {
      url: "Nimbalyst-Linux-arm64.AppImage",
      sha512: "appimage-arm64-hash",
      size: 22,
      arch: "arm64",
    },
  ];

  it("emits one files entry per artifact", () => {
    const yaml: string = buildLinuxChannelYaml(
      "1.2.3",
      artifacts,
      "2026-09-02T00:00:00.000Z"
    );

    expect(yaml).toContain(
      "  - url: Nimbalyst-Linux-x64.AppImage\n    sha512: appimage-x64-hash\n    size: 11\n    arch: x64\n"
    );
    expect(yaml).toContain(
      "  - url: Nimbalyst-Linux-arm64.AppImage\n    sha512: appimage-arm64-hash\n    size: 22\n    arch: arm64\n"
    );
  });

  // Clients installed before the .deb existed read the top-level path/sha512,
  // so those must keep pointing at the AppImage.
  it("keeps the top-level path and sha512 on the first artifact", () => {
    const yaml: string = buildLinuxChannelYaml(
      "1.2.3",
      artifacts,
      "2026-09-02T00:00:00.000Z"
    );

    expect(yaml).toContain("path: Nimbalyst-Linux-x64.AppImage\n");
    expect(yaml).toContain("sha512: appimage-x64-hash\nreleaseDate:");
  });

  it("omits the arch line for an artifact that has no arch", () => {
    const yaml: string = buildLinuxChannelYaml(
      "1.2.3",
      [{ url: "Nimbalyst-Linux.AppImage", sha512: "legacy-hash", size: 33 }],
      "2026-09-02T00:00:00.000Z"
    );

    expect(yaml).toContain(
      "  - url: Nimbalyst-Linux.AppImage\n    sha512: legacy-hash\n    size: 33\npath:"
    );
  });

  it("refuses to write a channel file with no artifacts", () => {
    expect(() =>
      buildLinuxChannelYaml("1.2.3", [], "2026-09-02T00:00:00.000Z")
    ).toThrow(/at least one artifact/);
  });
});
