import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, IncomingMessage, type Server } from "http";
import { Socket } from "net";
import {
  authorizeMcpSessionRequest,
  authorizeMcpTransportRequest,
  generateMcpAuthToken,
  getMcpAuthToken,
  issueMcpSessionCredential,
  requireMcpAuth,
  revokeMcpSessionCredentials,
  setMcpAuthTokenForTest,
  type McpSessionAuthority,
} from "../mcpAuth";

function makeRequest(opts: {
  url?: string;
  authorization?: string;
}): IncomingMessage {
  const req = new IncomingMessage(new Socket());
  req.url = opts.url ?? "/mcp";
  if (opts.authorization !== undefined) {
    req.headers["authorization"] = opts.authorization;
  }
  return req;
}

describe("mcpAuth", () => {
  let server: Server | null = null;

  beforeEach(() => {
    setMcpAuthTokenForTest(null);
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  describe("generateMcpAuthToken", () => {
    it("returns a 64-character hex string (256 bits of entropy)", () => {
      const token = generateMcpAuthToken();
      expect(token).toMatch(/^[0-9a-f]{64}$/);
    });

    it("returns a different token on each call", () => {
      const a = generateMcpAuthToken();
      const b = generateMcpAuthToken();
      expect(a).not.toBe(b);
    });

    it("getMcpAuthToken returns the most recently generated token", () => {
      const token = generateMcpAuthToken();
      expect(getMcpAuthToken()).toBe(token);
    });
  });

  describe("requireMcpAuth", () => {
    it("returns false when no token has been generated yet (fail closed)", () => {
      const req = makeRequest({ authorization: "Bearer whatever" });
      expect(requireMcpAuth(req)).toBe(false);
    });

    it("accepts a matching Bearer header", () => {
      const token = generateMcpAuthToken();
      const req = makeRequest({ authorization: `Bearer ${token}` });
      expect(requireMcpAuth(req)).toBe(true);
    });

    it("accepts a Bearer header regardless of case (case-insensitive scheme)", () => {
      const token = generateMcpAuthToken();
      const req = makeRequest({ authorization: `bearer ${token}` });
      expect(requireMcpAuth(req)).toBe(true);
    });

    it("rejects a missing Authorization header", () => {
      generateMcpAuthToken();
      const req = makeRequest({});
      expect(requireMcpAuth(req)).toBe(false);
    });

    it("rejects an Authorization header with the wrong token", () => {
      generateMcpAuthToken();
      const req = makeRequest({ authorization: "Bearer wrong-token-abc" });
      expect(requireMcpAuth(req)).toBe(false);
    });

    it("rejects a non-Bearer Authorization scheme", () => {
      const token = generateMcpAuthToken();
      const req = makeRequest({ authorization: `Basic ${token}` });
      expect(requireMcpAuth(req)).toBe(false);
    });

    it("accepts the token via the ?token= query parameter (fallback)", () => {
      const token = generateMcpAuthToken();
      const req = makeRequest({ url: `/mcp?token=${token}` });
      expect(requireMcpAuth(req)).toBe(true);
    });

    it("rejects a wrong token in the ?token= query parameter", () => {
      generateMcpAuthToken();
      const req = makeRequest({ url: "/mcp?token=wrong" });
      expect(requireMcpAuth(req)).toBe(false);
    });

    it("rejects when neither header nor query token is present", () => {
      generateMcpAuthToken();
      const req = makeRequest({ url: "/mcp?other=value" });
      expect(requireMcpAuth(req)).toBe(false);
    });

    it("rejects a token of different length without throwing", () => {
      generateMcpAuthToken();
      const req = makeRequest({ authorization: "Bearer short" });
      expect(() => requireMcpAuth(req)).not.toThrow();
      expect(requireMcpAuth(req)).toBe(false);
    });
  });

  it("binds an HTTP credential to one actor and canonical workspace", async () => {
    const rootToken = generateMcpAuthToken();
    const actorCredential = issueMcpSessionCredential("actor-a", "C:\\repo");
    const otherCredential = issueMcpSessionCredential("actor-b", "C:\\repo");
    const knownAuthorities = new Map([
      ["actor-a", { actorSessionId: "actor-a", workspacePath: "C:\\repo" }],
      ["actor-b", { actorSessionId: "actor-b", workspacePath: "C:\\repo" }],
    ]);
    const transportAuthorities = new Map<string, Readonly<McpSessionAuthority>>();

    server = createServer((req, res) => {
      const parsed = new URL(req.url ?? "/", "http://127.0.0.1");
      const transportId = parsed.searchParams.get("transportId");
      if (transportId) {
        const expected = transportAuthorities.get(transportId) ?? null;
        const liveHostAuthority = expected
          ? knownAuthorities.get(expected.actorSessionId) ?? null
          : null;
        if (!expected || !authorizeMcpTransportRequest(req, expected, liveHostAuthority)) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Not found" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      const requestedSessionId = parsed.searchParams.get("sessionId") ?? undefined;
      const hostAuthority = requestedSessionId
        ? knownAuthorities.get(requestedSessionId) ?? null
        : null;
      const authority = authorizeMcpSessionRequest(req, requestedSessionId, hostAuthority);
      if (!authority) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
        return;
      }
      transportAuthorities.set("transport-a", authority);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(authority));
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test port");
    const base = `http://127.0.0.1:${address.port}/mcp`;

    const accepted = await fetch(`${base}?sessionId=actor-a&workspacePath=C%3A%5Cspoofed`, {
      headers: { Authorization: `Bearer ${actorCredential}` },
    });
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toEqual({
      actorSessionId: "actor-a",
      workspacePath: "C:\\repo",
      workspaceComparisonPath: "c:/repo",
    });

    const actorSwitch = await fetch(`${base}?sessionId=actor-b`, {
      headers: { Authorization: `Bearer ${actorCredential}` },
    });
    expect(actorSwitch.status).toBe(404);
    await expect(actorSwitch.json()).resolves.toEqual({ error: "Not found" });

    const omittedActor = await fetch(`${base}?workspacePath=C%3A%5Cspoofed`, {
      headers: { Authorization: `Bearer ${actorCredential}` },
    });
    expect(omittedActor.status).toBe(404);

    const processBearer = await fetch(`${base}?sessionId=actor-a`, {
      headers: { Authorization: `Bearer ${rootToken}` },
    });
    expect(processBearer.status).toBe(404);
    await expect(processBearer.json()).resolves.toEqual({ error: "Not found" });

    const boundFollowUp = await fetch(`${base}?transportId=transport-a`, {
      headers: { Authorization: `Bearer ${actorCredential}` },
    });
    expect(boundFollowUp.status).toBe(200);

    knownAuthorities.delete('actor-a');
    const revokedFollowUp = await fetch(`${base}?transportId=transport-a`, {
      headers: { Authorization: `Bearer ${actorCredential}` },
    });
    expect(revokedFollowUp.status).toBe(404);

    const transportHijack = await fetch(`${base}?transportId=transport-a`, {
      headers: { Authorization: `Bearer ${otherCredential}` },
    });
    expect(transportHijack.status).toBe(404);
  });

  it("requires current host ownership and derives operational spelling from the current host record", () => {
    generateMcpAuthToken();
    const credential = issueMcpSessionCredential("actor-a", "C:\\Repo");
    const reissued = issueMcpSessionCredential("actor-a", "c:/repo/");
    const request = makeRequest({ authorization: `Bearer ${reissued}` });

    expect(reissued).toBe(credential);
    expect(authorizeMcpSessionRequest(request, "actor-a", null)).toBeNull();
    expect(authorizeMcpSessionRequest(request, "actor-a", {
      actorSessionId: "actor-a",
      workspacePath: "c:/repo/",
    })).toEqual({
      actorSessionId: "actor-a",
      workspacePath: "c:/repo/",
      workspaceComparisonPath: "c:/repo",
    });
  });

  it("mints a new opaque credential after the actor lifecycle is revoked", () => {
    generateMcpAuthToken();
    const first = issueMcpSessionCredential("actor-a", "C:\\Repo");
    const firstRequest = makeRequest({ authorization: `Bearer ${first}` });
    expect(requireMcpAuth(firstRequest)).toBe(true);

    revokeMcpSessionCredentials("actor-a");
    expect(requireMcpAuth(firstRequest)).toBe(false);
    expect(authorizeMcpSessionRequest(firstRequest, "actor-a", {
      actorSessionId: "actor-a",
      workspacePath: "C:\\Repo",
    })).toBeNull();

    const replacement = issueMcpSessionCredential("actor-a", "c:/repo/");
    expect(replacement).not.toBe(first);
    expect(requireMcpAuth(makeRequest({ authorization: `Bearer ${replacement}` }))).toBe(true);
  });
});
