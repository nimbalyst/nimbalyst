/**
 * SQLite Migration Runner
 *
 * Replaces the inline PL/pgSQL `DO $$ ... END $$` migration blocks scattered
 * through `worker.js` with a single explicit ledger:
 *
 *   _migrations(version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)
 *
 * Each migration is a static SQL string or a function that takes the open
 * database and runs imperative work. Migrations run in version order, inside
 * a transaction; on throw, the transaction rolls back and the run aborts.
 *
 * Source-of-truth: `schemas/0001_initial.sql` (the consolidated end state).
 * Follow-up migrations should be added here in version order.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Database as SqliteDatabase } from 'better-sqlite3';

export interface Migration {
  version: number;
  name: string;
  /** SQL string, file path, or a callback. Exactly one of these is set. */
  sql?: string;
  sqlFile?: string;
  run?: (db: SqliteDatabase) => void;
}

export interface MigrationResult {
  applied: number[];
  skipped: number[];
}

/**
 * Order matters. Versions must be ascending; gaps are allowed but unusual.
 *
 * The `0001_initial.sql` file is the consolidated end-state schema; everything
 * the PGLite worker's cumulative migrations produced lives there. Once landed,
 * new schema changes go in subsequent migrations (0002_..., 0003_...).
 */
export function getMigrations(schemaDir: string): Migration[] {
  return [
    {
      version: 1,
      name: 'initial',
      sqlFile: path.join(schemaDir, '0001_initial.sql'),
    },
    {
      version: 2,
      name: 'pending_files_index',
      sqlFile: path.join(schemaDir, '0002_pending_files_index.sql'),
    },
    {
      version: 3,
      name: 'searchable_text_message_kind',
      sqlFile: path.join(schemaDir, '0003_searchable_text_message_kind.sql'),
    },
    {
      version: 4,
      name: 'fts_on_searchable_text',
      sqlFile: path.join(schemaDir, '0004_fts_on_searchable_text.sql'),
    },
    {
      version: 5,
      name: 'drop_transcript_events',
      sqlFile: path.join(schemaDir, '0005_drop_transcript_events.sql'),
    },
    {
      version: 6,
      name: 'message_kind_index',
      sqlFile: path.join(schemaDir, '0006_message_kind_index.sql'),
    },
    {
      version: 7,
      name: 'rebuild_fts_after_kind',
      sqlFile: path.join(schemaDir, '0007_rebuild_fts_after_kind.sql'),
    },
    {
      version: 8,
      name: 'guard_fts_triggers',
      sqlFile: path.join(schemaDir, '0008_guard_fts_triggers.sql'),
    },
    {
      version: 9,
      name: 'worktree_pr_linkage',
      sqlFile: path.join(schemaDir, '0009_worktree_pr_linkage.sql'),
    },
    {
      version: 10,
      name: 'tracker_origin_urn',
      sqlFile: path.join(schemaDir, '0010_tracker_origin_urn.sql'),
    },
    {
      version: 11,
      name: 'project_file_sync_baseline',
      sqlFile: path.join(schemaDir, '0011_project_file_sync_baseline.sql'),
    },
    {
      version: 12,
      name: 'tracker_type_defs',
      sqlFile: path.join(schemaDir, '0012_tracker_type_defs.sql'),
    },
    {
      version: 13,
      name: 'orgs_and_projects',
      sqlFile: path.join(schemaDir, '0013_orgs_and_projects.sql'),
    },
    {
      version: 14,
      name: 'tracker_relationship_index',
      sqlFile: path.join(schemaDir, '0014_tracker_relationship_index.sql'),
    },
    {
      version: 15,
      name: 'collab_local_origins_project_id',
      sqlFile: path.join(schemaDir, '0015_collab_local_origins_project_id.sql'),
    },
    {
      version: 16,
      name: 'read_receipts',
      sqlFile: path.join(schemaDir, '0016_read_receipts.sql'),
    },
  ];
}

export function runMigrations(db: SqliteDatabase, schemaDir: string): MigrationResult {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);

  const appliedRows = db
    .prepare('SELECT version FROM _migrations ORDER BY version ASC')
    .all() as Array<{ version: number }>;
  const applied = new Set(appliedRows.map((r) => r.version));

  const result: MigrationResult = { applied: [], skipped: [] };
  const migrations = getMigrations(schemaDir).sort((a, b) => a.version - b.version);

  // Verify ordering: no version may equal a previous version.
  const seen = new Set<number>();
  for (const m of migrations) {
    if (seen.has(m.version)) {
      throw new Error(`Duplicate migration version ${m.version} (${m.name})`);
    }
    seen.add(m.version);
  }

  for (const m of migrations) {
    if (applied.has(m.version)) {
      result.skipped.push(m.version);
      continue;
    }
    const sources = [m.sql, m.sqlFile, m.run].filter((x) => x !== undefined);
    if (sources.length !== 1) {
      throw new Error(
        `Migration ${m.version} (${m.name}) must specify exactly one of sql/sqlFile/run`,
      );
    }

    const tx = db.transaction(() => {
      if (m.sqlFile) {
        const sql = fs.readFileSync(m.sqlFile, 'utf-8');
        db.exec(sql);
      } else if (m.sql) {
        db.exec(m.sql);
      } else if (m.run) {
        m.run(db);
      }
      db.prepare('INSERT INTO _migrations (version, name) VALUES (?, ?)').run(
        m.version,
        m.name,
      );
    });
    tx();
    result.applied.push(m.version);
  }

  return result;
}
