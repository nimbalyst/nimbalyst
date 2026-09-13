// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGlite } from '@electric-sql/pglite';
import { buildSyncedMetadataProjectionSql } from '../PGLiteSessionStore';
import { translateSql } from '../../database/sqlite/dialectTranslator';

/**
 * `getAllSessionsForSync` projects the seven consumed metadata keys in SQL so a
 * full metadata blob never crosses the database boundary for every session in
 * the account. One SQL string has to work on both live backends, and the two
 * disagree about JSON in exactly the way that would corrupt it silently:
 * SQLite re-quotes a nested object as a string unless the value carries the
 * JSON subtype. Assert against the real engines, not a mock.
 */

const FULL_METADATA = {
  tutorial: false,
  hostDeviceId: 'desktop-1',
  tokenUsage: { totalTokens: 1234, contextWindow: 200_000 },
  phase: 'implementing',
  tags: ['sync', 'ios'],
  draftInput: '',
  draftUpdatedAt: 99,
  // Not consumed by the wire; this is the weight the projection exists to drop.
  transcriptSummary: 'x'.repeat(2048),
  providerScratch: { nested: { deep: true } },
};

const CONSUMED_KEYS = [
  'tutorial',
  'hostDeviceId',
  'tokenUsage',
  'phase',
  'tags',
  'draftInput',
  'draftUpdatedAt',
];

describe('synced metadata projection runs on both live backends', () => {
  let pgliteDir: string;
  let pglite: PGlite;

  beforeAll(async () => {
    pgliteDir = mkdtempSync(join(tmpdir(), 'sync-metadata-projection-'));
    pglite = new PGlite({ dataDir: pgliteDir });
    await pglite.query('CREATE TABLE ai_sessions (id TEXT PRIMARY KEY, metadata JSONB)');
    await pglite.query('INSERT INTO ai_sessions (id, metadata) VALUES ($1, $2)', [
      'full',
      JSON.stringify(FULL_METADATA),
    ]);
    await pglite.query('INSERT INTO ai_sessions (id, metadata) VALUES ($1, $2)', [
      'sparse',
      JSON.stringify({ phase: 'planning' }),
    ]);
  }, 30_000);

  afterAll(async () => {
    await pglite?.close();
    rmSync(pgliteDir, { recursive: true, force: true });
  });

  it('keeps nested objects and arrays intact on PGLite', async () => {
    const sql = `SELECT id, ${buildSyncedMetadataProjectionSql('s.metadata')} AS metadata FROM ai_sessions s ORDER BY id`;
    const { rows } = await pglite.query<any>(sql);

    const full = rows.find((r: any) => r.id === 'full')!;
    expect(Object.keys(full.metadata).sort()).toEqual([...CONSUMED_KEYS].sort());
    expect(full.metadata.tokenUsage).toEqual({ totalTokens: 1234, contextWindow: 200_000 });
    expect(full.metadata.tags).toEqual(['sync', 'ios']);
    // Explicit clear must survive as "", not collapse to null/absent.
    expect(full.metadata.draftInput).toBe('');
    expect(full.metadata.transcriptSummary).toBeUndefined();

    const sparse = rows.find((r: any) => r.id === 'sparse')!;
    expect(sparse.metadata.phase).toBe('planning');
    // Keys the row never had come back null and are stripped in JS afterwards.
    expect(sparse.metadata.draftInput).toBeNull();
  });

  it('keeps nested objects and arrays intact on SQLite after dialect translation', async () => {
    const betterSqlite = await import('better-sqlite3').then((m) => m.default);
    const db = new betterSqlite(':memory:');
    try {
      db.exec('CREATE TABLE ai_sessions (id TEXT PRIMARY KEY, metadata TEXT)');
      db.prepare('INSERT INTO ai_sessions (id, metadata) VALUES (?, ?)')
        .run('full', JSON.stringify(FULL_METADATA));
      db.prepare('INSERT INTO ai_sessions (id, metadata) VALUES (?, ?)')
        .run('sparse', JSON.stringify({ phase: 'planning' }));

      const pgSql = `SELECT id, ${buildSyncedMetadataProjectionSql('s.metadata')} AS metadata FROM ai_sessions s ORDER BY id`;
      const translated = translateSql(pgSql);
      expect(translated.sql).toContain('json_object(');
      expect(translated.sql).not.toContain('jsonb_build_object');

      const rows = db.prepare(translated.sql).all() as Array<{ id: string; metadata: string }>;
      const full = JSON.parse(rows.find((r) => r.id === 'full')!.metadata);

      expect(Object.keys(full).sort()).toEqual([...CONSUMED_KEYS].sort());
      // The failure this test exists for: a nested value re-encoded as a quoted
      // string instead of an object.
      expect(full.tokenUsage).toEqual({ totalTokens: 1234, contextWindow: 200_000 });
      expect(full.tags).toEqual(['sync', 'ios']);
      expect(full.draftInput).toBe('');
      expect(full.transcriptSummary).toBeUndefined();

      const sparse = JSON.parse(rows.find((r) => r.id === 'sparse')!.metadata);
      expect(sparse.phase).toBe('planning');
      expect(sparse.draftInput).toBeNull();
    } finally {
      db.close();
    }
  });
});
