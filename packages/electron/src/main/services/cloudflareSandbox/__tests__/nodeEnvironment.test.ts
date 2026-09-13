// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests through the REAL environment wiring, not an injected fake.
 *
 * R-3b finding 9: every other test in this directory takes a
 * `SandboxNodeEnvironment` stub, so nothing exercised the production accessors.
 * The reviewer substituted a team JWT for the personal one, and added a log
 * line carrying a refresh token, and the whole suite stayed green.
 *
 * The type system now blocks the first mutation (the seam takes `PersonalJwt`),
 * so this file covers what a type cannot: which accessor is actually called,
 * and whether anything secret reaches the logger.
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

const getPersonalSessionJwt = vi.fn(() => "personal.jwt.value");
/** Not wired to anything. Its job is to prove it is never reached. */
const getSessionJwt = vi.fn(() => "team.jwt.value");

vi.mock("../../StytchAuthService", () => ({
  getPersonalSessionJwt: (...args: unknown[]) => getPersonalSessionJwt(...(args as [])),
  getSessionJwt: (...args: unknown[]) => getSessionJwt(...(args as [])),
  getPersonalOrgId: () => "org-7",
  getPersonalUserId: () => "member-9",
}));
vi.mock("../../SyncManager", () => ({ getSyncProvider: () => null }));
vi.mock("../../CredentialService", () => ({ getEncryptionKeySeed: () => "seed-abc" }));
vi.mock("../../../utils/store", () => ({ getSessionSyncConfig: () => null }));
vi.mock("../deploymentStore", () => ({
  readDeployment: vi.fn(),
  readNodeId: vi.fn(),
  readPendingRevocations: vi.fn(() => []),
  recordPendingRevocation: vi.fn(),
  clearPendingRevocation: vi.fn(),
  readWorkerName: vi.fn(),
  requireTarget: vi.fn(),
  updateDeployment: vi.fn(),
  updateDeploymentIfUnchanged: vi.fn(),
  updateDeploymentNode: vi.fn(),
  clearDeploymentNode: vi.fn(),
  writeDeployment: vi.fn(),
  clearDeployment: vi.fn(),
  getInstallationId: vi.fn(() => "install-1"),
}));

import { createDefaultNodeEnvironment } from "../CloudflareSandboxService";

const REFRESH_TOKEN = "refresh-tok-must-not-be-logged";
const ACCESS_TOKEN = "nimnode_v1~kid~payload~sig-must-not-be-logged";

const originalFetch = globalThis.fetch;
const seenAuthorization: Array<string | null> = [];

beforeEach(() => {
  logCalls.length = 0;
  seenAuthorization.length = 0;
  getPersonalSessionJwt.mockClear();
  getSessionJwt.mockClear();

  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seenAuthorization.push(headers.authorization ?? null);
    const path = new URL(String(url)).pathname;
    const reply = (body: unknown) =>
      ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

    if (path === "/auth/device/code") {
      return reply({ device_code: "dc-1", user_code: "ABCD-EFGH", interval: 5 });
    }
    if (path === "/auth/device/approve") return reply({ status: "approved" });
    if (path === "/auth/device/token") {
      return reply({
        access_token: ACCESS_TOKEN,
        expires_in: 900,
        refresh_token: REFRESH_TOKEN,
        refresh_expires_at: 4_000_000,
        user_id: "member-9",
        org_id: "org-7",
        node_id: "node-1",
      });
    }
    return reply({});
  }) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("createDefaultNodeEnvironment", () => {
  it("authorizes the grant with the personal JWT and never reaches for a team one", async () => {
    await createDefaultNodeEnvironment().issueNodeCredential("Cloudflare sandbox");

    expect(getPersonalSessionJwt).toHaveBeenCalled();
    expect(getSessionJwt).not.toHaveBeenCalled();
    expect(seenAuthorization).toContain("Bearer personal.jwt.value");
    expect(seenAuthorization).not.toContain("Bearer team.jwt.value");
  });

  it("logs nothing at all while running the grant", async () => {
    // The strongest form of "no secret in the log": this path has no reason to
    // log, so any line here is a regression whether or not it looks sensitive.
    await createDefaultNodeEnvironment().issueNodeCredential("Cloudflare sandbox");

    expect(logCalls).toEqual([]);
  });

  it("keeps the issued tokens and the JWT out of every log line", async () => {
    const environment = createDefaultNodeEnvironment();
    await environment.issueNodeCredential("Cloudflare sandbox");
    await environment.revokeNodeCredential("node-1");

    const written = JSON.stringify(logCalls);
    expect(written).not.toContain(REFRESH_TOKEN);
    expect(written).not.toContain(ACCESS_TOKEN);
    expect(written).not.toContain("personal.jwt.value");
  });

  it("resolves the production sync server even when the persisted URL is empty", async () => {
    // The live config on the user's machine has `serverUrl: ""` while connected
    // to production, so the node's URL must come from the same derivation
    // SyncManager uses, never from the stored string.
    expect(createDefaultNodeEnvironment().syncServerUrl()).toBe("https://sync.nimbalyst.com");
  });
});
