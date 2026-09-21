// @vitest-environment node
import { it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SQLiteDatabase } from '../../../database/sqlite/SQLiteDatabase';
import { PGLiteToSQLiteMigrator } from '../../../database/sqlite/PGLiteToSQLiteMigrator';
import { createShellCoverageStore } from '../shellCoverageStore';
import { ShellTrackingCoverage } from '../ShellTrackingCoverage';

it.each(['pglite', 'sqlite'])(
  'persists gaps across reload and cascades session deletion on %s',
  async (engine) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nim-coverage-store-'));
    const db =
      engine === 'pglite'
        ? new PGlite()
        : new SQLiteDatabase({
            dbDir: root,
            schemaDir: path.resolve(__dirname, '../../../database/sqlite/schemas'),
            log: () => {},
          });
    try {
      if (db instanceof SQLiteDatabase) await db.initialize();
      else {
        await db.waitReady;
        await db.exec('CREATE TABLE ai_sessions (id TEXT PRIMARY KEY, provider TEXT)');
      }
      await db.query("INSERT INTO ai_sessions (id, provider) VALUES ('a', 'openai-codex')");
      const first = new ShellTrackingCoverage({ ...createShellCoverageStore(db), notify: () => {} });
      await first.open('a', 'g');
      first.turn('g', 't');
      first.record('g', 'missingPre', 't', 'tool-1');
      first.observation('g', false);
      first.observation('g', true);
      first.endTurn('g');
      await first.close('g');
      const second = new ShellTrackingCoverage({ ...createShellCoverageStore(db), notify: () => {} });
      expect((await second.readMany(['a']))[0]).toMatchObject({
        state: 'degraded',
        reasons: { missingPre: 1 },
        events: [expect.objectContaining({ reason: 'missingPre', toolUseId: 'tool-1' })],
      });
      if (db instanceof PGlite) {
        const migrated = new SQLiteDatabase({
          dbDir: path.join(root, 'migrated'),
          schemaDir: path.resolve(__dirname, '../../../database/sqlite/schemas'),
          log: () => {},
        });
        try {
          await migrated.initialize();
          await new PGLiteToSQLiteMigrator().migrate({ pglite: db, sqlite: migrated, spotCheckPerTable: 1 });
          expect((await createShellCoverageStore(migrated).load('a'))?.events).toEqual([expect.objectContaining({ reason: 'missingPre', toolUseId: 'tool-1' })]);
        } finally {
          await migrated.close();
        }
      }
      await db.query("DELETE FROM ai_sessions WHERE id = 'a'");
      expect(await createShellCoverageStore(db).load('a')).toBeUndefined();
    } finally {
      await db.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  }
);
