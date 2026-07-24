import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

vi.mock("electron", () => ({
  app: { getPath: () => os.tmpdir() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => {
      throw new Error("not used");
    },
    decryptString: () => {
      throw new Error("not used");
    },
  },
}));

import {
  CollabDocumentReplicaStore,
  SafeStorageReplicaDeviceKeyProvider,
  type ReplicaDeviceKeyProvider,
} from "../CollabDocumentReplicaStore";
import { SQLiteDatabase } from "../../database/sqlite/SQLiteDatabase";

const POSTGRES_SCHEMA = `
  CREATE TABLE collab_document_replicas (
    account_id TEXT NOT NULL, org_id TEXT NOT NULL, document_id TEXT NOT NULL,
    document_type TEXT NOT NULL, encoding_version INTEGER NOT NULL DEFAULT 1,
    encrypted_snapshot BYTEA, snapshot_generation INTEGER NOT NULL DEFAULT 0,
    last_server_seq BIGINT NOT NULL DEFAULT 0,
    completeness TEXT NOT NULL DEFAULT 'complete', snapshot_checksum TEXT,
    staged_encrypted_snapshot BYTEA, staged_snapshot_generation INTEGER,
    staged_snapshot_checksum TEXT, staged_encoding_version INTEGER,
    staged_snapshot_token TEXT, snapshot_commit_token TEXT,
    quarantine_reason TEXT, quarantined_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_accessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (account_id, org_id, document_id)
  );
  CREATE TABLE collab_document_replica_updates (
    update_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, org_id TEXT NOT NULL,
    document_id TEXT NOT NULL, encrypted_update BYTEA NOT NULL, source TEXT NOT NULL,
    server_sequence BIGINT, snapshot_generation INTEGER NOT NULL DEFAULT 0,
    encoding_version INTEGER NOT NULL DEFAULT 1, update_checksum TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (account_id, org_id, document_id)
      REFERENCES collab_document_replicas(account_id, org_id, document_id) ON DELETE CASCADE
  );
  CREATE UNIQUE INDEX idx_collab_replica_updates_server_seq
    ON collab_document_replica_updates(account_id, org_id, document_id, server_sequence)
    WHERE server_sequence IS NOT NULL;
  CREATE TABLE collab_document_outbox (
    batch_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, org_id TEXT NOT NULL,
    document_id TEXT NOT NULL, encrypted_update BYTEA NOT NULL,
    encoding_version INTEGER NOT NULL DEFAULT 1, update_checksum TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'queued', attempt_count INTEGER NOT NULL DEFAULT 0,
    last_error_code TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (account_id, org_id, document_id)
      REFERENCES collab_document_replicas(account_id, org_id, document_id) ON DELETE CASCADE
  );
`;

const identity = {
  accountId: "account-a",
  orgId: "org-a",
  documentId: "document-a",
};

const fixedKeyProvider: ReplicaDeviceKeyProvider = {
  getKey: async () => new Uint8Array(32).fill(7),
};

it("refuses persistence when safeStorage is unavailable", async () => {
  await expect(
    new SafeStorageReplicaDeviceKeyProvider().getKey("account-no-keychain")
  ).rejects.toThrow("credential storage is unavailable");
});

interface TestDatabase {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  runTransaction(
    statements: Array<{ sql: string; params?: unknown[] }>
  ): Promise<void>;
}

describe.each(["pglite", "sqlite"] as const)(
  "CollabDocumentReplicaStore (%s)",
  (backend) => {
    let db: TestDatabase;
    let close: () => Promise<void>;
    let tempDir: string | null = null;
    let store: CollabDocumentReplicaStore;

    beforeEach(async () => {
      if (backend === "pglite") {
        const pglite = new PGlite();
        await pglite.exec(POSTGRES_SCHEMA);
        db = {
          query: (sql, params) => pglite.query(sql, params),
          runTransaction: async (statements) => {
            await pglite.transaction(async (tx) => {
              for (const statement of statements) {
                await tx.query(statement.sql, statement.params);
              }
            });
          },
        };
        close = () => pglite.close();
      } else {
        tempDir = await fs.mkdtemp(
          path.join(os.tmpdir(), "nimbalyst-replica-sqlite-")
        );
        const sqlite = new SQLiteDatabase({
          dbDir: tempDir,
          schemaDir: path.resolve(__dirname, "../../database/sqlite/schemas"),
        });
        await sqlite.initialize();
        db = sqlite;
        close = () => sqlite.close();
      }
      store = new CollabDocumentReplicaStore(db, fixedKeyProvider);
    });

    afterEach(async () => {
      await close();
      if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
    });

    it("round-trips encrypted local tail and outbox bytes", async () => {
      const update = new Uint8Array([1, 2, 3, 4, 5]);
      await store.appendLocalUpdate({
        identity,
        documentType: "markdown",
        updateId: "local-1",
        update,
        snapshotGeneration: 0,
      });

      const loaded = await store.load(identity);
      expect(loaded?.updates).toHaveLength(1);
      expect(loaded?.outbox).toHaveLength(1);
      expect([...loaded!.updates[0].update]).toEqual([...update]);
      expect([...loaded!.outbox[0].update]).toEqual([...update]);

      const raw = await db.query<{ encrypted_update: Uint8Array }>(
        "SELECT encrypted_update FROM collab_document_replica_updates WHERE update_id = $1",
        ["local-1"]
      );
      expect([...raw.rows[0].encrypted_update]).not.toEqual([...update]);
      expect(raw.rows[0].encrypted_update.byteLength).toBeGreaterThan(
        update.byteLength
      );
    });

    it("resets quarantined replica content for clean hydration without dropping the outbox", async () => {
      await store.appendLocalUpdate({
        identity,
        documentType: "markdown",
        updateId: "offline-edit",
        update: new Uint8Array([1, 2, 3]),
        snapshotGeneration: 0,
      });
      await store.quarantine(identity, "bad snapshot");

      await store.resetForCleanHydration(identity);

      let loaded = await store.load(identity);
      expect(loaded?.completeness).toBe("corrupt");
      expect(loaded?.lastServerSeq).toBe(0);
      expect(loaded?.snapshot).toBeNull();
      expect(loaded?.updates).toEqual([]);
      expect((await store.loadOutbox(identity)).map((entry) => entry.batchId)).toEqual([
        "offline-edit",
      ]);

      await store.markComplete(identity);
      loaded = await store.load(identity);
      expect(loaded?.completeness).toBe("complete");
      expect(loaded?.outbox.map((entry) => entry.batchId)).toEqual([
        "offline-edit",
      ]);
    });

    it("retains quarantined encrypted bytes for diagnostics", async () => {
      await store.appendRemoteUpdates({
        identity,
        documentType: "markdown",
        updates: [{
          updateId: "diagnostic-tail",
          update: new Uint8Array([3, 4, 5]),
          source: "remote",
          serverSequence: 3,
        }],
        snapshotGeneration: 0,
        lastServerSeq: 3,
      });
      await store.quarantine(identity, "simulated corruption");

      const retained = await db.query<{ encrypted_update: Uint8Array }>(
        `SELECT encrypted_update FROM collab_document_replica_updates
         WHERE account_id = $1 AND org_id = $2 AND document_id = $3`,
        [identity.accountId, identity.orgId, identity.documentId],
      );
      const quarantine = await db.query<{
        quarantine_reason: string;
        quarantined_at: unknown;
      }>(
        `SELECT quarantine_reason, quarantined_at
         FROM collab_document_replicas
         WHERE account_id = $1 AND org_id = $2 AND document_id = $3`,
        [identity.accountId, identity.orgId, identity.documentId],
      );
      expect(retained.rows).toHaveLength(1);
      expect(retained.rows[0].encrypted_update.byteLength).toBeGreaterThan(3);
      expect(quarantine.rows[0].quarantine_reason).toBe("simulated corruption");
      expect(quarantine.rows[0].quarantined_at).toBeTruthy();
      expect((await store.load(identity))?.completeness).toBe("corrupt");
    });

    it("discards one replica and cascades its tail and outbox", async () => {
      await store.appendLocalUpdate({
        identity,
        documentType: "markdown",
        updateId: "discarded-edit",
        update: new Uint8Array([4, 5, 6]),
        snapshotGeneration: 0,
      });
      await store.setOutboxState(identity, ["discarded-edit"], "rejected");

      await store.discard(identity);

      expect(await store.load(identity)).toBeNull();
      const updates = await db.query(
        "SELECT update_id FROM collab_document_replica_updates WHERE document_id = $1",
        [identity.documentId]
      );
      const outbox = await db.query(
        "SELECT batch_id FROM collab_document_outbox WHERE document_id = $1",
        [identity.documentId]
      );
      expect(updates.rows).toEqual([]);
      expect(outbox.rows).toEqual([]);
    });

    it("persists validated remote updates and the durable cursor together", async () => {
      await store.appendRemoteUpdates({
        identity,
        documentType: "markdown",
        updates: [
          {
            updateId: "remote-9",
            update: new Uint8Array([9, 8, 7]),
            source: "remote",
            serverSequence: 9,
          },
        ],
        snapshotGeneration: 0,
        lastServerSeq: 9,
      });

      const loaded = await store.load(identity);
      expect(loaded?.lastServerSeq).toBe(9);
      expect(loaded?.updates[0]).toMatchObject({
        source: "remote",
        serverSequence: 9,
      });
      expect([...loaded!.updates[0].update]).toEqual([9, 8, 7]);
    });

    it("records an ack sequence without advancing past unpersisted broadcasts", async () => {
      await store.appendRemoteUpdates({
        identity,
        documentType: "markdown",
        updates: [
          {
            updateId: "remote-5",
            update: new Uint8Array([5]),
            source: "remote",
            serverSequence: 5,
          },
        ],
        snapshotGeneration: 0,
        lastServerSeq: 5,
      });
      await store.appendLocalUpdate({
        identity,
        documentType: "markdown",
        updateId: "local-ack",
        update: new Uint8Array([4, 2]),
        snapshotGeneration: 0,
      });
      await store.acknowledgeOutbox(identity, ["local-ack"], 12);

      const loaded = await store.load(identity);
      expect(loaded?.outbox).toEqual([]);
      expect(loaded?.lastServerSeq).toBe(5);
      expect(
        loaded?.updates.find((update) => update.updateId === "local-ack")
      ).toMatchObject({ source: "local", serverSequence: 12 });
    });

    it("ignores an abandoned staged snapshot after a crash before tail pruning", async () => {
      await store.appendRemoteUpdates({
        identity,
        documentType: "markdown",
        updates: [{
          updateId: "pre-crash-tail",
          update: new Uint8Array([4, 4]),
          source: "remote",
          serverSequence: 4,
        }],
        snapshotGeneration: 0,
        lastServerSeq: 4,
      });

      const stageSnapshot = (store as unknown as {
        stageSnapshot(input: {
          identity: typeof identity;
          documentType: string;
          snapshot: Uint8Array;
          expectedGeneration: number;
          nextGeneration: number;
          snapshotToken: string;
        }): Promise<boolean>;
      }).stageSnapshot;
      await expect(stageSnapshot.call(store, {
        identity,
        documentType: "markdown",
        snapshot: new Uint8Array([9, 9, 9]),
        expectedGeneration: 0,
        nextGeneration: 1,
        snapshotToken: "crash-stage",
      })).resolves.toBe(true);

      // Simulate process death here: the staged bytes exist, but promotion and
      // tail pruning never ran. A fresh store must select generation 0.
      const restarted = new CollabDocumentReplicaStore(db, fixedKeyProvider);
      const loaded = await restarted.load(identity);
      expect(loaded?.snapshotGeneration).toBe(0);
      expect(loaded?.snapshot).toBeNull();
      expect(loaded?.updates.map((update) => update.updateId)).toEqual([
        "pre-crash-tail",
      ]);
    });

    it("promotes a snapshot without pruning a tail appended after its basis", async () => {
      await store.appendRemoteUpdates({
        identity,
        documentType: "markdown",
        updates: [{
          updateId: "snapshot-basis",
          update: new Uint8Array([1]),
          source: "remote",
          serverSequence: 1,
        }],
        snapshotGeneration: 0,
        lastServerSeq: 1,
      });

      const stagedStore = store as unknown as {
        stageSnapshot(input: {
          identity: typeof identity;
          documentType: string;
          snapshot: Uint8Array;
          expectedGeneration: number;
          nextGeneration: number;
          snapshotToken: string;
        }): Promise<boolean>;
        commitStagedSnapshot(input: {
          identity: typeof identity;
          expectedGeneration: number;
          nextGeneration: number;
          coveredUpdateIds: string[];
          snapshotToken: string;
        }): Promise<boolean>;
      };
      await expect(stagedStore.stageSnapshot({
        identity,
        documentType: "markdown",
        snapshot: new Uint8Array([8, 8]),
        expectedGeneration: 0,
        nextGeneration: 1,
        snapshotToken: "cas-stage",
      })).resolves.toBe(true);

      await store.appendRemoteUpdates({
        identity,
        documentType: "markdown",
        updates: [{
          updateId: "concurrent-tail",
          update: new Uint8Array([2]),
          source: "remote",
          serverSequence: 2,
        }],
        snapshotGeneration: 0,
        lastServerSeq: 2,
      });

      await expect(stagedStore.commitStagedSnapshot({
        identity,
        expectedGeneration: 0,
        nextGeneration: 1,
        coveredUpdateIds: ["snapshot-basis"],
        snapshotToken: "cas-stage",
      })).resolves.toBe(true);

      const loaded = await store.load(identity);
      expect(loaded?.snapshotGeneration).toBe(1);
      expect([...loaded!.snapshot!]).toEqual([8, 8]);
      expect(loaded?.lastServerSeq).toBe(2);
      expect(loaded?.updates.map((update) => update.updateId)).toEqual([
        "concurrent-tail",
      ]);
      expect(loaded?.updates[0].snapshotGeneration).toBe(1);
    });

    it("evicts the least-recently-used clean replica before a newer clean replica", async () => {
      const oldest = { ...identity, documentId: "oldest-clean" };
      const newest = { ...identity, documentId: "newest-clean" };
      for (const [target, sequence] of [[oldest, 31], [newest, 32]] as const) {
        await store.appendRemoteUpdates({
          identity: target,
          documentType: "markdown",
          updates: [{
            updateId: `remote-${sequence}`,
            update: new Uint8Array([sequence]),
            source: "remote",
            serverSequence: sequence,
          }],
          snapshotGeneration: 0,
          lastServerSeq: sequence,
        });
      }
      await db.query(
        `UPDATE collab_document_replicas SET last_accessed_at = $4
         WHERE account_id = $1 AND org_id = $2 AND document_id = $3`,
        [oldest.accountId, oldest.orgId, oldest.documentId, new Date(1_000)],
      );
      await db.query(
        `UPDATE collab_document_replicas SET last_accessed_at = $4
         WHERE account_id = $1 AND org_id = $2 AND document_id = $3`,
        [newest.accountId, newest.orgId, newest.documentId, new Date(2_000)],
      );
      const usage = await store.getStorageUsage(identity.accountId);
      expect(usage.replicas.map((replica) => replica.lastAccessedAt)).toEqual(
        expect.arrayContaining([1_000, 2_000]),
      );
      const oneReplicaBudget = Math.max(
        ...usage.replicas.map((replica) => replica.encryptedBytes),
      );
      const limitedStore = new CollabDocumentReplicaStore(
        db,
        fixedKeyProvider,
        oneReplicaBudget,
      );

      await limitedStore.enforceStorageBudget(identity.accountId);

      const remaining = await db.query<{ document_id: string }>(
        `SELECT document_id FROM collab_document_replicas
         WHERE account_id = $1 ORDER BY document_id`,
        [identity.accountId],
      );
      expect(remaining.rows).toEqual([{ document_id: newest.documentId }]);
    });

    it("accounts for encrypted storage with one aggregate metadata query", async () => {
      await store.appendRemoteUpdates({
        identity,
        documentType: "markdown",
        updates: [{
          updateId: "aggregate-accounting",
          update: new Uint8Array([1, 2, 3]),
          source: "remote",
          serverSequence: 41,
        }],
        snapshotGeneration: 0,
        lastServerSeq: 41,
      });
      const query = vi.spyOn(db, "query");

      const usage = await store.getStorageUsage(identity.accountId);

      expect(usage.encryptedBytes).toBeGreaterThan(3);
      expect(query).toHaveBeenCalledTimes(1);
      expect(String(query.mock.calls[0][0])).toContain(
        "SUM(OCTET_LENGTH(u.encrypted_update))"
      );
    });

    it("bounds exact storage checks between small append reservations", async () => {
      const getStorageUsage = vi.spyOn(store, "getStorageUsage");

      await store.prepareForAppend(identity.accountId, 128);
      await store.prepareForAppend(identity.accountId, 128);

      expect(getStorageUsage).toHaveBeenCalledTimes(1);
    });

    it("rejects an over-budget append before any replica bytes commit", async () => {
      const limitedStore = new CollabDocumentReplicaStore(db, fixedKeyProvider, 1);
      const input = {
        identity,
        documentType: "markdown",
        updateId: "must-not-commit",
        update: new Uint8Array([9, 9, 9]),
        snapshotGeneration: 0,
      };

      await expect(
        limitedStore.prepareForAppend(
          identity.accountId,
          limitedStore.estimateLocalAppendBytes(input)
        )
      ).rejects.toThrow("LOCAL_REPLICA_STORAGE_BUDGET_EXCEEDED");

      const replicas = await db.query<{ count: number | bigint }>(
        `SELECT COUNT(*) AS count FROM collab_document_replicas
         WHERE account_id = $1`,
        [identity.accountId]
      );
      expect(Number(replicas.rows[0].count)).toBe(0);
    });

    it("pins pending outboxes and reports budget exhaustion when nothing is safe to evict", async () => {
      await store.appendLocalUpdate({
        identity,
        documentType: "markdown",
        updateId: "pinned-offline-edit",
        update: new Uint8Array([5, 5, 5]),
        snapshotGeneration: 0,
      });
      const limitedStore = new CollabDocumentReplicaStore(db, fixedKeyProvider, 1);

      await expect(
        limitedStore.enforceStorageBudget(identity.accountId),
      ).rejects.toThrow("LOCAL_REPLICA_STORAGE_BUDGET_EXCEEDED");
      expect((await limitedStore.loadOutbox(identity)).map((row) => row.batchId)).toEqual([
        "pinned-offline-edit",
      ]);
    });

    it("never prunes an unacknowledged local tail or advances the server cursor", async () => {
      await store.appendLocalUpdate({
        identity,
        documentType: "markdown",
        updateId: "unacknowledged-local",
        update: new Uint8Array([6]),
        snapshotGeneration: 0,
      });

      await expect(store.replaceSnapshot({
        identity,
        documentType: "markdown",
        snapshot: new Uint8Array([7]),
        expectedGeneration: 0,
        nextGeneration: 1,
        lastServerSeq: 999,
        coveredUpdateIds: ["unacknowledged-local"],
      })).resolves.toBe(true);

      const loaded = await store.load(identity);
      expect(loaded?.lastServerSeq).toBe(0);
      expect(loaded?.updates.map((update) => update.updateId)).toEqual([
        "unacknowledged-local",
      ]);
      expect(loaded?.updates[0].snapshotGeneration).toBe(1);
      expect(loaded?.outbox.map((entry) => entry.batchId)).toEqual([
        "unacknowledged-local",
      ]);
    });

    it("absorbs a double-applied broadcast by remote sequence uniqueness", async () => {
      for (const updateId of ["broadcast-first", "broadcast-duplicate"]) {
        await store.appendRemoteUpdates({
          identity,
          documentType: "markdown",
          updates: [{
            updateId,
            update: new Uint8Array([7, 7]),
            source: "remote",
            serverSequence: 77,
          }],
          snapshotGeneration: 0,
          lastServerSeq: 0,
        });
      }

      const sequenced = await db.query<{ update_id: string }>(
        `SELECT update_id FROM collab_document_replica_updates
         WHERE account_id = $1 AND org_id = $2 AND document_id = $3
           AND server_sequence = 77`,
        [identity.accountId, identity.orgId, identity.documentId],
      );
      expect(sequenced.rows).toEqual([{ update_id: "broadcast-first" }]);
    });

    it("enumerates and atomically claims durable outbox batches", async () => {
      await store.appendLocalUpdate({
        identity,
        documentType: "markdown",
        updateId: "stable-batch-id",
        update: new Uint8Array([6, 2]),
        snapshotGeneration: 0,
      });

      const pending = await store.listPendingOutboxes(identity.accountId);
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        identity,
        documentType: "markdown",
        queuedCount: 1,
        inflightCount: 0,
        rejectedCount: 0,
      });
      const loadedOutbox = await store.loadOutbox(identity);
      expect(loadedOutbox[0]).toMatchObject({
        batchId: "stable-batch-id",
        state: "queued",
      });
      expect([...loadedOutbox[0].update]).toEqual([6, 2]);

      await expect(
        store.claimOutboxBatch(identity, ["stable-batch-id"])
      ).resolves.toBe(true);
      await expect(
        store.claimOutboxBatch(identity, ["stable-batch-id"])
      ).resolves.toBe(false);
      expect((await store.loadOutbox(identity))[0]).toMatchObject({
        state: "inflight",
        attemptCount: 1,
      });
    });

    it("claims multiple rows atomically and preserves the last error on requeue", async () => {
      for (const updateId of ["batch-a", "batch-b"]) {
        await store.appendLocalUpdate({
          identity,
          documentType: "markdown",
          updateId,
          update: new Uint8Array([updateId === "batch-a" ? 1 : 2]),
          snapshotGeneration: 0,
        });
      }

      await expect(
        store.claimOutboxBatch(identity, ["batch-a", "batch-b"])
      ).resolves.toBe(true);
      await store.recordOutboxError(
        identity,
        ["batch-a", "batch-b"],
        "write_rejected"
      );
      await store.setOutboxState(identity, ["batch-a", "batch-b"], "queued");

      expect(await store.loadOutbox(identity)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            batchId: "batch-a",
            state: "queued",
            attemptCount: 1,
            lastErrorCode: "write_rejected",
          }),
          expect.objectContaining({
            batchId: "batch-b",
            state: "queued",
            attemptCount: 1,
            lastErrorCode: "write_rejected",
          }),
        ])
      );

      await store.claimOutboxBatch(identity, ["batch-a", "batch-b"]);
      await store.acknowledgeOutbox(identity, ["batch-a", "batch-b"], 22);
      const acknowledged = await store.load(identity);
      expect(acknowledged?.outbox).toEqual([]);
      expect(
        acknowledged?.updates.find((update) => update.updateId === "batch-a")
      ).toMatchObject({ serverSequence: 22 });
      expect(
        acknowledged?.updates.find((update) => update.updateId === "batch-b")
      ).toMatchObject({ serverSequence: null });
    });

    it("never conflict-drops a snapshot that covers an existing update sequence", async () => {
      await store.appendRemoteUpdates({
        identity,
        documentType: "markdown",
        updates: [
          {
            updateId: "remote-collision",
            update: new Uint8Array([9]),
            source: "remote",
            serverSequence: 9,
          },
        ],
        snapshotGeneration: 0,
        lastServerSeq: 9,
      });
      await store.appendRemoteUpdates({
        identity,
        documentType: "markdown",
        updates: [
          {
            updateId: "snapshot-covering-9",
            update: new Uint8Array([8]),
            source: "server-snapshot",
            serverSequence: null,
          },
        ],
        snapshotGeneration: 0,
        lastServerSeq: 9,
      });

      const loaded = await store.load(identity);
      expect(loaded?.updates).toHaveLength(2);
      expect(
        loaded?.updates.find(
          (update) => update.updateId === "snapshot-covering-9"
        )
      ).toMatchObject({ source: "server-snapshot", serverSequence: null });
    });

    it("replaces a same-generation server snapshot instead of accumulating rows", async () => {
      for (const [updateId, byte] of [["snapshot-first", 7], ["snapshot-second", 8]] as const) {
        await store.appendRemoteUpdates({
          identity,
          documentType: "markdown",
          updates: [{
            updateId,
            update: new Uint8Array([byte]),
            source: "server-snapshot",
            serverSequence: null,
          }],
          snapshotGeneration: 0,
          lastServerSeq: 10,
        });
      }

      const snapshots = await db.query<{ update_id: string }>(
        `SELECT update_id FROM collab_document_replica_updates
         WHERE account_id = $1 AND org_id = $2 AND document_id = $3
           AND source = 'server-snapshot'`,
        [identity.accountId, identity.orgId, identity.documentId]
      );
      expect(snapshots.rows).toEqual([{ update_id: "snapshot-second" }]);
    });

    it("appends legacy pending bytes even when another durable outbox row exists", async () => {
      await store.appendLocalUpdate({
        identity,
        documentType: "markdown",
        updateId: "already-durable",
        update: new Uint8Array([1]),
        snapshotGeneration: 0,
      });

      await expect(store.migrateLegacyPendingUpdate(
        identity,
        "markdown",
        new Uint8Array([2])
      )).resolves.toBe(true);

      const loaded = await store.load(identity);
      expect(loaded?.outbox).toHaveLength(2);
      expect(loaded?.outbox.map((entry) => [...entry.update])).toEqual(
        expect.arrayContaining([[1], [2]])
      );
    });

    it("refuses to discard queued or inflight outbox rows but allows rejected recovery deletion", async () => {
      await store.appendLocalUpdate({
        identity,
        documentType: "markdown",
        updateId: "active-row",
        update: new Uint8Array([1]),
        snapshotGeneration: 0,
      });
      await expect(store.discard(identity)).rejects.toThrow(
        "LOCAL_REPLICA_HAS_ACTIVE_OUTBOX"
      );

      await store.setOutboxState(identity, ["active-row"], "rejected");
      await expect(store.discard(identity)).resolves.toBeUndefined();
      await expect(store.load(identity)).resolves.toBeNull();
    });

    it("requires an explicit force flag before an account purge can delete unsent rows", async () => {
      await store.appendLocalUpdate({
        identity,
        documentType: "markdown",
        updateId: "logout-pending",
        update: new Uint8Array([4]),
        snapshotGeneration: 0,
      });

      await expect(store.purgeByAccount(identity.accountId)).rejects.toThrow(
        "LOCAL_REPLICA_HAS_PENDING_OUTBOX"
      );
      expect(await store.listPendingOutboxes(identity.accountId)).toHaveLength(1);

      await expect(
        store.purgeByAccount(identity.accountId, true)
      ).resolves.toBeUndefined();
      expect(await store.listPendingOutboxes(identity.accountId)).toEqual([]);
    });

    it("binds ciphertext to account, org, document, purpose, and encoding version", async () => {
      await store.appendLocalUpdate({
        identity,
        documentType: "markdown",
        updateId: "aad-source",
        update: new Uint8Array([7, 7, 7]),
        snapshotGeneration: 0,
      });
      const raw = await db.query<{
        encrypted_update: Uint8Array;
        update_checksum: string;
      }>(
        "SELECT encrypted_update, update_checksum FROM collab_document_replica_updates WHERE update_id = $1",
        ["aad-source"]
      );
      const other = { ...identity, documentId: "document-b" };
      await db.runTransaction([
        {
          sql: `INSERT INTO collab_document_replicas
          (account_id, org_id, document_id, document_type)
          VALUES ($1,$2,$3,'markdown')`,
          params: [other.accountId, other.orgId, other.documentId],
        },
        {
          sql: `INSERT INTO collab_document_replica_updates
          (update_id, account_id, org_id, document_id, encrypted_update, source,
           snapshot_generation, encoding_version, update_checksum)
          VALUES ('aad-copy',$1,$2,$3,$4,'local',0,1,$5)`,
          params: [
            other.accountId,
            other.orgId,
            other.documentId,
            raw.rows[0].encrypted_update,
            raw.rows[0].update_checksum,
          ],
        },
      ]);

      await expect(store.load(other)).rejects.toThrow();
      const quarantined = await db.query<{ completeness: string }>(
        `SELECT completeness FROM collab_document_replicas
         WHERE account_id = $1 AND org_id = $2 AND document_id = $3`,
        [other.accountId, other.orgId, other.documentId]
      );
      expect(quarantined.rows[0].completeness).toBe("corrupt");
    });
  }
);
