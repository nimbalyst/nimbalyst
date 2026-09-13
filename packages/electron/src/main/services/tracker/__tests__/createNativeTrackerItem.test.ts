// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { SQLiteDatabase } from '../../../database/sqlite/SQLiteDatabase';
import { createSQLiteStoreAdapter } from '../../../database/sqlite/SQLiteStoreAdapter';

const state = vi.hoisted(() => ({ db: null as any }));
vi.mock('../../../database/PGLiteDatabaseWorker', () => ({
  database: {
    query: (...args: any[]) => state.db.query(...args),
    runTransaction: (...args: any[]) => state.db.runTransaction(...args),
  },
}));
vi.mock('../../TrackerIdentityService', () => ({
  getCurrentIdentity: () => ({}),
}));
vi.mock(
  '@nimbalyst/runtime/plugins/TrackerPlugin/models/TrackerDataModel',
  () => ({ globalRegistry: { get: () => ({ creatable: true }) } }),
);
vi.mock('../../TrackerPolicyService', () => ({
  getEffectiveTrackerSharingPolicy: () => ({ sharing: 'personal' }),
  getInitialTrackerSyncStatus: () => 'local',
}));
import { createNativeTrackerItem } from '../createNativeTrackerItem';

let close: () => Promise<void>;
afterEach(async () => {
  await close?.();
  state.db = null;
});

describe.each(['sqlite', 'pglite'] as const)(
  'native creation on %s',
  (backend) => {
    it('round trips content, caches it atomically, reconciles retries, and rolls back partial writes', async () => {
      if (backend === 'sqlite') {
        const directory = await fs.mkdtemp(
          path.join(os.tmpdir(), 'tracker-create-'),
        );
        const sqlite = new SQLiteDatabase({
          dbDir: directory,
          schemaDir: path.resolve(
            __dirname,
            '../../../database/sqlite/schemas',
          ),
          log: () => {},
        });
        await sqlite.initialize();
        const adapter = createSQLiteStoreAdapter(sqlite);
        state.db = {
          query: adapter.query,
          runTransaction: (statements: any[]) =>
            sqlite.runTransaction(statements),
        };
        close = async () => {
          await sqlite.close();
          await fs.rm(directory, { recursive: true, force: true });
        };
      } else {
        const pg = new PGlite();
        await pg.exec(`CREATE TABLE tracker_items (
        id TEXT PRIMARY KEY, type TEXT, type_tags TEXT[], data JSONB, workspace TEXT,
        document_path TEXT, line_number INTEGER, created TIMESTAMPTZ, updated TIMESTAMPTZ,
        last_indexed TIMESTAMPTZ, sync_status TEXT, content JSONB, archived BOOLEAN,
        source TEXT, source_ref TEXT, body_version BIGINT, status TEXT, kanban_sort_order TEXT
      ); CREATE TABLE tracker_body_cache (item_id TEXT, body_version BIGINT, content TEXT NOT NULL,
        cached_at TIMESTAMPTZ, PRIMARY KEY (item_id, body_version));
      CREATE TABLE tracker_creation_receipts (item_id TEXT PRIMARY KEY REFERENCES tracker_items(id) ON DELETE CASCADE,
        workspace TEXT, request_hash TEXT, publication_status TEXT, error TEXT, updated TIMESTAMPTZ DEFAULT NOW());`);
        state.db = {
          query: (sql: string, params: any[]) => pg.query(sql, params),
          runTransaction: (statements: any[]) =>
            pg.transaction(async (tx) => {
              for (const statement of statements)
                await tx.query(statement.sql, statement.params);
            }),
        };
        close = () => pg.close();
      }
      const notify = vi.fn();
      const deps = {
        assignLocalKeysFrom: async () => {},
        rowToTrackerItem: (row: any) => row,
        notify,
      };
      const markdown =
        'Paragraph Ω\r\n\r\n**Details**\n![screen](.nimbalyst/assets/abc.png)';
      const payload = {
        id: 'task-a',
        creationRequestId: 'task-a',
        type: 'task',
        title: 'Task',
        status: 'to-do',
        priority: 'medium',
        workspace: '/test',
        content: markdown,
      };
      await createNativeTrackerItem(payload, deps);
      const { rows: snapshots } = await state.db.query(
        'SELECT content FROM tracker_body_cache WHERE item_id = $1 AND body_version = 1',
        ['task-a'],
      );
      expect(JSON.parse(snapshots[0].content)).toBe(markdown);
      const { rows } = await state.db.query(
        'SELECT content, body_version FROM tracker_items WHERE id = $1',
        ['task-a'],
      );
      expect(
        backend === 'sqlite' ? JSON.parse(rows[0].content) : rows[0].content,
      ).toBe(markdown);
      expect(Number(rows[0].body_version)).toBe(1);
      await Promise.all([
        createNativeTrackerItem(payload, deps),
        createNativeTrackerItem(payload, deps),
      ]);
      expect(notify).toHaveBeenCalledTimes(1);
      await expect(
        createNativeTrackerItem({ ...payload, title: 'Changed request' }, deps),
      ).rejects.toThrow('different draft');

      // A body-cache conflict is after the item insert. A real transaction must
      // roll back the item and receipt, without notifying the renderer.
      await state.db.query(
        'INSERT INTO tracker_body_cache (item_id, body_version, content, cached_at) VALUES ($1, 1, $2, NOW())',
        ['rollback', '"older"'],
      );
      await expect(
        createNativeTrackerItem(
          { ...payload, id: 'rollback', creationRequestId: 'rollback' },
          deps,
        ),
      ).rejects.toThrow();
      expect(
        (
          await state.db.query('SELECT id FROM tracker_items WHERE id = $1', [
            'rollback',
          ])
        ).rows,
      ).toHaveLength(0);
      expect(
        (
          await state.db.query(
            'SELECT item_id FROM tracker_creation_receipts WHERE item_id = $1',
            ['rollback'],
          )
        ).rows,
      ).toHaveLength(0);
      expect(notify).toHaveBeenCalledTimes(1);
      await createNativeTrackerItem(
        { ...payload, id: 'empty', creationRequestId: 'empty', content: '' },
        deps,
      );
      expect(
        JSON.parse(
          (
            await state.db.query(
              'SELECT content FROM tracker_body_cache WHERE item_id = $1',
              ['empty'],
            )
          ).rows[0].content,
        ),
      ).toBe('');
    }, 30_000);
  },
);
