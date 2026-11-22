// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "module";

const require_ = createRequire(import.meta.url);
const { buildMacYmlString, MAC_UPDATE_MINIMUM_DARWIN_VERSION } = require_("../generate-update-yml.js");
// The parser and OS check of the updater that existing installs run. Feeding
// our generated feed through them is what proves a Monterey install skips it.
const { parseUpdateInfo } = require_("electron-updater/out/providers/Provider.js");
const { AppUpdater } = require_("electron-updater/out/AppUpdater.js");
const os = require_("os");

const feed = buildMacYmlString({
  version: "0.90.0",
  files: [
    { url: "Nimbalyst-macOS-arm64.zip", sha512: "a", size: 1, arch: "arm64" },
    { url: "Nimbalyst-macOS-x64.zip", sha512: "b", size: 2, arch: "x64" },
  ],
  path: "Nimbalyst-macOS-arm64.zip",
  sha512: "a",
  releaseDate: "2026-11-20T00:00:00.000Z",
  releaseNotes: "notes",
  minimumSystemVersion: MAC_UPDATE_MINIMUM_DARWIN_VERSION,
});

function updateSupportedOn(darwinRelease: string): boolean {
  vi.spyOn(os, "release").mockReturnValue(darwinRelease);
  const info = parseUpdateInfo(feed, "latest-mac.yml", new URL("https://example.invalid/latest-mac.yml"));
  const logger = { info: vi.fn(), warn: vi.fn() };
  return AppUpdater.prototype.checkIfUpdateSupported.call({ _logger: logger }, info);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("latest-mac.yml macOS floor", () => {
  it("is skipped by the shipped updater on macOS 12 (Darwin 21) and accepted on macOS 13 (Darwin 22)", () => {
    expect(updateSupportedOn("21.6.0")).toBe(false);
    expect(updateSupportedOn("22.0.0")).toBe(true);
    expect(updateSupportedOn("25.1.0")).toBe(true);
  });

  it("keeps both architectures in the parsed feed", () => {
    const info = parseUpdateInfo(feed, "latest-mac.yml", new URL("https://example.invalid/latest-mac.yml"));
    expect(info.files.map((file: { arch: string }) => file.arch)).toEqual(["arm64", "x64"]);
    expect(info.minimumSystemVersion).toBe("22.0.0");
  });
});
