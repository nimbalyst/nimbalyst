import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

vi.mock("electron", () => ({
  app: { getPath: () => os.tmpdir() },
  safeStorage: { isEncryptionAvailable: () => false },
}));

import {
  CollabAssetStore,
  type CollabAssetDeviceKeyProvider,
} from "../CollabAssetStore";
import { SQLiteDatabase } from "../../database/sqlite/SQLiteDatabase";

const POSTGRES_SCHEMA = `
  CREATE TABLE collab_document_replicas (
    account_id TEXT NOT NULL, org_id TEXT NOT NULL, document_id TEXT NOT NULL,
    document_type TEXT NOT NULL, encoding_version INTEGER NOT NULL DEFAULT 1,
    snapshot_generation INTEGER NOT NULL DEFAULT 0, last_server_seq BIGINT NOT NULL DEFAULT 0,
    completeness TEXT NOT NULL DEFAULT 'complete', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_accessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (account_id, org_id, document_id)
  );
  CREATE TABLE collab_document_outbox (
    batch_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, org_id TEXT NOT NULL,
    document_id TEXT NOT NULL, encrypted_update BYTEA NOT NULL,
    encoding_version INTEGER NOT NULL DEFAULT 1, update_checksum TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'queued', attempt_count INTEGER NOT NULL DEFAULT 0,
    last_error_code TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE collab_document_assets (
    account_id TEXT NOT NULL, org_id TEXT NOT NULL, document_id TEXT NOT NULL,
    asset_id TEXT NOT NULL, encrypted_asset BYTEA NOT NULL,
    encoding_version INTEGER NOT NULL DEFAULT 1, asset_checksum TEXT NOT NULL,
    plaintext_size BIGINT NOT NULL, upload_state TEXT NOT NULL DEFAULT 'cached',
    attempt_count INTEGER NOT NULL DEFAULT 0, last_error_code TEXT,
    next_attempt_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_accessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (account_id, org_id, document_id, asset_id)
  );
`;

const documentIdentity = {
  accountId: "account-a",
  orgId: "org-a",
  documentId: "document-a",
};
const assetIdentity = { ...documentIdentity, assetId: "asset-a" };

interface TestDatabase {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  runTransaction(
    statements: Array<{ sql: string; params?: unknown[] }>
  ): Promise<void>;
}

describe.each(["pglite", "sqlite"] as const)(
  "CollabAssetStore (%s)",
  (backend) => {
    let db: TestDatabase;
    let close: () => Promise<void>;
    let tempDir: string | null = null;
    let store: CollabAssetStore;
    const deleteKey = vi.fn(async () => undefined);
    const keyProvider: CollabAssetDeviceKeyProvider = {
      getKey: async () => new Uint8Array(32).fill(11),
      deleteKey,
    };

    beforeEach(async () => {
      deleteKey.mockClear();
      if (backend === "pglite") {
        const pglite = new PGlite();
        await pglite.exec(POSTGRES_SCHEMA);
        db = {
          query: (sql, params) => pglite.query(sql, params),
          runTransaction: async (statements) => {
            await pglite.transaction(async (tx) => {
              for (const statement of statements)
                await tx.query(statement.sql, statement.params);
            });
          },
        };
        close = () => pglite.close();
      } else {
        tempDir = await fs.mkdtemp(
          path.join(os.tmpdir(), "nimbalyst-asset-sqlite-")
        );
        const sqlite = new SQLiteDatabase({
          dbDir: tempDir,
          schemaDir: path.resolve(__dirname, "../../database/sqlite/schemas"),
        });
        await sqlite.initialize();
        db = sqlite;
        close = () => sqlite.close();
      }
      store = new CollabAssetStore(db, keyProvider);
    });

    afterEach(async () => {
      await close();
      if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    });

    it("round-trips a cached blob encrypted under asset-bound AAD", async () => {
      const bytes = new Uint8Array([1, 2, 3, 4]);
      await store.cacheAsset({
        identity: assetIdentity,
        bytes,
        mimeType: "image/png",
        fileName: "diagram.png",
      });

      const loaded = await store.loadAsset(assetIdentity);
      expect([...loaded!.bytes]).toEqual([...bytes]);
      expect(loaded).toMatchObject({
        mimeType: "image/png",
        fileName: "diagram.png",
        uploadState: "cached",
      });

      const raw = await db.query<{ encrypted_asset: Uint8Array }>(
        "SELECT encrypted_asset FROM collab_document_assets WHERE asset_id = $1",
        [assetIdentity.assetId]
      );
      expect([...raw.rows[0].encrypted_asset]).not.toEqual([...bytes]);
    });

    it("rejects ciphertext copied under the wrong asset identity", async () => {
      await store.cacheAsset({
        identity: assetIdentity,
        bytes: new Uint8Array([4, 3, 2, 1]),
        mimeType: "image/png",
        fileName: "bound.png",
      });
      const wrongIdentity = { ...assetIdentity, assetId: "asset-b" };
      await db.query(
        `UPDATE collab_document_assets SET asset_id = $5
         WHERE account_id = $1 AND org_id = $2 AND document_id = $3 AND asset_id = $4`,
        [
          assetIdentity.accountId,
          assetIdentity.orgId,
          assetIdentity.documentId,
          assetIdentity.assetId,
          wrongIdentity.assetId,
        ]
      );

      await expect(store.loadAsset(wrongIdentity)).rejects.toThrow();
    });

    it("durably queues an offline upload and clears only after drain acknowledgement", async () => {
      await store.enqueueUpload({
        identity: assetIdentity,
        bytes: new Uint8Array([9, 8, 7]),
        mimeType: "application/octet-stream",
        fileName: "offline.bin",
      });

      expect(
        await store.listPendingUploads(documentIdentity.accountId)
      ).toHaveLength(1);
      await expect(store.claimUpload(assetIdentity)).resolves.toBe(true);
      expect((await store.loadAsset(assetIdentity))?.uploadState).toBe(
        "inflight"
      );
      await store.markUploaded(assetIdentity);
      expect(
        await store.listPendingUploads(documentIdentity.accountId)
      ).toEqual([]);
      expect((await store.loadAsset(assetIdentity))?.uploadState).toBe(
        "cached"
      );
    });

    it("persists retry eligibility and only requeues an inflight upload", async () => {
      await store.enqueueUpload({
        identity: assetIdentity,
        bytes: new Uint8Array([9]),
        mimeType: "application/octet-stream",
        fileName: "retry.bin",
      });
      await store.claimUpload(assetIdentity);
      const retryAt = Date.now() + 60_000;
      await store.recordUploadError(assetIdentity, "http_500", false, retryAt);

      expect((await store.listPendingUploads(assetIdentity.accountId))[0]).toMatchObject({
        uploadState: "queued",
        attemptCount: 1,
        lastErrorCode: "http_500",
        nextAttemptAt: retryAt,
      });

      await store.recordUploadError(assetIdentity, "forbidden", true, null);
      expect((await store.loadAsset(assetIdentity))?.uploadState).toBe("queued");
    });

    it("requires explicit force before account purge deletes a queued upload", async () => {
      await store.enqueueUpload({
        identity: assetIdentity,
        bytes: new Uint8Array([7]),
        mimeType: "image/png",
        fileName: "pending.png",
      });

      await expect(store.purgeByAccount(assetIdentity.accountId)).rejects.toThrow(
        "COLLAB_ASSET_HAS_PENDING_UPLOAD"
      );
      expect(await store.loadAsset(assetIdentity)).not.toBeNull();
      await store.purgeByAccount(assetIdentity.accountId, true);
      expect(await store.loadAsset(assetIdentity)).toBeNull();
    });

    it("subtracts the existing row when admitting an upsert", async () => {
      const input = {
        identity: assetIdentity,
        bytes: new Uint8Array([1, 2, 3]),
        mimeType: "image/png",
        fileName: "same.png",
      };
      await store.cacheAsset(input);
      const exactBudget = (await store.getStorageUsage(assetIdentity.accountId)).encryptedBytes;
      const limited = new CollabAssetStore(db, keyProvider, exactBudget);

      await expect(limited.cacheAsset(input)).resolves.toBeUndefined();
    });

    it("evicts clean cached assets in least-recently-used order", async () => {
      const oldest = { ...assetIdentity, assetId: "asset-oldest" };
      const newest = { ...assetIdentity, assetId: "asset-newest" };
      const incoming = { ...assetIdentity, assetId: "asset-incoming" };
      for (const identity of [oldest, newest]) {
        await store.cacheAsset({
          identity,
          bytes: new Uint8Array([1, 2, 3]),
          mimeType: "image/png",
          fileName: `${identity.assetId}.png`,
        });
      }
      await db.query(
        `UPDATE collab_document_assets SET last_accessed_at = $3
         WHERE account_id = $1 AND asset_id = $2`,
        [
          assetIdentity.accountId,
          oldest.assetId,
          new Date("2026-01-01T00:00:00.000Z"),
        ]
      );
      await db.query(
        `UPDATE collab_document_assets SET last_accessed_at = $3
         WHERE account_id = $1 AND asset_id = $2`,
        [
          assetIdentity.accountId,
          newest.assetId,
          new Date("2026-01-02T00:00:00.000Z"),
        ]
      );
      const usage = await store.getStorageUsage(assetIdentity.accountId);
      const limited = new CollabAssetStore(db, keyProvider, usage.encryptedBytes);

      await limited.cacheAsset({
        identity: incoming,
        bytes: new Uint8Array([1, 2, 3]),
        mimeType: "image/png",
        fileName: "incoming.png",
      });

      expect(await limited.loadAsset(oldest)).toBeNull();
      expect(await limited.loadAsset(newest)).not.toBeNull();
      expect(await limited.loadAsset(incoming)).not.toBeNull();
    });

    it("pins assets for a document with a pending Yjs outbox", async () => {
      await store.cacheAsset({
        identity: assetIdentity,
        bytes: new Uint8Array([5, 5, 5]),
        mimeType: "image/png",
        fileName: "pinned.png",
      });
      await db.query(
        `INSERT INTO collab_document_replicas
       (account_id, org_id, document_id, document_type)
       VALUES ($1,$2,$3,'markdown')`,
        [
          documentIdentity.accountId,
          documentIdentity.orgId,
          documentIdentity.documentId,
        ]
      );
      await db.query(
        `INSERT INTO collab_document_outbox
       (batch_id, account_id, org_id, document_id, encrypted_update, update_checksum, state)
       VALUES ('pending',$1,$2,$3,$4,'checksum','queued')`,
        [
          documentIdentity.accountId,
          documentIdentity.orgId,
          documentIdentity.documentId,
          new Uint8Array([1]),
        ]
      );

      const limited = new CollabAssetStore(db, keyProvider, 1);
      await expect(
        limited.enforceStorageBudget(documentIdentity.accountId)
      ).rejects.toThrow("COLLAB_ASSET_STORAGE_BUDGET_EXCEEDED");
      expect(await limited.loadAsset(assetIdentity)).not.toBeNull();
    });

    it("purges one account without touching another account", async () => {
      await store.cacheAsset({
        identity: assetIdentity,
        bytes: new Uint8Array([1]),
        mimeType: "image/png",
        fileName: "a.png",
      });
      const other = { ...assetIdentity, accountId: "account-b" };
      await store.cacheAsset({
        identity: other,
        bytes: new Uint8Array([2]),
        mimeType: "image/png",
        fileName: "b.png",
      });

      await store.purgeByAccount(documentIdentity.accountId);

      expect(await store.loadAsset(assetIdentity)).toBeNull();
      expect(await store.loadAsset(other)).not.toBeNull();
      expect(deleteKey).not.toHaveBeenCalled();
    });
  }
);
