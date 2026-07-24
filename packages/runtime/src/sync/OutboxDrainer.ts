import * as Y from "yjs";
import type {
  LocalReplicaIdentity,
  LocalReplicaOutboxEntry,
  LocalReplicaPendingOutbox,
  LocalReplicaStore,
} from "./LocalReplicaStore";

export interface OutboxDrainBatch {
  identity: LocalReplicaIdentity;
  documentType: string;
  batchId: string;
  batchIds: string[];
  update: Uint8Array;
}

export type OutboxDrainSendResult =
  | { status: "acknowledged"; sequence: number }
  | { status: "rejected"; errorCode: string };

export interface OutboxDrainTransport {
  send(batch: OutboxDrainBatch): Promise<OutboxDrainSendResult>;
  close?(): void | Promise<void>;
}

export interface OutboxDrainerOptions {
  store: LocalReplicaStore;
  createTransport: (
    identity: LocalReplicaIdentity
  ) => Promise<OutboxDrainTransport>;
  isLiveProviderAttached?: (identity: LocalReplicaIdentity) => boolean;
}

export interface OutboxDrainResult {
  documentsExamined: number;
  batchesUploaded: number;
  rejectedBatches: number;
}

export class OutboxWriteRejectedError extends Error {
  constructor(readonly errorCode: string, message?: string) {
    super(message ?? errorCode);
    this.name = "OutboxWriteRejectedError";
  }
}

const CONFIRMED_REVOCATION_CODES = new Set([
  "forbidden",
  "membership_revoked",
  "authorization_revoked",
  "access_revoked",
  "not_a_member",
  "document_access_revoked",
]);

/** Unknown and write-barrier codes are retryable by design. */
export function isConfirmedOutboxRevocationCode(errorCode: string): boolean {
  return CONFIRMED_REVOCATION_CODES.has(errorCode);
}

function identityKey(identity: LocalReplicaIdentity): string {
  return `${identity.accountId}\u0000${identity.orgId}\u0000${identity.documentId}`;
}

function sortEntries(entries: LocalReplicaOutboxEntry[]): LocalReplicaOutboxEntry[] {
  return [...entries].sort(
    (left, right) =>
      left.createdAt - right.createdAt ||
      left.batchId.localeCompare(right.batchId)
  );
}

/**
 * Transport-only durable outbox replay. It never constructs a Y.Doc, applies
 * remote state, or advances a replica cursor. Y.mergeUpdates only combines
 * update bytes and does not materialize document state.
 */
export class OutboxDrainer {
  private readonly store: LocalReplicaStore;
  private readonly createTransport: OutboxDrainerOptions["createTransport"];
  private readonly isLiveProviderAttached: NonNullable<
    OutboxDrainerOptions["isLiveProviderAttached"]
  >;
  private activeRun: Promise<OutboxDrainResult> | null = null;
  private readonly yieldedIdentities = new Set<string>();
  private readonly activeTransports = new Map<string, OutboxDrainTransport>();
  private readonly documentRuns = new Map<string, Promise<void>>();

  constructor(options: OutboxDrainerOptions) {
    this.store = options.store;
    this.createTransport = options.createTransport;
    this.isLiveProviderAttached =
      options.isLiveProviderAttached ?? (() => false);
  }

  drainOnce(accountId?: string): Promise<OutboxDrainResult> {
    if (this.activeRun) return this.activeRun;
    this.activeRun = this.run(accountId).finally(() => {
      this.activeRun = null;
    });
    return this.activeRun;
  }

  /** Stops and settles a document drain before a live provider may attach. */
  async yieldToLiveProvider(identity: LocalReplicaIdentity): Promise<void> {
    const key = identityKey(identity);
    this.yieldedIdentities.add(key);
    // Once send() has begun, completion is the only way to know whether the
    // server accepted the bytes. Wait for its durable acknowledgement instead
    // of creating an ambiguous resend before server dedupe is deployed.
    await this.documentRuns.get(key);
  }

  resumeAfterLiveProvider(identity: LocalReplicaIdentity): void {
    this.yieldedIdentities.delete(identityKey(identity));
  }

  private shouldYield(identity: LocalReplicaIdentity): boolean {
    return (
      this.yieldedIdentities.has(identityKey(identity)) ||
      this.isLiveProviderAttached(identity)
    );
  }

  private async run(accountId?: string): Promise<OutboxDrainResult> {
    const result: OutboxDrainResult = {
      documentsExamined: 0,
      batchesUploaded: 0,
      rejectedBatches: 0,
    };
    // Metadata-only enumeration avoids decrypting rows for attached/skipped docs.
    const pending = await this.store.listPendingOutboxes(accountId);

    for (const document of pending) {
      result.documentsExamined += 1;
      if (this.shouldYield(document.identity)) continue;
      const key = identityKey(document.identity);
      const work = this.drainDocument(document, result);
      this.documentRuns.set(key, work);
      try {
        await work;
      } finally {
        if (this.documentRuns.get(key) === work) this.documentRuns.delete(key);
      }
    }
    return result;
  }

  private async drainDocument(
    document: LocalReplicaPendingOutbox,
    result: OutboxDrainResult
  ): Promise<void> {
    const key = identityKey(document.identity);
    let transport: OutboxDrainTransport | null = null;
    let batchIds: string[] = [];
    try {
      const entries = sortEntries(await this.store.loadOutbox(document.identity));
      if (this.shouldYield(document.identity)) return;

      const inflight = entries.filter((entry) => entry.state === "inflight");
      const replayEntries =
        inflight.length > 0
          ? inflight
          : entries.filter((entry) => entry.state === "queued");
      if (replayEntries.length === 0) return;
      batchIds = replayEntries.map((entry) => entry.batchId);

      if (inflight.length === 0) {
        const claimed = await this.store.claimOutboxBatch(
          document.identity,
          batchIds
        );
        if (!claimed) return;
      }
      if (this.shouldYield(document.identity)) return;

      transport = await this.createTransport(document.identity);
      this.activeTransports.set(key, transport);
      if (this.shouldYield(document.identity)) return;

      const sendResult = await transport.send({
        identity: document.identity,
        documentType: document.documentType,
        batchId: batchIds[0],
        batchIds,
        update: Y.mergeUpdates(replayEntries.map((entry) => entry.update)),
      });
      if (sendResult.status === "rejected") {
        if (isConfirmedOutboxRevocationCode(sendResult.errorCode)) {
          await this.store.setOutboxState(
            document.identity,
            batchIds,
            "rejected",
            sendResult.errorCode
          );
          result.rejectedBatches += 1;
        } else {
          await this.store.recordOutboxError(
            document.identity,
            batchIds,
            sendResult.errorCode
          );
        }
        return;
      }
      await this.store.acknowledgeOutbox(
        document.identity,
        batchIds,
        sendResult.sequence
      );
      result.batchesUploaded += 1;
    } catch (error) {
      if (batchIds.length === 0) throw error;
      const errorCode =
        error instanceof OutboxWriteRejectedError
          ? error.errorCode
          : error instanceof Error
            ? error.message
            : String(error);
      if (isConfirmedOutboxRevocationCode(errorCode)) {
        await this.store.setOutboxState(
          document.identity,
          batchIds,
          "rejected",
          errorCode
        );
        result.rejectedBatches += 1;
      } else {
        await this.store.recordOutboxError(
          document.identity,
          batchIds,
          errorCode
        );
      }
    } finally {
      if (this.activeTransports.get(key) === transport) {
        this.activeTransports.delete(key);
      }
      await transport?.close?.();
    }
  }
}
