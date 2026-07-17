import { app, safeStorage } from "electron";
import * as fs from "fs/promises";
import * as path from "path";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "crypto";
import type {
  AppendLocalReplicaUpdateInput,
  AppendRemoteReplicaUpdatesInput,
  LoadedLocalReplica,
  LocalReplicaIdentity,
  LocalReplicaOutboxEntry,
  LocalReplicaOutboxState,
  LocalReplicaPendingOutbox,
  LocalReplicaStorageUsage,
  LocalReplicaStore,
  ReplaceLocalReplicaSnapshotInput,
} from "@nimbalyst/runtime/sync";
import type { AppDatabase } from "../database/PGLiteDatabaseWorker";
import { database } from "../database/PGLiteDatabaseWorker";
import { toMillis } from "../utils/timestampUtils";
import { logger } from "../utils/logger";

const ENCODING_VERSION = 1;
const ENCRYPTED_VALUE_OVERHEAD_BYTES = 12 + 16;
const STORAGE_BUDGET_RECHECK_INTERVAL_MS = 5_000;
const STORAGE_BUDGET_RECHECK_BYTES = 4 * 1024 * 1024;
export const DEFAULT_LOCAL_REPLICA_ACCOUNT_BUDGET_BYTES = 512 * 1024 * 1024;
type ReplicaPurpose = "replica" | "update" | "outbox";

export interface ReplicaDeviceKeyProvider {
  getKey(accountId: string): Promise<Uint8Array>;
  deleteKey?(accountId: string): Promise<void>;
}

/** Account-scoped random keys wrapped by Electron safeStorage. */
export class SafeStorageReplicaDeviceKeyProvider
  implements ReplicaDeviceKeyProvider
{
  private readonly keys = new Map<string, Promise<Uint8Array>>();

  getKey(accountId: string): Promise<Uint8Array> {
    let pending = this.keys.get(accountId);
    if (!pending) {
      pending = this.loadOrCreate(accountId);
      this.keys.set(accountId, pending);
    }
    return pending;
  }

  async deleteKey(accountId: string): Promise<void> {
    this.keys.delete(accountId);
    await fs.rm(this.keyPath(accountId), { force: true });
  }

  private async loadOrCreate(accountId: string): Promise<Uint8Array> {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error(
        "OS credential storage is unavailable; local replica persistence is disabled"
      );
    }
    const filePath = this.keyPath(accountId);
    const directory = path.dirname(filePath);
    try {
      const protectedKey = await fs.readFile(filePath);
      const raw = Buffer.from(
        safeStorage.decryptString(protectedKey),
        "base64"
      );
      if (raw.byteLength !== 32)
        throw new Error("invalid local replica device key length");
      return raw;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const raw = randomBytes(32);
    const protectedKey = safeStorage.encryptString(raw.toString("base64"));
    await fs.mkdir(directory, { recursive: true });
    try {
      await fs.writeFile(filePath, protectedKey, { mode: 0o600, flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await fs.readFile(filePath);
      const existingRaw = Buffer.from(
        safeStorage.decryptString(existing),
        "base64"
      );
      if (existingRaw.byteLength !== 32)
        throw new Error("invalid local replica device key length");
      return existingRaw;
    }
    return raw;
  }

  private keyPath(accountId: string): string {
    const fileName = `${createHash("sha256")
      .update(accountId)
      .digest("hex")}.key`;
    return path.join(app.getPath("userData"), "collab-replica-keys", fileName);
  }
}

interface ReplicaDatabase {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  runTransaction(
    statements: Array<{ sql: string; params?: unknown[] }>
  ): Promise<void>;
}

interface ReplicaRow {
  account_id: string;
  org_id: string;
  document_id: string;
  document_type: string;
  encoding_version: number;
  encrypted_snapshot: Uint8Array | null;
  snapshot_generation: number;
  last_server_seq: number | bigint;
  completeness: "complete" | "incomplete" | "corrupt";
  snapshot_checksum: string | null;
  staged_encrypted_snapshot: Uint8Array | null;
  staged_snapshot_generation: number | null;
  staged_snapshot_checksum: string | null;
  staged_encoding_version: number | null;
  staged_snapshot_token: string | null;
  snapshot_commit_token: string | null;
}

interface UpdateRow {
  update_id: string;
  encrypted_update: Uint8Array;
  source: "local" | "remote" | "server-snapshot";
  server_sequence: number | bigint | null;
  snapshot_generation: number;
  encoding_version: number;
  update_checksum: string;
  created_at: unknown;
}

interface OutboxRow {
  batch_id: string;
  encrypted_update: Uint8Array;
  encoding_version: number;
  update_checksum: string;
  state: LocalReplicaOutboxState;
  attempt_count: number;
  last_error_code: string | null;
  created_at: unknown;
  updated_at: unknown;
}

interface PendingOutboxMetadataRow {
  account_id: string;
  org_id: string;
  document_id: string;
  document_type: string;
  queued_count: number | bigint;
  inflight_count: number | bigint;
  rejected_count: number | bigint;
}

interface AccountBudgetEstimate {
  estimatedBytes: number;
  bytesSinceMeasure: number;
  lastMeasuredAt: number;
}

function checksum(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function aad(
  identity: LocalReplicaIdentity,
  purpose: ReplicaPurpose,
  encodingVersion: number
): Buffer {
  return Buffer.from(
    JSON.stringify([
      "nimbalyst-collab-replica",
      identity.accountId,
      identity.orgId,
      identity.documentId,
      purpose,
      encodingVersion,
    ])
  );
}

export class CollabDocumentReplicaStore implements LocalReplicaStore {
  private readonly accountBudgetEstimates = new Map<string, AccountBudgetEstimate>();
  private readonly accountBudgetAdmissionTails = new Map<string, Promise<void>>();

  constructor(
    private readonly db: ReplicaDatabase = database as AppDatabase,
    private readonly keyProvider: ReplicaDeviceKeyProvider = new SafeStorageReplicaDeviceKeyProvider(),
    private readonly accountBudgetBytes = DEFAULT_LOCAL_REPLICA_ACCOUNT_BUDGET_BYTES
  ) {}

  async load(
    identity: LocalReplicaIdentity
  ): Promise<LoadedLocalReplica | null> {
    const startedAt = Date.now();
    const replicaResult = await this.db.query<ReplicaRow>(
      `
      SELECT account_id, org_id, document_id, document_type, encoding_version,
             encrypted_snapshot, snapshot_generation, last_server_seq,
             completeness, snapshot_checksum, staged_encrypted_snapshot,
             staged_snapshot_generation, staged_snapshot_checksum,
             staged_encoding_version, staged_snapshot_token, snapshot_commit_token
      FROM collab_document_replicas
      WHERE account_id = $1 AND org_id = $2 AND document_id = $3
    `,
      this.identityParams(identity)
    );
    const row = replicaResult.rows[0];
    if (!row) {
      logger.main.info("[CollabOfflineMetric]", {
        metric: "replica_hydration",
        hit: false,
        durationMs: Date.now() - startedAt,
        snapshotBytes: 0,
        tailBytes: 0,
        updateCount: 0,
      });
      return null;
    }
    if (row.completeness !== "complete") {
      return {
        identity,
        documentType: row.document_type,
        encodingVersion: row.encoding_version,
        snapshot: null,
        snapshotGeneration: row.snapshot_generation,
        lastServerSeq: Number(row.last_server_seq),
        completeness: row.completeness,
        updates: [],
        outbox: [],
      };
    }

    const updateResult = await this.db.query<UpdateRow>(
      `
      SELECT update_id, encrypted_update, source, server_sequence,
             snapshot_generation, encoding_version, update_checksum, created_at
      FROM collab_document_replica_updates
      WHERE account_id = $1 AND org_id = $2 AND document_id = $3
        AND snapshot_generation >= $4
      ORDER BY created_at ASC, update_id ASC
    `,
      [...this.identityParams(identity), row.snapshot_generation]
    );
    const outboxResult = await this.db.query<OutboxRow>(
      `
      SELECT batch_id, encrypted_update, encoding_version, update_checksum,
             state, attempt_count, last_error_code, created_at, updated_at
      FROM collab_document_outbox
      WHERE account_id = $1 AND org_id = $2 AND document_id = $3
      ORDER BY created_at ASC, batch_id ASC
    `,
      this.identityParams(identity)
    );

    await this.db.query(
      `
      UPDATE collab_document_replicas SET last_accessed_at = $4
      WHERE account_id = $1 AND org_id = $2 AND document_id = $3
    `,
      [...this.identityParams(identity), new Date()]
    );

    let snapshot: Uint8Array | null;
    let updates: LoadedLocalReplica["updates"];
    let outbox: LoadedLocalReplica["outbox"];
    try {
      snapshot = row.encrypted_snapshot
        ? await this.decrypt(
            identity,
            "replica",
            row.encoding_version,
            row.encrypted_snapshot,
            row.snapshot_checksum
          )
        : null;
      updates = await Promise.all(
        updateResult.rows.map(async (item) => ({
          updateId: item.update_id,
          update: await this.decrypt(
            identity,
            "update",
            item.encoding_version,
            item.encrypted_update,
            item.update_checksum
          ),
          source: item.source,
          serverSequence:
            item.server_sequence === null ? null : Number(item.server_sequence),
          snapshotGeneration: item.snapshot_generation,
          createdAt: toMillis(item.created_at) ?? 0,
        }))
      );
      outbox = await Promise.all(
        outboxResult.rows.map(async (item) => ({
          batchId: item.batch_id,
          update: await this.decrypt(
            identity,
            "outbox",
            item.encoding_version,
            item.encrypted_update,
            item.update_checksum
          ),
          state: item.state,
          attemptCount: item.attempt_count,
          lastErrorCode: item.last_error_code,
          createdAt: toMillis(item.created_at) ?? 0,
          updatedAt: toMillis(item.updated_at) ?? 0,
        }))
      );
    } catch (error) {
      await this.quarantine(
        identity,
        error instanceof Error ? error.message : String(error)
      );
      throw new Error(
        `CORRUPT_LOCAL_REPLICA: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    const loaded = {
      identity,
      documentType: row.document_type,
      encodingVersion: row.encoding_version,
      snapshot,
      snapshotGeneration: row.snapshot_generation,
      lastServerSeq: Number(row.last_server_seq),
      completeness: row.completeness,
      updates,
      outbox,
    };
    logger.main.info("[CollabOfflineMetric]", {
      metric: "replica_hydration",
      hit: true,
      durationMs: Date.now() - startedAt,
      snapshotBytes: snapshot?.byteLength ?? 0,
      tailBytes: updates.reduce((sum, update) => sum + update.update.byteLength, 0),
      updateCount: updates.length,
    });
    return loaded;
  }

  async appendLocalUpdate(input: AppendLocalReplicaUpdateInput): Promise<void> {
    const now = new Date();
    const encryptedTail = await this.encrypt(
      input.identity,
      "update",
      input.update
    );
    const encryptedOutbox = await this.encrypt(
      input.identity,
      "outbox",
      input.update
    );
    await this.db.runTransaction([
      this.upsertReplicaStatement(
        input.identity,
        input.documentType,
        input.snapshotGeneration,
        now
      ),
      {
        sql: `INSERT INTO collab_document_replica_updates
          (update_id, account_id, org_id, document_id, encrypted_update, source,
           server_sequence, snapshot_generation, encoding_version, update_checksum, created_at)
          VALUES ($1,$2,$3,$4,$5,'local',NULL,
            (SELECT snapshot_generation FROM collab_document_replicas
             WHERE account_id = $2 AND org_id = $3 AND document_id = $4),
            $6,$7,$8)
          ON CONFLICT DO NOTHING`,
        params: [
          input.updateId,
          ...this.identityParams(input.identity),
          encryptedTail,
          ENCODING_VERSION,
          checksum(encryptedTail),
          now,
        ],
      },
      {
        sql: `INSERT INTO collab_document_outbox
          (batch_id, account_id, org_id, document_id, encrypted_update,
           encoding_version, update_checksum, state, attempt_count, created_at, updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,'queued',0,$8,$8)
          ON CONFLICT DO NOTHING`,
        params: [
          input.updateId,
          ...this.identityParams(input.identity),
          encryptedOutbox,
          ENCODING_VERSION,
          checksum(encryptedOutbox),
          now,
        ],
      },
    ]);
  }

  estimateLocalAppendBytes(input: AppendLocalReplicaUpdateInput): number {
    return 2 * (input.update.byteLength + ENCRYPTED_VALUE_OVERHEAD_BYTES);
  }

  estimateRemoteAppendBytes(input: AppendRemoteReplicaUpdatesInput): number {
    return input.updates.reduce(
      (sum, item) => sum + item.update.byteLength + ENCRYPTED_VALUE_OVERHEAD_BYTES,
      0
    );
  }

  /**
   * Reserve storage before an append can commit. Exact aggregate accounting
   * is bounded by time and accumulated bytes instead of running on every edit.
   * Reservations deliberately overestimate when a deduplicated/failed append
   * stores fewer bytes; the next bounded measurement corrects the estimate.
   */
  async prepareForAppend(
    accountId: string,
    additionalBytes: number,
    isPinned: (identity: LocalReplicaIdentity) => boolean = () => false
  ): Promise<void> {
    const previous = this.accountBudgetAdmissionTails.get(accountId) ?? Promise.resolve();
    const admission = previous.catch(() => undefined).then(async () => {
      const now = Date.now();
      const estimate = this.accountBudgetEstimates.get(accountId);
      const requiresMeasurement =
        !estimate ||
        now - estimate.lastMeasuredAt >= STORAGE_BUDGET_RECHECK_INTERVAL_MS ||
        estimate.bytesSinceMeasure + additionalBytes >= STORAGE_BUDGET_RECHECK_BYTES ||
        estimate.estimatedBytes + additionalBytes > this.accountBudgetBytes;

      if (requiresMeasurement) {
        const usage = await this.enforceStorageBudget(
          accountId,
          isPinned,
          additionalBytes
        );
        this.accountBudgetEstimates.set(accountId, {
          estimatedBytes: usage.encryptedBytes + additionalBytes,
          bytesSinceMeasure: additionalBytes,
          lastMeasuredAt: now,
        });
        return;
      }

      this.accountBudgetEstimates.set(accountId, {
        estimatedBytes: estimate.estimatedBytes + additionalBytes,
        bytesSinceMeasure: estimate.bytesSinceMeasure + additionalBytes,
        lastMeasuredAt: estimate.lastMeasuredAt,
      });
    });
    this.accountBudgetAdmissionTails.set(accountId, admission);
    try {
      await admission;
    } finally {
      if (this.accountBudgetAdmissionTails.get(accountId) === admission) {
        this.accountBudgetAdmissionTails.delete(accountId);
      }
    }
  }

  async appendRemoteUpdates(
    input: AppendRemoteReplicaUpdatesInput
  ): Promise<void> {
    const now = new Date();
    const statements: Array<{ sql: string; params?: unknown[] }> = [
      this.upsertReplicaStatement(
        input.identity,
        input.documentType,
        input.snapshotGeneration,
        now,
        input.lastServerSeq
      ),
    ];
    for (const item of input.updates) {
      const encrypted = await this.encrypt(
        input.identity,
        "update",
        item.update
      );
      if (item.source === "server-snapshot") {
        // A full replay may revisit the same generation after an incomplete
        // open. Keep one authoritative server snapshot row instead of adding
        // a fresh random update_id on every reconnect.
        statements.push({
          sql: `DELETE FROM collab_document_replica_updates
            WHERE account_id = $1 AND org_id = $2 AND document_id = $3
              AND source = 'server-snapshot'
              AND snapshot_generation = (
                SELECT snapshot_generation FROM collab_document_replicas
                WHERE account_id = $1 AND org_id = $2 AND document_id = $3
              )`,
          params: this.identityParams(input.identity),
        });
      }
      statements.push({
        sql: `INSERT INTO collab_document_replica_updates
          (update_id, account_id, org_id, document_id, encrypted_update, source,
           server_sequence, snapshot_generation, encoding_version, update_checksum, created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,
            (SELECT snapshot_generation FROM collab_document_replicas
             WHERE account_id = $2 AND org_id = $3 AND document_id = $4),
            $8,$9,$10)
          ON CONFLICT DO NOTHING`,
        params: [
          item.updateId,
          ...this.identityParams(input.identity),
          encrypted,
          item.source,
          item.serverSequence,
          ENCODING_VERSION,
          checksum(encrypted),
          now,
        ],
      });
    }
    await this.db.runTransaction(statements);
  }

  async setOutboxState(
    identity: LocalReplicaIdentity,
    batchIds: string[],
    state: LocalReplicaOutboxState,
    lastErrorCode?: string | null
  ): Promise<void> {
    if (batchIds.length === 0) return;
    await this.db.runTransaction(
      batchIds.map((batchId) => ({
        sql: `UPDATE collab_document_outbox
        SET state = $5,
            attempt_count = attempt_count + CASE
              WHEN $5 = 'inflight' AND state <> 'inflight' THEN 1 ELSE 0 END,
            last_error_code = CASE WHEN $6 = 1 THEN $7 ELSE last_error_code END,
            updated_at = $8
        WHERE account_id = $1 AND org_id = $2 AND document_id = $3 AND batch_id = $4`,
        params: [
          ...this.identityParams(identity),
          batchId,
          state,
          lastErrorCode === undefined ? 0 : 1,
          lastErrorCode ?? null,
          new Date(),
        ],
      }))
    );
  }

  async claimOutboxBatch(
    identity: LocalReplicaIdentity,
    batchIds: string[]
  ): Promise<boolean> {
    if (batchIds.length === 0) return false;
    const firstIds = batchIds.map((_, index) => `$${index + 4}`);
    const secondOffset = 4 + batchIds.length;
    const secondIds = batchIds.map((_, index) => `$${index + secondOffset}`);
    const updatedAtParam = `$${4 + batchIds.length * 2}`;
    const result = await this.db.query<{ batch_id: string }>(
      `UPDATE collab_document_outbox
       SET state = 'inflight', attempt_count = attempt_count + 1,
           updated_at = ${updatedAtParam}
       WHERE account_id = $1 AND org_id = $2 AND document_id = $3
         AND batch_id IN (${firstIds.join(", ")}) AND state = 'queued'
         AND (
           SELECT COUNT(*) FROM collab_document_outbox candidate
           WHERE candidate.account_id = $1 AND candidate.org_id = $2
             AND candidate.document_id = $3 AND candidate.state = 'queued'
             AND candidate.batch_id IN (${secondIds.join(", ")})
         ) = ${batchIds.length}
       RETURNING batch_id`,
      [
        ...this.identityParams(identity),
        ...batchIds,
        ...batchIds,
        new Date(),
      ]
    );
    return result.rows.length === batchIds.length;
  }

  async loadOutbox(
    identity: LocalReplicaIdentity
  ): Promise<LocalReplicaOutboxEntry[]> {
    const result = await this.db.query<OutboxRow>(
      `SELECT batch_id, encrypted_update, encoding_version, update_checksum,
              state, attempt_count, last_error_code, created_at, updated_at
       FROM collab_document_outbox
       WHERE account_id = $1 AND org_id = $2 AND document_id = $3
       ORDER BY created_at, batch_id`,
      this.identityParams(identity)
    );
    return Promise.all(
      result.rows.map(async (row) => ({
        batchId: row.batch_id,
        update: await this.decrypt(
          identity,
          "outbox",
          row.encoding_version,
          row.encrypted_update,
          row.update_checksum
        ),
        state: row.state,
        attemptCount: row.attempt_count,
        lastErrorCode: row.last_error_code,
        createdAt: toMillis(row.created_at) ?? 0,
        updatedAt: toMillis(row.updated_at) ?? 0,
      }))
    );
  }

  async recordOutboxError(
    identity: LocalReplicaIdentity,
    batchIds: string[],
    errorCode: string
  ): Promise<void> {
    if (batchIds.length === 0) return;
    await this.db.runTransaction(
      batchIds.map((batchId) => ({
        sql: `UPDATE collab_document_outbox
          SET last_error_code = $5, updated_at = $6
          WHERE account_id = $1 AND org_id = $2 AND document_id = $3
            AND batch_id = $4`,
        params: [
          ...this.identityParams(identity),
          batchId,
          errorCode,
          new Date(),
        ],
      }))
    );
  }

  async acknowledgeOutbox(
    identity: LocalReplicaIdentity,
    batchIds: string[],
    serverSequence: number
  ): Promise<void> {
    if (batchIds.length === 0) return;
    await this.db.runTransaction([
      {
        sql: `UPDATE collab_document_replica_updates
          SET server_sequence = $5
          WHERE account_id = $1 AND org_id = $2 AND document_id = $3
            AND update_id = $4 AND source = 'local'
            AND NOT EXISTS (
              SELECT 1 FROM collab_document_replica_updates existing
              WHERE existing.account_id = $1 AND existing.org_id = $2
                AND existing.document_id = $3
                AND existing.server_sequence = $5
                AND existing.update_id <> $4
            )`,
        // One merged wire batch has one server sequence. Associate it with the
        // stable canonical (oldest) local row; remaining constituent rows stay
        // sequence-less so the per-document uniqueness invariant is preserved.
        params: [
          ...this.identityParams(identity),
          batchIds[0],
          serverSequence,
        ],
      },
      ...batchIds.map((batchId) => ({
        sql: `DELETE FROM collab_document_outbox
          WHERE account_id = $1 AND org_id = $2 AND document_id = $3 AND batch_id = $4`,
        params: [...this.identityParams(identity), batchId],
      })),
    ]);
  }

  async replaceSnapshot(
    input: ReplaceLocalReplicaSnapshotInput
  ): Promise<boolean> {
    const snapshotToken = randomUUID();
    const staged = await this.stageSnapshot({ ...input, snapshotToken });
    if (!staged) return false;
    return this.commitStagedSnapshot({
      identity: input.identity,
      expectedGeneration: input.expectedGeneration,
      nextGeneration: input.nextGeneration,
      coveredUpdateIds: input.coveredUpdateIds ?? [],
      snapshotToken,
    });
  }

  async stageSnapshot(
    input: ReplaceLocalReplicaSnapshotInput & { snapshotToken: string }
  ): Promise<boolean> {
    const encrypted = await this.encrypt(
      input.identity,
      "replica",
      input.snapshot
    );
    const result = await this.db.query<{ staged_snapshot_token: string }>(
      `UPDATE collab_document_replicas
       SET staged_encrypted_snapshot = $4,
           staged_snapshot_generation = $5,
           staged_snapshot_checksum = $6,
           staged_encoding_version = $7,
           staged_snapshot_token = $8,
           updated_at = $9
       WHERE account_id = $1 AND org_id = $2 AND document_id = $3
         AND snapshot_generation = $10 AND completeness = 'complete'
       RETURNING staged_snapshot_token`,
      [
        ...this.identityParams(input.identity),
        encrypted,
        input.nextGeneration,
        checksum(encrypted),
        ENCODING_VERSION,
        input.snapshotToken,
        new Date(),
        input.expectedGeneration,
      ]
    );
    return result.rows[0]?.staged_snapshot_token === input.snapshotToken;
  }

  async commitStagedSnapshot(input: {
    identity: LocalReplicaIdentity;
    expectedGeneration: number;
    nextGeneration: number;
    coveredUpdateIds: string[];
    snapshotToken: string;
  }): Promise<boolean> {
    const staged = await this.db.query<ReplicaRow>(
      `SELECT account_id, org_id, document_id, document_type, encoding_version,
              encrypted_snapshot, snapshot_generation, last_server_seq,
              completeness, snapshot_checksum, staged_encrypted_snapshot,
              staged_snapshot_generation, staged_snapshot_checksum,
              staged_encoding_version, staged_snapshot_token, snapshot_commit_token
       FROM collab_document_replicas
       WHERE account_id = $1 AND org_id = $2 AND document_id = $3`,
      this.identityParams(input.identity)
    );
    const row = staged.rows[0];
    if (
      !row ||
      row.completeness !== "complete" ||
      row.snapshot_generation !== input.expectedGeneration ||
      row.staged_snapshot_generation !== input.nextGeneration ||
      row.staged_snapshot_token !== input.snapshotToken ||
      !row.staged_encrypted_snapshot ||
      !row.staged_encoding_version
    ) {
      return false;
    }

    // Verification happens before promotion, so a crash or checksum failure
    // leaves the prior snapshot and its complete tail authoritative.
    await this.decrypt(
      input.identity,
      "replica",
      row.staged_encoding_version,
      row.staged_encrypted_snapshot,
      row.staged_snapshot_checksum
    );

    const identityParams = this.identityParams(input.identity);
    const statements: Array<{ sql: string; params?: unknown[] }> = [
      {
        sql: `UPDATE collab_document_replicas
          SET encrypted_snapshot = staged_encrypted_snapshot,
              snapshot_checksum = staged_snapshot_checksum,
              encoding_version = staged_encoding_version,
              snapshot_generation = staged_snapshot_generation,
              snapshot_commit_token = staged_snapshot_token,
              staged_encrypted_snapshot = NULL,
              staged_snapshot_generation = NULL,
              staged_snapshot_checksum = NULL,
              staged_encoding_version = NULL,
              staged_snapshot_token = NULL,
              updated_at = $7
          WHERE account_id = $1 AND org_id = $2 AND document_id = $3
            AND snapshot_generation = $4
            AND staged_snapshot_generation = $5
            AND staged_snapshot_token = $6
            AND completeness = 'complete'`,
        params: [
          ...identityParams,
          input.expectedGeneration,
          input.nextGeneration,
          input.snapshotToken,
          new Date(),
        ],
      },
      {
        sql: `UPDATE collab_document_replica_updates
          SET snapshot_generation = $4
          WHERE account_id = $1 AND org_id = $2 AND document_id = $3
            AND snapshot_generation = $5
            AND EXISTS (
              SELECT 1 FROM collab_document_replicas r
              WHERE r.account_id = $1 AND r.org_id = $2 AND r.document_id = $3
                AND r.snapshot_generation = $4
                AND r.snapshot_commit_token = $6
            )`,
        params: [
          ...identityParams,
          input.nextGeneration,
          input.expectedGeneration,
          input.snapshotToken,
        ],
      },
      ...input.coveredUpdateIds.map((updateId) => ({
        sql: `DELETE FROM collab_document_replica_updates
          WHERE account_id = $1 AND org_id = $2 AND document_id = $3
            AND update_id = $4
            AND NOT EXISTS (
              SELECT 1 FROM collab_document_outbox o
              WHERE o.account_id = $1 AND o.org_id = $2 AND o.document_id = $3
                AND o.batch_id = $4
            )
            AND EXISTS (
              SELECT 1 FROM collab_document_replicas r
              WHERE r.account_id = $1 AND r.org_id = $2 AND r.document_id = $3
                AND r.snapshot_generation = $5
                AND r.snapshot_commit_token = $6
            )`,
        params: [
          ...identityParams,
          updateId,
          input.nextGeneration,
          input.snapshotToken,
        ],
      })),
    ];
    await this.db.runTransaction(statements);
    const committed = await this.db.query<{
      snapshot_generation: number;
      snapshot_commit_token: string | null;
    }>(
      `SELECT snapshot_generation, snapshot_commit_token
       FROM collab_document_replicas
       WHERE account_id = $1 AND org_id = $2 AND document_id = $3`,
      identityParams
    );
    const didCommit =
      committed.rows[0]?.snapshot_generation === input.nextGeneration &&
      committed.rows[0]?.snapshot_commit_token === input.snapshotToken;
    if (didCommit) this.invalidateStorageBudget(input.identity.accountId);
    return didCommit;
  }

  async markIncomplete(identity: LocalReplicaIdentity): Promise<void> {
    await this.db.query(
      `UPDATE collab_document_replicas
      SET completeness = 'incomplete', updated_at = $4
      WHERE account_id = $1 AND org_id = $2 AND document_id = $3`,
      [...this.identityParams(identity), new Date()]
    );
  }

  async markComplete(identity: LocalReplicaIdentity): Promise<void> {
    await this.db.query(
      `UPDATE collab_document_replicas
       SET completeness = 'complete', updated_at = $4
       WHERE account_id = $1 AND org_id = $2 AND document_id = $3`,
      [...this.identityParams(identity), new Date()]
    );
  }

  async quarantine(
    identity: LocalReplicaIdentity,
    reason: string
  ): Promise<void> {
    await this.db.query(
      `UPDATE collab_document_replicas
      SET completeness = 'corrupt', quarantine_reason = $4,
          quarantined_at = $5, updated_at = $5
      WHERE account_id = $1 AND org_id = $2 AND document_id = $3`,
      [...this.identityParams(identity), reason, new Date()]
    );
    logger.main.warn("[CollabOfflineMetric]", {
      metric: "replica_quarantined",
      count: 1,
    });
  }

  async resetForCleanHydration(identity: LocalReplicaIdentity): Promise<void> {
    await this.db.runTransaction([
      {
        sql: `UPDATE collab_document_replicas
          SET encrypted_snapshot = NULL, snapshot_checksum = NULL,
              snapshot_generation = 0, last_server_seq = 0,
              completeness = 'corrupt', updated_at = $4
          WHERE account_id = $1 AND org_id = $2 AND document_id = $3`,
        params: [...this.identityParams(identity), new Date()],
      },
      {
        sql: `DELETE FROM collab_document_replica_updates
          WHERE account_id = $1 AND org_id = $2 AND document_id = $3`,
        params: this.identityParams(identity),
      },
    ]);
    this.invalidateStorageBudget(identity.accountId);
  }

  async discard(identity: LocalReplicaIdentity): Promise<void> {
    const activeOutbox = await this.db.query<{ batch_id: string }>(
      `SELECT batch_id FROM collab_document_outbox
       WHERE account_id = $1 AND org_id = $2 AND document_id = $3
         AND state <> 'rejected'
       LIMIT 1`,
      this.identityParams(identity)
    );
    if (activeOutbox.rows.length > 0) {
      throw new Error("LOCAL_REPLICA_HAS_ACTIVE_OUTBOX");
    }
    await this.db.query(
      `DELETE FROM collab_document_replicas
       WHERE account_id = $1 AND org_id = $2 AND document_id = $3`,
      this.identityParams(identity)
    );
    this.invalidateStorageBudget(identity.accountId);
  }

  async hasAccountData(accountId: string): Promise<boolean> {
    const result = await this.db.query<{ account_id: string }>(
      `SELECT account_id FROM collab_document_replicas
       WHERE account_id = $1 LIMIT 1`,
      [accountId]
    );
    return result.rows.length > 0;
  }

  async assertAccountPurgeAllowed(accountId: string, force = false): Promise<void> {
    if (!force) {
      const activeOutbox = await this.db.query<{ batch_id: string }>(
        `SELECT batch_id FROM collab_document_outbox
         WHERE account_id = $1 LIMIT 1`,
        [accountId]
      );
      if (activeOutbox.rows.length > 0) {
        throw new Error("LOCAL_REPLICA_HAS_PENDING_OUTBOX");
      }
    }
  }

  async purgeByAccount(accountId: string, force = false): Promise<void> {
    await this.assertAccountPurgeAllowed(accountId, force);
    await this.db.query(
      "DELETE FROM collab_document_replicas WHERE account_id = $1",
      [accountId]
    );
    await this.keyProvider.deleteKey?.(accountId);
    this.invalidateStorageBudget(accountId);
  }

  async purgeByOrg(accountId: string, orgId: string): Promise<void> {
    await this.db.query(
      "DELETE FROM collab_document_replicas WHERE account_id = $1 AND org_id = $2",
      [accountId, orgId]
    );
    this.invalidateStorageBudget(accountId);
  }

  async getStorageUsage(accountId: string): Promise<LocalReplicaStorageUsage> {
    const replicas = await this.db.query<{
      account_id: string;
      org_id: string;
      document_id: string;
      encrypted_bytes: number | bigint | string;
      last_accessed_at: unknown;
      clean: boolean | number;
    }>(
      `SELECT r.account_id, r.org_id, r.document_id, r.last_accessed_at,
              COALESCE(OCTET_LENGTH(r.encrypted_snapshot), 0)
              + COALESCE(OCTET_LENGTH(r.staged_encrypted_snapshot), 0)
              + COALESCE((
                  SELECT SUM(OCTET_LENGTH(u.encrypted_update))
                  FROM collab_document_replica_updates u
                  WHERE u.account_id = r.account_id AND u.org_id = r.org_id
                    AND u.document_id = r.document_id
                ), 0)
              + COALESCE((
                  SELECT SUM(OCTET_LENGTH(o.encrypted_update))
                  FROM collab_document_outbox o
                  WHERE o.account_id = r.account_id AND o.org_id = r.org_id
                    AND o.document_id = r.document_id
                ), 0) AS encrypted_bytes,
              (r.completeness = 'complete' AND NOT EXISTS (
                SELECT 1 FROM collab_document_outbox o
                WHERE o.account_id = r.account_id AND o.org_id = r.org_id
                  AND o.document_id = r.document_id
              )) AS clean
       FROM collab_document_replicas r WHERE r.account_id = $1`,
      [accountId]
    );
    const replicaUsage = replicas.rows.map((row) => {
      return {
        identity: {
          accountId: row.account_id,
          orgId: row.org_id,
          documentId: row.document_id,
        },
        encryptedBytes: Number(row.encrypted_bytes),
        lastAccessedAt: toMillis(row.last_accessed_at) ?? 0,
        clean: row.clean === true || Number(row.clean) === 1,
      };
    });
    return {
      replicaCount: replicas.rows.length,
      encryptedBytes: replicaUsage.reduce(
        (sum, replica) => sum + replica.encryptedBytes,
        0
      ),
      replicas: replicaUsage,
    };
  }

  async enforceStorageBudget(
    accountId: string,
    isPinned: (identity: LocalReplicaIdentity) => boolean = () => false,
    requiredBytes = 0
  ): Promise<LocalReplicaStorageUsage> {
    let usage = await this.getStorageUsage(accountId);
    if (usage.encryptedBytes + requiredBytes <= this.accountBudgetBytes) {
      this.invalidateStorageBudget(accountId);
      return usage;
    }
    const candidates = usage.replicas
      .filter((replica) => replica.clean && !isPinned(replica.identity))
      .sort(
        (left, right) =>
          left.lastAccessedAt - right.lastAccessedAt ||
          left.identity.orgId.localeCompare(right.identity.orgId) ||
          left.identity.documentId.localeCompare(right.identity.documentId)
      );
    for (const candidate of candidates) {
      // Re-check immediately before dispatching the delete. A renderer can
      // still attach while the DB worker is executing; such a rare TOCTOU is
      // safe because only clean replicas are eligible and the attached window
      // can self-heal from the server (or sibling fan-out while offline).
      if (isPinned(candidate.identity)) continue;
      const deleted = await this.db.query<{ document_id: string }>(
        `DELETE FROM collab_document_replicas
         WHERE account_id = $1 AND org_id = $2 AND document_id = $3
           AND completeness = 'complete'
           AND NOT EXISTS (
             SELECT 1 FROM collab_document_outbox o
             WHERE o.account_id = $1 AND o.org_id = $2 AND o.document_id = $3
           )
         RETURNING document_id`,
        this.identityParams(candidate.identity)
      );
      if (deleted.rows.length === 0) continue;
      logger.main.info("[CollabOfflineMetric]", {
        metric: "storage_eviction",
        storageKind: "replica",
        evictedBytes: candidate.encryptedBytes,
      });
      usage = {
        replicaCount: usage.replicaCount - 1,
        encryptedBytes: Math.max(0, usage.encryptedBytes - candidate.encryptedBytes),
        replicas: usage.replicas.filter(
          (replica) =>
            replica.identity.orgId !== candidate.identity.orgId ||
            replica.identity.documentId !== candidate.identity.documentId
        ),
      };
      if (usage.encryptedBytes + requiredBytes <= this.accountBudgetBytes) {
        const verified = await this.getStorageUsage(accountId);
        if (verified.encryptedBytes + requiredBytes <= this.accountBudgetBytes) {
          this.invalidateStorageBudget(accountId);
          return verified;
        }
        usage = verified;
      }
    }
    logger.main.error("[CollabOfflineMetric]", {
      metric: "disk_full",
      storageKind: "replica",
      requiredBytes,
      budgetBytes: this.accountBudgetBytes,
    });
    throw new Error("LOCAL_REPLICA_STORAGE_BUDGET_EXCEEDED");
  }

  async listPendingOutboxes(
    accountId?: string
  ): Promise<LocalReplicaPendingOutbox[]> {
    const accountFilter = accountId ? "WHERE o.account_id = $1" : "";
    const result = await this.db.query<PendingOutboxMetadataRow>(
      `SELECT o.account_id, o.org_id, o.document_id, r.document_type,
              SUM(CASE WHEN o.state = 'queued' THEN 1 ELSE 0 END) AS queued_count,
              SUM(CASE WHEN o.state = 'inflight' THEN 1 ELSE 0 END) AS inflight_count,
              SUM(CASE WHEN o.state = 'rejected' THEN 1 ELSE 0 END) AS rejected_count
       FROM collab_document_outbox o
       JOIN collab_document_replicas r
         ON r.account_id = o.account_id AND r.org_id = o.org_id
        AND r.document_id = o.document_id
       ${accountFilter}
       GROUP BY o.account_id, o.org_id, o.document_id, r.document_type
       ORDER BY o.account_id, o.org_id, o.document_id`,
      accountId ? [accountId] : []
    );
    return result.rows.map((row) => ({
      identity: {
        accountId: row.account_id,
        orgId: row.org_id,
        documentId: row.document_id,
      },
      documentType: row.document_type,
      queuedCount: Number(row.queued_count),
      inflightCount: Number(row.inflight_count),
      rejectedCount: Number(row.rejected_count),
    }));
  }

  async migrateLegacyPendingUpdate(
    identity: LocalReplicaIdentity,
    documentType: string,
    update: Uint8Array
  ): Promise<boolean> {
    const updateId = `legacy-${checksum(update)}`;
    const input: AppendLocalReplicaUpdateInput = {
      identity,
      documentType,
      updateId,
      update,
      snapshotGeneration: 0,
    };
    await this.prepareForAppend(
      identity.accountId,
      this.estimateLocalAppendBytes(input),
      (candidate) =>
        candidate.orgId === identity.orgId &&
        candidate.documentId === identity.documentId
    );
    await this.appendLocalUpdate(input);
    const committed = await this.db.query<{ batch_id: string }>(
      `SELECT batch_id FROM collab_document_outbox
       WHERE account_id = $1 AND org_id = $2 AND document_id = $3
         AND batch_id = $4
       LIMIT 1`,
      [...this.identityParams(identity), updateId]
    );
    return committed.rows.length === 1;
  }

  private upsertReplicaStatement(
    identity: LocalReplicaIdentity,
    documentType: string,
    snapshotGeneration: number,
    now: Date,
    lastServerSeq = 0
  ): { sql: string; params: unknown[] } {
    return {
      sql: `INSERT INTO collab_document_replicas
        (account_id, org_id, document_id, document_type, encoding_version,
         snapshot_generation, last_server_seq, completeness,
         created_at, updated_at, last_accessed_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'complete',$8,$8,$8)
        ON CONFLICT (account_id, org_id, document_id) DO UPDATE SET
          document_type = EXCLUDED.document_type,
          last_server_seq = CASE
            WHEN collab_document_replicas.last_server_seq > EXCLUDED.last_server_seq
            THEN collab_document_replicas.last_server_seq ELSE EXCLUDED.last_server_seq END,
          updated_at = EXCLUDED.updated_at,
          last_accessed_at = EXCLUDED.last_accessed_at`,
      params: [
        ...this.identityParams(identity),
        documentType,
        ENCODING_VERSION,
        snapshotGeneration,
        lastServerSeq,
        now,
      ],
    };
  }

  private identityParams(
    identity: LocalReplicaIdentity
  ): [string, string, string] {
    return [identity.accountId, identity.orgId, identity.documentId];
  }

  private invalidateStorageBudget(accountId: string): void {
    this.accountBudgetEstimates.delete(accountId);
  }

  private async encrypt(
    identity: LocalReplicaIdentity,
    purpose: ReplicaPurpose,
    plaintext: Uint8Array
  ): Promise<Buffer> {
    const key = Buffer.from(await this.keyProvider.getKey(identity.accountId));
    if (key.byteLength !== 32)
      throw new Error("local replica device key must be 32 bytes");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(aad(identity, purpose, ENCODING_VERSION));
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
  }

  private async decrypt(
    identity: LocalReplicaIdentity,
    purpose: ReplicaPurpose,
    encodingVersion: number,
    stored: Uint8Array,
    expectedChecksum: string | null
  ): Promise<Uint8Array> {
    const bytes = Buffer.from(stored);
    if (!expectedChecksum || checksum(bytes) !== expectedChecksum) {
      throw new Error("local replica encrypted payload checksum mismatch");
    }
    if (encodingVersion !== ENCODING_VERSION || bytes.byteLength < 28) {
      throw new Error(
        `unsupported local replica encoding version ${encodingVersion}`
      );
    }
    const key = Buffer.from(await this.keyProvider.getKey(identity.accountId));
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      bytes.subarray(0, 12)
    );
    decipher.setAAD(aad(identity, purpose, encodingVersion));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([
      decipher.update(bytes.subarray(28)),
      decipher.final(),
    ]);
  }
}

let singleton: CollabDocumentReplicaStore | null = null;

export function getCollabDocumentReplicaStore(): CollabDocumentReplicaStore {
  singleton ??= new CollabDocumentReplicaStore();
  return singleton;
}
