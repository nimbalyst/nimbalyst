import { describe, it, expect, beforeEach } from "vitest";
import { IncomingMessage } from "http";
import { Socket } from "net";
import {
  generateMcpAuthToken,
  getMcpAuthToken,
  requireMcpAuth,
  setMcpAuthTokenForTest,
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
  beforeEach(() => {
    setMcpAuthTokenForTest(null);
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
});
