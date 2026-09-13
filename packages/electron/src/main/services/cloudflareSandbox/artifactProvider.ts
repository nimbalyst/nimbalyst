/**
 * The deployable Worker artifact that ships with the build.
 *
 * The artifact is produced by `packages/cloudflare-sandbox` and copied into the
 * app: `packages/cloudflare-sandbox/dist` in development,
 * `process.resourcesPath/cloudflare-sandbox` when packaged. It contains
 * `worker.mjs`, `rpc-helper.mjs`, and a `manifest.json` describing both.
 *
 * Two things this module refuses to do:
 *
 *   - **Deploy an unverified script.** The manifest carries SHA-256 digests and
 *     both files are hashed before use. A mismatch is a hard failure, not a
 *     warning: this script is about to run in the user's Cloudflare account.
 *   - **Pretend a deployment is possible when it is not.** `image: null` means
 *     no container image has been published yet, and there is no way to build
 *     one locally. `describe()` reports that in the user's terms and the plan
 *     step stops there, rather than producing a plan whose deploy could only
 *     fail halfway through and leave a half-built Worker behind.
 */

import { createHash } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import { app } from "electron";

import type { PlannedContainerConfig } from "../../../shared/cloudflareSandbox";
import { SandboxOperationError } from "./errors";
import { writeDeployConfig } from "./workerConfig";

/** Container sizing for the single-sandbox model. Shown in the review. */
export const SANDBOX_CONTAINER: PlannedContainerConfig = {
  instanceType: "standard-3",
  maxInstances: 1,
  sleepAfterMinutes: 5,
};

export type ArtifactAvailability =
  | {
      available: true;
      workerName: string;
      imageRef: string;
      container: PlannedContainerConfig;
      /** Mixed into the plan id, so any artifact change invalidates approval. */
      contentHash: string;
    }
  | { available: false; reason: string };

export interface PreparedArtifact {
  projectDir: string;
  configPath: string;
  workerName: string;
  imageRef: string;
  container: PlannedContainerConfig;
  contentHash: string;
}

export interface PrepareArtifactRequest {
  accountId: string;
  accountName: string;
  profileName: string;
  /** Installation-unique Worker name; see `workerConfig.ts`. */
  workerName: string;
}

export interface SandboxArtifactProvider {
  describe(): Promise<ArtifactAvailability>;
  prepare(request: PrepareArtifactRequest): Promise<PreparedArtifact>;
  /** Absolute paths the control helper needs. Throws when unavailable. */
  helper(): Promise<{ helperPath: string }>;
}

export interface ArtifactManifest {
  schemaVersion: 1;
  sdkVersion: string;
  workerSha256: string;
  helperSha256: string;
  /** Full registry digest reference, or null when nothing is published. */
  image: string | null;
}

/** Digest references only. A mutable tag would let the image change under us. */
const DIGEST_REF = /^[a-z0-9.\-_/]+@sha256:[a-f0-9]{64}$/;
export const SANDBOX_SDK_VERSION = "0.13.0-next.751.1";

export function parseManifest(raw: string): ArtifactManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SandboxOperationError("deploy-failed", "manifest-parse");
  }
  const record = parsed as Record<string, unknown>;
  if (record?.schemaVersion !== 1) {
    throw new SandboxOperationError("deploy-failed", "manifest-schema");
  }
  if (
    typeof record.workerSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.workerSha256) ||
    typeof record.helperSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.helperSha256) ||
    record.sdkVersion !== SANDBOX_SDK_VERSION
  ) {
    throw new SandboxOperationError("deploy-failed", "manifest-fields");
  }
  const image = record.image ?? null;
  if (
    image !== null &&
    (typeof image !== "string" || !DIGEST_REF.test(image))
  ) {
    // A tag is not good enough: it can be repointed after review, which would
    // deploy a different image than the one the user approved.
    throw new SandboxOperationError(
      "deploy-failed",
      "manifest-image-not-digest"
    );
  }
  return {
    schemaVersion: 1,
    sdkVersion: record.sdkVersion,
    workerSha256: record.workerSha256,
    helperSha256: record.helperSha256,
    image,
  };
}

/** Where the artifact lives, dev and packaged. */
export function getArtifactSourceDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "cloudflare-sandbox");
  }
  return path.join(app.getAppPath(), "..", "cloudflare-sandbox", "dist");
}

export class PackagedArtifactProvider implements SandboxArtifactProvider {
  #sourceDir: () => string;

  constructor(sourceDir: () => string = getArtifactSourceDir) {
    this.#sourceDir = sourceDir;
  }

  async describe(): Promise<ArtifactAvailability> {
    let manifest: ArtifactManifest;
    try {
      manifest = await this.#readManifest();
    } catch {
      return {
        available: false,
        reason:
          "This build does not include the Cloudflare sandbox Worker, so there is nothing to deploy.",
      };
    }

    if (manifest.image === null) {
      // Distinct from any account problem: nothing the user can fix in
      // Cloudflare, and nothing they can build locally.
      return {
        available: false,
        reason:
          "The Cloudflare sandbox container image has not been published yet, so this version cannot deploy a sandbox. Nothing is wrong with your Cloudflare account.",
      };
    }

    return {
      available: true,
      // The Worker name is installation-specific and decided at prepare time.
      // Only the parts that affect what gets deployed belong in the digest.
      workerName: "",
      imageRef: manifest.image,
      container: SANDBOX_CONTAINER,
      contentHash: contentHashFor(manifest),
    };
  }

  async prepare(request: PrepareArtifactRequest): Promise<PreparedArtifact> {
    const manifest = await this.#readManifest();
    if (manifest.image === null) {
      throw new SandboxOperationError(
        "deploy-failed",
        "prepare-without-image",
        "The Cloudflare sandbox container image has not been published yet, so this version cannot deploy a sandbox."
      );
    }

    // No pre-check here: writeDeployConfig hashes the exact bytes it copies, so
    // verifying first would only add a window in which the file could change.
    return writeDeployConfig({
      workerSource: path.join(this.#sourceDir(), "worker.mjs"),
      expectedWorkerSha256: manifest.workerSha256,
      workerName: request.workerName,
      accountId: request.accountId,
      imageRef: manifest.image,
      container: SANDBOX_CONTAINER,
      contentHash: contentHashFor(manifest),
    });
  }

  async helper(): Promise<{ helperPath: string }> {
    const manifest = await this.#readManifest();
    const helperPath = path.join(this.#sourceDir(), "rpc-helper.mjs");
    await verifyDigest(helperPath, manifest.helperSha256, "helper");
    return { helperPath };
  }

  async #readManifest(): Promise<ArtifactManifest> {
    const raw = await fs.readFile(
      path.join(this.#sourceDir(), "manifest.json"),
      "utf8"
    );
    return parseManifest(raw);
  }
}

/** The artifact identity mixed into the plan digest. */
export function contentHashFor(manifest: ArtifactManifest): string {
  return `${manifest.workerSha256}:${manifest.sdkVersion}:${
    manifest.image ?? "no-image"
  }`;
}

/**
 * Hash a file and compare. Anything but an exact match refuses to proceed —
 * a modified worker or helper is either a broken build or a tampered one, and
 * both deserve the same answer.
 */
export async function verifyDigest(
  filePath: string,
  expected: string,
  what: "worker" | "helper"
): Promise<void> {
  let contents: Buffer;
  try {
    contents = await fs.readFile(filePath);
  } catch {
    throw new SandboxOperationError("deploy-failed", `${what}-missing`);
  }
  const actual = createHash("sha256").update(contents).digest("hex");
  if (actual !== expected) {
    throw new SandboxOperationError(
      "deploy-failed",
      `${what}-digest-mismatch`,
      "The Cloudflare sandbox files that ship with Nimbalyst failed their integrity check, so nothing was deployed. Reinstall Nimbalyst."
    );
  }
}
