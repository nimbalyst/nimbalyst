// @vitest-environment node
/**
 * A Local wiki item (a typed page file or a CSV row) is shown as a tracker
 * record in the renderer but is never a database row: no write path may give
 * it one, and nothing may push it to a team room.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { SQLiteDatabase } from '../../../database/sqlite/SQLiteDatabase';
import { createSQLiteStoreAdapter } from '../../../database/sqlite/SQLiteStoreAdapter';

const state = vi.hoisted(() => ({ db: null as any }));
vi.mock('../../../database/PGLiteDatabaseWorker', () => ({
  database: { query: (...args: any[]) => state.db.query(...args) },
}));
const sync = vi.hoisted(() => ({ syncTrackerItem: vi.fn(), unsyncTrackerItem: vi.fn() }));
vi.mock('../../TrackerSyncManager', () => ({
  syncTrackerItem: sync.syncTrackerItem,
  unsyncTrackerItem: sync.unsyncTrackerItem,
  isTrackerSyncActive: vi.fn(() => true),
}));
vi.mock('../../MainBodyDocService', () => ({ applyHeadlessBodyMarkdown: vi.fn() }));
vi.mock('../../../utils/store', () => ({ getWorkspaceState: () => ({}), isAnalyticsEnabled: () => false }));
vi.mock('../../../utils/workspaceDetection', () => ({ resolveProjectPath: (p: string) => p }));

import { ElectronDocumentService } from '../../ElectronDocumentService';
import { forgetLocalWikiItemIds, rememberLocalWikiItemIds } from '../localWikiItemIds';

let service: ElectronDocumentService | null = null;
let close: () => Promise<void> = async () => {};
afterEach(async () => {
  service?.destroy();
  service = null;
  forgetLocalWikiItemIds();
  await close();
});

describe('Local wiki items stay out of the database and the team room', () => {
  it('refuses every row write and room push for a wiki item id, and never projects a wiki file', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'local-wiki-guards-'));
    const sqlite = new SQLiteDatabase({
      dbDir: path.join(directory, 'db'),
      schemaDir: path.resolve(__dirname, '../../../database/sqlite/schemas'),
      log: () => {},
    });
    await sqlite.initialize();
    state.db = { query: createSQLiteStoreAdapter(sqlite).query };
    close = async () => {
      await sqlite.close();
      await fs.rm(directory, { recursive: true, force: true });
    };
    const wikiFile = path.join(directory, 'nimbalyst-local', 'wiki', 'Acme.md');
    await fs.mkdir(path.dirname(wikiFile), { recursive: true });
    const original = '---\ntrackerStatus:\n  type: plan\nid: wiki-acme\nstatus: active\n---\nBody\n';
    await fs.writeFile(wikiFile, original);
    rememberLocalWikiItemIds(path.join(directory, 'nimbalyst-local', 'wiki'), ['wiki-acme']);
    service = new ElectronDocumentService(directory);
    const rows = async () => (await state.db.query('SELECT id FROM tracker_items')).rows;

    await expect(service.updateTrackerItem('wiki-acme', { status: 'done' } as never)).rejects.toThrow();
    await expect(service.deleteTrackerItem('wiki-acme')).rejects.toThrow(/Local wiki item/);
    // A `trackerStatus` block inside the wiki folder is not projected as `fm:plan:<path>`
    // and cannot be rewritten through the frontmatter path either.
    await expect(service.updateTrackerItemInFile('fm:plan:nimbalyst-local/wiki/Acme.md', { status: 'done' })).rejects.toThrow(/not found/);
    expect(await service.findTrackerRowForPublicId('fm:plan:nimbalyst-local/wiki/Acme.md')).toBeNull();
    expect(await service.importTrackerItemFromFile('nimbalyst-local/wiki/Acme.md')).toMatchObject({ item: null, skipped: true });

    expect(await rows()).toEqual([]);
    expect(await fs.readFile(wikiFile, 'utf8')).toBe(original);
    expect(sync.syncTrackerItem).not.toHaveBeenCalled();
    expect(sync.unsyncTrackerItem).not.toHaveBeenCalled();
  });

  it('refuses to push or delete a wiki item in a team room', async () => {
    rememberLocalWikiItemIds('/ws/nimbalyst-local/wiki', ['wiki-acme']);
    const real = await vi.importActual<typeof import('../../TrackerSyncManager')>('../../TrackerSyncManager');
    await expect(real.syncTrackerItem({ id: 'wiki-acme', workspace: '/ws' } as never)).rejects.toThrow(/Local wiki item/);
    await expect(real.unsyncTrackerItem('wiki-acme', '/ws')).rejects.toThrow(/Local wiki item/);
  });
});
