import { net } from "electron";
import {
  CollabAssetOutboxDrainer,
  type CollabAssetUploadTransport,
} from "./CollabAssetOutboxDrainer";
import { getCollabAssetStore } from "./CollabAssetStore";
import { encryptAndUploadCollabAsset } from "./CollabAssetUploader";
import { getCollabSyncHttpUrl } from "../utils/collabSyncUrl";
import { getPersonalUserId, onAuthStateChange } from "./StytchAuthService";
import { onNetworkAvailable } from "./NetworkAvailability";
import { logger } from "../utils/logger";

const PERIODIC_DRAIN_MS = 30_000;

class ElectronCollabAssetUploadTransport implements CollabAssetUploadTransport {
  async upload(asset: Parameters<CollabAssetUploadTransport["upload"]>[0]) {
    let result = await encryptAndUploadCollabAsset({
      orgId: asset.identity.orgId,
      documentId: asset.identity.documentId,
      assetId: asset.identity.assetId,
      fileBytes: asset.bytes.buffer.slice(
        asset.bytes.byteOffset,
        asset.bytes.byteOffset + asset.bytes.byteLength
      ) as ArrayBuffer,
      mimeType: asset.mimeType,
      fileName: asset.fileName,
      syncHttpUrl: getCollabSyncHttpUrl(),
    });
    if (
      !result.success &&
      (result.statusCode === 401 || result.statusCode === 403)
    ) {
      result = await encryptAndUploadCollabAsset({
        orgId: asset.identity.orgId,
        documentId: asset.identity.documentId,
        assetId: asset.identity.assetId,
        fileBytes: asset.bytes.buffer.slice(
          asset.bytes.byteOffset,
          asset.bytes.byteOffset + asset.bytes.byteLength
        ) as ArrayBuffer,
        mimeType: asset.mimeType,
        fileName: asset.fileName,
        syncHttpUrl: getCollabSyncHttpUrl(),
        forceRefreshJwt: true,
      });
    }
    if (result.success) return { status: "uploaded" as const };
    return {
      status: "rejected" as const,
      // A 403 after a forced exchange is confirmed access loss. Every other
      // result remains retryable through the shared outbox classification.
      errorCode: result.statusCode === 403 ? "forbidden" : result.errorCode,
    };
  }
}

export class CollabAssetOutboxDrainCoordinator {
  private readonly drainer = new CollabAssetOutboxDrainer(
    getCollabAssetStore(),
    new ElectronCollabAssetUploadTransport()
  );
  private periodicTimer: ReturnType<typeof setInterval> | null = null;
  private unsubscribeNetwork: (() => void) | null = null;
  private unsubscribeAuth: (() => void) | null = null;

  start(): void {
    if (this.periodicTimer) return;
    this.unsubscribeNetwork = onNetworkAvailable(() =>
      this.trigger("network-restored")
    );
    this.unsubscribeAuth = onAuthStateChange((state) => {
      if (state.isAuthenticated) this.trigger("auth-restored");
    });
    this.periodicTimer = setInterval(
      () => this.trigger("periodic"),
      PERIODIC_DRAIN_MS
    );
    this.trigger("startup");
  }

  stop(): void {
    if (this.periodicTimer) clearInterval(this.periodicTimer);
    this.periodicTimer = null;
    this.unsubscribeNetwork?.();
    this.unsubscribeAuth?.();
    this.unsubscribeNetwork = null;
    this.unsubscribeAuth = null;
  }

  trigger(source: string): void {
    if (!net.isOnline()) return;
    const accountId = getPersonalUserId();
    if (!accountId) return;
    const startedAt = Date.now();
    void this.drainer
      .drainOnce(accountId)
      .then((result) => {
        // Only log drains that did work -- the periodic trigger fires every
        // 30s and an idle heartbeat line each time floods main.log.
        if (result.assetsExamined > 0) {
          logger.main.info("[CollabOfflineMetric]", {
            metric: "asset_drain",
            source,
            durationMs: Date.now() - startedAt,
            ...result,
          });
        }
      })
      .catch((error) => {
        logger.main.warn("[CollabAssetOutboxDrainer] Drain failed", {
          source,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }
}

let coordinator: CollabAssetOutboxDrainCoordinator | null = null;

export function getCollabAssetOutboxDrainCoordinator(): CollabAssetOutboxDrainCoordinator {
  coordinator ??= new CollabAssetOutboxDrainCoordinator();
  return coordinator;
}
