// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createRequire } from "module";

const require_ = createRequire(import.meta.url);
const { generateLinuxYml } = require_("../generate-update-yml.js");

const createdDirectories: string[] = [];

function createReleaseDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nim-release-"));
  createdDirectories.push(directory);
  return directory;
}

afterEach(() => {
  while (createdDirectories.length > 0) {
    fs.rmSync(createdDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("generateLinuxYml", () => {
  it("lists both arch-suffixed AppImages with x64 as the primary", () => {
    const dir = createReleaseDirectory();
    fs.writeFileSync(path.join(dir, "Nimbalyst-Linux-x64.AppImage"), "x64");
    fs.writeFileSync(path.join(dir, "Nimbalyst-Linux-arm64.AppImage"), "arm64");

    expect(generateLinuxYml(dir)).toBe(true);

    const yml = fs.readFileSync(path.join(dir, "latest-linux.yml"), "utf8");
    expect(yml).toContain("url: Nimbalyst-Linux-x64.AppImage");
    expect(yml).toContain("url: Nimbalyst-Linux-arm64.AppImage");
    expect(yml).toContain("arch: x64");
    expect(yml).toContain("arch: arm64");
    expect(yml).toContain("path: Nimbalyst-Linux-x64.AppImage");
  });

  it("falls back to arm64 as primary when only arm64 is present", () => {
    const dir = createReleaseDirectory();
    fs.writeFileSync(path.join(dir, "Nimbalyst-Linux-arm64.AppImage"), "arm64");

    expect(generateLinuxYml(dir)).toBe(true);

    const yml = fs.readFileSync(path.join(dir, "latest-linux.yml"), "utf8");
    expect(yml).toContain("path: Nimbalyst-Linux-arm64.AppImage");
  });

  it("skips generation when no AppImage is present", () => {
    const dir = createReleaseDirectory();

    expect(generateLinuxYml(dir)).toBe(false);
    expect(fs.existsSync(path.join(dir, "latest-linux.yml"))).toBe(false);
  });
});
