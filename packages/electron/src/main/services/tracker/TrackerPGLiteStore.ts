/**
 * TrackerPGLiteStore
 *
 * Implements `TrackerPersistence` (from `@nimbalyst/runtime/sync`) over
 * the PGLite worker. Owned by the Electron host adapter
 * (`TrackerSyncManager`). One instance per workspace.
 *
 * Scope notes
 * -----------
 * - Projection writes (apply / rollback) hit `tracker_items`.
 * - Queue writes hit `tracker_transactions`.
 * - The store does NOT broadcast IPC events; that's the host adapter's
 *   job. Keeping persistence pure lets the engine's tests use the
 *   in-memory variant without IPC plumbing.
 * - `applyAndEnqueueAtomically` does both writes sequentially; PGLite's
 *   single-connection worker serializes them, and the worker-thread
 *   queue prevents interleaving with other callers. We do not wrap in
 *   BEGIN/COMMIT today because the worker's `transaction()` helper does
 *   not currently produce real SQL transactions -- if a crash lands
 *   between the two writes the next engine startup re-drives the
 *   projection via `applyRemoteItem` after bootstrap, which is correct.
 */

import type { AppDatabase } from '../../database/PGLiteDatabaseWorker';
import type {
  EncryptedTrackerItemEnvelope,
  SyncId,
  TrackerItemPayload,
  TrackerTransactionRow,
  TrackerTransactionState,
  TrackerMutationRejectCode,
  TrackerPersistence,
  TrackerRowSnapshot,
  LabelsMap,
} from '@nimbalyst/runtime/sync';
import { mergeLabelMaps, normalizeLegacyLabelValues, projectLabelsToValues } from '@nimbalyst/runtime/sync';
import type { TrackerItem } from '@nimbalyst/runtime';
import { trackerRecordToItem, type TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { logger } from '../../utils/logger';
import { toDbBoolean } from './trackerDbValue';
import { extractItemCustomFields } from './trackerRowCustomFields';

// ============================================================================
// Local-only field preservation on UPDATE
// ============================================================================
//
// JSONB keys in `tracker_items.data` that the wire payload never carries.
// On UPDATE we strip these from the incoming `data` and lift the existing
// row's values in -- the engine has no authoritative view of them.
//
// Keep in sync with `LOCAL_ONLY_PAYLOAD_FIELDS` in trackerProtocol.ts.
const LOCAL_ONLY_DATA_KEYS = ['linkedSessions'] as const;

/**
 * Normalize a payload timestamp (epoch ms number, ISO string, or Date) into
 * epoch milliseconds. Returns undefined when the value is missing or
 * unparseable so callers can fall back. Used to honor an item's authoritative
 * `updatedAt` when writing the `updated` column (NIM-1559).
 */
function toEpochMs(value: unknown): number | undefined {
  if (value == null) return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isNaN(t) ? undefined : t;
  }
  if (typeof value === 'string') {
    const t = Date.parse(value);
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
}

function toIsoTimestamp(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') return value;
  const t = toEpochMs(value);
  return t !== undefined ? new Date(t).toISOString() : undefined;
}

/**
 * Build a JSONB expression that merges `newData` with the local-only subset
 * of `existingData`. Inline because PGLite does not support stored
 * procedures and we want this to be a single SQL statement.
 *
 *   result = (newData - 'linkedSessions') || jsonb_build_object('linkedSessions', existingData->'linkedSessions')
 *
 * When existingData doesn't have linkedSessions, the build_object yields
 * `{"linkedSessions": null}` -- we filter that out via `strip_nulls`.
 */
function LOCAL_DATA_MERGE_SQL(newDataExpr: string, existingDataExpr: string): string {
  const stripKeys = LOCAL_ONLY_DATA_KEYS.map(k => `- '${k}'`).join(' ');
  const buildObjectArgs = LOCAL_ONLY_DATA_KEYS
    .map(k => `'${k}', ${existingDataExpr}->'${k}'`)
    .join(', ');
  return `(${newDataExpr} ${stripKeys} || jsonb_strip_nulls(jsonb_build_object(${buildObjectArgs})))`;
}

// ============================================================================
// Row shapes
// ============================================================================

interface PGLiteTrackerItemRow {
  id: string;
  type: string;
  data: unknown;
  workspace: string;
  document_path: string | null;
  line_number: number | null;
  created: Date | null;
  updated: Date | null;
  last_indexed: Date | null;
  issue_number: number | null;
  issue_key: string | null;
  sync_status: string | null;
  sync_id: string | number | null;
  body_version: string | number | null;
  deleted_at: Date | null;
  archived: boolean | null;
  source: string | null;
  source_ref: string | null;
  type_tags: string[] | null;
}

interface PGLiteTrackerTransactionRow {
  client_mutation_id: string;
  item_id: string;
  workspace_path: string;
  state: TrackerTransactionState;
  kind: 'create' | 'update' | 'delete';
  payload: unknown;
  enqueued_at: Date;
  started_at: Date | null;
  confirmed_sync_id: string | number | null;
  last_rejection: unknown;
}

// ============================================================================
// Store
// ============================================================================

export class TrackerPGLiteStore implements TrackerPersistence {
  constructor(
    private readonly db: AppDatabase,
    private readonly workspacePath: string,
  ) {}

  // --------------------------------------------------------------------------
  // Watermark
  // --------------------------------------------------------------------------

  /**
   * Read a single PGLite row back as a legacy `TrackerItem`. Used by the
   * host adapter to build `document-service:tracker-items-changed`
   * payloads for the renderer after a remote delta or self-originated ack
   * lands. Returns `null` for tombstoned or missing rows -- callers should
   * emit a `removed` event in that case.
   */
  async getTrackerItem(itemId: string): Promise<TrackerItem | null> {
    const result = await this.db.query<PGLiteTrackerItemRow>(
      `SELECT id, type, type_tags, data, workspace,
              document_path, line_number, issue_number, issue_key,
              sync_status, sync_id, body_version, deleted_at,
              archived, source, source_ref,
              created, updated, last_indexed
         FROM tracker_items
        WHERE id = $1 AND workspace = $2`,
      [itemId, this.workspacePath],
    );
    const row = result.rows[0];
    if (!row || row.deleted_at !== null) return null;
    return pgliteRowToTrackerItem(row, this.workspacePath);
  }

  async getMaxSyncId(): Promise<SyncId> {
    const result = await this.db.query<{ max_sync_id: string | number | null }>(
      `SELECT MAX(sync_id) as max_sync_id FROM tracker_items WHERE workspace = $1`,
      [this.workspacePath],
    );
    const raw = result.rows[0]?.max_sync_id;
    if (raw === null || raw === undefined) return 0;
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }

  // --------------------------------------------------------------------------
  // Projection writes
  // --------------------------------------------------------------------------

  async applyRemoteItem(
    envelope: EncryptedTrackerItemEnvelope,
    payload: TrackerItemPayload | null,
  ): Promise<void> {
    if (payload === null) {
      // Tombstone: mark deleted_at, drop sync_id-eligible fields.
      await this.db.query(
        `UPDATE tracker_items
           SET sync_id = $2,
               deleted_at = to_timestamp($3 / 1000.0),
               updated = NOW(),
               sync_status = 'synced'
         WHERE id = $1 AND workspace = $4`,
        [envelope.itemId, envelope.syncId, envelope.deletedAt ?? Date.now(), this.workspacePath],
      );
      return;
    }

    // Labels CRDT merge: union the incoming add-wins map with the local
    // map BEFORE projecting back into the legacy `labels` string[]. Read
    // the prior local map from `tracker_items.data->'labelsMap'`. The
    // server-confirmed envelope only adds and tombstones; it never deletes
    // entry IDs, so a stale incoming payload with fewer entries does not
    // erase concurrent local additions a peer hasn't ack'd yet.
    const priorRow = await this.db.query<{ labels_map: LabelsMap | string | null }>(
      `SELECT (data->'labelsMap') AS labels_map FROM tracker_items WHERE id = $1`,
      [envelope.itemId],
    );
    // Nimbalyst runs over either PGLite or better-sqlite3. The `data->'key'`
    // sub-extraction is NOT shape-uniform across the two backends: PGLite
    // returns a parsed JS object, but SQLite's JSON1 `->` operator returns
    // the sub-value as TEXT (a JSON string). If we let a string through,
    // `mergeLabelMaps({...string}, incoming)` spreads the JSON characters
    // into numeric-keyed entries, then merges in the real UUID-keyed
    // entries on top -- and `projectLabelsToValues` emits a leading `null`
    // in the values list because the first character entry has no `.value`.
    // The typeof check below handles both backends without privileging one.
    const rawLabelsMap = priorRow.rows[0]?.labels_map ?? undefined;
    const priorLabelsMap: LabelsMap | undefined =
      typeof rawLabelsMap === 'string' ? safeParseLabelsMap(rawLabelsMap) : rawLabelsMap;
    const mergedLabelsMap = mergeLabelMaps(priorLabelsMap, payload.labels);
    const mergedLabels = projectLabelsToValues(mergedLabelsMap);
    // Mutate the payload in place so `payloadToRecord` -> trackerRecordToItem
    // sees the merged projection. payload is freshly decrypted; no shared refs.
    payload.fields = { ...payload.fields, labels: mergedLabels };

    // Convert TrackerItemPayload (wire shape) into the legacy TrackerItem
    // shape that ElectronDocumentService / kanban already render. We build
    // a minimal TrackerRecord and pipe it through `trackerRecordToItem`
    // to avoid duplicating the field mapping logic.
    const record = payloadToRecord(envelope, payload, this.workspacePath);
    const item = trackerRecordToItem(record);
    item.labelsMap = mergedLabelsMap;

    // Upsert the row. The `data` JSONB carries everything not exposed as
    // a top-level column.
    const dataJson: Record<string, unknown> = { ...item };
    delete dataJson.id;
    delete dataJson.type;
    delete dataJson.workspace;
    delete dataJson.module;
    delete dataJson.lineNumber;
    delete dataJson.lastIndexed;
    delete dataJson.created;
    delete dataJson.updated;

    // `data` carries device-local keys (e.g. linkedSessions) that the wire
     // payload does not. Preserve those on UPDATE by JSONB-merging the
     // existing row's local-only subset on top of EXCLUDED.data. See
     // LOCAL_ONLY_PAYLOAD_FIELDS in trackerProtocol.ts -- this server-blind
     // merge keeps that contract honest at the storage layer too.
    //
    // Likewise `source`, `source_ref`, `document_path`, `line_number` are
    // local indexer concerns (where the item was discovered on disk); a
    // remote sync write should NOT clobber them with 'native'/null. Use
    // COALESCE-from-EXCLUDED-fallback-to-existing so a brand-new item still
    // gets the engine-provided defaults but an existing inline item keeps
    // its provenance.
    //
    // Issue-number conflict resolution: two clients that each had locally
    // assigned NIM-{N} before the new tracker room arbitrated them can
    // legitimately ship items with the same `(workspace, issue_number)`
    // pair. The partial unique index `idx_tracker_workspace_issue_number`
    // rejects the INSERT in that case, and the engine's bootstrap loop
    // used to silently die there. Detect the collision up front and
    // land the incoming row with NULL issue_number / issue_key -- the
    // data is preserved and the user can renumber later. NULLs are
    // exempt from the partial index.
    let effectiveIssueNumber: number | null = envelope.issueNumber ?? item.issueNumber ?? null;
    let effectiveIssueKey: string | null = envelope.issueKey ?? item.issueKey ?? null;
    if (effectiveIssueNumber !== null) {
      const conflict = await this.db.query<{ id: string }>(
        `SELECT id FROM tracker_items
         WHERE workspace = $1 AND issue_number = $2 AND id != $3
         LIMIT 1`,
        [this.workspacePath, effectiveIssueNumber, envelope.itemId],
      );
      if (conflict.rows.length > 0) {
        logger.main.warn(
          '[TrackerPGLiteStore] issue_number collision for incoming', envelope.itemId,
          'number:', effectiveIssueNumber,
          'conflicts with local:', conflict.rows[0].id,
          '-- landing incoming row with NULL issue_number',
        );
        effectiveIssueNumber = null;
        effectiveIssueKey = null;
      }
    }
    await this.db.query(
      `INSERT INTO tracker_items (
        id, type, type_tags, data, workspace,
        document_path, line_number, issue_number, issue_key,
        sync_status, sync_id, body_version, deleted_at,
        archived, source, source_ref, content,
        created, updated, last_indexed
      ) VALUES (
        $1, $2, $3, $4::jsonb, $5,
        $6, $7, $8, $9,
        'synced', $10, $11, NULL,
        $12, $13, $14, $15::jsonb,
        NOW(), to_timestamp($16 / 1000.0), NOW()
      )
      ON CONFLICT (id) DO UPDATE SET
        type = EXCLUDED.type,
        type_tags = EXCLUDED.type_tags,
        data = ${LOCAL_DATA_MERGE_SQL('EXCLUDED.data', 'tracker_items.data')},
        document_path = COALESCE(tracker_items.document_path, EXCLUDED.document_path),
        line_number = COALESCE(tracker_items.line_number, EXCLUDED.line_number),
        issue_number = COALESCE(EXCLUDED.issue_number, tracker_items.issue_number),
        issue_key = COALESCE(EXCLUDED.issue_key, tracker_items.issue_key),
        sync_status = 'synced',
        sync_id = EXCLUDED.sync_id,
        body_version = EXCLUDED.body_version,
        deleted_at = NULL,
        archived = EXCLUDED.archived,
        source = COALESCE(tracker_items.source, EXCLUDED.source),
        source_ref = COALESCE(tracker_items.source_ref, EXCLUDED.source_ref),
        content = EXCLUDED.content,
        updated = EXCLUDED.updated,
        last_indexed = NOW()`,
      [
        item.id,
        item.type,
        item.typeTags ?? [item.type],
        JSON.stringify(dataJson),
        this.workspacePath,
        item.module || null,
        item.lineNumber ?? null,
        effectiveIssueNumber,
        effectiveIssueKey,
        envelope.syncId,
        payload.bodyVersion ?? 0,
        toDbBoolean(item.archived),
        item.source || 'native',
        item.sourceRef ?? null,
        item.content != null ? JSON.stringify(item.content) : null,
        // NIM-1559: honor the sender's authoritative updatedAt instead of
        // stamping NOW() on every accepted delta. A bootstrap/echo re-apply
        // of an unchanged envelope then writes back the SAME timestamp rather
        // than advancing `updated` to the receive time. `last_indexed` still
        // reflects local receive time.
        envelope.updatedAt ?? Date.now(),
      ],
    );
  }

  async applyOptimistic(
    itemId: string,
    payload: TrackerItemPayload | null,
  ): Promise<TrackerRowSnapshot> {
    const snapshot = await this.snapshotRow(itemId);

    if (payload === null) {
      // Local tombstone: don't bump sync_id (server still owns it).
      await this.db.query(
        `UPDATE tracker_items
           SET deleted_at = NOW(),
               sync_status = 'pending',
               updated = NOW()
         WHERE id = $1 AND workspace = $2`,
        [itemId, this.workspacePath],
      );
      return snapshot;
    }

    // Optimistic upsert: reuse the same row-shape build as applyRemoteItem
    // but mark sync_status='pending' and leave sync_id at the existing value.
    const existingSyncId = snapshot.syncId ?? 0;
    const placeholderEnvelope: EncryptedTrackerItemEnvelope = {
      itemId,
      syncId: existingSyncId,
      encryptedPayload: 'optimistic',
      iv: 'optimistic-iv',
      updatedAt: Date.now(),
      deletedAt: null,
      orgKeyFingerprint: null,
    };
    // The producer (trackerItemToPayload) already diffed the user's
    // string[] into a CRDT map and put it in `payload.labels`. Project
    // back to the legacy string[] view so the kanban/table reflects the
    // optimistic state before the server ack.
    const optimisticLabels = projectLabelsToValues(payload.labels);
    payload.fields = { ...payload.fields, labels: optimisticLabels };
    const record = payloadToRecord(placeholderEnvelope, payload, this.workspacePath);
    const item = trackerRecordToItem(record);
    item.labelsMap = payload.labels;

    // NIM-1559: honor the payload's authoritative updatedAt instead of
    // stamping NOW(). A pending transaction is re-driven through
    // applyOptimistic on every startup (loadPendingTransactions); the stored
    // payload's `system.updatedAt` is frozen at enqueue time, so re-applying
    // it writes the SAME timestamp each restart rather than advancing
    // `updated` to the restart time. A genuine new edit still carries a fresh
    // updatedAt from the producer.
    const optimisticUpdatedAtMs = toEpochMs(payload.system?.updatedAt) ?? Date.now();

    const dataJson: Record<string, unknown> = { ...item };
    delete dataJson.id;
    delete dataJson.type;
    delete dataJson.workspace;
    delete dataJson.module;
    delete dataJson.lineNumber;
    delete dataJson.lastIndexed;
    delete dataJson.created;
    delete dataJson.updated;

    // See applyRemoteItem for why the JSONB-merge + COALESCE pattern is
    // needed: device-local fields (linkedSessions, source provenance) must
    // not be clobbered when the engine optimistically rewrites the row from
    // a wire payload that does not carry them.
    await this.db.query(
      `INSERT INTO tracker_items (
        id, type, type_tags, data, workspace,
        document_path, line_number, issue_number, issue_key,
        sync_status, sync_id, body_version, deleted_at,
        archived, source, source_ref, content,
        created, updated, last_indexed
      ) VALUES (
        $1, $2, $3, $4::jsonb, $5,
        $6, $7, $8, $9,
        'pending', $10, $11, NULL,
        $12, $13, $14, $15::jsonb,
        NOW(), to_timestamp($16 / 1000.0), NOW()
      )
      ON CONFLICT (id) DO UPDATE SET
        type = EXCLUDED.type,
        type_tags = EXCLUDED.type_tags,
        data = ${LOCAL_DATA_MERGE_SQL('EXCLUDED.data', 'tracker_items.data')},
        document_path = COALESCE(tracker_items.document_path, EXCLUDED.document_path),
        line_number = COALESCE(tracker_items.line_number, EXCLUDED.line_number),
        source = COALESCE(tracker_items.source, EXCLUDED.source),
        source_ref = COALESCE(tracker_items.source_ref, EXCLUDED.source_ref),
        sync_status = 'pending',
        deleted_at = NULL,
        archived = EXCLUDED.archived,
        body_version = EXCLUDED.body_version,
        updated = EXCLUDED.updated`,
      [
        item.id,
        item.type,
        item.typeTags ?? [item.type],
        JSON.stringify(dataJson),
        this.workspacePath,
        item.module || null,
        item.lineNumber ?? null,
        item.issueNumber ?? null,
        item.issueKey ?? null,
        existingSyncId,
        payload.bodyVersion ?? 0,
        toDbBoolean(item.archived),
        item.source || 'native',
        item.sourceRef ?? null,
        item.content != null ? JSON.stringify(item.content) : null,
        optimisticUpdatedAtMs,
      ],
    );

    return snapshot;
  }

  async rollbackOptimistic(itemId: string, snapshot: TrackerRowSnapshot): Promise<void> {
    if (snapshot.payload === null && !snapshot.isTombstone && snapshot.syncId === null) {
      // No prior row -- delete the optimistic insert.
      await this.db.query(
        `DELETE FROM tracker_items WHERE id = $1 AND workspace = $2`,
        [itemId, this.workspacePath],
      );
      return;
    }

    if (snapshot.isTombstone) {
      // Restore the tombstone marker.
      await this.db.query(
        `UPDATE tracker_items
           SET deleted_at = NOW(),
               sync_status = 'synced'
         WHERE id = $1 AND workspace = $2`,
        [itemId, this.workspacePath],
      );
      return;
    }

    // Restore the prior payload. Synthesize an envelope at the existing
    // sync_id (the server-confirmed state we want to roll back TO).
    if (snapshot.payload !== null) {
      const restoredUpdatedAt = toEpochMs(snapshot.payload.system?.updatedAt) ?? Date.now();
      const envelope: EncryptedTrackerItemEnvelope = {
        itemId,
        syncId: snapshot.syncId ?? 0,
        encryptedPayload: 'restored',
        iv: 'restored-iv',
        updatedAt: restoredUpdatedAt,
        deletedAt: null,
        orgKeyFingerprint: null,
      };
      await this.applyRemoteItem(envelope, snapshot.payload);
    }
  }

  private async snapshotRow(itemId: string): Promise<TrackerRowSnapshot> {
    const result = await this.db.query<PGLiteTrackerItemRow>(
      `SELECT id, type, type_tags, data, workspace,
              document_path, line_number, issue_number, issue_key,
              sync_status, sync_id, body_version, deleted_at,
              archived, source, source_ref,
              created, updated, last_indexed
         FROM tracker_items
        WHERE id = $1 AND workspace = $2`,
      [itemId, this.workspacePath],
    );
    const row = result.rows[0];
    if (!row) {
      return { payload: null, syncId: null, isTombstone: false };
    }
    if (row.deleted_at !== null) {
      return {
        payload: null,
        syncId: row.sync_id !== null ? Number(row.sync_id) : null,
        isTombstone: true,
      };
    }
    const payload = pgliteRowToPayload(row);
    return {
      payload,
      syncId: row.sync_id !== null ? Number(row.sync_id) : null,
      isTombstone: false,
    };
  }

  // --------------------------------------------------------------------------
  // Transaction queue
  // --------------------------------------------------------------------------

  async enqueueTransaction(row: TrackerTransactionRow): Promise<void> {
    await this.db.query(
      `INSERT INTO tracker_transactions (
        client_mutation_id, item_id, workspace_path, state, kind, payload, enqueued_at
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, to_timestamp($7 / 1000.0))
      ON CONFLICT (client_mutation_id) DO UPDATE SET
        state = EXCLUDED.state,
        kind = EXCLUDED.kind,
        payload = EXCLUDED.payload`,
      [
        row.clientMutationId,
        row.itemId,
        row.workspacePath || this.workspacePath,
        row.state,
        row.kind,
        row.payload ? JSON.stringify(row.payload) : null,
        row.enqueuedAt,
      ],
    );
  }

  async applyAndEnqueueAtomically(
    itemId: string,
    payload: TrackerItemPayload | null,
    row: TrackerTransactionRow,
  ): Promise<TrackerRowSnapshot> {
    // Crash-safety ordering (NIM-602, SECURITY_REVIEW_ADDENDUM Finding C).
    //
    // Previous implementation applied the projection first, then wrote the
    // queue row. A process crash in the gap left the projection updated
    // and the queue row missing. On next bootstrap, the engine re-synced
    // from the server, which had never seen the mutation, and overwrote
    // the user's optimistic edit. The edit was silently lost.
    //
    // New ordering:
    //   1. Snapshot the current row (so a later rollback can restore it).
    //   2. Write the queue row in state `pendingApply`. If we crash here
    //      the projection is unchanged and the queue row alone signals
    //      bootstrap to replay.
    //   3. Apply the optimistic projection.
    //   4. Promote the queue row to `persistedEnqueue`. If we crash
    //      between 3 and 4 bootstrap still finds `pendingApply` and
    //      re-applies; `applyOptimistic` is idempotent against the
    //      stored payload, so the projection ends up correct.
    //
    // PGLite serializes worker calls so these statements never interleave
    // with another caller. They are not in a single SQL transaction --
    // PGLite's worker `transaction()` helper does not produce real
    // BEGIN/COMMIT -- but the ordering above makes every crash window
    // recoverable.
    const snapshot = await this.snapshotRow(itemId);
    await this.enqueueTransaction({ ...row, state: 'pendingApply' });
    await this.applyOptimistic(itemId, payload);
    await this.markTransactionState(row.clientMutationId, 'persistedEnqueue');
    return snapshot;
  }

  async markTransactionState(
    clientMutationId: string,
    state: TrackerTransactionState,
    startedAt?: number,
  ): Promise<void> {
    if (startedAt !== undefined) {
      await this.db.query(
        `UPDATE tracker_transactions
           SET state = $1, started_at = to_timestamp($2 / 1000.0)
         WHERE client_mutation_id = $3`,
        [state, startedAt, clientMutationId],
      );
      return;
    }
    await this.db.query(
      `UPDATE tracker_transactions SET state = $1 WHERE client_mutation_id = $2`,
      [state, clientMutationId],
    );
  }

  async ackTransaction(clientMutationId: string, _syncId: SyncId): Promise<void> {
    // The contract is that on ack the projection is up-to-date (advanced
    // via `applyRemoteItem` from the ack's `item` field). We don't keep
    // confirmed rows around -- the local sync_id watermark on `tracker_items`
    // already records the server-assigned version.
    await this.db.query(
      `DELETE FROM tracker_transactions WHERE client_mutation_id = $1`,
      [clientMutationId],
    );
  }

  async rejectTransaction(
    clientMutationId: string,
    rejection: { code: TrackerMutationRejectCode; message: string; occurredAt: number },
  ): Promise<void> {
    await this.db.query(
      `UPDATE tracker_transactions
         SET last_rejection = $1::jsonb
       WHERE client_mutation_id = $2`,
      [JSON.stringify(rejection), clientMutationId],
    );
  }

  async loadPendingTransactions(): Promise<TrackerTransactionRow[]> {
    const result = await this.db.query<PGLiteTrackerTransactionRow>(
      `SELECT client_mutation_id, item_id, workspace_path, state, kind, payload,
              enqueued_at, started_at, confirmed_sync_id, last_rejection
         FROM tracker_transactions
        WHERE workspace_path = $1
          AND confirmed_sync_id IS NULL
        ORDER BY enqueued_at ASC`,
      [this.workspacePath],
    );
    return result.rows.map((row) => {
      const out: TrackerTransactionRow = {
        clientMutationId: row.client_mutation_id,
        itemId: row.item_id,
        workspacePath: row.workspace_path,
        state: row.state,
        kind: row.kind,
        enqueuedAt: row.enqueued_at instanceof Date ? row.enqueued_at.getTime() : Date.now(),
      };
      if (row.payload) {
        try {
          out.payload =
            typeof row.payload === 'string'
              ? JSON.parse(row.payload)
              : (row.payload as TrackerItemPayload);
        } catch (err) {
          logger.main.warn('[TrackerPGLiteStore] failed to parse queued payload:', err);
        }
      }
      if (row.started_at instanceof Date) {
        out.startedAt = row.started_at.getTime();
      }
      if (row.confirmed_sync_id !== null) {
        out.confirmedSyncId = Number(row.confirmed_sync_id);
      }
      if (row.last_rejection) {
        try {
          out.lastRejection =
            typeof row.last_rejection === 'string'
              ? JSON.parse(row.last_rejection)
              : (row.last_rejection as TrackerTransactionRow['lastRejection']);
        } catch { /* ignore */ }
      }
      return out;
    });
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Build a TrackerRecord from a wire envelope + decrypted payload. Used by
 * `applyRemoteItem` so we can reuse `trackerRecordToItem` for the
 * field-to-column projection.
 */
export function payloadToRecord(
  envelope: EncryptedTrackerItemEnvelope,
  payload: TrackerItemPayload,
  workspacePath: string,
): TrackerRecord {
  const now = new Date().toISOString();
  // itemId is AAD-bound, so envelope.itemId == payload.itemId after a
  // successful decrypt. Prefer the payload value so the server cannot
  // remain authoritative for this identifier.
  //
  // issueNumber / issueKey are NOT in AAD: the server allocates them on
  // first write, after the client has encrypted. This is an intentional
  // tradeoff -- to bind them via AAD the client would need a two-phase
  // create-then-rewrap dance.
  //
  // Trust model for these two fields:
  //   - On the FIRST write, payload.* is undefined and we fall through to
  //     envelope.* (the server-allocated value). The server is briefly
  //     authoritative until the client persists the allocation locally.
  //   - On EVERY SUBSEQUENT write, the client puts the values inside the
  //     ciphertext (payload.*), so the server cannot rewrite them without
  //     holding the org key.
  // A malicious server CAN therefore lie about issueNumber/issueKey for
  // freshly-allocated items it serves to a different client (where that
  // client has never seen the real payload). Mitigation requires a
  // post-allocation client-side rewrap; we accept the gap pre-release.
  return {
    id: payload.itemId,
    primaryType: payload.primaryType,
    typeTags: [payload.primaryType],
    issueNumber: payload.issueNumber ?? envelope.issueNumber,
    issueKey: payload.issueKey ?? envelope.issueKey,
    source: 'native',
    archived: payload.archived,
    syncStatus: 'synced',
    content: undefined,
    system: {
      workspace: workspacePath,
      createdAt: payload.system?.createdAt ?? now,
      updatedAt: payload.system?.updatedAt ?? now,
      authorIdentity: payload.system?.authorIdentity ?? null,
      lastModifiedBy: payload.system?.lastModifiedBy ?? null,
      createdByAgent: payload.system?.createdByAgent,
      linkedCommitSha: payload.system?.linkedCommitSha,
      linkedCommits: payload.system?.linkedCommits,
      documentId: payload.system?.documentId,
      // Carry external-source provenance back into the record so
      // recordToDbParams persists `data.origin` (and the URN index). Dropping
      // it here is what made imported items lose their origin on first apply.
      origin: payload.system?.origin,
      comments: payload.comments,
    },
    fields: payload.fields,
  };
}

/**
 * Build a TrackerItemPayload from a PGLite row. Used by `snapshotRow`
 * so rollbacks can restore the pre-write state without going through
 * the server.
 */
function pgliteRowToPayload(row: PGLiteTrackerItemRow): TrackerItemPayload {
  const data: Record<string, unknown> =
    typeof row.data === 'string' ? JSON.parse(row.data) : ((row.data as Record<string, unknown>) || {});

  // Carve system/non-field keys out of `fields`.
  const systemKeys = new Set([
    'authorIdentity', 'lastModifiedBy', 'createdByAgent',
    'linkedSessions', 'linkedCommitSha', 'linkedCommits', 'documentId',
    'activity', 'comments', 'created', 'updated', 'origin',
  ]);
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (systemKeys.has(k)) continue;
    fields[k] = v;
  }

  return {
    itemId: row.id,
    primaryType: row.type,
    archived: row.archived ?? false,
    issueNumber: row.issue_number ?? undefined,
    issueKey: row.issue_key ?? undefined,
    bodyVersion: row.body_version !== null ? Number(row.body_version) : 0,
    fields,
    // The CRDT map is the wire-shape `labels`. Legacy rows without a map
    // produce an empty record -- the next upload (via trackerItemToPayload)
    // will mint per-element IDs from the string[] projection.
    labels: (data.labelsMap as TrackerItemPayload['labels']) ?? {},
    comments: (data.comments as TrackerItemPayload['comments']) ?? [],
    system: {
      authorIdentity: (data.authorIdentity as TrackerItemPayload['system']['authorIdentity']) ?? null,
      lastModifiedBy: (data.lastModifiedBy as TrackerItemPayload['system']['lastModifiedBy']) ?? null,
      createdByAgent: data.createdByAgent as boolean | undefined,
      linkedCommitSha: data.linkedCommitSha as string | undefined,
      linkedCommits: data.linkedCommits as TrackerItemPayload['system']['linkedCommits'],
      documentId: data.documentId as string | undefined,
      createdAt:
        typeof data.created === 'string'
          ? data.created
          : toIsoTimestamp(row.created),
      updatedAt:
        typeof data.updated === 'string'
          ? data.updated
          : toIsoTimestamp(row.updated),
      origin: data.origin as TrackerItemPayload['system']['origin'],
    },
  };
}

/**
 * Build a legacy `TrackerItem` from a PGLite row. Used by `getTrackerItem`
 * so the host adapter can broadcast `document-service:tracker-items-changed`
 * payloads after the engine writes a remote delta. Mirrors
 * `ElectronDocumentService.rowToTrackerItem` but lives here so the host
 * adapter does not need a back-reference into the document service.
 */
export function pgliteRowToTrackerItem(row: PGLiteTrackerItemRow, workspacePath: string): TrackerItem {
  const data: Record<string, unknown> =
    typeof row.data === 'string' ? JSON.parse(row.data) : ((row.data as Record<string, unknown>) || {});
  // type_tags is TEXT[] in PGLite (returns string[]) but TEXT in SQLite
  // (returns a JSON-encoded string). Parse the SQLite shape back into an array.
  const rawTags = row.type_tags;
  const parsedTags: string[] | undefined = Array.isArray(rawTags)
    ? (rawTags as string[])
    : typeof rawTags === 'string'
      ? safeParseStringArray(rawTags)
      : undefined;
  const typeTags: string[] =
    parsedTags && parsedTags.length > 0 ? parsedTags : [row.type];
  // Keys already mapped onto first-class TrackerItem props below; everything
  // else in `data` (incl. the nested `data.customFields` bag: prUrl, prNumber,
  // relationship fields, ...) must be lifted into `customFields`. Omitting this
  // dropped prUrl from the sync read-back broadcast, wiping PR badges and schema
  // columns until a full reload (NIM-1659).
  const knownDataKeys = new Set<string>([
    'title', 'description', 'status', 'priority', 'owner', 'tags',
    'created', 'updated', 'dueDate', 'progress', 'authorIdentity',
    'lastModifiedBy', 'createdByAgent', 'labels', 'labelsMap',
    'linkedSessions', 'linkedCommitSha', 'linkedCommits', 'documentId',
  ]);
  return {
    id: row.id,
    issueNumber: row.issue_number ?? undefined,
    issueKey: row.issue_key ?? undefined,
    type: row.type as TrackerItem['type'],
    typeTags,
    title: (data.title as string) ?? '',
    description: (data.description as string) ?? undefined,
    status: ((data.status as string) ?? 'to-do') as TrackerItem['status'],
    priority: data.priority as TrackerItem['priority'],
    owner: data.owner as string | undefined,
    module: row.document_path ?? '',
    lineNumber: row.line_number ?? undefined,
    workspace: workspacePath,
    tags: data.tags as string[] | undefined,
    created:
      typeof data.created === 'string'
        ? data.created
        : toIsoTimestamp(row.created),
    updated:
      typeof data.updated === 'string'
        ? data.updated
        : toIsoTimestamp(row.updated),
    dueDate: data.dueDate as string | undefined,
    progress: data.progress as number | undefined,
    lastIndexed: row.last_indexed instanceof Date ? row.last_indexed : new Date(),
    customFields: extractItemCustomFields(data, knownDataKeys),
    content: undefined,
    archived: row.archived ?? false,
    source: (row.source ?? 'native') as TrackerItem['source'],
    sourceRef: row.source_ref ?? undefined,
    authorIdentity: (data.authorIdentity as TrackerItem['authorIdentity']) ?? null,
    lastModifiedBy: (data.lastModifiedBy as TrackerItem['lastModifiedBy']) ?? null,
    createdByAgent: data.createdByAgent as boolean | undefined,
    labels: normalizeLegacyLabelValues(data.labels),
    labelsMap: data.labelsMap as TrackerItem['labelsMap'],
    linkedSessions: data.linkedSessions as string[] | undefined,
    linkedCommitSha: data.linkedCommitSha as string | undefined,
    linkedCommits: data.linkedCommits as TrackerItem['linkedCommits'],
    documentId: data.documentId as string | undefined,
    syncStatus: (row.sync_status ?? 'synced') as TrackerItem['syncStatus'],
  };
}

function safeParseStringArray(raw: string): string[] | undefined {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as string[]) : undefined;
  } catch {
    return undefined;
  }
}

function safeParseLabelsMap(raw: string): LabelsMap | undefined {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as LabelsMap)
      : undefined;
  } catch {
    return undefined;
  }
}
