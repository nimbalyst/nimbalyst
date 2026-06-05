import { describe, it, expect } from "vitest";
import { IncomingMessage } from "http";
import { Socket } from "net";
import {
  getAllowedClipOrigin,
  hasAllowedClipContentType,
} from "../clipRequestGuards";

function makeRequest(opts: {
  origin?: string;
  contentType?: string;
}): IncomingMessage {
  const req = new IncomingMessage(new Socket());
  req.url = "/clip";
  if (opts.origin !== undefined) {
    req.headers.origin = opts.origin;
  }
  if (opts.contentType !== undefined) {
    req.headers["content-type"] = opts.contentType;
  }
  return req;
}

describe("clip request guards", () => {
  describe("getAllowedClipOrigin", () => {
    it("accepts chrome extension origins", () => {
      const req = makeRequest({ origin: "chrome-extension://abcdefghijklmnop" });
      expect(getAllowedClipOrigin(req)).toBe("chrome-extension://abcdefghijklmnop");
    });

    it("accepts moz extension origins", () => {
      const req = makeRequest({ origin: "moz-extension://12345678-1234-1234-1234-123456789abc" });
      expect(getAllowedClipOrigin(req)).toBe("moz-extension://12345678-1234-1234-1234-123456789abc");
    });

    it("rejects localhost page origins", () => {
      const req = makeRequest({ origin: "http://127.0.0.1:5273" });
      expect(getAllowedClipOrigin(req)).toBeNull();
    });

    it("rejects missing origins", () => {
      const req = makeRequest({});
      expect(getAllowedClipOrigin(req)).toBeNull();
    });

    it("rejects malformed origins", () => {
      const req = makeRequest({ origin: "not-a-valid-origin" });
      expect(getAllowedClipOrigin(req)).toBeNull();
    });
  });

  describe("hasAllowedClipContentType", () => {
    it("accepts application/json", () => {
      const req = makeRequest({ contentType: "application/json" });
      expect(hasAllowedClipContentType(req)).toBe(true);
    });

    it("accepts application/json with charset", () => {
      const req = makeRequest({ contentType: "application/json; charset=utf-8" });
      expect(hasAllowedClipContentType(req)).toBe(true);
    });

    it("rejects text/plain", () => {
      const req = makeRequest({ contentType: "text/plain;charset=UTF-8" });
      expect(hasAllowedClipContentType(req)).toBe(false);
    });

    it("rejects missing content type", () => {
      const req = makeRequest({});
      expect(hasAllowedClipContentType(req)).toBe(false);
    });
  });
});
