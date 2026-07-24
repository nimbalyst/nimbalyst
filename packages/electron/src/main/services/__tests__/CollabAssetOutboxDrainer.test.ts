import { describe, expect, it, vi } from "vitest";
import {
  CollabAssetOutboxDrainer,
  type CollabAssetUploadTransport,
} from "../CollabAssetOutboxDrainer";
import type {
  CollabAssetIdentity,
  LoadedCollabAsset,
  PendingCollabAssetUpload,
} from "../CollabAssetStore";

const identity: CollabAssetIdentity = {
  accountId: "account-a",
  orgId: "org-a",
  documentId: "document-a",
  assetId: "asset-a",
};

function makeStore() {
  let state: "queued" | "inflight" | "cached" | "rejected" = "queued";
  let errorCode: string | null = null;
  let attemptCount = 0;
  let nextAttemptAt: number | null = null;
  const loaded: LoadedCollabAsset = {
    identity,
    bytes: new Uint8Array([1, 2, 3]),
    mimeType: "image/png",
    fileName: "offline.png",
    uploadState: "queued",
    attemptCount: 0,
    lastErrorCode: null,
    createdAt: 1,
    updatedAt: 1,
  };
  return {
    get state() {
      return state;
    },
    get errorCode() {
      return errorCode;
    },
    get nextAttemptAt() {
      return nextAttemptAt;
    },
    listPendingUploads: vi.fn(
      async (): Promise<PendingCollabAssetUpload[]> =>
        state === "queued" || state === "inflight"
          ? [
              {
                identity,
                uploadState: state,
                attemptCount,
                lastErrorCode: errorCode,
                createdAt: 1,
                nextAttemptAt,
              },
            ]
          : []
    ),
    claimUpload: vi.fn(async () => {
      if (state !== "queued") return false;
      state = "inflight";
      attemptCount += 1;
      nextAttemptAt = null;
      return true;
    }),
    loadAsset: vi.fn(
      async () => ({ ...loaded, uploadState: state, attemptCount } as LoadedCollabAsset)
    ),
    markUploaded: vi.fn(async () => {
      state = "cached";
      errorCode = null;
    }),
    recordUploadError: vi.fn(
      async (
        _identity: CollabAssetIdentity,
        code: string,
        rejected: boolean,
        retryAt: number | null,
      ) => {
        state = rejected ? "rejected" : "queued";
        errorCode = code;
        nextAttemptAt = retryAt;
      }
    ),
  };
}

describe("CollabAssetOutboxDrainer", () => {
  it("uploads a durable queued asset and acknowledges it", async () => {
    const store = makeStore();
    const transport: CollabAssetUploadTransport = {
      upload: vi.fn(async () => ({ status: "uploaded" as const })),
    };
    const drainer = new CollabAssetOutboxDrainer(store, transport);

    const result = await drainer.drainOnce(identity.accountId);

    expect(result).toEqual({
      assetsExamined: 1,
      assetsUploaded: 1,
      rejectedAssets: 0,
    });
    expect(store.state).toBe("cached");
    expect(transport.upload).toHaveBeenCalledWith(
      expect.objectContaining({ identity })
    );
  });

  it("freezes only a confirmed revocation", async () => {
    const store = makeStore();
    const transport: CollabAssetUploadTransport = {
      upload: vi.fn(async () => ({
        status: "rejected" as const,
        errorCode: "forbidden",
      })),
    };
    const drainer = new CollabAssetOutboxDrainer(store, transport);

    await drainer.drainOnce(identity.accountId);

    expect(store.state).toBe("rejected");
    expect(store.errorCode).toBe("forbidden");
  });

  it("keeps transient and write-barrier failures retryable", async () => {
    const store = makeStore();
    const transport: CollabAssetUploadTransport = {
      upload: vi.fn(async () => ({
        status: "rejected" as const,
        errorCode: "write_rejected",
      })),
    };
    const drainer = new CollabAssetOutboxDrainer(store, transport);

    await drainer.drainOnce(identity.accountId);

    expect(store.state).toBe("queued");
    expect(store.errorCode).toBe("write_rejected");
    expect(store.nextAttemptAt).toBeGreaterThan(Date.now());
  });

  it("respects the persisted exponential-backoff schedule", async () => {
    let now = 1_000;
    const store = makeStore();
    const transport: CollabAssetUploadTransport = {
      upload: vi.fn(async () => ({
        status: "rejected" as const,
        errorCode: "http_500",
      })),
    };
    const drainer = new CollabAssetOutboxDrainer(store, transport, {
      now: () => now,
      baseBackoffMs: 30_000,
    });

    await drainer.drainOnce(identity.accountId);
    expect(store.nextAttemptAt).toBe(31_000);
    now = 30_999;
    await drainer.drainOnce(identity.accountId);
    expect(transport.upload).toHaveBeenCalledTimes(1);
    now = 31_000;
    await drainer.drainOnce(identity.accountId);
    expect(transport.upload).toHaveBeenCalledTimes(2);
    expect(store.nextAttemptAt).toBe(91_000);
  });

  it("parks a persistent 404 after the bounded retry cap", async () => {
    let now = 0;
    const store = makeStore();
    const transport: CollabAssetUploadTransport = {
      upload: vi.fn(async () => ({
        status: "rejected" as const,
        errorCode: "http_404",
      })),
    };
    const drainer = new CollabAssetOutboxDrainer(store, transport, {
      now: () => now,
      baseBackoffMs: 10,
      terminalAttemptCap: 3,
    });

    await drainer.drainOnce(identity.accountId);
    now = store.nextAttemptAt!;
    await drainer.drainOnce(identity.accountId);
    now = store.nextAttemptAt!;
    await drainer.drainOnce(identity.accountId);

    expect(transport.upload).toHaveBeenCalledTimes(3);
    expect(store.state).toBe("rejected");
    expect(store.errorCode).toBe("http_404");
    expect(store.nextAttemptAt).toBeNull();
  });

  it("does not classify an unstructured exception by its message", async () => {
    const store = makeStore();
    const transport: CollabAssetUploadTransport = {
      upload: vi.fn(async () => {
        throw new Error("forbidden");
      }),
    };
    const drainer = new CollabAssetOutboxDrainer(store, transport);

    await drainer.drainOnce(identity.accountId);

    expect(store.state).toBe("queued");
    expect(store.errorCode).toBe("transport_error");
  });

  it("keeps concurrent drains isolated by account", async () => {
    const otherIdentity = { ...identity, accountId: "account-b" };
    const resolvers = new Map<string, (result: { status: "uploaded" }) => void>();
    const transport: CollabAssetUploadTransport = {
      upload: vi.fn(
        (asset) =>
          new Promise<{ status: "uploaded" }>((resolve) => {
            resolvers.set(asset.identity.accountId, resolve);
          })
      ),
    };
    const store = {
      listPendingUploads: vi.fn(async (accountId?: string) => [{
        identity: accountId === "account-b" ? otherIdentity : identity,
        uploadState: "queued" as const,
        attemptCount: 0,
        lastErrorCode: null,
        createdAt: 1,
        nextAttemptAt: null,
      }]),
      claimUpload: vi.fn(async () => true),
      loadAsset: vi.fn(async (target: CollabAssetIdentity) => ({
        identity: target,
        bytes: new Uint8Array([1]),
        mimeType: "image/png",
        fileName: "asset.png",
        uploadState: "inflight" as const,
        attemptCount: 1,
        lastErrorCode: null,
        createdAt: 1,
        updatedAt: 1,
      })),
      markUploaded: vi.fn(async () => undefined),
      recordUploadError: vi.fn(async () => undefined),
    };
    const drainer = new CollabAssetOutboxDrainer(store, transport);

    const accountARun = drainer.drainOnce("account-a");
    const accountBRun = drainer.drainOnce("account-b");
    expect(accountARun).not.toBe(accountBRun);
    await vi.waitFor(() => expect(transport.upload).toHaveBeenCalledTimes(2));
    resolvers.get("account-a")!({ status: "uploaded" });
    resolvers.get("account-b")!({ status: "uploaded" });
    await Promise.all([accountARun, accountBRun]);
  });
});
