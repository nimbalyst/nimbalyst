// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { asPersonalMemberId } from "@nimbalyst/runtime/auth/jwtScopes";

import type {
  SandboxDeployment,
  SandboxDeploymentTarget,
} from "../../../../shared/cloudflareSandbox";

// The store reaches electron-store, and profiles/wranglerCli spawn Wrangler.
// Both are mocked so these tests exercise the service's own decisions.
vi.mock("../deploymentStore", () => ({
  readDeployment: vi.fn(),
  readNodeId: vi.fn(() => null),
  readWorkerName: vi.fn(),
  requireTarget: vi.fn(),
  updateDeployment: vi.fn(),
  updateDeploymentIfUnchanged: vi.fn(),
  updateDeploymentNode: vi.fn(),
  clearDeploymentNode: vi.fn(),
  readPendingRevocations: vi.fn(() => []),
  pendingRevocationsAtCapacity: vi.fn(() => false),
  recordPendingRevocation: vi.fn(() => true),
  clearRevokedNode: vi.fn(),
  clearPendingRevocation: vi.fn(),
  writeDeployment: vi.fn(),
  clearDeployment: vi.fn(),
  getInstallationId: vi.fn(() => "install-1"),
}));
// The node environment reaches sync, auth and credential storage. Mocked at
// their own module paths — never through the runtime barrel, which drags the
// whole editor tree in for nothing.
vi.mock("../../SyncManager", () => ({ getSyncProvider: vi.fn(() => null) }));
vi.mock("../../StytchAuthService", () => ({
  getPersonalSessionJwt: vi.fn(() => "personal.jwt"),
  getPersonalOrgId: vi.fn(() => "org-7"),
  getPersonalUserId: vi.fn(() => "member-9"),
}));
vi.mock("../../CredentialService", () => ({ getEncryptionKeySeed: vi.fn(() => "seed-abc") }));
vi.mock("../../../utils/store", () => ({ getSessionSyncConfig: vi.fn(() => null) }));
vi.mock("../profiles", () => ({
  listAccounts: vi.fn(),
  listProfiles: vi.fn(),
  createOrReauthenticateProfile: vi.fn(),
  resolvedProfileDir: vi.fn(async () => "/tmp/profiles/work"),
}));
vi.mock("../workerConfig", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../workerConfig")>()),
  writeControlConfig: vi.fn(async () => "/tmp/control/wrangler.json"),
}));
vi.mock("../wranglerCli", () => ({
  runWrangler: vi.fn(),
  resolveWranglerModulePath: vi.fn(async () => "/tmp/wrangler/cli.js"),
}));
vi.mock("../../../utils/logger", () => ({
  logger: { main: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } },
}));

import { CloudflareSandboxService } from "../CloudflareSandboxService";
import type { SandboxArtifactProvider } from "../artifactProvider";
import * as store from "../deploymentStore";
import * as profiles from "../profiles";
import { runWrangler } from "../wranglerCli";
import { SandboxOperationError } from "../errors";
import { deriveWorkerName, writeControlConfig } from "../workerConfig";

const WORKER_NAME = deriveWorkerName("install-1");

const ACCOUNT = { id: "acct-1", name: "Work Account" };

const SAVED: SandboxDeployment = {
  deploymentId: "dep-1",
  revision: "rev-1",
  status: "deployed",
  container: { status: "stopped", observedAt: null, message: null },
  node: null,
  profileName: "work",
  account: ACCOUNT,
  access: "private-rpc",
  url: null,
  deployedAt: "2026-09-09T00:00:00.000Z",
  errorMessage: null,
};

const TARGET: SandboxDeploymentTarget = {
  deploymentId: "dep-1",
  revision: "rev-1",
  profileName: "work",
  accountId: "acct-1",
};

function availableArtifacts(): SandboxArtifactProvider {
  return {
    describe: vi.fn(async () => ({
      available: true as const,
      workerName: "",
      imageRef: "docker.io/nimbalyst/sandbox@sha256:" + "a".repeat(64),
      container: {
        instanceType: "standard-3",
        maxInstances: 1,
        sleepAfterMinutes: 5,
      },
      contentHash: "hash-a",
    })),
    helper: vi.fn(async () => ({ helperPath: "/tmp/artifact/rpc-helper.mjs" })),
    prepare: vi.fn(async () => ({
      projectDir: "/tmp/artifact",
      configPath: "/tmp/artifact/wrangler.jsonc",
      workerName: WORKER_NAME,
      imageRef: "docker.io/nimbalyst/sandbox@sha256:" + "a".repeat(64),
      container: {
        instanceType: "standard-3",
        maxInstances: 1,
        sleepAfterMinutes: 5,
      },
      contentHash: "hash-a",
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(profiles.listAccounts).mockResolvedValue([ACCOUNT]);
  vi.mocked(store.readDeployment).mockReturnValue(null);
  vi.mocked(store.readWorkerName).mockReturnValue(WORKER_NAME);
  vi.mocked(store.requireTarget).mockReturnValue(SAVED);
  vi.mocked(store.updateDeploymentIfUnchanged).mockImplementation(
    (_revision, patch) =>
      ({ ...SAVED, ...patch, revision: "rev-2" } as SandboxDeployment)
  );
  vi.mocked(store.updateDeployment).mockImplementation(
    (patch) => ({ ...SAVED, ...patch, revision: "rev-2" } as SandboxDeployment)
  );
  vi.mocked(store.writeDeployment).mockImplementation(
    (input) =>
      ({
        ...SAVED,
        status: input.status,
        errorMessage: input.errorMessage ?? null,
      } as SandboxDeployment)
  );
  answerWrangler({ applications: [] });
});

const APP_ID = "a033a6ac-f267-4792-baac-09437eb1f1fd";
const OTHER_APP_ID = "5e0d7e0b-2f8e-4a5e-9f1a-3c1e0d3b8a11";

/**
 * Wrangler answers by command. `containers list` reports `applications` on the
 * first call and `remaining` afterwards, so a test can model an application
 * that survives its own delete.
 */
function answerWrangler(options: {
  applications: Array<{ id: string; name: string }>;
  remaining?: Array<{ id: string; name: string }>;
  workerDelete?: () => Promise<void>;
}) {
  let lists = 0;
  vi.mocked(runWrangler).mockImplementation(async (args) => {
    if (args[0] === "delete" && options.workerDelete) await options.workerDelete();
    if (args[0] === "containers" && args[1] === "list") {
      lists += 1;
      const apps =
        lists === 1 ? options.applications : options.remaining ?? [];
      return { stdout: JSON.stringify(apps), stderr: "" };
    }
    return { stdout: "", stderr: "" };
  });
}

describe("planDeployment", () => {
  it("refuses an account the chosen profile cannot reach", async () => {
    const service = new CloudflareSandboxService({
      artifacts: availableArtifacts(),
    });

    const result = await service.planDeployment({
      profileName: "work",
      accountId: "someone-elses-account",
    });

    expect(result).toMatchObject({
      success: false,
      error: { code: "account-required" },
    });
  });

  it("reports the artifact as unavailable instead of offering a plan that cannot deploy", async () => {
    const service = new CloudflareSandboxService();

    const result = await service.planDeployment({
      profileName: "work",
      accountId: "acct-1",
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toMatch(
      /does not include the Cloudflare sandbox Worker/i
    );
  });

  it("never spawns Wrangler for a deploy when no plan was approved", async () => {
    const service = new CloudflareSandboxService({
      artifacts: availableArtifacts(),
    });

    const result = await service.deploy({
      planId: "fabricated",
      profileName: "work",
      accountId: "acct-1",
    });

    expect(result).toMatchObject({
      success: false,
      error: { code: "plan-stale" },
    });
    expect(vi.mocked(runWrangler)).not.toHaveBeenCalled();
  });
});

describe("deploy", () => {
  it("passes the explicit profile to Wrangler rather than relying on a default", async () => {
    const service = new CloudflareSandboxService({
      artifacts: availableArtifacts(),
    });
    const planned = await service.planDeployment({
      profileName: "work",
      accountId: "acct-1",
    });
    if (!planned.success) throw new Error("expected a plan");

    await service.deploy({
      planId: planned.data.planId,
      profileName: "work",
      accountId: "acct-1",
    });

    const [args] = vi.mocked(runWrangler).mock.calls[0] as [string[]];
    expect(args.slice(0, 3)).toEqual(['deploy', '--containers-rollout', 'immediate']);
    expect(args).toContain("--profile");
    expect(args[args.indexOf("--profile") + 1]).toBe("work");
  });

  it("records an error against the attempted account when Wrangler fails", async () => {
    const service = new CloudflareSandboxService({
      artifacts: availableArtifacts(),
    });
    const planned = await service.planDeployment({
      profileName: "work",
      accountId: "acct-1",
    });
    if (!planned.success) throw new Error("expected a plan");
    vi.mocked(runWrangler).mockRejectedValueOnce(
      new SandboxOperationError("deploy-failed", "boom")
    );

    const result = await service.deploy({
      planId: planned.data.planId,
      profileName: "work",
      accountId: "acct-1",
    });

    expect(result).toMatchObject({
      success: false,
      error: { code: "deploy-failed" },
    });
    expect(vi.mocked(store.writeDeployment)).toHaveBeenCalledWith(
      expect.objectContaining({ status: "error", accountId: "acct-1" })
    );
  });

  it("will not accept the same approved plan twice", async () => {
    const service = new CloudflareSandboxService({
      artifacts: availableArtifacts(),
    });
    const planned = await service.planDeployment({
      profileName: "work",
      accountId: "acct-1",
    });
    if (!planned.success) throw new Error("expected a plan");
    const request = {
      planId: planned.data.planId,
      profileName: "work",
      accountId: "acct-1",
    };

    expect((await service.deploy(request)).success).toBe(true);
    expect(await service.deploy(request)).toMatchObject({
      success: false,
      error: { code: "plan-stale" },
    });
  });
});

describe("lifecycle target binding", () => {
  it("refuses a stale target rather than acting on the saved sandbox", async () => {
    vi.mocked(store.requireTarget).mockImplementation(() => {
      throw new SandboxOperationError("deployment-stale", "revision mismatch");
    });
    const service = new CloudflareSandboxService();

    const result = await service.stop({
      ...TARGET,
      revision: "stale",
      discardEphemeralData: true,
    });

    expect(result).toMatchObject({
      success: false,
      error: { code: "deployment-stale" },
    });
  });

  it("asks the worker to discard ephemeral data on stop, explicitly", async () => {
    const stop = vi.fn(async () => ({
      sandboxId: "personal" as const,
      state: "stopped" as const,
      lastChangedAt: 0,
      sleepAfterSeconds: 300,
      persistence: "ephemeral" as const,
    }));
    const service = new CloudflareSandboxService({
      artifacts: availableArtifacts(),
      control: { status: vi.fn(), wake: vi.fn(), stop } as never,
    });

    await service.stop({ ...TARGET, discardEphemeralData: true });

    expect(stop).toHaveBeenCalledWith(expect.anything(), {
      discardEphemeralData: true,
    });
  });

  it("records an unreachable container as an observation, not a deployment error", async () => {
    const service = new CloudflareSandboxService({
      artifacts: availableArtifacts(),
      control: {
        status: vi.fn(),
        wake: vi.fn(async () => {
          throw new SandboxOperationError(
            "container-unavailable",
            "helper-timeout"
          );
        }),
        stop: vi.fn(),
      } as never,
    });

    const result = await service.wake(TARGET);

    expect(result).toMatchObject({
      success: false,
      error: { code: "container-unavailable" },
    });
    expect(vi.mocked(store.updateDeployment)).toHaveBeenCalledWith(
      expect.objectContaining({
        container: expect.objectContaining({ status: "unknown" }),
      })
    );
    expect(vi.mocked(store.updateDeployment)).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "error" })
    );
  });
});

describe("deleteDeployment", () => {
  it("refuses without the explicit confirmation flag and never calls Wrangler", async () => {
    const service = new CloudflareSandboxService();

    const result = await service.deleteDeployment({
      ...TARGET,
      confirmed: false as unknown as true,
    });

    expect(result).toMatchObject({
      success: false,
      error: { code: "confirmation-required" },
    });
    expect(vi.mocked(runWrangler)).not.toHaveBeenCalled();
  });

  it("keeps the saved record when the delete fails, so a live worker is not orphaned", async () => {
    vi.mocked(runWrangler).mockRejectedValueOnce(new Error("network down"));
    const service = new CloudflareSandboxService();

    const result = await service.deleteDeployment({
      ...TARGET,
      confirmed: true,
    });

    expect(result.success).toBe(false);
    expect(vi.mocked(store.clearDeployment)).not.toHaveBeenCalled();
    expect(vi.mocked(store.updateDeployment)).toHaveBeenCalledWith(
      expect.objectContaining({ status: "error" })
    );
  });

  it("clears the record only after Wrangler reports the worker deleted", async () => {
    const service = new CloudflareSandboxService();

    const result = await service.deleteDeployment({
      ...TARGET,
      confirmed: true,
    });

    expect(result).toEqual({ success: true, data: null });
    expect(vi.mocked(store.clearDeployment)).toHaveBeenCalledOnce();
  });

  // Wrangler's Worker delete leaves the container application behind, which
  // the first live delete proved: the panel said nothing remained while the
  // application sat in the account in state "ready".
  it("deletes every container application named for the worker, and only those, before clearing the record", async () => {
    answerWrangler({
      applications: [
        { id: APP_ID, name: `${WORKER_NAME}-nimbalystsandbox` },
        { id: OTHER_APP_ID, name: "someone-elses-worker-nimbalystsandbox" },
      ],
      remaining: [
        { id: OTHER_APP_ID, name: "someone-elses-worker-nimbalystsandbox" },
      ],
    });
    const service = new CloudflareSandboxService();

    const result = await service.deleteDeployment({
      ...TARGET,
      confirmed: true,
    });

    expect(result).toEqual({ success: true, data: null });
    const commands = vi
      .mocked(runWrangler)
      .mock.calls.map(([args]) => args.slice(0, 3).join(" "));
    expect(commands).toContain(`containers delete ${APP_ID}`);
    expect(commands.join("\n")).not.toContain(OTHER_APP_ID);
    // The Worker goes first: its Durable Object is what keeps the container alive.
    expect(commands.indexOf(`delete --name ${WORKER_NAME}`)).toBeLessThan(
      commands.indexOf(`containers delete ${APP_ID}`)
    );
    expect(vi.mocked(store.clearDeployment)).toHaveBeenCalledOnce();
  });

  it("keeps the record when a container application survives the delete", async () => {
    const app = { id: APP_ID, name: `${WORKER_NAME}-nimbalystsandbox` };
    answerWrangler({ applications: [app], remaining: [app] });
    const service = new CloudflareSandboxService();

    const result = await service.deleteDeployment({
      ...TARGET,
      confirmed: true,
    });

    expect(result.success).toBe(false);
    expect(vi.mocked(store.clearDeployment)).not.toHaveBeenCalled();
    expect(vi.mocked(store.updateDeployment)).toHaveBeenCalledWith(
      expect.objectContaining({ status: "error" })
    );
  });

  it("still removes the container application when an earlier attempt already deleted the worker", async () => {
    answerWrangler({
      applications: [{ id: APP_ID, name: `${WORKER_NAME}-nimbalystsandbox` }],
      workerDelete: async () => {
        throw new SandboxOperationError("worker-missing", "wrangler-cli");
      },
    });
    const service = new CloudflareSandboxService();

    const result = await service.deleteDeployment({
      ...TARGET,
      confirmed: true,
    });

    expect(result).toEqual({ success: true, data: null });
    expect(
      vi.mocked(runWrangler).mock.calls.some(
        ([args]) => args[0] === "containers" && args[1] === "delete" && args[2] === APP_ID
      )
    ).toBe(true);
    expect(vi.mocked(store.clearDeployment)).toHaveBeenCalledOnce();
  });
});

describe("review regressions", () => {
  /** Approve a plan and return the deploy request for it. */
  async function approved(service: CloudflareSandboxService) {
    const planned = await service.planDeployment({
      profileName: "work",
      accountId: "acct-1",
    });
    if (!planned.success) throw new Error("expected a plan");
    return {
      planId: planned.data.planId,
      profileName: "work",
      accountId: "acct-1",
    };
  }

  it("B2: refuses when prepare returns a different artifact than was reviewed", async () => {
    const artifacts = availableArtifacts();
    const service = new CloudflareSandboxService({ artifacts });
    const request = await approved(service);

    // The artifact directory is rebuilt between describe() and prepare().
    vi.mocked(artifacts.prepare).mockResolvedValueOnce({
      projectDir: "/tmp/artifact",
      configPath: "/tmp/artifact/wrangler.json",
      workerName: WORKER_NAME,
      imageRef: "docker.io/nimbalyst/sandbox@sha256:" + "b".repeat(64),
      container: {
        instanceType: "standard-3",
        maxInstances: 1,
        sleepAfterMinutes: 5,
      },
      contentHash: "hash-b",
    });

    const result = await service.deploy(request);

    expect(result).toMatchObject({
      success: false,
      error: { code: "plan-stale" },
    });
    // Nothing was saved and nothing was sent: the check runs before both.
    expect(vi.mocked(store.writeDeployment)).not.toHaveBeenCalled();
    expect(vi.mocked(runWrangler)).not.toHaveBeenCalled();
  });

  it.each(["error", "deploying", "deleting"] as const)(
    "B3: a saved %s record for another account blocks a deploy that would orphan it",
    async (status) => {
      vi.mocked(store.readDeployment).mockReturnValue({
        ...SAVED,
        status,
        account: { id: "other-account", name: "Other" },
      });
      const service = new CloudflareSandboxService({
        artifacts: availableArtifacts(),
      });
      const request = await approved(service);

      const result = await service.deploy(request);

      expect(result).toMatchObject({
        success: false,
        error: { code: "deployment-stale" },
      });
      expect(vi.mocked(runWrangler)).not.toHaveBeenCalled();
    }
  );

  it("B4: a slow status observation does not overwrite a record that changed meanwhile", async () => {
    vi.mocked(store.readDeployment).mockReturnValue(SAVED);
    vi.mocked(store.updateDeploymentIfUnchanged).mockReturnValue(null);
    const service = new CloudflareSandboxService({
      artifacts: availableArtifacts(),
      control: {
        status: vi.fn(async () => ({
          sandboxId: "personal" as const,
          state: "running" as const,
          lastChangedAt: 0,
          sleepAfterSeconds: 300,
          persistence: "ephemeral" as const,
        })),
        wake: vi.fn(),
        stop: vi.fn(),
      } as never,
    });

    await service.getDeployment();

    // Conditional on the revision it observed, never unconditional.
    expect(vi.mocked(store.updateDeploymentIfUnchanged)).toHaveBeenCalledWith(
      "rev-1",
      expect.objectContaining({ container: expect.anything() })
    );
    expect(vi.mocked(store.updateDeployment)).not.toHaveBeenCalled();
  });

  it("B4: refresh actually observes the container instead of returning the cache", async () => {
    vi.mocked(store.readDeployment).mockReturnValue(SAVED);
    const status = vi.fn(async () => ({
      sandboxId: "personal" as const,
      state: "running" as const,
      lastChangedAt: 0,
      sleepAfterSeconds: 300,
      persistence: "ephemeral" as const,
    }));
    const service = new CloudflareSandboxService({
      artifacts: availableArtifacts(),
      control: { status, wake: vi.fn(), stop: vi.fn() } as never,
    });

    await service.getDeployment();

    expect(status).toHaveBeenCalledOnce();
  });

  it("B4: an unreachable container leaves the deployment status alone", async () => {
    vi.mocked(store.readDeployment).mockReturnValue(SAVED);
    const service = new CloudflareSandboxService({
      artifacts: availableArtifacts(),
      control: {
        status: vi.fn(async () => {
          throw new SandboxOperationError(
            "container-unavailable",
            "helper:rpc-failed"
          );
        }),
        wake: vi.fn(),
        stop: vi.fn(),
      } as never,
    });

    const result = await service.getDeployment();

    expect(result.success).toBe(true);
    const patch = vi.mocked(store.updateDeploymentIfUnchanged).mock
      .calls[0]?.[1];
    expect(patch).not.toHaveProperty("status");
    expect(patch?.container).toMatchObject({ status: "unknown" });
  });

  it("serialises mutations so a queued deploy cannot interleave with a delete", async () => {
    const order: string[] = [];
    vi.mocked(runWrangler).mockImplementation(async (args: string[]) => {
      order.push(`${args[0]}:start`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(`${args[0]}:end`);
      return { stdout: args[0] === "containers" ? "[]" : "", stderr: "" };
    });
    const service = new CloudflareSandboxService({
      artifacts: availableArtifacts(),
    });
    const request = await approved(service);

    await Promise.allSettled([
      service.deploy(request),
      service.deleteDeployment({ ...TARGET, confirmed: true }),
    ]);

    // The deploy's single Wrangler call finishes before any of the delete's
    // calls (worker delete, application list) begin.
    expect(order.slice(0, 2)).toEqual(["deploy:start", "deploy:end"]);
    expect(order.slice(2).some((event) => event.startsWith("deploy"))).toBe(false);
    // No operation starts before the previous one finished.
    for (let i = 0; i + 1 < order.length; i += 2) {
      expect(order[i].endsWith(":start")).toBe(true);
      expect(order[i + 1]).toBe(order[i].replace(":start", ":end"));
    }
  });

  it("deletes the saved Worker explicitly while retaining the account config", async () => {
    vi.mocked(store.readDeployment).mockReturnValue(SAVED);
    const service = new CloudflareSandboxService();

    await service.deleteDeployment({ ...TARGET, confirmed: true });

    const [args] = vi.mocked(runWrangler).mock.calls[0] as [string[]];
    expect(args).toContain("--config");
    expect(args[args.indexOf("--name") + 1]).toBe(WORKER_NAME);
    expect(writeControlConfig).toHaveBeenCalledWith({workerName:WORKER_NAME,accountId:SAVED.account.id});
    expect(args[args.indexOf("--profile") + 1]).toBe(SAVED.profileName);
    expect(vi.mocked(runWrangler).mock.calls[0][1]).toMatchObject({cwd:"/tmp/profiles/work"});
  });
});

// ---------------------------------------------------------------------------
// Headless node
// ---------------------------------------------------------------------------

const NODE_CREDENTIAL = {
  nodeId: "node-1",
  userId: asPersonalMemberId("member-9"),
  orgId: "org-7",
  refreshToken: "refresh-abc",
  refreshExpiresAt: 4_000_000,
  accessToken: "nimnode_v1~kid~payload~sig",
  accessTokenExpiresAt: 1_900_000,
};

/**
 * What `deploymentStore` actually hands back: identity, and the "not running"
 * observation default. It never returns a live observation, so a fixture that
 * claimed one would let a bug through by making the store look like the source
 * of process state.
 */
const CONNECTED_NODE = {
  running: false,
  processId: null,
  startedAt: null,
  exitCode: null,
  recentLog: "",
  nodeId: "node-1",
  deviceId: "sandbox-dep-1",
  provisionedAt: "2026-09-10T12:00:00.000Z",
  workspace: {
    projectId: "/Users/me/sources/stravu-editor",
    repoUrl: "https://github.com/nimbalyst/nimbalyst.git",
    branch: "main",
  },
};

function nodeEnvironment(overrides: Record<string, unknown> = {}) {
  return {
    syncServerUrl: () => "https://sync.nimbalyst.com",
    personalIdentity: () => ({ personalOrgId: "org-7", personalUserId: asPersonalMemberId("member-9") }),
    encryptionKeySeed: () => "seed-abc",
    readClaudeCredential: vi.fn(async () => '{"claudeAiOauth":{"accessToken":"a"}}'),
    issueNodeCredential: vi.fn(async () => NODE_CREDENTIAL),
    revokeNodeCredential: vi.fn(async () => undefined),
    git: {
      remoteUrl: async () => "git@github.com:nimbalyst/nimbalyst.git",
      branch: async () => "main",
    },
    requestRemoteSession: vi.fn(async () => "session-42"),
    ...overrides,
  } as never;
}

function runningNodeStatus(running = true) {
  return {
    sandboxId: "personal",
    state: "running",
    lastChangedAt: 1_000,
    sleepAfterSeconds: 600,
    persistence: "ephemeral",
    node: {
      running,
      processId: running ? "proc-1" : null,
      startedAt: running ? 1_000 : null,
      exitCode: null,
      recentLog: "serve: joined index room",
    },
  };
}

describe("CloudflareSandboxService node operations", () => {
  it("wakes, provisions and starts, then saves what it connected", async () => {
    vi.mocked(store.updateDeploymentNode).mockImplementation(
      (patch) => ({ ...SAVED, node: { ...CONNECTED_NODE, ...patch }, revision: "rev-2" } as SandboxDeployment),
    );
    const calls: string[] = [];
    const service = new CloudflareSandboxService({
      artifacts: availableArtifacts(),
      node: nodeEnvironment(),
      control: {
        wake: vi.fn(async () => { calls.push("wake"); return runningNodeStatus(); }),
        provision: vi.fn(async () => { calls.push("provision"); return runningNodeStatus(false); }),
        startNode: vi.fn(async () => { calls.push("startNode"); return runningNodeStatus(); }),
      } as never,
      now: () => new Date("2026-09-10T12:00:00.000Z"),
    });

    const response = await service.connectNode({ ...TARGET, workspacePath: "/Users/me/sources/stravu-editor" });

    expect(response.success).toBe(true);
    expect(calls).toEqual(["wake", "provision", "startNode"]);
    const saved = vi.mocked(store.updateDeploymentNode).mock.calls[0][0];
    expect(saved).toEqual({
      nodeId: "node-1",
      deviceId: "sandbox-dep-1",
      provisionedAt: "2026-09-10T12:00:00.000Z",
      workspace: { projectId: "/Users/me/sources/stravu-editor", branch: "main" },
    });
    // R-3b finding 6: identity only. No observation, and no repo URL, reaches
    // the disk. `toEqual` rather than `toMatchObject` so an added field fails.
    expect(response.success && response.data.node?.running).toBe(true);
  });

  it("refuses to connect with no personal sync identity, before touching the container", async () => {
    const wake = vi.fn();
    const service = new CloudflareSandboxService({
      node: nodeEnvironment({ personalIdentity: () => null }),
      control: { wake } as never,
    });

    const response = await service.connectNode({ ...TARGET, workspacePath: "/Users/me/repo" });

    expect(response).toMatchObject({ success: false, error: { code: "not-authenticated" } });
    expect(wake).not.toHaveBeenCalled();
  });

  it("does not observe the node while the container is asleep, which would wake it", async () => {
    vi.mocked(store.readDeployment).mockReturnValue({ ...SAVED, node: CONNECTED_NODE } as SandboxDeployment);
    const nodeStatus = vi.fn();
    const service = new CloudflareSandboxService({
      node: nodeEnvironment(),
      control: {
        status: vi.fn(async () => ({ ...runningNodeStatus(), state: "stopped" })),
        nodeStatus,
      } as never,
    });

    await service.getDeployment();

    expect(nodeStatus).not.toHaveBeenCalled();
  });

  it("targets the create-session request at the node's device and returns the session id", async () => {
    vi.mocked(store.requireTarget).mockReturnValue({ ...SAVED, node: CONNECTED_NODE } as SandboxDeployment);
    const env = nodeEnvironment();
    const service = new CloudflareSandboxService({ node: env, control: {} as never });

    const response = await service.startRemoteSession({
      ...TARGET,
      workspacePath: "/Users/me/sources/stravu-editor",
      prompt: "  add a readme  ",
    });

    expect(response).toMatchObject({ success: true, data: { sessionId: "session-42" } });
    const sent = vi.mocked((env as never as { requestRemoteSession: ReturnType<typeof vi.fn> }).requestRemoteSession).mock.calls[0][0];
    expect(sent).toMatchObject({
      projectId: "/Users/me/sources/stravu-editor",
      prompt: "add a readme",
      targetDeviceId: "sandbox-dep-1",
    });
  });

  it("will not start a remote session for a workspace the node was not connected for", async () => {
    vi.mocked(store.requireTarget).mockReturnValue({ ...SAVED, node: CONNECTED_NODE } as SandboxDeployment);
    const env = nodeEnvironment();
    const service = new CloudflareSandboxService({ node: env, control: {} as never });

    const response = await service.startRemoteSession({
      ...TARGET,
      workspacePath: "/Users/me/other-repo",
      prompt: "go",
    });

    expect(response.success).toBe(false);
    expect((env as never as { requestRemoteSession: ReturnType<typeof vi.fn> }).requestRemoteSession).not.toHaveBeenCalled();
  });

  it("reports node-not-provisioned rather than a generic failure when no node is connected", async () => {
    vi.mocked(store.requireTarget).mockReturnValue(SAVED);
    const service = new CloudflareSandboxService({ node: nodeEnvironment(), control: {} as never });

    const response = await service.startRemoteSession({
      ...TARGET,
      workspacePath: "/Users/me/sources/stravu-editor",
      prompt: "go",
    });

    expect(response).toMatchObject({ success: false, error: { code: "node-not-provisioned" } });
  });

  it("stops the node, revokes its credential, then forgets it", async () => {
    vi.mocked(store.requireTarget).mockReturnValue({ ...SAVED, node: CONNECTED_NODE } as SandboxDeployment);
    vi.mocked(store.clearDeploymentNode).mockReturnValue({ ...SAVED, node: null } as SandboxDeployment);
    const order: string[] = [];
    const env = nodeEnvironment({
      revokeNodeCredential: vi.fn(async (id: string) => { order.push(`revoke:${id}`); }),
    });
    const service = new CloudflareSandboxService({
      artifacts: availableArtifacts(),
      node: env,
      control: {
        stopNode: vi.fn(async () => { order.push("stopNode"); return runningNodeStatus(false); }),
      } as never,
    });

    const response = await service.disconnectNode({ ...TARGET, discardEphemeralData: true });

    expect(response.success).toBe(true);
    expect(order).toEqual(["stopNode", "revoke:node-1"]);
    expect(store.clearDeploymentNode).toHaveBeenCalled();
  });

  it("keeps the node record when revoking fails, so the credential is still reachable", async () => {
    vi.mocked(store.requireTarget).mockReturnValue({ ...SAVED, node: CONNECTED_NODE } as SandboxDeployment);
    const service = new CloudflareSandboxService({
      artifacts: availableArtifacts(),
      node: nodeEnvironment({
        revokeNodeCredential: vi.fn(async () => { throw new Error("sync server down"); }),
      }),
      control: { stopNode: vi.fn(async () => runningNodeStatus(false)) } as never,
    });

    const response = await service.disconnectNode({ ...TARGET, discardEphemeralData: true });

    expect(response.success).toBe(false);
    expect(store.clearDeploymentNode).not.toHaveBeenCalled();
  });

  it("refuses a disconnect that did not carry the discard warning's consent", async () => {
    const stopNode = vi.fn();
    const service = new CloudflareSandboxService({
      node: nodeEnvironment(),
      control: { stopNode } as never,
    });

    const response = await service.disconnectNode({ ...TARGET } as never);

    expect(response).toMatchObject({ success: false, error: { code: "confirmation-required" } });
    expect(stopNode).not.toHaveBeenCalled();
  });
});

describe("CloudflareSandboxService node safety (R-3b)", () => {
  it("keeps the node and its credential when stopNode reports the process still running", async () => {
    // S3a returns a running node when SIGTERM has not completed. Treating that
    // as done would revoke the credential under a live agent and then hide it.
    vi.mocked(store.requireTarget).mockReturnValue({ ...SAVED, node: CONNECTED_NODE } as SandboxDeployment);
    const env = nodeEnvironment();
    const service = new CloudflareSandboxService({
      artifacts: availableArtifacts(),
      node: env,
      control: { stopNode: vi.fn(async () => runningNodeStatus(true)) } as never,
    });

    const response = await service.disconnectNode({ ...TARGET, discardEphemeralData: true });

    expect(response.success).toBe(false);
    expect(store.clearDeploymentNode).not.toHaveBeenCalled();
    expect(
      (env as never as { revokeNodeCredential: ReturnType<typeof vi.fn> }).revokeNodeCredential,
    ).not.toHaveBeenCalled();
  });

  it("shows a node as not running once the container is observed stopped", async () => {
    // The saved record carries no observation, so a stopped container yields
    // the default. The panel offers Connect again instead of a session form.
    vi.mocked(store.readDeployment).mockReturnValue({ ...SAVED, node: CONNECTED_NODE } as SandboxDeployment);
    vi.mocked(store.updateDeploymentIfUnchanged).mockImplementation(
      (_revision, patch) =>
        ({ ...SAVED, node: CONNECTED_NODE, ...patch, revision: "rev-2" } as SandboxDeployment),
    );
    const service = new CloudflareSandboxService({
      artifacts: availableArtifacts(),
      node: nodeEnvironment(),
      control: {
        status: vi.fn(async () => ({ ...runningNodeStatus(), state: "stopped" })),
        nodeStatus: vi.fn(),
      } as never,
    });

    const response = await service.getDeployment();

    expect(response.success && response.data?.node?.running).toBe(false);
  });

  it("redacts token-shaped text out of the node's log before it leaves the process", async () => {
    vi.mocked(store.requireTarget).mockReturnValue({ ...SAVED, node: CONNECTED_NODE } as SandboxDeployment);
    const hostile = {
      ...runningNodeStatus(true),
      node: {
        ...runningNodeStatus(true).node,
        recentLog: "auth: nimnode_v1~kid~payload~sig and Bearer abc.def.ghi and sk-ant-oat-secret",
      },
    };
    const service = new CloudflareSandboxService({
      artifacts: availableArtifacts(),
      node: nodeEnvironment(),
      control: { nodeStatus: vi.fn(async () => hostile) } as never,
    });

    const response = await service.nodeStatus(TARGET);

    const log = response.success ? response.data.node?.recentLog ?? "" : "";
    expect(log).not.toContain("nimnode_v1~kid~payload~sig");
    expect(log).not.toContain("sk-ant-oat-secret");
    expect(log).not.toContain("abc.def.ghi");
    expect(log).toContain("[redacted]");
  });

  it("refuses to provision against a sync server the sandbox cannot reach", async () => {
    // A dev build pointed at localhost would resolve that inside the container.
    const wake = vi.fn();
    const env = nodeEnvironment({ syncServerUrl: () => "http://localhost:8790" });
    const service = new CloudflareSandboxService({
      artifacts: availableArtifacts(),
      node: env,
      control: { wake } as never,
    });

    const response = await service.connectNode({
      ...TARGET,
      workspacePath: "/Users/me/sources/stravu-editor",
    });

    expect(response).toMatchObject({ success: false, error: { code: "grant-failed" } });
    expect(wake).not.toHaveBeenCalled();
    expect(
      (env as never as { issueNodeCredential: ReturnType<typeof vi.fn> }).issueNodeCredential,
    ).not.toHaveBeenCalled();
  });
});

describe("deleteDeployment credential cleanup (R-3b re-probe finding 2)", () => {
  beforeEach(() => {
    // `deleteDeployment` reads its target through `requireTarget`, not
    // `readDeployment`.
    const withNode = {
      ...SAVED,
      node: { ...CONNECTED_NODE, nodeId: "node-1" },
    } as SandboxDeployment;
    vi.mocked(store.readDeployment).mockReturnValue(withNode);
    vi.mocked(store.requireTarget).mockReturnValue(withNode);
  });

  it("queues the node id for cleanup before clearing the deployment", async () => {
    const order: string[] = [];
    vi.mocked(store.recordPendingRevocation).mockImplementation((id) => {
      order.push(`record:${id}`);
      return true;
    });
    vi.mocked(store.clearDeployment).mockImplementation(() => { order.push("clear"); });
    const service = new CloudflareSandboxService({
      artifacts: availableArtifacts(),
      node: nodeEnvironment({
        revokeNodeCredential: vi.fn(async () => { throw new Error("server down"); }),
      }),
      control: {} as never,
    });

    const response = await service.deleteDeployment({ ...TARGET, confirmed: true });

    expect(response.success).toBe(true);
    // The record is the only other place the id exists. Clearing first would
    // destroy the last pointer to a credential that is still live.
    expect(order).toEqual(["record:node-1", "clear"]);
  });

  it("keeps the deployment when the cleanup queue will not take the id either", async () => {
    vi.mocked(store.recordPendingRevocation).mockReturnValue(false);
    const service = new CloudflareSandboxService({
      artifacts: availableArtifacts(),
      node: nodeEnvironment({
        revokeNodeCredential: vi.fn(async () => { throw new Error("server down"); }),
      }),
      control: {} as never,
    });

    const response = await service.deleteDeployment({ ...TARGET, confirmed: true });

    expect(response.success).toBe(false);
    expect(store.clearDeployment).not.toHaveBeenCalled();
  });

  it("does not queue anything when the revoke succeeds", async () => {
    const service = new CloudflareSandboxService({
      artifacts: availableArtifacts(),
      node: nodeEnvironment(),
      control: {} as never,
    });

    await service.deleteDeployment({ ...TARGET, confirmed: true });

    expect(store.recordPendingRevocation).not.toHaveBeenCalled();
    expect(store.clearDeployment).toHaveBeenCalled();
  });
});
