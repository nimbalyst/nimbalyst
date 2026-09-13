// @vitest-environment node
/**
 * Regressions for the defects found in review. Each one is a way the deploy or
 * control path could have acted on something other than what the user approved.
 */
import { createHash } from "crypto";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getAppPath: () => "/app",
    getPath: () => "/tmp/nimbalyst-t",
  },
}));
vi.mock("../../../utils/logger", () => ({
  logger: { main: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } },
}));

import { PackagedArtifactProvider } from "../artifactProvider";
import { parseAuthListTable } from "../profileBindings";
import { parseHelperResponse } from "../sandboxControl";
import { writeDeployConfig } from "../workerConfig";
import { SandboxOperationError } from "../errors";

const IMAGE = "docker.io/nimbalyst/sandbox@sha256:" + "a".repeat(64);
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "nimbalyst-regress-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("B2 — the artifact must not change between review and deploy", () => {
  it("hashes the exact bytes it stages, so a swap after verification is caught", async () => {
    const source = path.join(dir, "worker.mjs");
    await fs.writeFile(source, "export default { reviewed: true };\n");
    const reviewedDigest = createHash("sha256")
      .update(await fs.readFile(source))
      .digest("hex");

    // The file changes after it was described and before it is staged.
    await fs.writeFile(source, "export default { swapped: true };\n");

    await expect(
      writeDeployConfig({
        workerSource: source,
        expectedWorkerSha256: reviewedDigest,
        workerName: "nimbalyst-sandbox-abcdef123456",
        accountId: "a".repeat(32),
        imageRef: IMAGE,
        container: {
          instanceType: "standard-3",
          maxInstances: 1,
          sleepAfterMinutes: 5,
        },
        contentHash: "hash-a",
        targetDir: path.join(dir, "out"),
      })
    ).rejects.toMatchObject({ sandboxErrorCode: "deploy-failed" });

    // Nothing was staged, so a later deploy cannot pick up the swapped file.
    await expect(
      fs.readFile(path.join(dir, "out", "worker.mjs"))
    ).rejects.toThrow();
  });

  it("describe reports the manifest digest, so a rebuild changes the plan identity", async () => {
    const write = async (body: string) => {
      await fs.writeFile(path.join(dir, "worker.mjs"), body);
      await fs.writeFile(
        path.join(dir, "rpc-helper.mjs"),
        "export const h = 1;\n"
      );
      await fs.writeFile(
        path.join(dir, "manifest.json"),
        JSON.stringify({
          schemaVersion: 1,
          sdkVersion: "0.13.0-next.751.1",
          workerSha256: createHash("sha256").update(body).digest("hex"),
          helperSha256: createHash("sha256")
            .update("export const h = 1;\n")
            .digest("hex"),
          image: IMAGE,
        })
      );
    };
    const provider = new PackagedArtifactProvider(() => dir);

    await write("export default { v: 1 };\n");
    const before = await provider.describe();
    await write("export default { v: 2 };\n");
    const after = await provider.describe();

    expect(before.available && after.available).toBe(true);
    if (!before.available || !after.available) return;
    expect(after.contentHash).not.toBe(before.contentHash);
  });
});

describe('B5 — an unreadable binding map must not read as "nothing is bound"', () => {
  it("refuses output it does not recognise rather than defaulting every directory", () => {
    // Returning [] here would resolve every directory to the default profile,
    // which is a different Cloudflare account than the user selected.
    expect(() => parseAuthListTable("Something unexpected happened")).toThrow(
      SandboxOperationError
    );
  });

  it("refuses a table with no header row", () => {
    expect(() =>
      parseAuthListTable(["│ work │ /a │", "└──────┴────┘"].join("\n"))
    ).toThrow(SandboxOperationError);
  });

  it("refuses a row whose profile cell it cannot read", () => {
    expect(() =>
      parseAuthListTable(
        ["│ Profile │ Bound Directories │", "│ not a valid name! │ /a │"].join(
          "\n"
        )
      )
    ).toThrow(SandboxOperationError);
  });

  it("still reports a genuinely empty profile list, which is a real answer", () => {
    expect(
      parseAuthListTable("No profiles found. Run `wrangler login`.")
    ).toEqual([]);
  });
});

describe("helper failure frames", () => {
  it("keeps an allowlisted code so a signed-out user is told to sign in", () => {
    let thrown: SandboxOperationError | null = null;
    try {
      parseHelperResponse({
        success: false,
        error: "not-authenticated",
        reason: "authentication",
      });
    } catch (error) {
      thrown = error as SandboxOperationError;
    }

    expect(thrown?.sandboxErrorCode).toBe("not-authenticated");
    expect(thrown?.userMessage).toMatch(/sign in/i);
  });

  it("maps a config rejection to an actionable message, not raw text", () => {
    let thrown: SandboxOperationError | null = null;
    try {
      parseHelperResponse({
        success: false,
        error: "unknown",
        reason: "invalid-config",
      });
    } catch (error) {
      thrown = error as SandboxOperationError;
    }

    expect(thrown?.userMessage).toMatch(/redeploy the sandbox/i);
  });

  it("does not trust a code outside the allowlist", () => {
    let thrown: SandboxOperationError | null = null;
    try {
      parseHelperResponse({
        success: false,
        error: "plan-stale",
        reason: "rpc-failed",
      });
    } catch (error) {
      thrown = error as SandboxOperationError;
    }

    expect(thrown?.sandboxErrorCode).toBe("container-unavailable");
  });
});

it("does not let an unknown helper reason escape as a message or log label", () => {
  expect.assertions(8);
  for (const reason of ["toString", "raw-secret-value"]) {
    try {
      parseHelperResponse({ success: false, error: "unknown", reason });
    } catch (error) {
      expect(error).toBeInstanceOf(SandboxOperationError);
      expect((error as SandboxOperationError).event).toBe("helper-failure");
      expect(typeof (error as Error).message).toBe("string");
      expect((error as Error).message).not.toContain(reason);
    }
  }
});
it("rejects null success data as a bounded helper failure", () => {
  expect(() => parseHelperResponse({ success: true, data: null })).toThrow(
    SandboxOperationError
  );
});
