/**
 * Direct mode: open the better-sqlite3 file read-only and query tracker_items
 * directly. Safe to run while the app is live because WAL lets a second process
 * read committed snapshots; we never take a write lock in this gateway.
 *
 * Row -> record conversion goes through the vendored `dbRowToRecord` so a
 * CLI-read row is shaped identically to an app-read one.
 */
import type { Database as DB } from 'better-sqlite3';
import * as fs from 'fs';
import { openDatabase } from '../db/openDatabase.js';
import { dbRowToRecord, type TrackerRecord } from '../vendor/trackerRecord.js';
import {
  appendActivity,
  buildComment,
  getCurrentIdentity,
  newTrackerId,
} from '../vendor/trackerWrite.js';
import { resolveSqlitePath, resolveDefaultSqlitePath, resolveAppSettingsPath } from '../config/paths.js';
import {
  connectionError,
  notFoundError,
  schemaError,
  writeNotPermittedError,
} from '../cli/exitCodes.js';
import { discoverEndpoint } from './endpoint.js';
import {
  MIN_SUPPORTED_SCHEMA,
  MAX_KNOWN_SCHEMA,
  TERMINAL_STATUSES,
  isMetaStatus,
} from './schema.js';
import type {
  CreateInput,
  GatewayStatus,
  ListFilters,
  TrackerGateway,
  TrackerTypeSummary,
  UpdateInput,
} from './types.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 250;
const ALL_CAP = 10000;

export class DirectGateway implements TrackerGateway {
  readonly mode = 'direct' as const;
  private db: DB;
  /** Lazily-opened writable handle (offline writes only; see writableDb()). */
  private wdb: DB | null = null;
  private dbPath: string;
  private schemaVersion: number | null = null;

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? resolveSqlitePath();
    if (!fs.existsSync(this.dbPath)) {
      throw connectionError(
        `No Nimbalyst database at ${this.dbPath}. Is Nimbalyst installed? Pass --db <file> to point elsewhere.`,
      );
    }
    try {
      this.db = openDatabase(this.dbPath, { readonly: true, fileMustExist: true });
      // A read-only handle still benefits from WAL read semantics; do not change
      // journal mode (that would require a write lock).
      this.db.pragma('query_only = true');
    } catch (err: any) {
      throw connectionError(`Failed to open database: ${err?.message ?? err}`);
    }
    this.assertSchemaCompatible();
  }

  private assertSchemaCompatible(): void {
    try {
      const row = this.db.prepare('SELECT MAX(version) AS v FROM _migrations').get() as { v: number | null };
      this.schemaVersion = row?.v ?? null;
    } catch (err: any) {
      throw schemaError(`Could not read schema version (_migrations): ${err?.message ?? err}`);
    }
    const v = this.schemaVersion;
    if (v == null) return;
    if (v < MIN_SUPPORTED_SCHEMA) {
      throw schemaError(
        `Database schema v${v} is older than this nim build supports (min v${MIN_SUPPORTED_SCHEMA}). Upgrade Nimbalyst.`,
      );
    }
    if (v > MAX_KNOWN_SCHEMA) {
      // Reads of a newer schema touch only long-stable columns, so warn rather
      // than refuse. Writes (phase 2) will hard-refuse here.
      process.stderr.write(
        `nim: warning: database schema v${v} is newer than this nim build knows (v${MAX_KNOWN_SCHEMA}). ` +
          `Reads proceed; consider upgrading @nimbalyst/cli.\n`,
      );
    }
  }

  async status(): Promise<GatewayStatus> {
    return {
      mode: this.mode,
      schemaVersion: this.schemaVersion,
      dbPath: this.dbPath,
      workspaces: await this.listWorkspaces(),
    };
  }

  async listWorkspaces(): Promise<{ path: string; name?: string }[]> {
    const out = new Map<string, { path: string; name?: string }>();

    // Workspaces that actually own tracker items.
    try {
      const rows = this.db
        .prepare('SELECT DISTINCT workspace FROM tracker_items WHERE workspace IS NOT NULL')
        .all() as { workspace: string }[];
      for (const r of rows) {
        if (r.workspace) out.set(r.workspace, { path: r.workspace });
      }
    } catch {
      /* table may not exist on a very old db */
    }

    // Recent workspaces from app-settings (gives friendly names + paths with no
    // trackers yet). Best-effort: it's a plain JSON file.
    try {
      const raw = fs.readFileSync(resolveAppSettingsPath(), 'utf8');
      const settings = JSON.parse(raw);
      const recent: any[] = settings?.recent?.workspaces ?? [];
      for (const item of recent) {
        const p = typeof item === 'string' ? item : item?.path;
        if (!p) continue;
        const name = typeof item === 'object' ? item?.name : undefined;
        const existing = out.get(p);
        out.set(p, { path: p, name: name ?? existing?.name });
      }
    } catch {
      /* settings file absent or unreadable */
    }

    return [...out.values()];
  }

  async listTrackers(filters: ListFilters): Promise<TrackerRecord[]> {
    const where: string[] = ['workspace = @workspace', 'deleted_at IS NULL'];
    const params: Record<string, unknown> = { workspace: filters.workspace };

    if (!filters.includeArchived) {
      where.push('archived = 0');
    }

    if (filters.type) {
      where.push('type = @type');
      params.type = filters.type;
    }

    if (filters.typeTag) {
      where.push(
        `EXISTS (SELECT 1 FROM json_each(tracker_items.type_tags) WHERE json_each.value = @typeTag)`,
      );
      params.typeTag = filters.typeTag;
    }

    if (filters.status) {
      if (isMetaStatus(filters.status)) {
        const list = [...TERMINAL_STATUSES];
        const placeholders = list.map((_, idx) => `@term${idx}`);
        list.forEach((s, idx) => (params[`term${idx}`] = s));
        if (filters.status === 'closed') {
          where.push(`LOWER(status) IN (${placeholders.join(', ')})`);
        } else {
          where.push(`(status IS NULL OR LOWER(status) NOT IN (${placeholders.join(', ')}))`);
        }
      } else {
        where.push('status = @status');
        params.status = filters.status;
      }
    }

    if (filters.priority) {
      where.push(`json_extract(data, '$.priority') = @priority`);
      params.priority = filters.priority;
    }

    if (filters.owner) {
      where.push(`json_extract(data, '$.owner') = @owner`);
      params.owner = filters.owner;
    }

    if (filters.search) {
      where.push(
        `(LOWER(IFNULL(title, '')) LIKE @search OR LOWER(IFNULL(json_extract(data, '$.description'), '')) LIKE @search)`,
      );
      params.search = `%${filters.search.toLowerCase()}%`;
    }

    const dateCol = filters.dateField === 'created' ? 'created' : 'updated';
    if (filters.since) {
      where.push(`${dateCol} >= @since`);
      params.since = filters.since;
    }
    if (filters.until) {
      where.push(`${dateCol} <= @until`);
      params.until = filters.until;
    }

    (filters.where ?? []).forEach((clause, idx) => {
      const path = `$.${clause.field}`;
      const pName = `w${idx}`;
      const expr = `json_extract(data, '${escapeJsonPath(path)}')`;
      switch (clause.op) {
        case '=':
          where.push(`${expr} = @${pName}`);
          params[pName] = clause.value;
          break;
        case '!=':
          where.push(`(${expr} IS NULL OR ${expr} != @${pName})`);
          params[pName] = clause.value;
          break;
        case '~':
          where.push(`LOWER(IFNULL(${expr}, '')) LIKE @${pName}`);
          params[pName] = `%${clause.value.toLowerCase()}%`;
          break;
        case 'in': {
          const values = clause.value.split(',').map((v) => v.trim()).filter(Boolean);
          if (values.length === 0) {
            where.push('0 = 1');
            break;
          }
          const ph = values.map((_, vIdx) => `@${pName}_${vIdx}`);
          values.forEach((v, vIdx) => (params[`${pName}_${vIdx}`] = v));
          where.push(`${expr} IN (${ph.join(', ')})`);
          break;
        }
      }
    });

    const limit = resolveLimit(filters.limit);
    const sql = `SELECT * FROM tracker_items WHERE ${where.join(' AND ')} ORDER BY ${dateCol} DESC LIMIT @__limit`;
    params.__limit = limit;

    const rows = this.db.prepare(sql).all(params) as any[];
    return rows.map(dbRowToRecord);
  }

  async getTracker(workspace: string, reference: string): Promise<TrackerRecord | null> {
    const row = this.db
      .prepare(
        `SELECT * FROM tracker_items
         WHERE (id = @ref OR issue_key = @ref) AND workspace = @ws AND deleted_at IS NULL
         ORDER BY updated DESC LIMIT 1`,
      )
      .get({ ref: reference, ws: workspace }) as any;
    if (!row) {
      // Fall back to a workspace-agnostic lookup so `nim tracker get BUG-1`
      // works even when workspace resolution picked a sibling.
      const any = this.db
        .prepare(
          `SELECT * FROM tracker_items
           WHERE (id = @ref OR issue_key = @ref) AND deleted_at IS NULL
           ORDER BY updated DESC LIMIT 1`,
        )
        .get({ ref: reference }) as any;
      return any ? dbRowToRecord(any) : null;
    }
    return dbRowToRecord(row);
  }

  async getTrackerByUrn(workspace: string, urn: string): Promise<TrackerRecord | null> {
    const row = this.db
      .prepare(
        `SELECT * FROM tracker_items
         WHERE workspace = @ws AND json_extract(data, '$.origin.external.urn') = @urn
           AND deleted_at IS NULL
         ORDER BY updated DESC LIMIT 1`,
      )
      .get({ ws: workspace, urn }) as any;
    return row ? dbRowToRecord(row) : null;
  }

  async getTrackerBody(_workspace: string, record: TrackerRecord): Promise<string | undefined> {
    // The freshest body lives in tracker_body_cache keyed by item id +
    // body_version. Read the body_version off the row, then the cache.
    try {
      const meta = this.db
        .prepare('SELECT body_version FROM tracker_items WHERE id = ?')
        .get(record.id) as { body_version: number } | undefined;
      if (!meta) return undefined;
      const cached = this.db
        .prepare('SELECT content FROM tracker_body_cache WHERE item_id = ? AND body_version = ?')
        .get(record.id, meta.body_version) as { content: string } | undefined;
      if (cached?.content) return cached.content;
      // Fall back to the latest cached version regardless of body_version.
      const latest = this.db
        .prepare('SELECT content FROM tracker_body_cache WHERE item_id = ? ORDER BY body_version DESC LIMIT 1')
        .get(record.id) as { content: string } | undefined;
      return latest?.content;
    } catch {
      return undefined;
    }
  }

  async listTypes(workspace: string): Promise<TrackerTypeSummary[]> {
    // Direct mode can't load the runtime's built-in/custom type registry without
    // the app. Report the types actually present in the store with counts — the
    // useful, ground-truth answer for scripting.
    const rows = this.db
      .prepare(
        `SELECT type, COUNT(*) AS count FROM tracker_items
         WHERE workspace = @ws AND deleted_at IS NULL
         GROUP BY type ORDER BY count DESC`,
      )
      .all({ ws: workspace }) as { type: string; count: number }[];
    return rows.map((r) => ({ type: r.type, count: r.count }));
  }

  // ---- writes --------------------------------------------------------------
  //
  // Offline guarded direct writes. These run ONLY when no live app owns the
  // database: if the endpoint descriptor shows a live app and we're pointed at
  // the default DB, every write is refused (exit 5) so the CLI never races the
  // app's writer. When truly offline, mutations open a writable WAL handle and
  // run inside a `BEGIN IMMEDIATE … COMMIT` transaction (SQLite cross-process
  // file locking makes this safe), shaping rows to match the app's MCP tool
  // handlers so a CLI-written row is indistinguishable from an app-written one.
  //
  // Sync-eligible items get `sync_status='pending'` on every offline mutation;
  // the app drains them on next launch via its normal backfill path (new items
  // also drain because their `sync_id` is NULL). Link-session and type
  // definition remain live-only (they need the in-app session/registry).

  /** Refuse a write that the offline path deliberately does not handle. */
  private refuseWrite(message: string): never {
    throw writeNotPermittedError(message);
  }

  /**
   * Open (once) a writable handle for offline mutations. Refuses up front if a
   * live app owns the default DB, or if the schema is newer than this build can
   * safely write.
   */
  private writableDb(): DB {
    if (this.wdb) return this.wdb;

    const live = discoverEndpoint();
    if (live && this.dbPath === resolveDefaultSqlitePath()) {
      throw writeNotPermittedError(
        'Nimbalyst is running and owns this database — writes must route through the app. ' +
          'Re-run without --offline (live mode), or quit Nimbalyst to write directly.',
      );
    }
    if (this.schemaVersion != null && this.schemaVersion > MAX_KNOWN_SCHEMA) {
      throw schemaError(
        `Database schema v${this.schemaVersion} is newer than this nim build can safely write ` +
          `(v${MAX_KNOWN_SCHEMA}). Upgrade @nimbalyst/cli before writing.`,
      );
    }

    try {
      const db = openDatabase(this.dbPath, { fileMustExist: true });
      db.pragma('journal_mode = WAL');
      db.pragma('busy_timeout = 5000');
      this.wdb = db;
      return db;
    } catch (err: any) {
      throw connectionError(`Failed to open database for writing: ${err?.message ?? err}`);
    }
  }

  /** Run `fn` inside a `BEGIN IMMEDIATE … COMMIT` transaction (rollback on throw). */
  private txn<T>(fn: (db: DB) => T): T {
    const db = this.writableDb();
    db.prepare('BEGIN IMMEDIATE').run();
    try {
      const result = fn(db);
      db.prepare('COMMIT').run();
      return result;
    } catch (err) {
      try {
        db.prepare('ROLLBACK').run();
      } catch {
        /* ignore rollback failure */
      }
      throw err;
    }
  }

  /** Resolve a row by id or issue key, workspace-first then workspace-agnostic. */
  private findRow(db: DB, workspace: string, reference: string): any {
    const inWs = db
      .prepare(
        `SELECT * FROM tracker_items
         WHERE (id = @ref OR issue_key = @ref) AND workspace = @ws AND deleted_at IS NULL
         ORDER BY updated DESC LIMIT 1`,
      )
      .get({ ref: reference, ws: workspace });
    if (inWs) return inWs;
    return db
      .prepare(
        `SELECT * FROM tracker_items
         WHERE (id = @ref OR issue_key = @ref) AND deleted_at IS NULL
         ORDER BY updated DESC LIMIT 1`,
      )
      .get({ ref: reference });
  }

  /** Derive the workspace's issue-key prefix from an existing key, else 'NIM'. */
  private issueKeyPrefix(db: DB, workspace: string): string {
    try {
      const row = db
        .prepare(
          `SELECT issue_key FROM tracker_items
           WHERE workspace = ? AND issue_key IS NOT NULL AND issue_key != ''
           ORDER BY issue_number DESC LIMIT 1`,
        )
        .get(workspace) as { issue_key: string } | undefined;
      if (row?.issue_key) {
        const idx = row.issue_key.lastIndexOf('-');
        if (idx > 0) return row.issue_key.slice(0, idx);
      }
    } catch {
      /* fall through to default */
    }
    return 'NIM';
  }

  /** Mark a row pending iff it is already part of the sync set. Local-only items
   *  stay local (new items drain via the app's sync_id-IS-NULL backfill). */
  private markPendingIfSyncEligible(db: DB, row: any): void {
    const eligible =
      row.sync_status === 'synced' || row.sync_status === 'pending' || row.sync_id != null;
    if (eligible) {
      db.prepare(`UPDATE tracker_items SET sync_status = 'pending' WHERE id = ?`).run(row.id);
    }
  }

  private readRowById(db: DB, id: string): any {
    return db.prepare(`SELECT * FROM tracker_items WHERE id = ?`).get(id);
  }

  // ---- offline type-schema resolution --------------------------------------
  //
  // Custom tracker types can remap semantic roles to non-default field names
  // (e.g. roles.title = 'name'). The app materializes every loaded schema into
  // `tracker_type_defs`, so offline writes resolve role->field from the DB and a
  // CLI-written custom-type row lands in the same JSON keys the app would use.
  // Falls back to default field names if the table is absent (un-migrated DB) or
  // the type has no stored definition (built-in types use defaults).

  private typeDefs: Map<string, any> | null = null;
  private typeDefsWorkspace: string | null = null;

  private loadTypeDefs(workspace: string): Map<string, any> {
    if (this.typeDefs && this.typeDefsWorkspace === workspace) return this.typeDefs;
    const map = new Map<string, any>();
    try {
      const rows = this.db
        .prepare(`SELECT type, model FROM tracker_type_defs WHERE workspace = ? AND deleted_at IS NULL`)
        .all(workspace) as { type: string; model: string }[];
      for (const r of rows) {
        try {
          map.set(r.type, typeof r.model === 'string' ? JSON.parse(r.model) : r.model);
        } catch {
          /* skip a malformed model */
        }
      }
    } catch {
      /* table absent on an un-migrated DB -> default field names apply */
    }
    this.typeDefs = map;
    this.typeDefsWorkspace = workspace;
    return map;
  }

  /** Resolve a semantic role to its field name for a type, else the fallback. */
  private roleField(workspace: string, type: string, role: string, fallback: string): string {
    const roles = this.loadTypeDefs(workspace).get(type)?.roles;
    const mapped = roles && typeof roles === 'object' ? roles[role] : undefined;
    return typeof mapped === 'string' && mapped ? mapped : fallback;
  }

  async createTracker(workspace: string, input: CreateInput): Promise<TrackerRecord> {
    const identity = getCurrentIdentity(workspace);
    const id = newTrackerId(input.type);
    const nowIso = new Date().toISOString();
    const createdDate = nowIso.split('T')[0];

    const description =
      input.description !== undefined ? input.description.replace(/\\n/g, '\n') : undefined;

    const rf = (role: string, fallback: string): string =>
      this.roleField(workspace, input.type, role, fallback);
    const titleField = rf('title', 'title');
    const statusField = rf('workflowStatus', 'status');
    const priorityField = rf('priority', 'priority');

    const data: Record<string, any> = {
      [titleField]: input.title,
      [statusField]: input.status || 'to-do',
      [priorityField]: input.priority || 'medium',
      created: createdDate,
      authorIdentity: identity,
      createdByAgent: true,
    };
    if (input.tags?.length) data[rf('tags', 'tags')] = input.tags;
    if (description) data.description = description;
    if (input.owner) data[rf('assignee', 'owner')] = input.owner;
    if (input.dueDate) data[rf('dueDate', 'dueDate')] = input.dueDate;
    if (input.progress !== undefined) data[rf('progress', 'progress')] = input.progress;
    if (input.labels?.length) data.labels = input.labels;
    if (input.linkedCommitSha) data.linkedCommitSha = input.linkedCommitSha;
    if (input.fields) {
      for (const [k, v] of Object.entries(input.fields)) {
        if (v !== undefined) data[k] = v;
      }
    }
    appendActivity(data, identity, 'created');

    const typeTags: string[] = [input.type];
    for (const t of input.typeTags ?? []) if (!typeTags.includes(t)) typeTags.push(t);

    const contentJson = description ? JSON.stringify(description) : null;
    const bodyVersion = description ? 1 : 0;

    this.txn((db) => {
      db.prepare(
        `INSERT INTO tracker_items (
          id, type, type_tags, data, workspace, document_path, line_number,
          created, updated, last_indexed, sync_status, content, archived,
          source, source_ref, body_version
        ) VALUES (
          @id, @type, @typeTags, @data, @workspace, '', NULL,
          @created, @updated, @lastIndexed, 'local', @content, 0,
          'native', NULL, @bodyVersion
        )`,
      ).run({
        id,
        type: input.type,
        typeTags: JSON.stringify(typeTags),
        data: JSON.stringify(data),
        workspace,
        created: nowIso,
        updated: nowIso,
        lastIndexed: nowIso,
        content: contentJson,
        bodyVersion,
      });

      // Allocate a local issue key (NULL issue_number on the new row is ignored
      // by MAX, so this picks the next number in the workspace).
      const prefix = this.issueKeyPrefix(db, workspace);
      const maxRow = db
        .prepare(`SELECT MAX(issue_number) AS m FROM tracker_items WHERE workspace = ?`)
        .get(workspace) as { m: number | null };
      const nextNum = (maxRow?.m ?? 0) + 1;
      db.prepare(`UPDATE tracker_items SET issue_number = ?, issue_key = ? WHERE id = ?`).run(
        nextNum,
        `${prefix}-${nextNum}`,
        id,
      );

      if (description && bodyVersion > 0) {
        db.prepare(
          `INSERT INTO tracker_body_cache (item_id, body_version, content, cached_at)
           VALUES (?, ?, ?, ?) ON CONFLICT (item_id, body_version) DO NOTHING`,
        ).run(id, bodyVersion, contentJson, nowIso);
      }
    });

    return dbRowToRecord(this.readRowById(this.writableDb(), id));
  }

  async updateTracker(workspace: string, reference: string, input: UpdateInput): Promise<TrackerRecord> {
    const identity = getCurrentIdentity(workspace);
    const nowIso = new Date().toISOString();
    let resultId = '';

    this.txn((db) => {
      const row = this.findRow(db, workspace, reference);
      if (!row) throw notFoundError(`No tracker item found for '${reference}'.`);
      if (row.document_path) {
        this.refuseWrite(
          'Offline update of file-backed tracker items (inline/frontmatter documents) is not ' +
            'supported. Start Nimbalyst so the change flows through the document service (live mode).',
        );
      }

      const data: Record<string, any> =
        typeof row.data === 'string' ? JSON.parse(row.data) : row.data || {};
      data.lastModifiedBy = identity;

      const rf = (role: string, fallback: string): string =>
        this.roleField(workspace, row.type, role, fallback);

      const changes: Record<string, { from: any; to: any }> = {};
      const setField = (field: string, value: unknown): void => {
        changes[field] = { from: data[field], to: value };
        data[field] = value;
      };

      if (input.title !== undefined) setField(rf('title', 'title'), input.title);
      if (input.status !== undefined) setField(rf('workflowStatus', 'status'), input.status);
      if (input.priority !== undefined) setField(rf('priority', 'priority'), input.priority);
      if (input.tags !== undefined) setField(rf('tags', 'tags'), input.tags);
      if (input.owner !== undefined) setField(rf('assignee', 'owner'), input.owner);
      if (input.dueDate !== undefined) setField(rf('dueDate', 'dueDate'), input.dueDate);
      if (input.progress !== undefined) setField(rf('progress', 'progress'), input.progress);
      // Labels/linkedCommitSha mirror the handler: written without a change entry.
      if (input.labels !== undefined) data.labels = input.labels;
      if (input.linkedCommitSha !== undefined) data.linkedCommitSha = input.linkedCommitSha;

      const description =
        input.description !== undefined ? input.description.replace(/\\n/g, '\n') : undefined;
      if (description !== undefined) {
        changes.description = { from: data.description, to: description };
        data.description = description;
      }

      if (input.archived !== undefined) {
        changes.archived = { from: row.archived ?? false, to: input.archived };
      }

      if (input.fields) {
        for (const [k, v] of Object.entries(input.fields)) {
          if (v === undefined) continue;
          if (data[k] !== v) changes[k] = { from: data[k], to: v };
          data[k] = v;
        }
      }
      if (input.unsetFields) {
        for (const k of input.unsetFields) {
          if (data[k] !== undefined) {
            changes[k] = { from: data[k], to: undefined };
            delete data[k];
          }
        }
      }

      let newType = row.type;
      if (input.primaryType && input.primaryType !== row.type) {
        changes.type = { from: row.type, to: input.primaryType };
        newType = input.primaryType;
      }

      for (const [field, change] of Object.entries(changes)) {
        const action =
          field === 'status'
            ? 'status_changed'
            : field === 'archived'
              ? 'archived'
              : field === 'type'
                ? 'type_changed'
                : 'updated';
        appendActivity(data, identity, action, {
          field,
          oldValue: change.from != null ? String(change.from) : undefined,
          newValue: change.to != null ? String(change.to) : undefined,
        });
      }

      if (newType !== row.type) {
        db.prepare(`UPDATE tracker_items SET type = ? WHERE id = ?`).run(newType, row.id);
      }
      if (input.typeTags !== undefined) {
        const tt = [newType];
        for (const t of input.typeTags) if (!tt.includes(t)) tt.push(t);
        db.prepare(`UPDATE tracker_items SET type_tags = ? WHERE id = ?`).run(
          JSON.stringify(tt),
          row.id,
        );
      } else if (newType !== row.type) {
        const existing = parseStoredTypeTags(row.type_tags, row.type);
        const preserved = existing.filter((t) => t !== row.type && t !== newType);
        db.prepare(`UPDATE tracker_items SET type_tags = ? WHERE id = ?`).run(
          JSON.stringify([newType, ...preserved]),
          row.id,
        );
      }

      db.prepare(`UPDATE tracker_items SET data = ?, updated = ? WHERE id = ?`).run(
        JSON.stringify(data),
        nowIso,
        row.id,
      );

      if (description !== undefined) {
        const contentJson = JSON.stringify(description);
        const newBodyVersion = (Number(row.body_version) || 0) + 1;
        db.prepare(`UPDATE tracker_items SET content = ?, body_version = ? WHERE id = ?`).run(
          contentJson,
          newBodyVersion,
          row.id,
        );
        db.prepare(
          `INSERT INTO tracker_body_cache (item_id, body_version, content, cached_at)
           VALUES (?, ?, ?, ?) ON CONFLICT (item_id, body_version) DO NOTHING`,
        ).run(row.id, newBodyVersion, contentJson, nowIso);
      }

      if (input.archived !== undefined) {
        db.prepare(`UPDATE tracker_items SET archived = ?, archived_at = ? WHERE id = ?`).run(
          input.archived ? 1 : 0,
          input.archived ? nowIso : null,
          row.id,
        );
      }

      this.markPendingIfSyncEligible(db, row);
      resultId = row.id;
    });

    return dbRowToRecord(this.readRowById(this.writableDb(), resultId));
  }

  async commentTracker(workspace: string, reference: string, body: string): Promise<void> {
    const identity = getCurrentIdentity(workspace);
    const nowIso = new Date().toISOString();

    this.txn((db) => {
      const row = this.findRow(db, workspace, reference);
      if (!row) throw notFoundError(`No tracker item found for '${reference}'.`);

      const data: Record<string, any> =
        typeof row.data === 'string' ? JSON.parse(row.data) : row.data || {};
      const comments = Array.isArray(data.comments) ? data.comments : [];
      comments.push(buildComment(identity, body));
      data.comments = comments;
      data.lastModifiedBy = identity;
      appendActivity(data, identity, 'commented');

      db.prepare(`UPDATE tracker_items SET data = ?, updated = ? WHERE id = ?`).run(
        JSON.stringify(data),
        nowIso,
        row.id,
      );
      this.markPendingIfSyncEligible(db, row);
    });
  }

  async setArchived(workspace: string, reference: string, archived: boolean): Promise<TrackerRecord> {
    return this.updateTracker(workspace, reference, { archived });
  }

  async linkSession(): Promise<void> {
    this.refuseWrite(
      'link-session requires live mode (a running Nimbalyst). It links an in-app AI session.',
    );
  }

  async defineType(): Promise<void> {
    this.refuseWrite(
      'Defining tracker types requires live mode (the running app validates and registers the schema).',
    );
  }

  async deleteType(): Promise<void> {
    this.refuseWrite(
      'Deleting tracker types requires live mode (the running app owns the type registry).',
    );
  }

  // ---- importers (live mode only) ------------------------------------------
  //
  // Importer backends are extension modules hosted by the running app; the CLI
  // cannot start or query them offline. These refuse with a connection error so
  // the message points the user at live mode.

  private importersNeedLive(): never {
    throw connectionError(
      'Importers require live mode (a running Nimbalyst). The importer backends are ' +
        'hosted by the app and cannot run offline. Start Nimbalyst and retry.',
    );
  }

  async importerList(): Promise<never> {
    this.importersNeedLive();
  }
  async importerSearch(): Promise<never> {
    this.importersNeedLive();
  }
  async importItem(): Promise<never> {
    this.importersNeedLive();
  }
  async resnapshot(): Promise<never> {
    this.importersNeedLive();
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
    if (this.wdb) {
      try {
        this.wdb.close();
      } catch {
        /* ignore */
      }
      this.wdb = null;
    }
  }
}

/** Parse a stored `type_tags` value (JSON string on SQLite) into an array. */
function parseStoredTypeTags(raw: unknown, fallbackType: string): string[] {
  if (Array.isArray(raw)) return raw as string[];
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed as string[];
    } catch {
      /* fall through */
    }
  }
  return [fallbackType];
}

function resolveLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (limit < 0) return ALL_CAP; // --all maps to a large cap by the caller
  return Math.min(limit, MAX_LIMIT);
}

/** SQLite json paths can't contain a literal single quote; field names are
 *  caller-supplied, so strip quotes defensively. */
function escapeJsonPath(path: string): string {
  return path.replace(/'/g, '');
}
