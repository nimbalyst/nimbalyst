// @vitest-environment node
/**
 * The disk-stamp upsert runs on PGLite as written (the SQLite side, through the
 * dialect translator, is covered in MigrationRunner.test.ts). Executes the
 * shipping worker.js DDL so the mirror of migration 0054 is what is tested.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { PGlite } from '@electric-sql/pglite';
import { diskStampUpsertSql, parseDiskStamp } from '../projectFileSyncDiskCache';

let pglite: PGlite;

function workerBlock(pattern: RegExp, label: string): string {
  const worker = fs.readFileSync(path.resolve(__dirname, '../../database/worker.js'), 'utf8');
  const sql = worker.match(pattern)?.[1];
  if (!sql) throw new Error(`Missing ${label} in worker.js`);
  return sql;
}

beforeAll(async () => {
  pglite = new PGlite();
  await (pglite as unknown as { waitReady: Promise<void> }).waitReady;
  await pglite.exec(workerBlock(/this\.db\.exec\(`(\s*CREATE TABLE IF NOT EXISTS project_file_sync_baseline[\s\S]*?)`\)/, 'baseline table'));
  const stampMigration = workerBlock(/Mirror of SQLite migration 0054[\s\S]*?this\.db\.exec\(`([\s\S]*?)`\)/, '0054 mirror');
  await pglite.exec(stampMigration);
  // It reruns on every launch.
  await pglite.exec(stampMigration);
});

afterAll(async () => {
  await pglite.close();
});

describe('disk stamp upsert on PGLite', () => {
  it('moves only the stamp columns of an existing row and reads back as numbers', async () => {
    await pglite.query(
      `INSERT INTO project_file_sync_baseline (project_id, sync_id, content_hash, last_synced_mtime, updated_at)
       VALUES ($1, $2, $3, $4, $5)`,
      ['p', 's1', 'agreed', 100, new Date()],
    );
    await pglite.query(diskStampUpsertSql(2), [
      'p', 's1', 'ignored', 999, new Date(), 'disk-1', 12, 1_760_000_000_123,
      'p', 's2', 'base-2', 300, new Date(), 'disk-2', 34, 300,
    ]);
    const { rows } = await pglite.query<Record<string, unknown>>(
      `SELECT sync_id, content_hash, last_synced_mtime, disk_hash, disk_size, disk_mtime
       FROM project_file_sync_baseline WHERE project_id = $1 ORDER BY sync_id`,
      ['p'],
    );
    expect(rows.map((r) => [r.sync_id, r.content_hash, Number(r.last_synced_mtime)])).toEqual([
      ['s1', 'agreed', 100],
      ['s2', 'base-2', 300],
    ]);
    expect(rows.map((r) => parseDiskStamp(r))).toEqual([
      { hash: 'disk-1', size: 12, mtime: 1_760_000_000_123 },
      { hash: 'disk-2', size: 34, mtime: 300 },
    ]);
  });

  it('treats a row without stamp columns as no stamp', () => {
    expect(parseDiskStamp({ disk_hash: null, disk_size: null, disk_mtime: null })).toBeUndefined();
  });
});
