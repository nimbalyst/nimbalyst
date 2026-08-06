/**
 * The uploader is the single writer of the collab-asset PUT wire format
 * (NIM-2235), and the `collab-asset://` read path plus the collab worker's
 * boundary validation both decode exactly what it emits. Pin the headers here
 * so a change on either side has to break a test rather than a user's image.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();

vi.mock("electron", () => ({
  net: { fetch: (...args: unknown[]) => fetchMock(...args) },
}));

vi.mock("../../utils/logger", () => ({
  logger: { main: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } },
}));

vi.mock("../TeamService", () => ({
  getOrgScopedJwt: vi.fn(async () => "team-jwt"),
}));

import { uploadCollabAsset } from "../CollabAssetUploader";
import {
  COLLAB_ASSET_HEADER_FILE_NAME,
  COLLAB_ASSET_HEADER_MIME,
  COLLAB_ASSET_HEADER_PLAINTEXT_SIZE,
  COLLAB_ASSET_HEADER_WIRE_FORMAT,
  COLLAB_ASSET_WIRE_FORMAT_PLAINTEXT,
  MAX_COLLAB_ASSET_FILE_NAME_LENGTH,
} from "../../../shared/collabAssetFormat";

const BYTES = new TextEncoder().encode("png-bytes").buffer as ArrayBuffer;

function baseParams(overrides: Record<string, unknown> = {}) {
  return {
    orgId: "org-1",
    documentId: "doc-1",
    fileBytes: BYTES,
    mimeType: "image/png",
    fileName: "diagram.png",
    syncHttpUrl: "https://sync.example.com",
    assetId: "asset-1",
    ...overrides,
  };
}

function lastRequestInit(): RequestInit & { headers: Record<string, string> } {
  return fetchMock.mock.calls.at(-1)![1] as RequestInit & {
    headers: Record<string, string>;
  };
}

describe("uploadCollabAsset", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
  });

  it("PUTs the raw bytes and declares the plaintext wire format", async () => {
    const result = await uploadCollabAsset(baseParams());

    expect(result).toEqual({
      success: true,
      assetId: "asset-1",
      uri: "collab-asset://doc/doc-1/asset/asset-1",
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://sync.example.com/api/collab/docs/doc-1/assets/asset-1");
    expect(init.method).toBe("PUT");
    // The body is the file itself. The client holds no key and does no crypto;
    // the server encrypts at rest under the team DEK.
    expect(init.body).toBe(BYTES);

    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(headers[COLLAB_ASSET_HEADER_WIRE_FORMAT]).toBe(
      COLLAB_ASSET_WIRE_FORMAT_PLAINTEXT
    );
    expect(headers[COLLAB_ASSET_HEADER_MIME]).toBe("image/png");
    expect(headers[COLLAB_ASSET_HEADER_PLAINTEXT_SIZE]).toBe(
      String(BYTES.byteLength)
    );
    expect(headers.Authorization).toBe("Bearer team-jwt");
    // No IV: that header is what marks a blob as retired-lane ciphertext, and
    // the server refuses an upload that carries both.
    expect(headers["X-Collab-Asset-Iv"]).toBeUndefined();
  });

  it("percent-encodes a non-ASCII filename so it survives a latin-1 header", async () => {
    await uploadCollabAsset(baseParams({ fileName: "réunion été.png" }));

    const encoded = lastRequestInit().headers[COLLAB_ASSET_HEADER_FILE_NAME];
    expect(encoded).toBe(encodeURIComponent("réunion été.png"));
    expect(decodeURIComponent(encoded)).toBe("réunion été.png");
  });

  it("truncates an over-long filename instead of letting the server 400 the upload", async () => {
    await uploadCollabAsset(baseParams({ fileName: "a".repeat(400) }));

    const decoded = decodeURIComponent(
      lastRequestInit().headers[COLLAB_ASSET_HEADER_FILE_NAME]
    );
    // Losing the tail of a name beats losing the attachment.
    expect(decoded).toHaveLength(MAX_COLLAB_ASSET_FILE_NAME_LENGTH);
  });

  it("falls back to the asset id when the name is empty or only control characters", async () => {
    await uploadCollabAsset(baseParams({ fileName: "\u0000\x07  " }));

    expect(
      decodeURIComponent(lastRequestInit().headers[COLLAB_ASSET_HEADER_FILE_NAME])
    ).toBe("asset-1");
  });

  it("surfaces an HTTP refusal as a structured, status-tagged failure", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 413,
      text: async () => "Asset too large",
    });

    const result = await uploadCollabAsset(baseParams());

    // The outbox drainer classifies on errorCode; `http_413` is terminal there.
    expect(result).toEqual({
      success: false,
      error: "Asset too large",
      errorCode: "http_413",
      statusCode: 413,
    });
  });

  it("reports a transport throw as retryable rather than propagating it", async () => {
    fetchMock.mockRejectedValue(new Error("socket hang up"));

    const result = await uploadCollabAsset(baseParams());

    expect(result).toMatchObject({
      success: false,
      errorCode: "transport_error",
      error: "socket hang up",
    });
  });
});
