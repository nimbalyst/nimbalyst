/**
 * Generating the Wrangler project a deploy runs against.
 *
 * Nimbalyst writes this config itself rather than shipping one, because three
 * of its fields are decided per installation and must not be guessable from the
 * artifact: the account id, the Worker name, and the image digest the user
 * actually reviewed.
 *
 * Two properties are load-bearing:
 *
 *   - **`workers_dev: false` and `preview_urls: false`.** The control path is a
 *     private RPC service binding. Giving this Worker a public hostname would
 *     expose a sandbox-control API to the internet.
 *   - **An installation-unique Worker name.** The sandbox is a Durable Object
 *     addressed by the fixed id `personal`. Two installations deploying the same
 *     Worker name into the same Cloudflare account would share one DO, so a
 *     second laptop would silently attach to the first laptop's container. The
 *     suffix makes that collision impossible without the user naming anything.
 */

import { createHash, randomBytes } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";

import type { PlannedContainerConfig } from "../../../shared/cloudflareSandbox";
import type { PreparedArtifact } from "./artifactProvider";
import { SandboxOperationError } from "./errors";
import { getArtifactDir } from "./wranglerPaths";

/** Compatibility date pinned with the shipped SDK, not floating with "today". */
export const COMPATIBILITY_DATE = "2026-09-09";

/** Durable Object class exported by the artifact's worker.mjs. */
export const SANDBOX_CLASS_NAME = "NimbalystSandbox";

const WORKER_NAME_PREFIX = "nimbalyst-sandbox";

/**
 * The container application Cloudflare creates for a `containers` entry is
 * named `<worker>-<class name, lower-cased>`. It outlives the Worker: deleting
 * the Worker does not delete it, so delete has to address it by this name.
 */
export function containerApplicationName(workerName: string): string {
  return `${workerName}-${SANDBOX_CLASS_NAME.toLowerCase()}`;
}

/**
 * Derive the installation-unique Worker name from a stable installation id.
 *
 * Hashed rather than used raw so the deployed Worker name does not leak an
 * identifier that appears anywhere else, and truncated to keep the name within
 * Cloudflare's naming limits while staying collision-safe for this purpose.
 */
export function deriveWorkerName(installationId: string): string {
  if (!installationId) {
    throw new SandboxOperationError(
      "deploy-failed",
      "worker-name-no-installation-id"
    );
  }
  const suffix = createHash("sha256")
    .update(`nimbalyst-sandbox-worker:${installationId}`)
    .digest("hex")
    .slice(0, 12);
  return `${WORKER_NAME_PREFIX}-${suffix}`;
}

/** A fresh installation id. Persisted by the caller; never derived from the user. */
export function newInstallationId(): string {
  return randomBytes(16).toString("hex");
}

export interface WriteDeployConfigRequest {
  /** Absolute path to the verified worker.mjs in the read-only artifact dir. */
  workerSource: string;
  workerName: string;
  accountId: string;
  /** Full registry digest reference. Tags are rejected upstream. */
  imageRef: string;
  /** Manifest digest the copied bytes must still match. See below. */
  expectedWorkerSha256: string;
  container: PlannedContainerConfig;
  contentHash: string;
  /** Overridable for tests. */
  targetDir?: string;
}

/**
 * Stage the project and return the paths `wrangler deploy` needs.
 *
 * The worker script is copied out of the artifact directory rather than
 * referenced in place: when packaged, the artifact lives under
 * `process.resourcesPath`, which is read-only and inside the app bundle, and
 * pointing Wrangler at it would make the deploy depend on bundle layout.
 */
export async function writeDeployConfig(
  request: WriteDeployConfigRequest
): Promise<PreparedArtifact> {
  const projectDir = request.targetDir ?? getArtifactDir();
  await fs.mkdir(projectDir, { recursive: true });

  // Read once, hash those exact bytes, then write the same buffer. Verifying
  // the source and separately calling `copyFile` would re-read a mutable file:
  // anything that changed it in between would be deployed unverified, which is
  // precisely the window an integrity check exists to close.
  const workerBytes = await fs.readFile(request.workerSource);
  const workerSha256 = createHash("sha256").update(workerBytes).digest("hex");
  if (workerSha256 !== request.expectedWorkerSha256) {
    throw new SandboxOperationError(
      "deploy-failed",
      "worker-digest-changed-during-staging",
      "The Cloudflare sandbox files that ship with Nimbalyst changed while the deployment was being prepared, so nothing was deployed."
    );
  }

  const workerTarget = path.join(projectDir, "worker.mjs");
  await fs.writeFile(workerTarget, workerBytes);

  const config = {
    name: request.workerName,
    account_id: request.accountId,
    main: "worker.mjs",
    // The artifact is already a self-contained bundle. Re-bundling would need a
    // build toolchain on the user's machine and could change what they reviewed.
    no_bundle: true,
    compatibility_date: COMPATIBILITY_DATE,
    compatibility_flags: ["nodejs_compat"],
    // No public surface. See the module comment.
    workers_dev: false,
    preview_urls: false,
    containers: [
      {
        class_name: SANDBOX_CLASS_NAME,
        image: request.imageRef,
        instance_type: request.container.instanceType,
        max_instances: request.container.maxInstances,
      },
    ],
    durable_objects: {
      bindings: [{ name: "Sandbox", class_name: SANDBOX_CLASS_NAME }],
    },
    migrations: [{ tag: "v1", new_sqlite_classes: [SANDBOX_CLASS_NAME] }],
  };

  const configPath = path.join(projectDir, "wrangler.json");
  await fs.writeFile(
    configPath,
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8"
  );

  return {
    projectDir,
    configPath,
    workerName: request.workerName,
    imageRef: request.imageRef,
    container: request.container,
    contentHash: request.contentHash,
  };
}

/**
 * Config for the RPC control helper: nothing but the private service binding.
 *
 * Deliberately carries no `containers`, `durable_objects` or `env` — the helper
 * validates their absence and refuses otherwise, so a bug in this function
 * cannot cause the control path to provision anything. `account_id` is pinned
 * for the same reason it is on the deploy config: it is first in Wrangler's
 * account precedence, so nothing implicit can be selected.
 */
export async function writeControlConfig(request: {
  workerName: string;
  accountId: string;
  targetDir?: string;
}): Promise<string> {
  const dir = request.targetDir ?? path.join(getArtifactDir(), "..", "control");
  await fs.mkdir(dir, { recursive: true });

  const config = {
    name: `${request.workerName}-control`,
    account_id: request.accountId,
    compatibility_date: COMPATIBILITY_DATE,
    services: [
      {
        binding: "Manager",
        service: request.workerName,
        entrypoint: "SandboxManager",
        remote: true,
      },
    ],
  };

  const configPath = path.join(dir, "wrangler.json");
  await fs.writeFile(
    configPath,
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8"
  );
  return configPath;
}
