// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../utils/logger", () => ({
  logger: { main: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } },
}));

import { asPersonalJwt, type PersonalJwt } from "@nimbalyst/runtime/auth/jwtScopes";

import { DeviceGrantClient } from "../deviceGrantClient";
import { SandboxOperationError } from "../errors";

interface Call {
  url: string;
  body: Record<string, unknown>;
  authorization: string | null;
}

/**
 * A fake of the deployed device-auth endpoints. `tokenScript` is consumed one
 * entry per `/auth/device/token` call, so a test can make the grant stay
 * pending for a while exactly the way the real server does.
 */
function fakeServer(options: {
  tokenScript?: Array<{ status: number; body: Record<string, unknown> }>;
  codeResponse?: { status: number; body: Record<string, unknown> };
  approveResponse?: { status: number; body: Record<string, unknown> };
} = {}) {
  const calls: Call[] = [];
  const tokenScript = [...(options.tokenScript ?? [
    { status: 200, body: issuedCredential() },
  ])];

  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? "{}")),
      authorization: headers.authorization ?? null,
    });
    const path = new URL(String(url)).pathname;
    const reply = (status: number, body: unknown) =>
      ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

    if (path === "/auth/device/code") {
      const r = options.codeResponse ?? {
        status: 200,
        body: { device_code: "dc-1", user_code: "ABCD-EFGH", expires_in: 600, interval: 5 },
      };
      return reply(r.status, r.body);
    }
    if (path === "/auth/device/approve") {
      const r = options.approveResponse ?? { status: 200, body: { status: "approved" } };
      return reply(r.status, r.body);
    }
    if (path === "/auth/device/token") {
      const next = tokenScript.shift() ?? { status: 400, body: { error: "expired_token" } };
      return reply(next.status, next.body);
    }
    if (path === "/auth/device/revoke") return reply(200, { node_id: "node-1" });
    return reply(404, { error: "not_found" });
  }) as unknown as typeof globalThis.fetch;

  return { calls, fetchImpl };
}

function issuedCredential(): Record<string, unknown> {
  return {
    access_token: "nimnode_v1~kid~payload~sig",
    token_type: "Bearer",
    expires_in: 900,
    refresh_token: "refresh-abc",
    refresh_expires_at: 4_000_000,
    scope: "personal",
    user_id: "member-9",
    org_id: "org-7",
    node_id: "node-1",
  };
}

function makeClient(
  fetchImpl: typeof globalThis.fetch,
  overrides: { personalJwt?: () => PersonalJwt | null; sleep?: (ms: number) => Promise<void> } = {},
) {
  const sleeps: number[] = [];
  const client = new DeviceGrantClient({
    serverUrl: "https://sync.nimbalyst.com/",
    personalJwt: overrides.personalJwt ?? (() => asPersonalJwt("personal.jwt.value")),
    fetch: fetchImpl,
    now: () => 1_000_000,
    sleep: overrides.sleep ?? (async (ms) => { sleeps.push(ms); }),
  });
  return { client, sleeps };
}

describe("DeviceGrantClient", () => {
  it("runs code -> approve -> token and returns the node credential", async () => {
    const { calls, fetchImpl } = fakeServer();
    const { client } = makeClient(fetchImpl);

    const credential = await client.run("Cloudflare sandbox");

    expect(credential).toEqual({
      nodeId: "node-1",
      userId: "member-9",
      orgId: "org-7",
      refreshToken: "refresh-abc",
      refreshExpiresAt: 4_000_000,
      accessToken: "nimnode_v1~kid~payload~sig",
      // now (1_000_000) + expires_in 900s.
      accessTokenExpiresAt: 1_900_000,
    });

    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/auth/device/code",
      "/auth/device/approve",
      "/auth/device/token",
    ]);
    expect(calls[0].body).toEqual({
      client_id: "nimbalyst-node",
      device_label: "Cloudflare sandbox",
    });
    expect(calls[1].body).toEqual({ user_code: "ABCD-EFGH", action: "approve" });
  });

  it("authorizes only the approval, never the code or token calls", async () => {
    const { calls, fetchImpl } = fakeServer();
    const { client } = makeClient(fetchImpl);

    await client.run("Cloudflare sandbox");

    const byPath = new Map(calls.map((c) => [new URL(c.url).pathname, c.authorization]));
    expect(byPath.get("/auth/device/approve")).toBe("Bearer personal.jwt.value");
    expect(byPath.get("/auth/device/code")).toBeNull();
    expect(byPath.get("/auth/device/token")).toBeNull();
  });

  it("polls on authorization_pending, waiting the server's interval", async () => {
    const { calls, fetchImpl } = fakeServer({
      tokenScript: [
        { status: 400, body: { error: "authorization_pending" } },
        { status: 400, body: { error: "slow_down" } },
        { status: 200, body: issuedCredential() },
      ],
    });
    const { client, sleeps } = makeClient(fetchImpl);

    await expect(client.run("Cloudflare sandbox")).resolves.toMatchObject({ nodeId: "node-1" });

    expect(calls.filter((c) => c.url.endsWith("/token"))).toHaveLength(3);
    // Two waits for three polls: the first poll fires straight after approval.
    // The second wait is longer because the server said `slow_down` -- RFC 8628
    // section 3.5 requires adding five seconds, and not doing so keeps the
    // client pinned against the rate limit until the grant expires.
    expect(sleeps).toEqual([5000, 10000]);
  });

  it("keeps backing off for each slow_down, and never shrinks the interval", async () => {
    const { fetchImpl } = fakeServer({
      tokenScript: [
        { status: 400, body: { error: "slow_down" } },
        { status: 400, body: { error: "slow_down" } },
        { status: 400, body: { error: "authorization_pending" } },
        { status: 200, body: issuedCredential() },
      ],
    });
    const { client, sleeps } = makeClient(fetchImpl);

    await client.run("Cloudflare sandbox");

    expect(sleeps).toEqual([10_000, 15_000, 15_000]);
  });

  it("never repeats server-controlled text in the event it logs", async () => {
    // R-3b finding 4. The event label reaches main.log through toSandboxError,
    // so a hostile or merely unexpected `error` field must be discarded, not
    // echoed. Keep this test: it is the regression guard for that path.
    const secret = "sk-ant-oat-leaked-via-error-field";
    const { fetchImpl } = fakeServer({
      approveResponse: { status: 400, body: { error: secret } },
    });
    const { client } = makeClient(fetchImpl);

    await expect(client.run("Cloudflare sandbox")).rejects.toMatchObject({
      sandboxErrorCode: "grant-failed",
      event: "grant-approve-rejected",
    });
  });

  it("discards an unrecognized token error instead of naming it", async () => {
    const { fetchImpl } = fakeServer({
      tokenScript: [{ status: 400, body: { error: "Bearer abc.def.ghi" } }],
    });
    const { client } = makeClient(fetchImpl);

    await expect(client.run("Cloudflare sandbox")).rejects.toMatchObject({
      event: "grant-token-rejected",
    });
  });

  it("stops polling on a non-retryable token error", async () => {
    const { calls, fetchImpl } = fakeServer({
      tokenScript: [{ status: 400, body: { error: "access_denied" } }],
    });
    const { client } = makeClient(fetchImpl);

    await expect(client.run("Cloudflare sandbox")).rejects.toMatchObject({
      sandboxErrorCode: "grant-failed",
      event: "grant-token-access_denied",
    });
    expect(calls.filter((c) => c.url.endsWith("/token"))).toHaveLength(1);
  });

  it("reports a team-JWT rejection of the approval as a grant failure", async () => {
    const { fetchImpl } = fakeServer({
      approveResponse: { status: 403, body: { error: "personal_scope_required" } },
    });
    const { client } = makeClient(fetchImpl);

    await expect(client.run("Cloudflare sandbox")).rejects.toMatchObject({
      sandboxErrorCode: "grant-failed",
      event: "grant-approve-personal_scope_required",
    });
  });

  it("fails as not-authenticated, not grant-failed, when there is no personal JWT", async () => {
    const { calls, fetchImpl } = fakeServer();
    const { client } = makeClient(fetchImpl, { personalJwt: () => null });

    await expect(client.run("Cloudflare sandbox")).rejects.toMatchObject({
      sandboxErrorCode: "not-authenticated",
    });
    // The code call still happened; nothing authorized was ever sent.
    expect(calls.every((c) => c.authorization === null)).toBe(true);
  });

  it("rejects a token response that is missing a field the node needs", async () => {
    const { refresh_token: _dropped, ...incomplete } = issuedCredential();
    const { fetchImpl } = fakeServer({ tokenScript: [{ status: 200, body: incomplete }] });
    const { client } = makeClient(fetchImpl);

    await expect(client.run("Cloudflare sandbox")).rejects.toBeInstanceOf(SandboxOperationError);
  });

  it("treats an already-revoked credential as revoked", async () => {
    // R-3b re-probe finding 1: revocation gates replacement, so a 404 that
    // means "already gone" has to succeed. Otherwise every retry re-revokes the
    // same dead id, gets the same 404, and refuses to issue, forever.
    const fetchImpl = (async (url: string | URL) => {
      const path = new URL(String(url)).pathname;
      if (path === "/auth/device/revoke") {
        return { ok: false, status: 404, json: async () => ({ error: "unknown_node" }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof globalThis.fetch;
    const { client } = makeClient(fetchImpl);

    await expect(client.revoke("node-gone")).resolves.toBeUndefined();
  });

  it("still fails a revoke the server actually rejected", async () => {
    const fetchImpl = (async () =>
      ({ ok: false, status: 401, json: async () => ({ error: "unauthorized" }) }) as unknown as Response
    ) as unknown as typeof globalThis.fetch;
    const { client } = makeClient(fetchImpl);

    await expect(client.revoke("node-1")).rejects.toMatchObject({
      sandboxErrorCode: "grant-failed",
      event: "grant-revoke-unauthorized",
    });
  });

  it("sends the node id when revoking and skips the call for an empty id", async () => {
    const { calls, fetchImpl } = fakeServer();
    const { client } = makeClient(fetchImpl);

    await client.revoke("node-1");
    await client.revoke("");

    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual({ node_id: "node-1" });
    expect(calls[0].authorization).toBe("Bearer personal.jwt.value");
  });
});
