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
  /** Injectable for tests. */
  now?: () => number;
}

export interface OutboxDrainResult {
  documentsExamined: number;
  batchesUploaded: number;
  rejectedBatches: number;
  /** Documents skipped this pass because their retry backoff had not elapsed. */
  documentsDeferred: number;
  /** Documents that have failed repeatedly and are not converging. */
  stuck: StuckOutboxDocument[];
}

export interface StuckOutboxDocument {
  identity: LocalReplicaIdentity;
  batchCount: number;
  attemptCount: number;
  lastErrorCode: string | null;
  oldestCreatedAt: number | null;
}

/**
 * Retry backoff for a document whose upload keeps failing.
 *
 * The periodic trigger fires every 30s. Without backoff a permanently-failing
 * document is re-uploaded 2,880 times a day — one full WebSocket connect,
 * merge and send per pass — and every one of those passes queues on the same
 * single-lane DB worker as the rest of the app. A document stranded since
 * 2026-08-05 against an HTTP 404 room did exactly that.
 */
export const OUTBOX_RETRY_BASE_MS = 30_000;
export const OUTBOX_RETRY_MAX_MS = 30 * 60_000;
/** Failures before a document is reported as not converging. */
export const OUTBOX_STUCK_ATTEMPTS = 5;

export function outboxRetryDelayMs(attemptCount: number): number {
  if (attemptCount <= 1) return 0;
  const exponent = Math.min(attemptCount - 1, 20);
  return Math.min(OUTBOX_RETRY_BASE_MS * 2 ** (exponent - 1), OUTBOX_RETRY_MAX_MS);
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
  // A role that permits reading but not editing is a settled answer, not a
  // transient one: retrying replays the same refused update on every
  // reconnect, forever, instead of telling the user the document is read-only.
  "document_read_only",
  // A commenter's docUpdate that changed more than the comment threads. The
  // room closes the socket (4009): later updates from that Y.Doc's client
  // depend on the refused one, so a retry can only be refused again.
  "document_comment_update_refused",
  // A commenter's docCompact. Not terminal (the socket stays open), but a
  // commenter can never compact, so retrying is pointless.
  "document_comment_forbidden",
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
  private readonly now: () => number;

  constructor(options: OutboxDrainerOptions) {
    this.store = options.store;
    this.createTransport = options.createTransport;
    this.isLiveProviderAttached =
      options.isLiveProviderAttached ?? (() => false);
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * `respectBackoff` is for the unconditional periodic cadence only. An
   * event-driven trigger — network restored, auth restored, a live provider
   * detaching — is new information that the previous failure may no longer
   * apply, so it always retries immediately.
   */
  drainOnce(
    accountId?: string,
    options?: { respectBackoff?: boolean }
  ): Promise<OutboxDrainResult> {
    if (this.activeRun) return this.activeRun;
    this.activeRun = this.run(accountId, options?.respectBackoff === true).finally(() => {
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

  private async run(
    accountId: string | undefined,
    respectBackoff: boolean
  ): Promise<OutboxDrainResult> {
    const result: OutboxDrainResult = {
      documentsExamined: 0,
      batchesUploaded: 0,
      rejectedBatches: 0,
      documentsDeferred: 0,
      stuck: [],
    };
    // Metadata-only enumeration avoids decrypting rows for attached/skipped
    // docs. `rejected` is a settled answer, so those documents are not
    // enumerated at all rather than re-examined every 30 seconds forever.
    const pending = await this.store.listPendingOutboxes(accountId, {
      states: ["queued", "inflight"],
    });

    for (const document of pending) {
      result.documentsExamined += 1;
      if (this.shouldYield(document.identity)) continue;

      if (document.maxAttemptCount >= OUTBOX_STUCK_ATTEMPTS) {
        result.stuck.push({
          identity: document.identity,
          batchCount: document.queuedCount + document.inflightCount,
          attemptCount: document.maxAttemptCount,
          lastErrorCode: document.lastErrorCode,
          oldestCreatedAt: document.oldestCreatedAt,
        });
      }

      if (respectBackoff && document.lastAttemptAt !== null) {
        const waitUntil =
          document.lastAttemptAt + outboxRetryDelayMs(document.maxAttemptCount);
        if (this.now() < waitUntil) {
          result.documentsDeferred += 1;
          continue;
        }
      }

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
    // `claimOutboxBatch` counts the attempt it starts. A replay of rows that
    // were ALREADY inflight never re-claims, so without this the counter froze
    // at 1 no matter how many times the send failed — which is how a document
    // retried every 30s for 17 days still looked like it had been tried once.
    let attemptAlreadyCounted = false;
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
        attemptAlreadyCounted = true;
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
            sendResult.errorCode,
            { countAttempt: !attemptAlreadyCounted }
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
          errorCode,
          { countAttempt: !attemptAlreadyCounted }
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
