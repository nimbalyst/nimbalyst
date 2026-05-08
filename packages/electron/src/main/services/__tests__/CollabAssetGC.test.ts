import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub electron's net.fetch so we can record DELETE calls without
// touching the network. The setup file already mocks `app`, but does
// not export `net`, so we extend the mock here.
vi.mock("electron", async () => {
  const actual = (await vi.importActual<typeof import("electron")>("electron")) as Record<string, unknown>;
  return {
    ...actual,
    net: { fetch: vi.fn() },
  };
});

import { net } from "electron";
import { deleteRemovedAssets } from "../CollabAssetGC";

const HTTP_URL = "https://sync.example";
const JWT = "test-jwt";
const DOC_ID = "doc-target";
const FOREIGN_DOC_ID = "doc-foreign";

function uri(docId: string, assetId: string): string {
  return `collab-asset://doc/${docId}/asset/${assetId}`;
}

describe("CollabAssetGC.deleteRemovedAssets", () => {
  beforeEach(() => {
    vi.mocked(net.fetch).mockReset();
  });

  it("deletes exactly the URIs supplied (no enumeration of server list)", async () => {
    vi.mocked(net.fetch).mockResolvedValue(new Response("", { status: 200 }));

    const result = await deleteRemovedAssets(HTTP_URL, JWT, DOC_ID, [
      uri(DOC_ID, "a1"),
      uri(DOC_ID, "a2"),
    ]);

    expect(result).toEqual({ requested: 2, deleted: 2, failed: 0, skipped: 0 });
    expect(net.fetch).toHaveBeenCalledTimes(2);
    const fetchMock = vi.mocked(net.fetch);
    const url1 = fetchMock.mock.calls[0][0] as string;
    const url2 = fetchMock.mock.calls[1][0] as string;
    expect(url1.endsWith("/api/collab/docs/doc-target/assets/a1")).toBe(true);
    expect(url2.endsWith("/api/collab/docs/doc-target/assets/a2")).toBe(true);
    // Each call was a DELETE
    for (const [, init] of fetchMock.mock.calls) {
      expect((init as RequestInit | undefined)?.method).toBe("DELETE");
    }
  });

  it("skips URIs that target a different document (defense in depth)", async () => {
    vi.mocked(net.fetch).mockResolvedValue(new Response("", { status: 200 }));

    const result = await deleteRemovedAssets(HTTP_URL, JWT, DOC_ID, [
      uri(DOC_ID, "mine"),
      uri(FOREIGN_DOC_ID, "not-mine"),
    ]);

    expect(result).toEqual({ requested: 2, deleted: 1, failed: 0, skipped: 1 });
    expect(net.fetch).toHaveBeenCalledTimes(1);
    const url = vi.mocked(net.fetch).mock.calls[0][0] as string;
    expect(url).toContain("/doc-target/assets/mine");
    expect(url).not.toContain("doc-foreign");
  });

  it("skips garbage URIs", async () => {
    vi.mocked(net.fetch).mockResolvedValue(new Response("", { status: 200 }));

    const result = await deleteRemovedAssets(HTTP_URL, JWT, DOC_ID, [
      "not-a-url",
      "https://example.com/something",
      uri(DOC_ID, "ok"),
    ]);

    expect(result).toEqual({ requested: 3, deleted: 1, failed: 0, skipped: 2 });
    expect(net.fetch).toHaveBeenCalledTimes(1);
  });

  it("does no network calls and returns zeros for an empty list", async () => {
    const result = await deleteRemovedAssets(HTTP_URL, JWT, DOC_ID, []);
    expect(result).toEqual({ requested: 0, deleted: 0, failed: 0, skipped: 0 });
    expect(net.fetch).not.toHaveBeenCalled();
  });

  it("counts failed when the server returns non-OK", async () => {
    vi.mocked(net.fetch).mockResolvedValue(new Response("nope", { status: 500 }));
    const result = await deleteRemovedAssets(HTTP_URL, JWT, DOC_ID, [uri(DOC_ID, "a1")]);
    expect(result).toEqual({ requested: 1, deleted: 0, failed: 1, skipped: 0 });
  });

  it("counts failed when net.fetch throws", async () => {
    vi.mocked(net.fetch).mockRejectedValue(new Error("offline"));
    const result = await deleteRemovedAssets(HTTP_URL, JWT, DOC_ID, [uri(DOC_ID, "a1")]);
    expect(result).toEqual({ requested: 1, deleted: 0, failed: 1, skipped: 0 });
  });

  it("attaches Authorization: Bearer <jwt> to each delete request", async () => {
    vi.mocked(net.fetch).mockResolvedValue(new Response("", { status: 200 }));
    await deleteRemovedAssets(HTTP_URL, JWT, DOC_ID, [uri(DOC_ID, "a1")]);
    const init = vi.mocked(net.fetch).mock.calls[0][1] as RequestInit | undefined;
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${JWT}`);
  });
});
