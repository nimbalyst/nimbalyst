/**
 * Open the Nimbalyst SQLite database from a plain Node process.
 *
 * The pragmas mirror `packages/electron`'s `SQLiteDatabase.doInitialize()`, so a
 * headless node and the desktop app make the same durability and locking
 * tradeoffs against the same file.
 */

import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { resolveSchemaDir, runMigrations, type MigrationResult } from './migrations.js';

export interface OpenDatabaseResult {
  db: SqliteDatabase;
  migrations: MigrationResult;
}

/**
 * better-sqlite3 13's prebuilds are Node-API 10. A Node-API 9 host (Node 18/20)
 * does not throw on load, it SIGSEGVs -- so the check has to happen before the
 * binding is opened, while there is still a process to report from. Same floor
 * as this package's `engines.node`.
 */
const REQUIRED_NAPI = 10;

function assertNapiFloor(): void {
  const napi = Number.parseInt(process.versions.napi ?? '0', 10);
  if (napi < REQUIRED_NAPI) {
    throw new Error(
      `[nimbalyst-node] needs Node-API ${REQUIRED_NAPI} or newer (Node 22+); `
      + `this is ${process.version} with Node-API ${process.versions.napi ?? 'unknown'}. `
      + 'Loading the better-sqlite3 binding here would crash the process outright.',
    );
  }
}

export function openDatabase(databasePath: string, schemaDir?: string): OpenDatabaseResult {
  assertNapiFloor();

  mkdirSync(path.dirname(databasePath), { recursive: true });

  const db = new Database(databasePath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('wal_autocheckpoint = 2000');
  db.pragma('temp_store = MEMORY');
  db.pragma('cache_size = -64000');

  const migrations = runMigrations(db, resolveSchemaDir(schemaDir));
  return { db, migrations };
}
