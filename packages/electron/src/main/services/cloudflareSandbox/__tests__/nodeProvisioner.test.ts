// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { asPersonalMemberId } from "@nimbalyst/runtime/auth/jwtScopes";

/**
 * Captures every log call rather than discarding it. R-3b inserted
 * `logger.main.warn(credential.refreshToken)` into the provisioner and all 219
 * service tests stayed green, because nothing ran the provisioner with the
 * logger under observation. See "leaks nothing" below.
 */
const logCalls: unknown[][] = [];

vi.mock("../../../utils/logger", () => ({
  logger: {
    main: {
      warn: (...args: unknown[]) => logCalls.push(args),
      info: (...args: unknown[]) => logCalls.push(args),
      error: (...args: unknown[]) => logCalls.push(args),
      debug: (...args: unknown[]) => logCalls.push(args),
    },
  },
}));

import {
  buildNodeProvisionPlan,
  checkoutDirFor,
  provisionAndStartNode,
  resolveWorkspaceMapping,
  toHttpsRemote,
  type NodeProvisionInput,
} from "../nodeProvisioner";
import type {
  SandboxControlClient,
  SandboxControlTarget,
  SandboxNodeStatus,
} from "../sandboxControl";

const TARGET: SandboxControlTarget = {
  cwd: "/profiles/work",
  configPath: "/tmp/control.jsonc",
  helperPath: "/app/rpc-helper.mjs",
  wranglerModulePath: "/app/wrangler.js",
};

const INPUT: Omit<NodeProvisionInput, "credential" | "claudeCredential"> = {
  deploymentId: "dep-1",
  identity: {
    serverUrl: "https://sync.nimbalyst.com",
    expectedPersonalOrgId: "org-7",
    expectedPersonalUserId: asPersonalMemberId("member-9"),
    encryptionKeySeed: "seed-abc",
  },
  workspace: {
    projectId: "/Users/me/sources/stravu-editor",
    repoUrl: "https://github.com/nimbalyst/nimbalyst.git",
    branch: "main",
    checkoutDir: "/workspace/stravu-editor",
  },
};

const CREDENTIAL = {
  nodeId: "node-1",
  userId: asPersonalMemberId("member-9"),
  orgId: "org-7",
  refreshToken: "refresh-abc",
  refreshExpiresAt: 4_000_000,
  accessToken: "nimnode_v1~kid~payload~sig",
  accessTokenExpiresAt: 1_900_000,
};

const CLAUDE_CREDENTIAL = '{"claudeAiOauth":{"accessToken":"sk-ant-oat-example"}}';

function nodeStatus(overrides: Partial<SandboxNodeStatus["node"]> = {}): SandboxNodeStatus {
  return {
    sandboxId: "personal",
    state: "running",
    lastChangedAt: 1_000,
    sleepAfterSeconds: 600,
    persistence: "ephemeral",
    node: {
      running: true,
      processId: "proc-1",
      startedAt: 1_000,
      exitCode: null,
      recentLog: "serve: joined index room",
      ...overrides,
    },
  };
}

function fakeControl(overrides: Partial<SandboxControlClient> = {}) {
  const calls: Array<{ op: string; request?: unknown }> = [];
  const client = {
    provision: vi.fn(async (_t, request) => { calls.push({ op: "provision", request }); return nodeStatus({ running: false, processId: null, startedAt: null }); }),
    startNode: vi.fn(async (_t, request) => { calls.push({ op: "startNode", request }); return nodeStatus(); }),
    nodeStatus: vi.fn(async () => nodeStatus()),
    stopNode: vi.fn(async () => nodeStatus({ running: false, processId: null, startedAt: null })),
    status: vi.fn(async () => nodeStatus()),
    wake: vi.fn(async () => nodeStatus()),
    stop: vi.fn(async () => nodeStatus()),
    ...overrides,
  } as unknown as SandboxControlClient;
  return { client, calls };
}

type ProvisionDeps = Parameters<typeof provisionAndStartNode>[2];

function defaultDeps(
  control: SandboxControlClient,
  overrides: Partial<ProvisionDeps> = {},
): ProvisionDeps & { issueCredential: ReturnType<typeof vi.fn> } {
  return {
    control,
    issueCredential: vi.fn(async () => CREDENTIAL),
    revokeCredential: vi.fn(async () => undefined),
    readClaudeCredential: vi.fn(async () => CLAUDE_CREDENTIAL),
    now: () => new Date("2026-09-10T12:00:00.000Z"),
    ...overrides,
  } as ProvisionDeps & { issueCredential: ReturnType<typeof vi.fn> };
}

describe("buildNodeProvisionPlan", () => {
  it("writes the four files the node serve mode reads, under /home/nimbalyst", () => {
    const plan = buildNodeProvisionPlan({
      ...INPUT,
      credential: CREDENTIAL,
      claudeCredential: CLAUDE_CREDENTIAL,
    });

    expect(plan.files.map((f) => f.path)).toEqual([
      "/home/nimbalyst/nimbalyst-node/config.json",
      "/home/nimbalyst/nimbalyst-node/node-credential.json",
      "/home/nimbalyst/nimbalyst-node/workspaces.json",
      "/home/nimbalyst/.claude/.credentials.json",
    ]);
    expect(plan.configPath).toBe("/home/nimbalyst/nimbalyst-node/config.json");
    expect(plan.deviceId).toBe("sandbox-dep-1");
  });

  it("emits exactly the config keys the node's serve mode expects", () => {
    const plan = buildNodeProvisionPlan({
      ...INPUT,
      credential: CREDENTIAL,
      claudeCredential: CLAUDE_CREDENTIAL,
    });

    expect(JSON.parse(plan.files[0].content)).toEqual({
      databasePath: "./nimbalyst.sqlite",
      trust: { mode: "bypass-all" },
      sync: {
        serverUrl: "https://sync.nimbalyst.com",
        credentialPath: "./node-credential.json",
        encryptionKeySeed: "seed-abc",
        personalOrgId: "org-7",
        personalUserId: asPersonalMemberId("member-9"),
        deviceId: "sandbox-dep-1",
        deviceName: "Cloudflare sandbox",
      },
      workspacesPath: "./workspaces.json",
    });
    expect(JSON.parse(plan.files[1].content)).toEqual(CREDENTIAL);
    expect(JSON.parse(plan.files[2].content)).toEqual({ workspaces: [INPUT.workspace] });
  });

  it("copies the Claude credential through byte for byte", () => {
    const exotic = '{"claudeAiOauth":{"accessToken":"a","futureField":{"nested":true}}}';
    const plan = buildNodeProvisionPlan({
      ...INPUT,
      credential: CREDENTIAL,
      claudeCredential: exotic,
    });
    expect(plan.files[3].content).toBe(exotic);
    expect(plan.files[3].mode).toBe(0o600);
  });

  it("asks for the repo host only when the baseline does not already cover it", () => {
    const onGithub = buildNodeProvisionPlan({ ...INPUT, credential: CREDENTIAL, claudeCredential: CLAUDE_CREDENTIAL });
    expect(onGithub.allowedHosts).toEqual([]);

    const selfHosted = buildNodeProvisionPlan({
      ...INPUT,
      workspace: { ...INPUT.workspace, repoUrl: "https://git.example.internal/team/repo.git" },
      credential: CREDENTIAL,
      claudeCredential: CLAUDE_CREDENTIAL,
    });
    expect(selfHosted.allowedHosts).toEqual(["git.example.internal"]);
  });
});

describe("provisionAndStartNode", () => {
  it("reads the Claude credential before minting one on the server", async () => {
    const { client } = fakeControl();
    const order: string[] = [];
    const deps = defaultDeps(client, {
      readClaudeCredential: vi.fn(async () => { order.push("claude"); return CLAUDE_CREDENTIAL; }),
      issueCredential: vi.fn(async () => { order.push("grant"); return CREDENTIAL; }),
    });

    await provisionAndStartNode(TARGET, INPUT, deps);

    expect(order).toEqual(["claude", "grant"]);
  });

  it("does not mint a credential when there is no Claude login to copy", async () => {
    const { client } = fakeControl();
    const deps = defaultDeps(client, {
      readClaudeCredential: vi.fn(async () => { throw new Error("no credential"); }),
    });

    await expect(provisionAndStartNode(TARGET, INPUT, deps)).rejects.toThrow();
    expect(deps.issueCredential).not.toHaveBeenCalled();
    expect(client.provision).not.toHaveBeenCalled();
  });

  it("revokes the previous node's credential before issuing a new one", async () => {
    const { client } = fakeControl();
    const order: string[] = [];
    const deps = defaultDeps(client, {
      revokeCredential: vi.fn(async (id: string) => { order.push(`revoke:${id}`); }),
      issueCredential: vi.fn(async () => { order.push("grant"); return CREDENTIAL; }),
      previousNodeId: "node-old",
    });

    await provisionAndStartNode(TARGET, INPUT, deps);

    expect(order).toEqual(["revoke:node-old", "grant"]);
  });

  it("refuses to issue a replacement while the previous credential is still live", async () => {
    // R-3b finding 1. Carrying on here leaves a usable personal-scope
    // credential on the server that nothing in the UI points at any more.
    const { client } = fakeControl();
    const logEvent = vi.fn();
    const recordPendingRevocation = vi.fn();
    const deps = defaultDeps(client, {
      revokeCredential: vi.fn(async () => { throw new Error("server down"); }),
      previousNodeId: "node-old",
      recordPendingRevocation,
      logEvent,
    });

    await expect(provisionAndStartNode(TARGET, INPUT, deps)).rejects.toMatchObject({
      sandboxErrorCode: "grant-failed",
      event: "node-revoke-previous-failed",
    });
    expect(deps.issueCredential).not.toHaveBeenCalled();
    expect(client.provision).not.toHaveBeenCalled();
    expect(recordPendingRevocation).toHaveBeenCalledWith("node-old", "revoke-before-replace-failed");
    expect(logEvent).toHaveBeenCalledWith("node-revoke-previous-failed");
  });

  it("retries an earlier failed revocation before minting anything new", async () => {
    // R-3b finding 2: the metadata written above has to actually be used.
    const { client } = fakeControl();
    const revoked: string[] = [];
    const clearPendingRevocation = vi.fn();
    const deps = defaultDeps(client, {
      revokeCredential: vi.fn(async (id: string) => { revoked.push(id); }),
      pendingRevocations: ["node-orphan"],
      previousNodeId: "node-old",
      clearPendingRevocation,
    });

    await provisionAndStartNode(TARGET, INPUT, deps);

    expect(revoked).toEqual(["node-orphan", "node-old"]);
    expect(clearPendingRevocation).toHaveBeenCalledWith("node-orphan");
  });

  it("records the revocation the instant it succeeds, not at the end of the run", async () => {
    // R-3b re-probe finding 1, the permanent-lockout case. If the confirmation
    // waits for a successful provision, a failed retry re-revokes a dead id.
    const { client } = fakeControl({
      provision: vi.fn(async () => { throw new Error("worker refused"); }),
    });
    const confirmed: string[] = [];
    const deps = defaultDeps(client, {
      previousNodeId: "node-old",
      confirmRevoked: (id: string) => { confirmed.push(id); },
    });

    await expect(provisionAndStartNode(TARGET, INPUT, deps)).rejects.toThrow();

    // Both: the old one before issuance, the new one on the way back out.
    expect(confirmed).toEqual(["node-old", "node-1"]);
  });

  it("refuses to issue while the cleanup backlog is full", async () => {
    const { client } = fakeControl();
    const logEvent = vi.fn();
    const deps = defaultDeps(client, { cleanupAtCapacity: () => true, logEvent });

    await expect(provisionAndStartNode(TARGET, INPUT, deps)).rejects.toMatchObject({
      sandboxErrorCode: "grant-failed",
      event: "node-cleanup-at-capacity",
    });
    expect(deps.issueCredential).not.toHaveBeenCalled();
    expect(logEvent).toHaveBeenCalledWith("node-cleanup-at-capacity");
  });

  it("says so when an orphaned credential could not even be written down", async () => {
    const { client } = fakeControl({
      provision: vi.fn(async () => { throw new Error("worker refused"); }),
    });
    const logEvent = vi.fn();
    const deps = defaultDeps(client, {
      revokeCredential: vi.fn(async () => { throw new Error("server down"); }),
      recordPendingRevocation: () => false,
      logEvent,
    });

    await expect(provisionAndStartNode(TARGET, INPUT, deps)).rejects.toThrow();
    expect(logEvent).toHaveBeenCalledWith("node-revoke-orphan-unrecorded");
  });

  it("takes the new credential back down when provisioning fails after it was issued", async () => {
    const { client } = fakeControl({
      provision: vi.fn(async () => { throw new Error("worker refused"); }),
    });
    const revoked: string[] = [];
    const deps = defaultDeps(client, {
      revokeCredential: vi.fn(async (id: string) => { revoked.push(id); }),
    });

    await expect(provisionAndStartNode(TARGET, INPUT, deps)).rejects.toThrow();
    expect(revoked).toEqual(["node-1"]);
  });

  it("revokes the new credential when the grant names the wrong user", async () => {
    const { client } = fakeControl();
    const revoked: string[] = [];
    const deps = defaultDeps(client, {
      issueCredential: vi.fn(async () => ({ ...CREDENTIAL, userId: asPersonalMemberId("member-other") })),
      revokeCredential: vi.fn(async (id: string) => { revoked.push(id); }),
    });

    await expect(provisionAndStartNode(TARGET, INPUT, deps)).rejects.toMatchObject({
      sandboxErrorCode: "grant-failed",
    });
    expect(revoked).toEqual(["node-1"]);
  });

  it("remembers a credential it could not take back down, so the next connect can", async () => {
    const { client } = fakeControl({
      startNode: vi.fn(async () => nodeStatus({ running: false, processId: null, startedAt: null, exitCode: 1 })),
    });
    const recordPendingRevocation = vi.fn();
    const logEvent = vi.fn();
    const deps = defaultDeps(client, {
      revokeCredential: vi.fn(async () => { throw new Error("server down"); }),
      recordPendingRevocation,
      logEvent,
    });

    await expect(provisionAndStartNode(TARGET, INPUT, deps)).rejects.toMatchObject({
      sandboxErrorCode: "node-start-failed",
    });
    expect(recordPendingRevocation).toHaveBeenCalledWith("node-1", "provision-failed");
    expect(logEvent).toHaveBeenCalledWith("node-revoke-orphan-failed");
  });

  it("starts from the path it just wrote and reports what it provisioned", async () => {
    const { client, calls } = fakeControl();
    const deps = defaultDeps(client);

    const result = await provisionAndStartNode(TARGET, INPUT, deps);

    expect(calls.map((c) => c.op)).toEqual(["provision", "startNode"]);
    expect(calls[1].request).toEqual({
      configPath: "/home/nimbalyst/nimbalyst-node/config.json",
    });
    expect(result.provisionedAt).toBe("2026-09-10T12:00:00.000Z");
    expect(result.status.node.running).toBe(true);
  });

  it("writes the grant's own ids into the config, not the desktop's", () => {
    // The node's access token carries these as `org`/`sub`, and the server
    // answers AUTH_MISMATCH if the config disagrees.
    const plan = buildNodeProvisionPlan({
      ...INPUT,
      credential: { ...CREDENTIAL, userId: asPersonalMemberId("member-9"), orgId: "org-7" },
      claudeCredential: CLAUDE_CREDENTIAL,
    });
    const config = JSON.parse(plan.files[0].content);
    expect(config.sync.personalUserId).toBe("member-9");
    expect(config.sync.personalOrgId).toBe("org-7");
  });

  it("refuses to provision when the grant names a different user than this desktop", async () => {
    const { client } = fakeControl();
    const logEvent = vi.fn();
    const deps = defaultDeps(client, {
      issueCredential: vi.fn(async () => ({ ...CREDENTIAL, userId: asPersonalMemberId("member-other") })),
      logEvent,
    });

    await expect(provisionAndStartNode(TARGET, INPUT, deps)).rejects.toMatchObject({
      sandboxErrorCode: "grant-failed",
    });
    expect(client.provision).not.toHaveBeenCalled();
    // Names which side disagreed, never the ids.
    expect(logEvent).toHaveBeenCalledWith("node-grant-identity-mismatch-user");
  });

  it("refuses to report a connected node when the process is not running", async () => {
    const { client } = fakeControl({
      startNode: vi.fn(async () => nodeStatus({ running: false, processId: null, startedAt: null, exitCode: 1 })),
    });

    await expect(provisionAndStartNode(TARGET, INPUT, defaultDeps(client))).rejects.toMatchObject({
      sandboxErrorCode: "node-start-failed",
    });
  });
});

describe("toHttpsRemote", () => {
  it.each([
    ["git@github.com:nimbalyst/nimbalyst.git", "https://github.com/nimbalyst/nimbalyst.git"],
    ["ssh://git@github.com/nimbalyst/nimbalyst.git", "https://github.com/nimbalyst/nimbalyst.git"],
    ["ssh://git@git.example.com:22/team/repo.git", "https://git.example.com/team/repo.git"],
    ["https://github.com/nimbalyst/nimbalyst.git", "https://github.com/nimbalyst/nimbalyst.git"],
  ])("%s -> %s", (input, expected) => {
    expect(toHttpsRemote(input)).toBe(expected);
  });

  it("strips credentials a local credential helper baked into the remote", () => {
    expect(toHttpsRemote("https://x-access-token:ghp_secret@github.com/org/repo.git"))
      .toBe("https://github.com/org/repo.git");
  });

  it("refuses an empty remote instead of provisioning an unclonable workspace", () => {
    expect(() => toHttpsRemote("  ")).toThrow();
  });
});

describe("resolveWorkspaceMapping", () => {
  it("maps the workspace onto a checkout dir named for its folder", async () => {
    const mapping = await resolveWorkspaceMapping("/Users/me/sources/stravu-editor", {
      remoteUrl: async () => "git@github.com:nimbalyst/nimbalyst.git\n",
      branch: async () => "feature/sandbox\n",
    });

    expect(mapping).toEqual({
      projectId: "/Users/me/sources/stravu-editor",
      repoUrl: "https://github.com/nimbalyst/nimbalyst.git",
      branch: "feature/sandbox",
      checkoutDir: "/workspace/stravu-editor",
    });
  });

  it("refuses a detached HEAD rather than guessing a branch", async () => {
    await expect(
      resolveWorkspaceMapping("/Users/me/repo", {
        remoteUrl: async () => "git@github.com:org/repo.git",
        branch: async () => "HEAD",
      }),
    ).rejects.toMatchObject({ event: "workspace-detached-head" });
  });

  it("keeps a folder name with spaces out of the container path", () => {
    expect(checkoutDirFor("/Users/me/My Project")).toBe("/workspace/My-Project");
  });
});

describe("secrets never reach the log (R-3b finding 4)", () => {
  /**
   * Distinctive values for everything that crosses this module. If any of them
   * appears in a captured log call, or in the fixed event labels handed to
   * `logEvent`, that is the leak.
   */
  const SECRETS = {
    personalJwt: "personal-jwt-AAAA-must-not-appear",
    accessToken: "nimnode_v1~kid~access-BBBB-must-not-appear",
    refreshToken: "refresh-CCCC-must-not-appear",
    claudeCredential: '{"claudeAiOauth":{"accessToken":"sk-ant-oat-DDDD-must-not-appear"}}',
    encryptionKeySeed: "seed-EEEE-must-not-appear",
  };

  const secretInput = {
    ...INPUT,
    identity: { ...INPUT.identity, encryptionKeySeed: SECRETS.encryptionKeySeed },
  };

  function secretDeps(control: SandboxControlClient, overrides: Partial<ProvisionDeps> = {}) {
    return defaultDeps(control, {
      readClaudeCredential: vi.fn(async () => SECRETS.claudeCredential),
      issueCredential: vi.fn(async () => ({
        ...CREDENTIAL,
        accessToken: SECRETS.accessToken,
        refreshToken: SECRETS.refreshToken,
      })),
      // The provisioner never sees the JWT directly, but a future change that
      // threads it through would be caught here too.
      logEvent: (event: string) => logCalls.push(["logEvent", event]),
      ...overrides,
    });
  }

  function assertNoSecretsLogged() {
    const written = JSON.stringify(logCalls);
    for (const [name, secret] of Object.entries(SECRETS)) {
      expect(written, `${name} reached the log`).not.toContain(secret);
    }
    // The Claude payload is passed through verbatim, so check the token inside
    // it as well as the whole string.
    expect(written).not.toContain("sk-ant-oat-DDDD-must-not-appear");
  }

  beforeEach(() => {
    logCalls.length = 0;
  });

  it("leaks nothing on the successful path", async () => {
    const { client } = fakeControl();

    await provisionAndStartNode(TARGET, secretInput, secretDeps(client));

    assertNoSecretsLogged();
  });

  it("leaks nothing when the start fails and the credential is revoked", async () => {
    const { client } = fakeControl({
      startNode: vi.fn(async () => nodeStatus({ running: false, processId: null, startedAt: null, exitCode: 1 })),
    });

    await expect(
      provisionAndStartNode(TARGET, secretInput, secretDeps(client)),
    ).rejects.toThrow();

    assertNoSecretsLogged();
  });

  it("leaks nothing when the compensating revoke also fails", async () => {
    const { client } = fakeControl({
      provision: vi.fn(async () => { throw new Error("worker refused"); }),
    });

    await expect(
      provisionAndStartNode(
        TARGET,
        secretInput,
        secretDeps(client, {
          revokeCredential: vi.fn(async () => { throw new Error("server down"); }),
        }),
      ),
    ).rejects.toThrow();

    assertNoSecretsLogged();
  });
});
