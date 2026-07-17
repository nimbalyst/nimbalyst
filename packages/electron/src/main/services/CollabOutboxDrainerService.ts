import { createCipheriv, randomBytes } from "crypto";
import { net } from "electron";
import WebSocket from "ws";
import {
  OutboxDrainer,
  appendSyncClientParams,
  encodeDocumentRoomId,
  type DocServerMessage,
  type LocalReplicaIdentity,
  type OutboxDrainBatch,
  type OutboxDrainTransport,
} from "@nimbalyst/runtime/sync";
import { getCollabDocumentReplicaStore } from "./CollabDocumentReplicaStore";
import { getCollabSyncWsUrl } from "../utils/collabSyncUrl";
import { getOrgScopedJwt } from "./TeamService";
import {
  fetchTeamKeyStatus,
  getOrgKey,
  getOrgKeyFingerprint,
} from "./OrgKeyService";
import {
  getPersonalUserId,
  onAuthStateChange,
} from "./StytchAuthService";
import { onNetworkAvailable } from "./NetworkAvailability";
import { logger } from "../utils/logger";
import {
  OutboxUpgradeRejectedError,
  retryOutboxConnectAfterAuthRejection,
} from "./OutboxTransportAuthRetry";
import { ProviderAttachmentRegistry } from "./ProviderAttachmentRegistry";

const PERIODIC_DRAIN_MS = 30_000;
const ACK_TIMEOUT_MS = 10_000;

async function encryptLegacyUpdate(
  update: Uint8Array,
  key: CryptoKey
): Promise<{ encryptedUpdate: string; iv: string }> {
  const rawKey = Buffer.from(await crypto.subtle.exportKey("raw", key));
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", rawKey, iv);
  const ciphertext = Buffer.concat([cipher.update(update), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    encryptedUpdate: Buffer.concat([ciphertext, authTag]).toString("base64"),
    iv: iv.toString("base64"),
  };
}

class ElectronDocumentOutboxTransport implements OutboxDrainTransport {
  private constructor(
    private readonly socket: WebSocket,
    private readonly serverManaged: boolean,
    private readonly orgKey: CryptoKey | null,
    private readonly orgKeyFingerprint: string | undefined
  ) {}

  static async connect(
    identity: LocalReplicaIdentity
  ): Promise<ElectronDocumentOutboxTransport> {
    return retryOutboxConnectAfterAuthRejection((forceRefresh) =>
      ElectronDocumentOutboxTransport.connectOnce(identity, forceRefresh)
    );
  }

  private static async connectOnce(
    identity: LocalReplicaIdentity,
    forceRefresh: boolean
  ): Promise<ElectronDocumentOutboxTransport> {
    const jwt = await getOrgScopedJwt(identity.orgId, undefined, forceRefresh);
    const keyStatus = await fetchTeamKeyStatus(identity.orgId, jwt);
    const serverManaged = keyStatus.mode === "server-managed";
    const orgKey = serverManaged ? null : await getOrgKey(identity.orgId);
    if (!serverManaged && !orgKey) {
      throw new Error("No org key available for durable outbox drain");
    }
    const roomId = encodeDocumentRoomId(identity.orgId, identity.documentId);
    const url = appendSyncClientParams(
      `${getCollabSyncWsUrl()}/sync/${roomId}?token=${encodeURIComponent(jwt)}`
    );
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error("Outbox drain WebSocket open timed out"));
      }, ACK_TIMEOUT_MS);
      socket.once("open", () => {
        clearTimeout(timeout);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      socket.once("unexpected-response", (_request, response) => {
        clearTimeout(timeout);
        response.resume();
        socket.close();
        reject(new OutboxUpgradeRejectedError(response.statusCode ?? 0));
      });
    });
    return new ElectronDocumentOutboxTransport(
      socket,
      serverManaged,
      orgKey,
      serverManaged
        ? undefined
        : getOrgKeyFingerprint(identity.orgId) ?? undefined
    );
  }

  async send(batch: OutboxDrainBatch) {
    const encrypted = this.serverManaged
      ? {
          encryptedUpdate: Buffer.from(batch.update).toString("base64"),
          iv: "",
        }
      : await encryptLegacyUpdate(batch.update, this.orgKey!);

    return new Promise<
      | { status: "acknowledged"; sequence: number }
      | { status: "rejected"; errorCode: string }
    >((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        this.socket.off("message", onMessage);
        this.socket.off("close", onClose);
        this.socket.off("error", onError);
      };
      const onMessage = (data: WebSocket.RawData) => {
        let message: DocServerMessage;
        try {
          message = JSON.parse(data.toString()) as DocServerMessage;
        } catch {
          return;
        }
        if (
          message.type === "docUpdateAck" &&
          message.clientUpdateId === batch.batchId
        ) {
          cleanup();
          resolve({ status: "acknowledged", sequence: message.sequence });
        } else if (
          message.type === "error" &&
          message.clientUpdateId === batch.batchId
        ) {
          cleanup();
          resolve({ status: "rejected", errorCode: message.code });
        }
      };
      const onClose = () => {
        cleanup();
        reject(
          new Error("Outbox drain WebSocket closed before acknowledgement")
        );
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Outbox drain acknowledgement timed out"));
      }, ACK_TIMEOUT_MS);
      this.socket.on("message", onMessage);
      this.socket.once("close", onClose);
      this.socket.once("error", onError);
      this.socket.send(
        JSON.stringify({
          type: "docUpdate",
          encryptedUpdate: encrypted.encryptedUpdate,
          iv: encrypted.iv,
          clientUpdateId: batch.batchId,
          orgKeyFingerprint: this.orgKeyFingerprint,
        })
      );
    });
  }

  close(): void {
    this.socket.close();
  }
}

export class CollabOutboxDrainCoordinator {
  private readonly providerAttachments = new ProviderAttachmentRegistry();
  private readonly drainer = new OutboxDrainer({
    store: getCollabDocumentReplicaStore(),
    createTransport: (identity) =>
      ElectronDocumentOutboxTransport.connect(identity),
    isLiveProviderAttached: (identity) => this.isLiveProviderAttached(identity),
  });
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
    for (const identity of this.providerAttachments.clear()) {
      this.drainer.resumeAfterLiveProvider(identity);
    }
  }

  async setProviderAttached(
    senderId: number,
    identity: LocalReplicaIdentity,
    attachmentId: string,
    attached: boolean
  ): Promise<void> {
    if (attached) {
      this.providerAttachments.attach(senderId, identity, attachmentId);
      // Mark attached first, then abort/settle the headless sender. The IPC
      // attach handshake does not resolve until the durable claim is safe for
      // the live provider to resume.
      await this.drainer.yieldToLiveProvider(identity);
    } else {
      this.providerAttachments.detach(senderId, identity, attachmentId);
      if (!this.isLiveProviderAttached(identity)) {
        this.drainer.resumeAfterLiveProvider(identity);
        this.trigger("provider-detached");
      }
    }
  }

  clearSender(senderId: number): void {
    const identities = this.providerAttachments.clearSender(senderId);
    if (identities.length === 0) return;
    for (const identity of identities) {
      if (!this.isLiveProviderAttached(identity)) {
        this.drainer.resumeAfterLiveProvider(identity);
      }
    }
    this.trigger("renderer-destroyed");
  }

  getAttachedSenderIds(
    identity: LocalReplicaIdentity,
    excludeSenderId?: number
  ): number[] {
    return this.providerAttachments.attachedSenderIds(identity, excludeSenderId);
  }

  isProviderAttached(identity: LocalReplicaIdentity): boolean {
    return this.providerAttachments.isAttached(identity);
  }

  private isLiveProviderAttached(identity: LocalReplicaIdentity): boolean {
    return this.providerAttachments.isAttached(identity);
  }

  private trigger(source: string): void {
    if (!net.isOnline()) return;
    const accountId = getPersonalUserId();
    if (!accountId) {
      logger.main.error(
        "[CollabOutboxDrainer] Personal account identity unavailable; refusing org-scoped fallback",
        { source }
      );
      return;
    }
    const startedAt = Date.now();
    void this.drainer
      .drainOnce(accountId)
      .then((result) => {
        // Only log drains that did work -- the periodic trigger fires every
        // 30s and an idle heartbeat line each time floods main.log.
        if (result.documentsExamined > 0 || result.batchesUploaded > 0 || result.rejectedBatches > 0) {
          logger.main.info("[CollabOfflineMetric]", {
            metric: "background_drain",
            source,
            durationMs: Date.now() - startedAt,
            documentsDrained: result.documentsExamined,
            batchesUploaded: result.batchesUploaded,
            rejectedBatches: result.rejectedBatches,
          });
        }
        if (result.batchesUploaded > 0 || result.rejectedBatches > 0) {
          logger.main.info("[CollabOutboxDrainer] Drain completed", {
            source,
            ...result,
          });
        }
      })
      .catch((error) => {
        logger.main.warn("[CollabOutboxDrainer] Drain failed", {
          source,
          error,
        });
      });
  }
}

let coordinator: CollabOutboxDrainCoordinator | null = null;

export function getCollabOutboxDrainCoordinator(): CollabOutboxDrainCoordinator {
  coordinator ??= new CollabOutboxDrainCoordinator();
  return coordinator;
}
