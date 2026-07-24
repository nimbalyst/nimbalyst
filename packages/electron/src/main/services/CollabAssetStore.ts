import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "crypto";
import type { LocalReplicaIdentity } from "@nimbalyst/runtime/sync";
import type { AppDatabase } from "../database/PGLiteDatabaseWorker";
import { database } from "../database/PGLiteDatabaseWorker";
import { toMillis } from "../utils/timestampUtils";
import { logger } from "../utils/logger";
import {
  SafeStorageReplicaDeviceKeyProvider,
  type ReplicaDeviceKeyProvider,
} from "./CollabDocumentReplicaStore";

const ENCODING_VERSION = 1;
export const DEFAULT_COLLAB_ASSET_ACCOUNT_BUDGET_BYTES = 256 * 1024 * 1024;

export type CollabAssetDeviceKeyProvider = ReplicaDeviceKeyProvider;
export type CollabAssetUploadState =
  | "cached"
  | "queued"
  | "inflight"
  | "rejected";

export interface CollabAssetIdentity extends LocalReplicaIdentity {
  assetId: string;
}

export interface PutCollabAssetInput {
  identity: CollabAssetIdentity;
  bytes: Uint8Array;
  mimeType: string;
  fileName: string;
}

export interface LoadedCollabAsset extends PutCollabAssetInput {
  uploadState: CollabAssetUploadState;
  attemptCount: number;
  lastErrorCode: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface PendingCollabAssetUpload {
  identity: CollabAssetIdentity;
  uploadState: "queued" | "inflight";
  attemptCount: number;
  lastErrorCode: string | null;
  createdAt: number;
  nextAttemptAt: number | null;
}

interface AssetDatabase {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  runTransaction(
    statements: Array<{ sql: string; params?: unknown[] }>
  ): Promise<void>;
}

interface AssetRow {
  account_id: string;
  org_id: string;
  document_id: string;
  asset_id: string;
  encrypted_asset: Uint8Array;
  encoding_version: number;
  asset_checksum: string;
  upload_state: CollabAssetUploadState;
  attempt_count: number;
  last_error_code: string | null;
  created_at: unknown;
  updated_at: unknown;
  next_attempt_at: unknown;
}

interface AssetUsageRow {
  org_id: string;
  document_id: string;
  asset_id: string;
  encrypted_bytes: number | bigint | string;
  last_accessed_at: unknown;
  evictable: boolean | number;
}

interface CollabAssetStorageUsage {
  encryptedBytes: number;
  assets: Array<{
    identity: CollabAssetIdentity;
    encryptedBytes: number;
    lastAccessedAt: number;
    evictable: boolean;
  }>;
}

function checksum(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function aad(identity: CollabAssetIdentity, encodingVersion: number): Buffer {
  return Buffer.from(
    JSON.stringify([
      "nimbalyst-collab-replica",
      identity.accountId,
      identity.orgId,
      identity.documentId,
      identity.assetId,
      "asset",
      encodingVersion,
    ])
  );
}

function encodeAsset(input: PutCollabAssetInput): Buffer {
  const metadata = Buffer.from(
    JSON.stringify({
      mimeType: input.mimeType || "application/octet-stream",
      fileName: input.fileName || input.identity.assetId,
    })
  );
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(metadata.byteLength, 0);
  return Buffer.concat([header, metadata, Buffer.from(input.bytes)]);
}

function decodeAsset(
  identity: CollabAssetIdentity,
  payload: Uint8Array
): PutCollabAssetInput {
  const bytes = Buffer.from(payload);
  if (bytes.byteLength < 4) throw new Error("invalid cached asset payload");
  const metadataLength = bytes.readUInt32BE(0);
  if (metadataLength > bytes.byteLength - 4)
    throw new Error("invalid cached asset metadata length");
  const metadata = JSON.parse(
    bytes.subarray(4, 4 + metadataLength).toString("utf8")
  ) as {
    mimeType?: unknown;
    fileName?: unknown;
  };
  if (
    typeof metadata.mimeType !== "string" ||
    typeof metadata.fileName !== "string"
  ) {
    throw new Error("invalid cached asset metadata");
  }
  return {
    identity,
    mimeType: metadata.mimeType,
    fileName: metadata.fileName,
    bytes: new Uint8Array(bytes.subarray(4 + metadataLength)),
  };
}

export class CollabAssetStore {
  private readonly accountUsageEstimates = new Map<string, number>();
  private readonly accountAdmissionTails = new Map<string, Promise<void>>();

  constructor(
    private readonly db: AssetDatabase = database as AppDatabase,
    private readonly keyProvider: CollabAssetDeviceKeyProvider = new SafeStorageReplicaDeviceKeyProvider(),
    private readonly accountBudgetBytes = DEFAULT_COLLAB_ASSET_ACCOUNT_BUDGET_BYTES
  ) {}

  async cacheAsset(input: PutCollabAssetInput): Promise<void> {
    await this.put(input, "cached");
  }

  async enqueueUpload(input: PutCollabAssetInput): Promise<void> {
    await this.put(input, "queued");
  }

  async loadAsset(
    identity: CollabAssetIdentity
  ): Promise<LoadedCollabAsset | null> {
    const result = await this.db.query<AssetRow>(
      `SELECT account_id, org_id, document_id, asset_id, encrypted_asset,
              encoding_version, asset_checksum, upload_state, attempt_count,
              last_error_code, created_at, updated_at, next_attempt_at
       FROM collab_document_assets
       WHERE account_id = $1 AND org_id = $2 AND document_id = $3 AND asset_id = $4`,
      this.identityParams(identity)
    );
    const row = result.rows[0];
    if (!row) return null;
    const plaintext = await this.decrypt(
      identity,
      row.encoding_version,
      row.encrypted_asset,
      row.asset_checksum
    );
    await this.db.query(
      `UPDATE collab_document_assets SET last_accessed_at = $5
       WHERE account_id = $1 AND org_id = $2 AND document_id = $3 AND asset_id = $4`,
      [...this.identityParams(identity), new Date()]
    );
    return {
      ...decodeAsset(identity, plaintext),
      uploadState: row.upload_state,
      attemptCount: row.attempt_count,
      lastErrorCode: row.last_error_code,
      createdAt: toMillis(row.created_at) ?? 0,
      updatedAt: toMillis(row.updated_at) ?? 0,
    };
  }

  async listPendingUploads(
    accountId?: string
  ): Promise<PendingCollabAssetUpload[]> {
    const result = await this.db.query<AssetRow>(
      `SELECT account_id, org_id, document_id, asset_id, encrypted_asset,
              encoding_version, asset_checksum, upload_state, attempt_count,
              last_error_code, created_at, updated_at, next_attempt_at
       FROM collab_document_assets
       WHERE upload_state IN ('queued','inflight')
         ${accountId ? "AND account_id = $1" : ""}
       ORDER BY created_at, account_id, org_id, document_id, asset_id`,
      accountId ? [accountId] : []
    );
    return result.rows.map((row) => ({
      identity: {
        accountId: row.account_id,
        orgId: row.org_id,
        documentId: row.document_id,
        assetId: row.asset_id,
      },
      uploadState: row.upload_state as "queued" | "inflight",
      attemptCount: row.attempt_count,
      lastErrorCode: row.last_error_code,
      createdAt: toMillis(row.created_at) ?? 0,
      nextAttemptAt: toMillis(row.next_attempt_at),
    }));
  }

  async listUnsentUploads(accountId: string): Promise<Array<{
    identity: CollabAssetIdentity;
  }>> {
    const result = await this.db.query<Pick<
      AssetRow,
      "account_id" | "org_id" | "document_id" | "asset_id"
    >>(
      `SELECT account_id, org_id, document_id, asset_id
       FROM collab_document_assets
       WHERE account_id = $1 AND upload_state IN ('queued','inflight','rejected')`,
      [accountId]
    );
    return result.rows.map((row) => ({
      identity: {
        accountId: row.account_id,
        orgId: row.org_id,
        documentId: row.document_id,
        assetId: row.asset_id,
      },
    }));
  }

  async claimUpload(identity: CollabAssetIdentity): Promise<boolean> {
    const result = await this.db.query<{ asset_id: string }>(
      `UPDATE collab_document_assets
       SET upload_state = 'inflight', attempt_count = attempt_count + 1,
           next_attempt_at = NULL, updated_at = $5
       WHERE account_id = $1 AND org_id = $2 AND document_id = $3 AND asset_id = $4
         AND upload_state = 'queued'
       RETURNING asset_id`,
      [...this.identityParams(identity), new Date()]
    );
    return result.rows.length === 1;
  }

  async markUploaded(identity: CollabAssetIdentity): Promise<void> {
    await this.db.query(
      `UPDATE collab_document_assets
       SET upload_state = 'cached', last_error_code = NULL,
           next_attempt_at = NULL, updated_at = $5
       WHERE account_id = $1 AND org_id = $2 AND document_id = $3 AND asset_id = $4`,
      [...this.identityParams(identity), new Date()]
    );
  }

  async recordUploadError(
    identity: CollabAssetIdentity,
    errorCode: string,
    rejected: boolean,
    nextAttemptAt: number | null
  ): Promise<void> {
    await this.db.query(
      `UPDATE collab_document_assets
       SET upload_state = $5, last_error_code = $6,
           next_attempt_at = $7, updated_at = $8
       WHERE account_id = $1 AND org_id = $2 AND document_id = $3 AND asset_id = $4
         AND upload_state = 'inflight'`,
      [
        ...this.identityParams(identity),
        rejected ? "rejected" : "queued",
        errorCode,
        nextAttemptAt === null ? null : new Date(nextAttemptAt),
        new Date(),
      ]
    );
  }

  async assertAccountPurgeAllowed(accountId: string, force = false): Promise<void> {
    if (force) return;
    const pending = await this.db.query<{ asset_id: string }>(
      `SELECT asset_id FROM collab_document_assets
       WHERE account_id = $1 AND upload_state IN ('queued','inflight','rejected')
       LIMIT 1`,
      [accountId]
    );
    if (pending.rows.length > 0) {
      throw new Error("COLLAB_ASSET_HAS_PENDING_UPLOAD");
    }
  }

  async purgeByAccount(accountId: string, force = false): Promise<void> {
    await this.assertAccountPurgeAllowed(accountId, force);
    await this.db.query(
      "DELETE FROM collab_document_assets WHERE account_id = $1",
      [accountId]
    );
    this.accountUsageEstimates.delete(accountId);
  }

  async hasAccountData(accountId: string): Promise<boolean> {
    const result = await this.db.query<{ account_id: string }>(
      `SELECT account_id FROM collab_document_assets
       WHERE account_id = $1 LIMIT 1`,
      [accountId]
    );
    return result.rows.length > 0;
  }

  async purgeByOrg(accountId: string, orgId: string): Promise<void> {
    await this.db.query(
      "DELETE FROM collab_document_assets WHERE account_id = $1 AND org_id = $2",
      [accountId, orgId]
    );
    this.accountUsageEstimates.delete(accountId);
  }

  async getStorageUsage(accountId: string): Promise<CollabAssetStorageUsage> {
    const result = await this.db.query<AssetUsageRow>(
      `SELECT a.org_id, a.document_id, a.asset_id,
              OCTET_LENGTH(a.encrypted_asset) AS encrypted_bytes,
              a.last_accessed_at,
              (a.upload_state = 'cached' AND NOT EXISTS (
                SELECT 1 FROM collab_document_outbox o
                WHERE o.account_id = a.account_id AND o.org_id = a.org_id
                  AND o.document_id = a.document_id
                  AND o.state IN ('queued','inflight','rejected')
              )) AS evictable
       FROM collab_document_assets a WHERE a.account_id = $1`,
      [accountId]
    );
    const assets = result.rows.map((row) => ({
      identity: {
        accountId,
        orgId: row.org_id,
        documentId: row.document_id,
        assetId: row.asset_id,
      },
      encryptedBytes: Number(row.encrypted_bytes),
      lastAccessedAt: toMillis(row.last_accessed_at) ?? 0,
      evictable: row.evictable === true || Number(row.evictable) === 1,
    }));
    return {
      encryptedBytes: assets.reduce(
        (sum, asset) => sum + asset.encryptedBytes,
        0
      ),
      assets,
    };
  }

  async enforceStorageBudget(
    accountId: string,
    requiredBytes = 0
  ): Promise<CollabAssetStorageUsage> {
    let usage = await this.getStorageUsage(accountId);
    if (usage.encryptedBytes + requiredBytes <= this.accountBudgetBytes) {
      this.accountUsageEstimates.set(accountId, usage.encryptedBytes);
      return usage;
    }
    const candidates = usage.assets
      .filter((asset) => asset.evictable)
      .sort(
        (left, right) =>
          left.lastAccessedAt - right.lastAccessedAt ||
          left.identity.orgId.localeCompare(right.identity.orgId) ||
          left.identity.documentId.localeCompare(right.identity.documentId) ||
          left.identity.assetId.localeCompare(right.identity.assetId)
      );
    for (const candidate of candidates) {
      const deleted = await this.db.query<{ asset_id: string }>(
        `DELETE FROM collab_document_assets
         WHERE account_id = $1 AND org_id = $2 AND document_id = $3 AND asset_id = $4
           AND upload_state = 'cached'
           AND NOT EXISTS (
             SELECT 1 FROM collab_document_outbox o
             WHERE o.account_id = $1 AND o.org_id = $2 AND o.document_id = $3
               AND o.state IN ('queued','inflight','rejected')
           )
         RETURNING asset_id`,
        this.identityParams(candidate.identity)
      );
      if (deleted.rows.length === 0) continue;
      logger.main.info("[CollabOfflineMetric]", {
        metric: "storage_eviction",
        storageKind: "asset",
        evictedBytes: candidate.encryptedBytes,
      });
      usage.encryptedBytes = Math.max(
        0,
        usage.encryptedBytes - candidate.encryptedBytes
      );
      usage.assets = usage.assets.filter(
        (asset) =>
          asset.identity.orgId !== candidate.identity.orgId ||
          asset.identity.documentId !== candidate.identity.documentId ||
          asset.identity.assetId !== candidate.identity.assetId
      );
      if (usage.encryptedBytes + requiredBytes <= this.accountBudgetBytes) {
        this.accountUsageEstimates.set(accountId, usage.encryptedBytes);
        return usage;
      }
    }
    logger.main.error("[CollabOfflineMetric]", {
      metric: "disk_full",
      storageKind: "asset",
      requiredBytes,
      budgetBytes: this.accountBudgetBytes,
    });
    throw new Error("COLLAB_ASSET_STORAGE_BUDGET_EXCEEDED");
  }

  private async put(
    input: PutCollabAssetInput,
    uploadState: CollabAssetUploadState
  ): Promise<void> {
    const accountId = input.identity.accountId;
    const previous = this.accountAdmissionTails.get(accountId) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(() => this.putSerial(input, uploadState));
    this.accountAdmissionTails.set(accountId, operation);
    try {
      await operation;
    } finally {
      if (this.accountAdmissionTails.get(accountId) === operation) {
        this.accountAdmissionTails.delete(accountId);
      }
    }
  }

  private async putSerial(
    input: PutCollabAssetInput,
    uploadState: CollabAssetUploadState
  ): Promise<void> {
    const encoded = encodeAsset(input);
    const encrypted = await this.encrypt(input.identity, encoded);
    const existing = await this.db.query<{ encrypted_bytes: number | bigint | string }>(
      `SELECT OCTET_LENGTH(encrypted_asset) AS encrypted_bytes
       FROM collab_document_assets
       WHERE account_id = $1 AND org_id = $2 AND document_id = $3 AND asset_id = $4`,
      this.identityParams(input.identity)
    );
    const existingBytes = existing.rows[0]
      ? Number(existing.rows[0].encrypted_bytes)
      : 0;
    const additionalBytes = Math.max(0, encrypted.byteLength - existingBytes);
    let estimatedUsage = this.accountUsageEstimates.get(input.identity.accountId);
    if (
      estimatedUsage === undefined ||
      estimatedUsage + additionalBytes > this.accountBudgetBytes
    ) {
      const usage = await this.enforceStorageBudget(
        input.identity.accountId,
        additionalBytes
      );
      estimatedUsage = usage.encryptedBytes;
    }
    const now = new Date();
    await this.db.query(
      `INSERT INTO collab_document_assets
       (account_id, org_id, document_id, asset_id, encrypted_asset,
        encoding_version, asset_checksum, plaintext_size, upload_state,
        attempt_count, last_error_code, next_attempt_at,
        created_at, updated_at, last_accessed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,NULL,NULL,$10,$10,$10)
       ON CONFLICT (account_id, org_id, document_id, asset_id) DO UPDATE SET
         encrypted_asset = EXCLUDED.encrypted_asset,
         encoding_version = EXCLUDED.encoding_version,
         asset_checksum = EXCLUDED.asset_checksum,
         plaintext_size = EXCLUDED.plaintext_size,
         upload_state = EXCLUDED.upload_state,
         attempt_count = 0,
         last_error_code = NULL,
         next_attempt_at = NULL,
         updated_at = EXCLUDED.updated_at,
         last_accessed_at = EXCLUDED.last_accessed_at`,
      [
        ...this.identityParams(input.identity),
        encrypted,
        ENCODING_VERSION,
        checksum(encrypted),
        input.bytes.byteLength,
        uploadState,
        now,
      ]
    );
    this.accountUsageEstimates.set(
      input.identity.accountId,
      Math.max(0, estimatedUsage + encrypted.byteLength - existingBytes)
    );
  }

  private identityParams(
    identity: CollabAssetIdentity
  ): [string, string, string, string] {
    return [
      identity.accountId,
      identity.orgId,
      identity.documentId,
      identity.assetId,
    ];
  }

  private async encrypt(
    identity: CollabAssetIdentity,
    plaintext: Uint8Array
  ): Promise<Buffer> {
    const key = Buffer.from(await this.keyProvider.getKey(identity.accountId));
    if (key.byteLength !== 32)
      throw new Error("collab asset device key must be 32 bytes");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(aad(identity, ENCODING_VERSION));
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
  }

  private async decrypt(
    identity: CollabAssetIdentity,
    encodingVersion: number,
    stored: Uint8Array,
    expectedChecksum: string
  ): Promise<Uint8Array> {
    const bytes = Buffer.from(stored);
    if (checksum(bytes) !== expectedChecksum)
      throw new Error("cached asset checksum mismatch");
    if (encodingVersion !== ENCODING_VERSION || bytes.byteLength < 28) {
      throw new Error(
        `unsupported cached asset encoding version ${encodingVersion}`
      );
    }
    const key = Buffer.from(await this.keyProvider.getKey(identity.accountId));
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      bytes.subarray(0, 12)
    );
    decipher.setAAD(aad(identity, encodingVersion));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([
      decipher.update(bytes.subarray(28)),
      decipher.final(),
    ]);
  }
}

let singleton: CollabAssetStore | null = null;

export function getCollabAssetStore(): CollabAssetStore {
  singleton ??= new CollabAssetStore();
  return singleton;
}
