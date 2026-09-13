/**
 * Reaching the deployed Worker's `SandboxManager` RPC entrypoint without giving
 * anything a public URL.
 *
 * The Worker ships `workers_dev: false` with no routes, so there is no HTTP
 * surface to call. Instead a short-lived Node child runs `rpc-helper.mjs`, which
 * opens `getPlatformProxy({ remoteBindings: true })` against a config whose only
 * binding is `{ entrypoint: 'SandboxManager', remote: true }`. Wrangler proxies
 * the RPC into the user's account and authorises it with their own OAuth
 * credential, inside that child. Nimbalyst never reads a token and there is no
 * shared secret anywhere.
 *
 * Why a child process rather than importing Wrangler here: remote-binding auth
 * resolves its profile from `process.cwd()` alone (`getRemoteBindingsAuthHook`
 * passes `profileDir ?? process.cwd()`, and `profileDir` is never assigned in
 * wrangler 4.125.0). A child can be spawned in the profile's verified
 * directory; the main process cannot change its own cwd without racing every
 * other consumer of it.
 *
 * The helper prints exactly one JSON line and suppresses Wrangler's own output,
 * because that output can contain authentication details.
 */

import { spawn, type ChildProcess } from "child_process";

import type {
  CloudflareSandboxErrorCode,
  SandboxContainerState,
  SandboxContainerStatus,
} from "../../../shared/cloudflareSandbox";
import { SANDBOX_ID } from "./deploymentPlan";
import { SandboxOperationError } from "./errors";
import { sanitizeWranglerEnv } from "./wranglerEnv";

export interface SandboxManagerStatus {
  sandboxId: string;
  state: "running" | "healthy" | "stopping" | "stopped" | "stopped_with_code";
  lastChangedAt: number;
  sleepAfterSeconds: number;
  persistence: "ephemeral";
}

export interface SandboxControlTarget {
  /** Verified directory that resolves to the profile. Becomes the child cwd. */
  cwd: string;
  /** Absolute path to the generated control config. */
  configPath: string;
  /** Absolute path to the integrity-checked helper script. */
  helperPath: string;
  /** Absolute path to the installed Wrangler module the helper imports. */
  wranglerModulePath: string;
}

export interface SandboxProvisionRequest {
  files: Array<{ path: string; content: string; mode?: number }>;
  allowedHosts: string[];
}

export interface SandboxNodeStatus extends SandboxManagerStatus {
  sandboxId: "personal";
  node: {
    running: boolean;
    processId: string | null;
    startedAt: number | null;
    exitCode: number | null;
    recentLog: string;
  };
}

export interface SandboxControlClient {
  provision(target: SandboxControlTarget, request: SandboxProvisionRequest): Promise<SandboxNodeStatus>;
  startNode(target: SandboxControlTarget, request: { configPath: string }): Promise<SandboxNodeStatus>;
  nodeStatus(target: SandboxControlTarget): Promise<SandboxNodeStatus>;
  stopNode(target: SandboxControlTarget, request: { discardEphemeralData: true }): Promise<SandboxNodeStatus>;
  status(target: SandboxControlTarget): Promise<SandboxManagerStatus>;
  wake(target: SandboxControlTarget): Promise<SandboxManagerStatus>;
  stop(
    target: SandboxControlTarget,
    options: { discardEphemeralData: true }
  ): Promise<SandboxManagerStatus>;
}

const DEFAULT_TIMEOUT_MS = 90_000;

/** Injection seam for tests. */
export type HelperRunner = (
  target: SandboxControlTarget,
  payload: Record<string, unknown>,
  timeoutMs: number
) => Promise<unknown>;

export class ChildProcessControlClient implements SandboxControlClient {
  #run: HelperRunner;
  #timeoutMs: number;

  constructor(run: HelperRunner = spawnHelper, timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.#run = run;
    this.#timeoutMs = timeoutMs;
  }

  status(target: SandboxControlTarget): Promise<SandboxManagerStatus> {
    return this.#invoke(target, { operation: "status" });
  }

  wake(target: SandboxControlTarget): Promise<SandboxManagerStatus> {
    return this.#invoke(target, { operation: "wake" });
  }

  provision(target: SandboxControlTarget, request: SandboxProvisionRequest): Promise<SandboxNodeStatus> {
    return this.#invokeNode(target, "provision", request);
  }

  startNode(target: SandboxControlTarget, request: { configPath: string }): Promise<SandboxNodeStatus> {
    return this.#invokeNode(target, "startNode", request);
  }

  nodeStatus(target: SandboxControlTarget): Promise<SandboxNodeStatus> {
    return this.#invokeNode(target, "nodeStatus");
  }

  stopNode(target: SandboxControlTarget, request: { discardEphemeralData: true }): Promise<SandboxNodeStatus> {
    if (request?.discardEphemeralData !== true) {
      throw new SandboxOperationError("confirmation-required", "stop-without-consent");
    }
    return this.#invokeNode(target, "stopNode", request);
  }

  async #invokeNode(target: SandboxControlTarget, operation: string, request?: unknown): Promise<SandboxNodeStatus> {
    const raw = await this.#run(target, {
      wranglerModulePath: target.wranglerModulePath,
      configPath: target.configPath,
      operation,
      ...(request === undefined ? {} : { request }),
    }, this.#timeoutMs);
    return parseNodeStatusResponse(raw);
  }

  stop(
    target: SandboxControlTarget,
    options: { discardEphemeralData: true }
  ): Promise<SandboxManagerStatus> {
    if (options?.discardEphemeralData !== true) {
      // The helper refuses this too. Checking here as well keeps the consent
      // explicit at every hop rather than re-inferred at the last one.
      throw new SandboxOperationError(
        "confirmation-required",
        "stop-without-consent"
      );
    }
    return this.#invoke(target, {
      operation: "stop",
      discardEphemeralData: true,
    });
  }

  async #invoke(
    target: SandboxControlTarget,
    payload: Record<string, unknown>
  ): Promise<SandboxManagerStatus> {
    const raw = await this.#run(
      target,
      {
        wranglerModulePath: target.wranglerModulePath,
        configPath: target.configPath,
        ...payload,
      },
      this.#timeoutMs
    );
    return assertExpectedSandbox(parseHelperResponse(raw));
  }
}

/**
 * Error codes the helper is allowed to name. Anything outside this list is
 * treated as unknown rather than trusted, so a corrupted or unexpected frame
 * cannot select an arbitrary code path in the UI.
 */
const HELPER_CODES = new Set<CloudflareSandboxErrorCode>([
  "not-authenticated",
  "confirmation-required",
  "wrangler-missing",
  "wrangler-unsupported",
  "container-unavailable",
  "node-not-provisioned",
  "node-start-failed",
  "grant-failed",
  "unknown",
]);

/** Fixed reasons the helper may report, mapped to curated user-facing text. */
const HELPER_REASON_MESSAGES: Record<string, string> = {
  authentication:
    "Wrangler could not authenticate to Cloudflare for this sandbox. Sign in to the profile again.",
  "confirmation-required":
    "This action needs an explicit confirmation before it can run.",
  "wrangler-module":
    "Nimbalyst could not load your installed Wrangler, so it cannot reach this sandbox.",
  "invalid-config":
    "The private control configuration for this sandbox was rejected. Redeploy the sandbox to regenerate it.",
  "invalid-operation":
    "Nimbalyst asked the sandbox for something it does not support.",
  "invalid-request": "Nimbalyst sent the sandbox a request it could not read.",
  "rpc-failed": "The sandbox did not respond to the request.",
  "invalid-path": "Sandbox files must be located under /home/nimbalyst/ without traversal or symbolic links.",
  "node-not-provisioned": "Provision the sandbox node configuration before starting it.",
  "node-start-failed": "The sandbox node could not start. Check its status and recent logs.",
  "grant-failed": "The sandbox device authorization could not be completed.",
};

export function parseNodeStatusResponse(raw: unknown): SandboxNodeStatus {
  const status = assertExpectedSandbox(parseHelperResponse(raw));
  const data = (raw as { data: Record<string, unknown> }).data;
  const node = data.node as Record<string, unknown> | null;
  if (!node || typeof node !== "object" || Array.isArray(node)
    || data.persistence !== "ephemeral"
    || typeof data.lastChangedAt !== "number" || !Number.isFinite(data.lastChangedAt)
    || typeof data.sleepAfterSeconds !== "number" || !Number.isFinite(data.sleepAfterSeconds) || data.sleepAfterSeconds < 0
    || typeof node.running !== "boolean"
    || !(node.processId === null || (typeof node.processId === "string" && node.processId.length > 0))
    || !(node.startedAt === null || (typeof node.startedAt === "number" && Number.isFinite(node.startedAt)))
    || !(node.exitCode === null || (typeof node.exitCode === "number" && Number.isInteger(node.exitCode)))
    || typeof node.recentLog !== "string" || Buffer.byteLength(node.recentLog, "utf8") > 4096
    || (node.running && (!node.processId || node.startedAt === null || node.exitCode !== null || !["running", "healthy"].includes(status.state)))) {
    throw new SandboxOperationError("container-unavailable", "helper-node-response-shape");
  }
  return { ...status, sandboxId: "personal", node: {
    running: node.running,
    processId: node.processId as string | null,
    startedAt: node.startedAt as number | null,
    exitCode: node.exitCode as number | null,
    recentLog: node.recentLog,
  } };
}

/**
 * Parse the helper's single JSON line.
 *
 * The helper exits non-zero on failure but still prints a bounded frame
 * `{success:false, error:<code>, reason:<enum>}`. That frame is more useful than
 * the exit status, so an allowlisted code is preserved rather than flattened to
 * `container-unavailable` — telling a signed-out user their container is
 * unreachable would send them to the wrong fix. Neither field is ever raw text.
 */
export function parseHelperResponse(raw: unknown): SandboxManagerStatus {
  const envelope = raw as {
    success?: unknown;
    data?: unknown;
    error?: unknown;
    reason?: unknown;
  } | null;

  if (envelope && envelope.success === false) {
    const code = HELPER_CODES.has(envelope.error as CloudflareSandboxErrorCode)
      ? (envelope.error as CloudflareSandboxErrorCode)
      : "container-unavailable";
    const reason = typeof envelope.reason === "string" ? envelope.reason : "";
    throw new SandboxOperationError(
      code,
      "helper-failure",
      Object.prototype.hasOwnProperty.call(HELPER_REASON_MESSAGES, reason)
        ? HELPER_REASON_MESSAGES[reason]
        : undefined
    );
  }

  if (
    !envelope ||
    envelope.success !== true ||
    !envelope.data ||
    typeof envelope.data !== "object"
  ) {
    throw new SandboxOperationError("container-unavailable", "helper-response");
  }
  const data = envelope.data as Record<string, unknown>;
  const states = [
    "running",
    "healthy",
    "stopping",
    "stopped",
    "stopped_with_code",
  ];
  if (
    typeof data.sandboxId !== "string" ||
    typeof data.state !== "string" ||
    !states.includes(data.state)
  ) {
    throw new SandboxOperationError(
      "container-unavailable",
      "helper-response-shape"
    );
  }
  return {
    sandboxId: data.sandboxId,
    state: data.state as SandboxManagerStatus["state"],
    lastChangedAt:
      typeof data.lastChangedAt === "number" ? data.lastChangedAt : 0,
    sleepAfterSeconds:
      typeof data.sleepAfterSeconds === "number" ? data.sleepAfterSeconds : 0,
    persistence: "ephemeral",
  };
}

const inFlightHelpers = new Map<ChildProcess, () => void>();

/** Reap detached helper groups before the Electron host exits. */
export function killInFlightHelpers(): void {
  for (const kill of inFlightHelpers.values()) kill();
}

function spawnHelper(
  target: SandboxControlTarget,
  payload: Record<string, unknown>,
  timeoutMs: number
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [target.helperPath], {
      cwd: target.cwd,
      env: sanitizeWranglerEnv(process.env, {
        WRANGLER_HIDE_BANNER: "true",
        WRANGLER_SEND_METRICS: "false",
        NO_COLOR: "1",
        // Same reason as the CLI runner: without it Wrangler can decide the
        // session needs an interactive login and sit waiting on a terminal
        // that does not exist, turning a failed RPC into a hung child.
        CI: "1",
        // Electron's own binary is the Node runtime here; this makes it behave
        // as plain Node rather than trying to start an app.
        ELECTRON_RUN_AS_NODE: "1",
      }),
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
      // Isolate the helper and its miniflare/workerd descendants for cleanup.
      detached: process.platform !== "win32",
    });

    let stdout = "";
    let settled = false;
    let exited = false;
    let killRequested = false;
    const killHelper = () => {
      if (settled || exited || killRequested) return;
      killRequested = true;
      if (
        process.platform !== "win32" &&
        typeof child.pid === "number" &&
        child.pid > 0
      ) {
        try {
          process.kill(-child.pid, "SIGKILL");
          return;
        } catch {
          // The group may already have exited; still settle the operation.
        }
      }
      // Windows has no POSIX process groups; retain its child-only cleanup.
      try {
        child.kill("SIGKILL");
      } catch {
        // A failed signal must not prevent cleanup of other registered helpers.
      }
    };
    inFlightHelpers.set(child, killHelper);
    child.on("exit", () => {
      exited = true;
    });
    child.on("close", () => inFlightHelpers.delete(child));
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      killHelper();
      finish(() =>
        reject(
          new SandboxOperationError("container-unavailable", "helper-timeout")
        )
      );
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (settled) return;
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") > 64 * 1024) {
        killHelper();
        finish(() =>
          reject(
            new SandboxOperationError(
              "container-unavailable",
              "helper-overflow"
            )
          )
        );
      }
    });

    child.on("error", () =>
      finish(() =>
        reject(
          new SandboxOperationError("container-unavailable", "helper-spawn")
        )
      )
    );

    // Preserve bounded failure frames on exit 1, but a failed process can
    // never turn a success frame into a successful management operation.
    child.on("close", (code) =>
      finish(() => {
        try {
          const frame = JSON.parse(stdout.trim());
          if (code !== 0 && frame?.success !== false)
            throw new Error("helper-exit");
          resolve(frame);
        } catch {
          reject(
            new SandboxOperationError("container-unavailable", "helper-output")
          );
        }
      })
    );

    child.stdin.on("error", () => {
      killHelper();
      finish(() =>
        reject(
          new SandboxOperationError("container-unavailable", "helper-input")
        )
      );
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

/** Map the Worker's vocabulary onto the contract's container states. */
export function toContainerState(
  status: SandboxManagerStatus,
  now: () => Date = () => new Date()
): SandboxContainerState {
  const mapping: Record<SandboxManagerStatus["state"], SandboxContainerStatus> =
    {
      running: "running",
      healthy: "running",
      stopping: "stopping",
      stopped: "stopped",
      stopped_with_code: "stopped",
    };
  return {
    status: mapping[status.state] ?? "unknown",
    observedAt: now().toISOString(),
    message:
      status.state === "stopped_with_code"
        ? "The sandbox process exited on its own."
        : null,
  };
}

/** An unreachable container is a state, not a crash. */
export function unreachableContainerState(
  message: string,
  now: () => Date = () => new Date()
): SandboxContainerState {
  return { status: "unknown", observedAt: now().toISOString(), message };
}

/** Guard against a Worker reply about some other sandbox. */
export function assertExpectedSandbox(
  status: SandboxManagerStatus
): SandboxManagerStatus {
  if (status.sandboxId !== SANDBOX_ID) {
    throw new SandboxOperationError(
      "container-unavailable",
      "sandbox-id-mismatch"
    );
  }
  return status;
}
