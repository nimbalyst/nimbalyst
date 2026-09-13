// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../utils/logger", () => ({
  logger: { main: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } },
}));

import {
  __setDeploymentStoreForTests,
  clearPendingRevocation,
  clearRevokedNode,
  PENDING_REVOCATION_CAPACITY,
  pendingRevocationsAtCapacity,
  readDeployment,
  readNodeId,
  readPendingRevocations,
  recordPendingRevocation,
  requireTarget,
  updateDeploymentNode,
  writeDeployment,
} from "../deploymentStore";

/**
 * The real store is electron-store, which resolves `app.getPath` at
 * construction. This is the same interface over a plain object, so these tests
 * exercise the store's own logic rather than a mock of it — which is the whole
 * point: `CloudflareSandboxService.test.ts` mocks this module wholesale, so
 * `requireTarget` and the persistence boundary have no coverage there.
 */
function fakeStore() {
  const data: Record<string, unknown> = {};
  return {
    get: (key: string) => data[key],
    set: (key: string, value: unknown) => { data[key] = value; },
    delete: (key: string) => { delete data[key]; },
    raw: data,
  };
}

let store: ReturnType<typeof fakeStore>;

beforeEach(() => {
  store = fakeStore();
  __setDeploymentStoreForTests(store as never);
});

function saveDeployment() {
  return writeDeployment({
    profileName: "work",
    accountId: "acct-1",
    accountName: "Work Account",
    workerName: "nimbalyst-sandbox-abc",
    status: "deployed",
    deployedAt: "2026-09-09T00:00:00.000Z",
  });
}

describe("requireTarget", () => {
  it.each([
    ["deploymentId", { deploymentId: "other" }],
    ["revision", { revision: "other" }],
    ["profileName", { profileName: "other" }],
    ["accountId", { accountId: "other" }],
  ])("refuses a request whose %s disagrees with the saved record", (_field, override) => {
    const saved = saveDeployment();
    const target = {
      deploymentId: saved.deploymentId,
      revision: saved.revision,
      profileName: saved.profileName,
      accountId: saved.account.id,
      ...override,
    };

    expect(() => requireTarget(target)).toThrow(
      expect.objectContaining({ sandboxErrorCode: "deployment-stale" }),
    );
  });

  it("accepts a request that matches on every field", () => {
    const saved = saveDeployment();
    expect(
      requireTarget({
        deploymentId: saved.deploymentId,
        revision: saved.revision,
        profileName: saved.profileName,
        accountId: saved.account.id,
      }).deploymentId,
    ).toBe(saved.deploymentId);
  });

  it("refuses any target when nothing is saved", () => {
    expect(() =>
      requireTarget({ deploymentId: "a", revision: "b", profileName: "c", accountId: "d" }),
    ).toThrow(expect.objectContaining({ sandboxErrorCode: "deployment-stale" }));
  });
});

describe("node record persistence", () => {
  it("keeps the node id across a redeploy, so its credential stays revocable", () => {
    // R-3b finding 3: dropping the record at the start of a deploy orphans a
    // live server-side credential, and a deploy that then fails loses it for
    // good. Changing the deployment does not invalidate anything on the server.
    saveDeployment();
    updateDeploymentNode({
      nodeId: "node-1",
      deviceId: "sandbox-dep-1",
      provisionedAt: "2026-09-10T12:00:00.000Z",
      workspace: { projectId: "/Users/me/repo", branch: "main" },
    });

    writeDeployment({
      profileName: "work",
      accountId: "acct-1",
      accountName: "Work Account",
      workerName: "nimbalyst-sandbox-abc",
      status: "deploying",
      deployedAt: null,
    });

    expect(readNodeId()).toBe("node-1");
  });

  it("stores identity only, never an observation of the process", () => {
    // R-3b finding 6. `recentLog` is another machine's process output and
    // `running` goes stale the moment the container sleeps.
    saveDeployment();
    updateDeploymentNode({
      nodeId: "node-1",
      deviceId: "sandbox-dep-1",
      provisionedAt: "2026-09-10T12:00:00.000Z",
      workspace: { projectId: "/Users/me/repo", branch: "main" },
    });

    const persisted = (store.raw.deployment as { node: Record<string, unknown> }).node;
    expect(Object.keys(persisted).sort()).toEqual([
      "deviceId",
      "nodeId",
      "provisionedAt",
      "workspace",
    ]);
    expect(persisted.workspace).toEqual({ projectId: "/Users/me/repo", branch: "main" });
  });

  it("reads a saved node back as not running, whatever the container is doing", () => {
    saveDeployment();
    updateDeploymentNode({ nodeId: "node-1", deviceId: "sandbox-dep-1" });

    expect(readDeployment()?.node).toMatchObject({
      running: false,
      processId: null,
      exitCode: null,
      recentLog: "",
      nodeId: "node-1",
    });
  });

  it("loads a record written before nodes existed", () => {
    saveDeployment();
    expect(readDeployment()?.node).toBeNull();
  });
});

describe("pending revocations", () => {
  it("survives the deployment being replaced, which is when cleanup is easiest to lose", () => {
    recordPendingRevocation("node-orphan");
    saveDeployment();

    expect(readPendingRevocations()).toEqual(["node-orphan"]);

    clearPendingRevocation("node-orphan");
    expect(readPendingRevocations()).toEqual([]);
  });

  it("does not record the same id twice", () => {
    recordPendingRevocation("node-orphan");
    recordPendingRevocation("node-orphan");
    expect(readPendingRevocations()).toEqual(["node-orphan"]);
  });
});

describe("pending-revocation queue bounds (R-3b re-probe finding 3)", () => {
  it("never evicts an unresolved id to make room", () => {
    // The earlier version kept the newest 20 and dropped the oldest, which
    // destroyed the only record of a credential still live on the server.
    for (let i = 0; i < PENDING_REVOCATION_CAPACITY + 5; i += 1) {
      expect(recordPendingRevocation(`node-${i}`)).toBe(true);
    }

    const queued = readPendingRevocations();
    expect(queued).toHaveLength(PENDING_REVOCATION_CAPACITY + 5);
    expect(queued[0]).toBe("node-0");
  });

  it("reports capacity so issuance can be blocked instead", () => {
    expect(pendingRevocationsAtCapacity()).toBe(false);
    for (let i = 0; i < PENDING_REVOCATION_CAPACITY; i += 1) recordPendingRevocation(`node-${i}`);
    expect(pendingRevocationsAtCapacity()).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["not base64url", "node/1+2=" ],
    ["too long", "a".repeat(65)],
    ["with a space", "node 1"],
  ])("refuses to persist a node id that is %s", (_why, nodeId) => {
    expect(recordPendingRevocation(nodeId)).toBe(false);
    expect(readPendingRevocations()).toEqual([]);
  });

  it("ignores an unparseable entry already on disk rather than replaying it", () => {
    store.set("pendingRevocations", ["good-id", { evil: true }, "bad id"]);
    expect(readPendingRevocations()).toEqual(["good-id"]);
  });
});

describe("clearRevokedNode", () => {
  it("drops the node record once its credential is confirmed revoked", () => {
    saveDeployment();
    updateDeploymentNode({ nodeId: "node-1", deviceId: "sandbox-dep-1" });

    clearRevokedNode("node-1");

    expect(readNodeId()).toBeNull();
    expect(readDeployment()?.node).toBeNull();
  });

  it("leaves a record that has since been repointed at a different node", () => {
    saveDeployment();
    updateDeploymentNode({ nodeId: "node-2", deviceId: "sandbox-dep-1" });

    clearRevokedNode("node-1");

    expect(readNodeId()).toBe("node-2");
  });
});
