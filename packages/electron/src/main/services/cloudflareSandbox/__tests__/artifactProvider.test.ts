// @vitest-environment node
import { createHash } from "crypto";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getAppPath: () => "/app",
    getPath: () =>
      process.env.NIMBALYST_TEST_USERDATA ?? "/tmp/nimbalyst-test-userdata",
  },
}));
vi.mock("../../../utils/logger", () => ({
  logger: { main: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } },
}));

import { PackagedArtifactProvider, parseManifest } from "../artifactProvider";
import { SandboxOperationError } from "../errors";

const DIGEST_IMAGE = "docker.io/nimbalyst/sandbox@sha256:" + "a".repeat(64);

let dir: string;

async function writeArtifact(image: string | null): Promise<void> {
  const worker = "export default {};\n";
  const helper = "export const helper = 1;\n";
  await fs.writeFile(path.join(dir, "worker.mjs"), worker);
  await fs.writeFile(path.join(dir, "rpc-helper.mjs"), helper);
  await fs.writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      sdkVersion: "0.13.0-next.751.1",
      workerSha256: createHash("sha256").update(worker).digest("hex"),
      helperSha256: createHash("sha256").update(helper).digest("hex"),
      image,
    })
  );
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "nimbalyst-artifact-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("parseManifest", () => {
  it("rejects stable SDK artifacts after the preview protocol migration", () => {
    expect(() => parseManifest(JSON.stringify({
      schemaVersion: 1, sdkVersion: '0.12.9', workerSha256: 'a'.repeat(64), helperSha256: 'b'.repeat(64), image: DIGEST_IMAGE,
    }))).toThrow(SandboxOperationError);
  });
  it("rejects a mutable tag, which could be repointed after the user reviewed it", () => {
    expect(() =>
      parseManifest(
        JSON.stringify({
          schemaVersion: 1,
          sdkVersion: "0.13.0-next.751.1",
          workerSha256: "a".repeat(64),
          helperSha256: "b".repeat(64),
          image: "docker.io/nimbalyst/sandbox:1.0.0",
        })
      )
    ).toThrow(SandboxOperationError);
  });

  it("accepts a full digest reference", () => {
    expect(
      parseManifest(
        JSON.stringify({
          schemaVersion: 1,
          sdkVersion: "0.13.0-next.751.1",
          workerSha256: "a".repeat(64),
          helperSha256: "b".repeat(64),
          image: DIGEST_IMAGE,
        })
      ).image
    ).toBe(DIGEST_IMAGE);
  });

  it("rejects an unknown schema version instead of guessing the layout", () => {
    expect(() => parseManifest(JSON.stringify({ schemaVersion: 2 }))).toThrow(
      SandboxOperationError
    );
  });
});

describe("PackagedArtifactProvider", () => {
  it("says an unpublished image is unavailable, and says it is not the account s fault", async () => {
    await writeArtifact(null);
    const provider = new PackagedArtifactProvider(() => dir);

    const availability = await provider.describe();

    expect(availability.available).toBe(false);
    if (availability.available) return;
    expect(availability.reason).toMatch(/not been published/i);
    // The user must not go hunting through Cloudflare for a problem we caused.
    expect(availability.reason).toMatch(
      /nothing is wrong with your cloudflare account/i
    );
  });

  it("refuses to prepare a deploy when no image is published", async () => {
    await writeArtifact(null);
    const provider = new PackagedArtifactProvider(() => dir);

    await expect(
      provider.prepare({
        accountId: "a".repeat(32),
        accountName: "Work",
        profileName: "work",
        workerName: "nimbalyst-sandbox-abc123abc123",
      })
    ).rejects.toThrow(SandboxOperationError);
  });

  it("reports availability once an image is published", async () => {
    await writeArtifact(DIGEST_IMAGE);

    const availability = await new PackagedArtifactProvider(
      () => dir
    ).describe();

    expect(availability).toMatchObject({
      available: true,
      imageRef: DIGEST_IMAGE,
    });
  });

  it("refuses a worker whose bytes do not match the manifest digest", async () => {
    await writeArtifact(DIGEST_IMAGE);
    await fs.writeFile(
      path.join(dir, "worker.mjs"),
      "export default { tampered: 1 };\n"
    );
    const provider = new PackagedArtifactProvider(() => dir);

    await expect(
      provider.prepare({
        accountId: "a".repeat(32),
        accountName: "Work",
        profileName: "work",
        workerName: "nimbalyst-sandbox-abc123abc123",
      })
    ).rejects.toMatchObject({ sandboxErrorCode: "deploy-failed" });
  });

  it("refuses a helper whose bytes do not match the manifest digest", async () => {
    await writeArtifact(DIGEST_IMAGE);
    await fs.writeFile(path.join(dir, "rpc-helper.mjs"), "process.exit(0);\n");

    await expect(
      new PackagedArtifactProvider(() => dir).helper()
    ).rejects.toThrow(SandboxOperationError);
  });

  it("reports a build with no artifact at all as unavailable rather than throwing", async () => {
    const availability = await new PackagedArtifactProvider(() =>
      path.join(dir, "missing")
    ).describe();

    expect(availability).toMatchObject({ available: false });
  });
});
