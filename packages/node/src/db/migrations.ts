/**
 * Apply the Nimbalyst SQLite schema from the numbered migration files.
 *
 * The DDL is NOT restated here. It is read from
 * `packages/electron/src/main/database/sqlite/schemas/*.sql` -- the same files
 * `packages/electron`'s own `MigrationRunner` reads -- so a headless node and the
 * desktop app can never drift into two schemas.
 *
 * The migration LIST is derived from that directory rather than imported,
 * because `getMigrations()` lives inside the Electron app package and importing
 * it from here would recreate exactly the cross-package source edge that slice
 * 2a spent a commit removing. Every entry in `getMigrations()` today is a plain
 * `sqlFile` whose `name` is the filename's suffix, so directory order and
 * filename-derived versions reproduce it exactly. `migrations.test.ts` asserts
 * that equality against the real `getMigrations()`, so the day someone adds a
 * `run:` callback or an inline `sql:` migration the test fails here instead of a
 * headless node silently skipping schema.
 *
 * The ledger table and its version semantics match `MigrationRunner` byte for
 * byte, so a database created by either side is readable by the other.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database as SqliteDatabase } from 'better-sqlite3';

export interface DerivedMigration {
  version: number;
  name: string;
  sqlFile: string;
}

export interface MigrationResult {
  applied: number[];
  skipped: number[];
}

const MIGRATION_FILE = /^(\d+)_(.+)\.sql$/;

/**
 * The schema files live inside the Electron app package and nowhere else.
 *
 * That is a real limitation, not a convenience: a `@nimbalyst/node` installed
 * from a registry has no `packages/electron` to point at, so it must be handed
 * a `schemaDir` explicitly. Extracting the schema into a package both hosts
 * depend on -- the `tracker-core` treatment -- is the fix, and it is out of
 * scope for phase 0. Until then this resolves the in-repo copy and says plainly
 * what it looked for when it is not there.
 */
export function resolveSchemaDir(explicit?: string): string {
  if (explicit) {
    if (!existsSync(explicit)) {
      throw new Error(`[nimbalyst-node] configured schemaDir does not exist: ${explicit}`);
    }
    return explicit;
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // From dist/db/ or src/db/ inside a monorepo checkout.
    path.resolve(here, '../../../electron/src/main/database/sqlite/schemas'),
    path.resolve(here, '../../../../electron/src/main/database/sqlite/schemas'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  throw new Error(
    '[nimbalyst-node] could not locate the SQLite schema directory. It currently ships only '
    + `inside packages/electron; set "schemaDir" in your config file. Looked in:\n  `
    + candidates.join('\n  '),
  );
}

/** The migration list, derived from the schema directory's filenames. */
export function deriveMigrations(schemaDir: string): DerivedMigration[] {
  const migrations: DerivedMigration[] = [];

  for (const entry of readdirSync(schemaDir)) {
    const match = MIGRATION_FILE.exec(entry);
    if (!match) continue;
    migrations.push({
      version: Number.parseInt(match[1], 10),
      name: match[2],
      sqlFile: path.join(schemaDir, entry),
    });
  }

  migrations.sort((a, b) => a.version - b.version);

  const seen = new Set<number>();
  for (const migration of migrations) {
    if (seen.has(migration.version)) {
      throw new Error(
        `[nimbalyst-node] duplicate migration version ${migration.version} in ${schemaDir}`,
      );
    }
    seen.add(migration.version);
  }

  if (migrations.length === 0) {
    throw new Error(`[nimbalyst-node] no NNNN_name.sql migrations found in ${schemaDir}`);
  }

  return migrations;
}

export function runMigrations(db: SqliteDatabase, schemaDir: string): MigrationResult {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);

  const appliedVersions = new Set(
    (db.prepare('SELECT version FROM _migrations').all() as Array<{ version: number }>)
      .map((row) => row.version),
  );

  const findApplied = db.prepare('SELECT version FROM _migrations WHERE version = ?');
  const recordApplied = db.prepare('INSERT INTO _migrations (version, name) VALUES (?, ?)');

  const result: MigrationResult = { applied: [], skipped: [] };

  for (const migration of deriveMigrations(schemaDir)) {
    if (appliedVersions.has(migration.version)) {
      result.skipped.push(migration.version);
      continue;
    }

    const apply = db.transaction((): boolean => {
      // Re-check under the write lock: another process may have applied this
      // version between our snapshot and now.
      if (findApplied.get(migration.version)) return false;
      db.exec(readFileSync(migration.sqlFile, 'utf-8'));
      recordApplied.run(migration.version, migration.name);
      return true;
    });

    if (apply.immediate()) {
      result.applied.push(migration.version);
    } else {
      result.skipped.push(migration.version);
    }
  }

  return result;
}
