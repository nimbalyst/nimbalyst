// @vitest-environment node
/**
 * A body write that names the version it was based on lands only while the
 * stored body is still at that version (`tracker_items.body_version`), on both
 * database backends. An agent editing a closed typed page relies on this so it
 * never overwrites text saved after it read the page. A write without a
 * version behaves exactly as before.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { SQLiteDatabase } from '../../database/sqlite/SQLiteDatabase';
import { createSQLiteStoreAdapter } from '../../database/sqlite/SQLiteStoreAdapter';

const state = vi.hoisted(() => ({ db: null as any }));
vi.mock('../../database/PGLiteDatabaseWorker', () => ({
  database: { query: (...args: any[]) => state.db.query(...args) },
}));
vi.mock('../TrackerSyncManager', () => ({
  syncTrackerItem: vi.fn(),
  unsyncTrackerItem: vi.fn(),
  isTrackerSyncActive: vi.fn(() => false),
}));
vi.mock('../MainBodyDocService', () => ({ applyHeadlessBodyMarkdown: vi.fn() }));
vi.mock('../TrackerIdentityService', () => ({ getCurrentIdentity: () => ({ email: 'me@example.com' }) }));
vi.mock('../../utils/store', () => ({ getWorkspaceState: () => ({}), isAnalyticsEnabled: () => false }));
vi.mock('../../../../../tracker-schema/src/TrackerDataModel', () => ({
  globalRegistry: { get: vi.fn(() => undefined), getForWorkspace: vi.fn(() => undefined), hasWorkspaceLayer: () => true },
}));
// Relationship edges are not under test.
vi.mock('../tracker/trackerRelationshipIndexStore', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  reindexItemRelationshipsAfterWrite: vi.fn(async () => undefined),
}));

import { ElectronDocumentService } from '../ElectronDocumentService';

let close: () => Promise<void> = async () => {};
let service: ElectronDocumentService | null = null;
afterEach(async () => {
  service?.destroy();
  service = null;
  await close();
  state.db = null;
});

async function openBackend(backend: 'sqlite' | 'pglite', directory: string): Promise<void> {
  if (backend === 'sqlite') {
    const sqlite = new SQLiteDatabase({
      dbDir: path.join(directory, 'db'),
      schemaDir: path.resolve(__dirname, '../../database/sqlite/schemas'),
      log: () => {},
    });
    await sqlite.initialize();
    state.db = { query: createSQLiteStoreAdapter(sqlite).query };
    close = async () => {
      await sqlite.close();
      await fs.rm(directory, { recursive: true, force: true });
    };
    return;
  }
  const pg = new PGlite();
  await pg.exec(`CREATE TABLE tracker_items (
    id TEXT PRIMARY KEY, type TEXT, type_tags TEXT[], data JSONB, workspace TEXT,
    document_path TEXT, line_number INTEGER, created TIMESTAMPTZ, updated TIMESTAMPTZ,
    last_indexed TIMESTAMPTZ, sync_status TEXT, content JSONB, archived BOOLEAN,
    source TEXT, source_ref TEXT, body_version BIGINT NOT NULL DEFAULT 0, status TEXT, kanban_sort_order TEXT
  ); CREATE TABLE tracker_body_cache (item_id TEXT, body_version BIGINT, content TEXT NOT NULL,
    cached_at TIMESTAMPTZ, PRIMARY KEY (item_id, body_version));`);
  state.db = { query: (sql: string, params: any[]) => pg.query(sql, params) };
  close = async () => {
    await pg.close();
    await fs.rm(directory, { recursive: true, force: true });
  };
}

describe.each(['sqlite', 'pglite'] as const)('typed page body version guard on %s', (backend) => {
  it('refuses a write based on an older version and keeps the stored body', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tracker-body-version-'));
    await openBackend(backend, directory);
    await state.db.query(
      `INSERT INTO tracker_items (id, type, type_tags, data, workspace, sync_status, content, archived, source, body_version, created, updated, last_indexed)
       VALUES ($1, 'idea', $2, $3, $4, 'local', $5, FALSE, 'native', 3, NOW(), NOW(), NOW())`,
      ['idea_1', backend === 'sqlite' ? JSON.stringify(['idea']) : ['idea'], JSON.stringify({ title: 'Idea' }), directory,
        JSON.stringify('Saved by a person at version 3.')],
    );
    service = new ElectronDocumentService(directory);
    const stored = async () => {
      const { rows } = await state.db.query('SELECT content, body_version FROM tracker_items WHERE id = $1', ['idea_1']);
      // JSONB comes back parsed on PGLite and as JSON text on SQLite.
      const content = backend === 'sqlite' ? JSON.parse(rows[0].content) : rows[0].content;
      return { content, version: Number(rows[0].body_version) };
    };

    await expect(service.updateTrackerItemContent('idea_1', 'Agent edit based on version 2.', 2))
      .rejects.toMatchObject({ code: 'BODY_VERSION_CONFLICT', bodyVersion: 3 });
    expect(await stored()).toEqual({ content: 'Saved by a person at version 3.', version: 3 });

    await service.updateTrackerItemContent('idea_1', 'Agent edit based on version 3.', 3);
    expect(await stored()).toEqual({ content: 'Agent edit based on version 3.', version: 4 });

    // No version named: written as before, whatever the stored version is.
    await service.updateTrackerItemContent('idea_1', 'Autosave.');
    expect(await stored()).toEqual({ content: 'Autosave.', version: 5 });
  });
});
