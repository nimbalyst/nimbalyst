import type {
  CollabAssetIdentity,
  LoadedCollabAsset,
  PendingCollabAssetUpload,
} from "./CollabAssetStore";

// Keep in lockstep with runtime OutboxDrainer. Unknown/write-barrier errors
// stay retryable; only these server-confirmed access changes freeze bytes.
const CONFIRMED_REVOCATION_CODES = new Set([
  "forbidden",
  "membership_revoked",
  "authorization_revoked",
  "access_revoked",
  "not_a_member",
  "document_access_revoked",
]);

function isConfirmedOutboxRevocationCode(errorCode: string): boolean {
  return CONFIRMED_REVOCATION_CODES.has(errorCode);
}

const TERMINAL_AFTER_RETRY_CODES = new Set([
  "http_404",
  "document_not_found",
]);

/**
 * Refusals no retry can fix. The server rejected the request on its own terms,
 * so the same bytes with the same headers will be rejected again forever;
 * parking on the first attempt keeps a permanently-bad asset from occupying the
 * drain lane every 30 seconds for the life of the install.
 *
 * `http_400` covers a payload the server's boundary validation refuses (an
 * over-long filename, an unsupported wire format). `http_413` is an oversize
 * asset. `asset_format_unreadable` is a blob whose stored format this server
 * cannot decode. Transport errors and 5xx stay retryable -- those are the ones
 * that come back on their own.
 */
const TERMINAL_ON_FIRST_ATTEMPT_CODES = new Set([
  "http_400",
  "http_413",
  "asset_format_unreadable",
]);

const DEFAULT_BACKOFF_MS = 30_000;
const DEFAULT_MAX_BACKOFF_MS = 60 * 60_000;
const DEFAULT_TERMINAL_ATTEMPT_CAP = 3;

function structuredErrorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "errorCode" in error &&
    typeof error.errorCode === "string"
  ) {
    return error.errorCode;
  }
  return "transport_error";
}

export type CollabAssetUploadResult =
  | { status: "uploaded" }
  | { status: "rejected"; errorCode: string };

export interface CollabAssetUploadTransport {
  upload(asset: LoadedCollabAsset): Promise<CollabAssetUploadResult>;
}

interface AssetOutboxStore {
  listPendingUploads(accountId?: string): Promise<PendingCollabAssetUpload[]>;
  claimUpload(identity: CollabAssetIdentity): Promise<boolean>;
  loadAsset(identity: CollabAssetIdentity): Promise<LoadedCollabAsset | null>;
  markUploaded(identity: CollabAssetIdentity): Promise<void>;
  recordUploadError(
    identity: CollabAssetIdentity,
    errorCode: string,
    rejected: boolean,
    nextAttemptAt: number | null
  ): Promise<void>;
}

export interface CollabAssetOutboxDrainerOptions {
  now?: () => number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  terminalAttemptCap?: number;
}

export interface CollabAssetDrainResult {
  assetsExamined: number;
  assetsUploaded: number;
  rejectedAssets: number;
}

/** Transport-only asset replay. It never opens or mutates a Y.Doc. */
export class CollabAssetOutboxDrainer {
  private readonly activeRuns = new Map<string, Promise<CollabAssetDrainResult>>();
  private readonly now: () => number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly terminalAttemptCap: number;

  constructor(
    private readonly store: AssetOutboxStore,
    private readonly transport: CollabAssetUploadTransport,
    options: CollabAssetOutboxDrainerOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.baseBackoffMs = options.baseBackoffMs ?? DEFAULT_BACKOFF_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.terminalAttemptCap =
      options.terminalAttemptCap ?? DEFAULT_TERMINAL_ATTEMPT_CAP;
  }

  drainOnce(accountId?: string): Promise<CollabAssetDrainResult> {
    const runKey = accountId ?? "*";
    const activeRun = this.activeRuns.get(runKey);
    if (activeRun) return activeRun;
    const run = this.run(accountId).finally(() => {
      if (this.activeRuns.get(runKey) === run) this.activeRuns.delete(runKey);
    });
    this.activeRuns.set(runKey, run);
    return run;
  }

  private nextAttemptAt(attemptCount: number): number {
    const exponent = Math.max(0, attemptCount - 1);
    return (
      this.now() +
      Math.min(this.maxBackoffMs, this.baseBackoffMs * 2 ** exponent)
    );
  }

  private shouldPark(errorCode: string, attemptCount: number): boolean {
    return (
      isConfirmedOutboxRevocationCode(errorCode) ||
      TERMINAL_ON_FIRST_ATTEMPT_CODES.has(errorCode) ||
      (TERMINAL_AFTER_RETRY_CODES.has(errorCode) &&
        attemptCount >= this.terminalAttemptCap)
    );
  }

  private async run(accountId?: string): Promise<CollabAssetDrainResult> {
    const result: CollabAssetDrainResult = {
      assetsExamined: 0,
      assetsUploaded: 0,
      rejectedAssets: 0,
    };
    const pending = await this.store.listPendingUploads(accountId);
    for (const item of pending) {
      if (item.nextAttemptAt !== null && item.nextAttemptAt > this.now()) {
        continue;
      }
      result.assetsExamined += 1;
      if (
        item.uploadState === "queued" &&
        !(await this.store.claimUpload(item.identity))
      ) {
        continue;
      }
      const asset = await this.store.loadAsset(item.identity);
      if (!asset || asset.uploadState !== "inflight") continue;
      try {
        const upload = await this.transport.upload(asset);
        if (upload.status === "uploaded") {
          await this.store.markUploaded(item.identity);
          result.assetsUploaded += 1;
          continue;
        }
        const rejected = this.shouldPark(
          upload.errorCode,
          asset.attemptCount
        );
        await this.store.recordUploadError(
          item.identity,
          upload.errorCode,
          rejected,
          rejected ? null : this.nextAttemptAt(asset.attemptCount)
        );
        if (rejected) result.rejectedAssets += 1;
      } catch (error) {
        const errorCode = structuredErrorCode(error);
        const rejected = this.shouldPark(errorCode, asset.attemptCount);
        await this.store.recordUploadError(
          item.identity,
          errorCode,
          rejected,
          rejected ? null : this.nextAttemptAt(asset.attemptCount)
        );
        if (rejected) result.rejectedAssets += 1;
      }
    }
    return result;
  }
}
