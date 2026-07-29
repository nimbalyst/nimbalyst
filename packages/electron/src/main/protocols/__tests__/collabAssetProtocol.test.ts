import { describe, it, expect, beforeEach, vi } from "vitest";

// The global electron mock (vitest.setup.ts) has no `net`; the upstream-fetch
// tests below need one. `protocol` is only touched by installer helpers the
// tests do not call, but the module imports it, so stub it too.
const netFetch = vi.fn();
vi.mock("electron", () => ({
  net: { fetch: (...args: unknown[]) => netFetch(...args) },
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
}));

import {
  parseCollabAssetUrl,
  registerCollabAssetDocument,
  unregisterCollabAssetDocument,
  isCollabAssetDocumentRegistered,
  isCollabAssetDocumentRegisteredForSender,
  clearCollabAssetSender,
  clearCollabAssetRegistry,
  COLLAB_ASSET_SCHEME,
  createCollabAssetRequestHandler,
} from "../collabAssetProtocol";

const SENDER_A = 100;
const SENDER_B = 200;

describe("collabAssetProtocol", () => {
  describe("parseCollabAssetUrl", () => {
    it("parses a well-formed collab-asset URL", () => {
      const url = `${COLLAB_ASSET_SCHEME}://doc/doc-123/asset/asset-abc`;
      expect(parseCollabAssetUrl(url)).toEqual({
        documentId: "doc-123",
        assetId: "asset-abc",
      });
    });

    it("decodes percent-encoded ids", () => {
      const url = `${COLLAB_ASSET_SCHEME}://doc/${encodeURIComponent(
        "doc with space"
      )}/asset/${encodeURIComponent("a/b")}`;
      expect(parseCollabAssetUrl(url)).toEqual({
        documentId: "doc with space",
        assetId: "a/b",
      });
    });

    it("rejects a different scheme", () => {
      expect(
        parseCollabAssetUrl("https://doc/doc-123/asset/asset-abc")
      ).toBeNull();
    });

    it("rejects a wrong host", () => {
      expect(
        parseCollabAssetUrl(
          `${COLLAB_ASSET_SCHEME}://other/doc-123/asset/asset-abc`
        )
      ).toBeNull();
    });

    it("rejects a malformed pathname", () => {
      expect(
        parseCollabAssetUrl(
          `${COLLAB_ASSET_SCHEME}://doc/doc-123/foo/asset-abc`
        )
      ).toBeNull();
    });

    it("rejects extra path segments", () => {
      expect(
        parseCollabAssetUrl(
          `${COLLAB_ASSET_SCHEME}://doc/doc-123/asset/asset-abc/extra`
        )
      ).toBeNull();
    });

    it("rejects an empty input", () => {
      expect(parseCollabAssetUrl("")).toBeNull();
    });

    it("rejects garbage that fails URL parsing", () => {
      expect(parseCollabAssetUrl("not a url at all")).toBeNull();
    });
  });

  describe("per-sender registry", () => {
    beforeEach(() => {
      clearCollabAssetRegistry();
    });

    it("registers and unregisters a doc for one sender", () => {
      registerCollabAssetDocument("org-1", "doc-1", SENDER_A);
      expect(
        isCollabAssetDocumentRegisteredForSender(SENDER_A, "org-1", "doc-1")
      ).toBe(true);
      unregisterCollabAssetDocument("doc-1", SENDER_A);
      expect(
        isCollabAssetDocumentRegisteredForSender(SENDER_A, "org-1", "doc-1")
      ).toBe(false);
    });

    it("scopes per sender: window A registering does NOT authorize window B", () => {
      registerCollabAssetDocument("org-1", "doc-1", SENDER_A);
      expect(
        isCollabAssetDocumentRegisteredForSender(SENDER_A, "org-1", "doc-1")
      ).toBe(true);
      expect(
        isCollabAssetDocumentRegisteredForSender(SENDER_B, "org-1", "doc-1")
      ).toBe(false);
    });

    it("rejects orgId mismatch within a sender", () => {
      registerCollabAssetDocument("org-1", "doc-1", SENDER_A);
      expect(
        isCollabAssetDocumentRegisteredForSender(SENDER_A, "org-2", "doc-1")
      ).toBe(false);
    });

    it("refcounts within a sender so two opens require two closes", () => {
      registerCollabAssetDocument("org-1", "doc-1", SENDER_A);
      registerCollabAssetDocument("org-1", "doc-1", SENDER_A);
      unregisterCollabAssetDocument("doc-1", SENDER_A);
      expect(
        isCollabAssetDocumentRegisteredForSender(SENDER_A, "org-1", "doc-1")
      ).toBe(true);
      unregisterCollabAssetDocument("doc-1", SENDER_A);
      expect(
        isCollabAssetDocumentRegisteredForSender(SENDER_A, "org-1", "doc-1")
      ).toBe(false);
    });

    it("does not bleed refcounts across senders (B's open does not affect A's count)", () => {
      registerCollabAssetDocument("org-1", "doc-1", SENDER_A);
      registerCollabAssetDocument("org-1", "doc-1", SENDER_B);
      unregisterCollabAssetDocument("doc-1", SENDER_A);
      expect(
        isCollabAssetDocumentRegisteredForSender(SENDER_A, "org-1", "doc-1")
      ).toBe(false);
      expect(
        isCollabAssetDocumentRegisteredForSender(SENDER_B, "org-1", "doc-1")
      ).toBe(true);
    });

    it("clearCollabAssetSender drops every entry for that sender only", () => {
      registerCollabAssetDocument("org-1", "doc-1", SENDER_A);
      registerCollabAssetDocument("org-1", "doc-2", SENDER_A);
      registerCollabAssetDocument("org-1", "doc-1", SENDER_B);
      clearCollabAssetSender(SENDER_A);
      expect(
        isCollabAssetDocumentRegisteredForSender(SENDER_A, "org-1", "doc-1")
      ).toBe(false);
      expect(
        isCollabAssetDocumentRegisteredForSender(SENDER_A, "org-1", "doc-2")
      ).toBe(false);
      expect(
        isCollabAssetDocumentRegisteredForSender(SENDER_B, "org-1", "doc-1")
      ).toBe(true);
    });

    it("ignores extra unregisters past zero", () => {
      registerCollabAssetDocument("org-1", "doc-1", SENDER_A);
      unregisterCollabAssetDocument("doc-1", SENDER_A);
      unregisterCollabAssetDocument("doc-1", SENDER_A);
      expect(
        isCollabAssetDocumentRegisteredForSender(SENDER_A, "org-1", "doc-1")
      ).toBe(false);
    });
  });

  describe("process-wide registry (used by protocol.handle)", () => {
    beforeEach(() => {
      clearCollabAssetRegistry();
    });

    it("returns true if any sender has registered the (orgId, documentId)", () => {
      registerCollabAssetDocument("org-1", "doc-1", SENDER_B);
      // The protocol handler can't see the sender, so it allows the read
      // as long as some window in the process has opened the doc. This
      // is a documented trade-off (see senderRegistry comment).
      expect(isCollabAssetDocumentRegistered("org-1", "doc-1")).toBe(true);
    });

    it("returns false when no sender has registered", () => {
      expect(isCollabAssetDocumentRegistered("org-1", "doc-1")).toBe(false);
    });

    it("returns false on orgId mismatch even with the right docId", () => {
      registerCollabAssetDocument("org-1", "doc-1", SENDER_A);
      expect(isCollabAssetDocumentRegistered("org-2", "doc-1")).toBe(false);
    });
  });

  describe("offline cache resolution", () => {
    beforeEach(() => {
      clearCollabAssetRegistry();
      registerCollabAssetDocument("org-1", "doc-1", SENDER_A);
    });

    it("serves cached bytes without an authorization round trip", async () => {
      const getOrgScopedJwt = vi.fn(async () => {
        throw new Error("must not run");
      });
      const loadAsset = vi.fn(async () => ({
        bytes: new Uint8Array([1, 2, 3]),
        mimeType: "image/png",
        fileName: "cached.png",
      }));
      const handler = createCollabAssetRequestHandler({
        getOrgScopedJwt,
        getCollabHttpUrl: () => "https://sync.invalid",
        getAccountId: () => "account-1",
        assetStore: {
          loadAsset,
          cacheAsset: vi.fn(async () => undefined),
        },
      });

      const response = await handler(
        new Request(`${COLLAB_ASSET_SCHEME}://doc/doc-1/asset/asset-1`)
      );

      expect(response.status).toBe(200);
      expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([
        1, 2, 3,
      ]);
      expect(getOrgScopedJwt).not.toHaveBeenCalled();
    });
  });

  describe("upstream read path", () => {
    const SERVED_BYTES = new Uint8Array([9, 8, 7]);

    function handlerWithoutCache() {
      return createCollabAssetRequestHandler({
        getOrgScopedJwt: vi.fn(async () => "jwt-token"),
        getCollabHttpUrl: () => "https://sync.invalid",
        // No accountId => no cache identity, so every read hits upstream.
        getAccountId: () => null,
      });
    }

    beforeEach(() => {
      netFetch.mockReset();
      clearCollabAssetRegistry();
      registerCollabAssetDocument("org-1", "doc-1", SENDER_A);
    });

    it("serves the plaintext the server decrypted, with its filename", async () => {
      netFetch.mockResolvedValue(
        new Response(SERVED_BYTES, {
          status: 200,
          headers: {
            "X-Collab-Asset-Format": "plaintext.v1",
            "X-Collab-Asset-Stored-Format": "server-dek-aes-gcm.v1",
            "X-Collab-Asset-Mime-Type": "image/png",
            "X-Collab-Asset-File-Name": encodeURIComponent("holiday photo.png"),
          },
        })
      );

      const response = await handlerWithoutCache()(
        new Request(`${COLLAB_ASSET_SCHEME}://doc/doc-1/asset/asset-1`)
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("image/png");
      expect(response.headers.get("Content-Disposition")).toContain(
        "holiday photo.png"
      );
      expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([
        9, 8, 7,
      ]);
    });

    it("fails closed on a blob the server cannot decode", async () => {
      // A leftover from the retired client-managed lane. Its key is gone, so
      // the only honest outcome is a terminal, typed refusal -- not a retry
      // loop, and not ciphertext handed to an <img> tag.
      netFetch.mockResolvedValue(
        new Response(JSON.stringify({ code: "asset_format_unreadable" }), {
          status: 409,
          headers: {
            "X-Collab-Asset-Error-Code": "asset_format_unreadable",
            "X-Collab-Asset-Stored-Format": "legacy-client-aes-gcm.v1",
          },
        })
      );

      const response = await handlerWithoutCache()(
        new Request(`${COLLAB_ASSET_SCHEME}://doc/doc-1/asset/asset-1`)
      );

      expect(response.status).toBe(415);
      expect(response.headers.get("X-Collab-Asset-Error-Code")).toBe(
        "asset_format_unreadable"
      );
      expect(response.headers.get("X-Collab-Asset-Stored-Format")).toBe(
        "legacy-client-aes-gcm.v1"
      );
      await expect(response.text()).resolves.toContain(
        "organization key that is no longer in use"
      );
    });

    it("refuses a 200 whose body is not the plaintext this build can render", async () => {
      // A server ahead of this build. The bytes would otherwise go straight to
      // an <img> tag on the strength of the status code alone.
      netFetch.mockResolvedValue(
        new Response(SERVED_BYTES, {
          status: 200,
          headers: {
            "X-Collab-Asset-Format": "envelope-per-blob.v1",
            "X-Collab-Asset-Stored-Format": "envelope-per-blob.v1",
          },
        })
      );

      const response = await handlerWithoutCache()(
        new Request(`${COLLAB_ASSET_SCHEME}://doc/doc-1/asset/asset-1`)
      );

      expect(response.status).toBe(415);
      expect(response.headers.get("X-Collab-Asset-Error-Code")).toBe(
        "asset_format_unreadable"
      );
      await expect(response.text()).resolves.toContain("unsupported format");
    });

    it("reports a real upstream failure as a bad gateway, not a format problem", async () => {
      netFetch.mockResolvedValue(new Response("boom", { status: 500 }));

      const response = await handlerWithoutCache()(
        new Request(`${COLLAB_ASSET_SCHEME}://doc/doc-1/asset/asset-1`)
      );

      expect(response.status).toBe(502);
    });

    it("returns a terminal offline response instead of hanging", async () => {
      netFetch.mockRejectedValue(new Error("offline"));

      const response = await handlerWithoutCache()(
        new Request(`${COLLAB_ASSET_SCHEME}://doc/doc-1/asset/asset-1`)
      );

      expect(response.status).toBe(503);
    });
  });
});
