// @vitest-environment node
/**
 * Personal pages live in the app database with no account. They must survive a
 * second launch, so these tests run on the real SQLite engine with the real
 * migrations (0049 included) and reopen the database directory between steps.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('electron', async () => ({
  app: {
    getPath: (await import('../../../../test-stubs/privateUserData')).testApp.getPath,
    getName: vi.fn(() => 'test'),
    getVersion: vi.fn(() => '1'),
    on: vi.fn(),
  },
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock('../../database/initialize', () => ({ getDatabase: () => null }));
vi.mock('../../HistoryManager', () => ({ historyManager: { createSnapshot: vi.fn() } }));

import { SQLiteDatabase } from '../../database/sqlite/SQLiteDatabase';
import { runMigrations } from '../../database/sqlite/MigrationRunner';
import { loadBetterSqlite } from '../../database/sqlite/betterSqliteLoader';
import { PersonalPagesService, personalDocHistoryKey } from '../PersonalPagesService';
import { PERSONAL_HOME_PAGE_ID } from '../personalPages/personalHomePage';

const SCHEMA_DIR = path.resolve(__dirname, '..', '..', 'database', 'sqlite', 'schemas');
const WS = '/ws/personal-pages';

/** A permanent removal takes two calls: to Trash, then a purge of what is in Trash. */
async function removeForGood(service: PersonalPagesService, folderId: string): Promise<void> {
  await service.command(WS, { type: 'remove-folder', folderId });
  await service.command(WS, { type: 'remove-folder', folderId, purge: true });
}

interface TestPagesDb {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
  runTransaction(statements: Array<{ sql: string; params?: unknown[] }>): Promise<void>;
}

/**
 * RV-1: another window restores a page (or restores it and trashes it again)
 * after a purge has read it in Trash and before the purge deletes. The purge
 * must leave the page alone and report that nothing was purged.
 */
async function purgeLosesARaceWithARestore(base: TestPagesDb): Promise<void> {
  const deps = { history: { createSnapshot: vi.fn(async () => undefined) }, notify: vi.fn() };
  const other = new PersonalPagesService({ db: () => base, ...deps });
  // Runs once, right before the purge's write reaches the database.
  let interleave: (() => Promise<unknown>) | null = null;
  const takeTurn = async () => {
    const turn = interleave;
    interleave = null;
    await turn?.();
  };
  const purging = new PersonalPagesService({
    db: () => ({
      query: async (sql: string, params?: unknown[]) => {
        if (/DELETE FROM personal_page_documents/.test(sql)) await takeTurn();
        return base.query(sql, params);
      },
      runTransaction: async (statements: Array<{ sql: string; params?: unknown[] }>) => {
        await takeTurn();
        return base.runTransaction(statements);
      },
    }),
    ...deps,
  });
  const page = (documentId: string, parentFolderId: string | null = null) =>
    other.command(WS, { type: 'register-document', documentId, title: documentId, documentType: 'markdown', parentFolderId });
  const trashedAt = async (documentId: string) =>
    (await other.snapshot(WS)).items.find((item) => item.documentId === documentId)?.trashedAt;

  await page('restored');
  await other.command(WS, { type: 'trash-document', documentId: 'restored', trashedAt: 1_000 });
  interleave = () => other.command(WS, { type: 'restore-document', documentId: 'restored' });
  const restoredPurge = await purging.command(WS, { type: 'remove-document', documentId: 'restored', purge: true });
  expect(await trashedAt('restored')).toBeNull();
  expect(restoredPurge).toEqual({ ok: true, purged: 0 });

  // Back in Trash by a later trashing: not the page the purge saw in Trash.
  await page('retrashed');
  await other.command(WS, { type: 'trash-document', documentId: 'retrashed', trashedAt: 1_000 });
  interleave = async () => {
    await other.command(WS, { type: 'restore-document', documentId: 'retrashed' });
    await other.command(WS, { type: 'trash-document', documentId: 'retrashed', trashedAt: 2_000 });
  };
  const retrashedPurge = await purging.command(WS, { type: 'remove-document', documentId: 'retrashed', purge: true });
  expect(await trashedAt('retrashed')).toBe(2_000);
  expect(retrashedPurge).toEqual({ ok: true, purged: 0 });

  await page('a');
  await page('a-child', 'a');
  await other.command(WS, { type: 'remove-folder', folderId: 'a' });
  interleave = () => other.command(WS, { type: 'restore-document', documentId: 'a' });
  const subtreePurge = await purging.command(WS, { type: 'remove-folder', folderId: 'a', purge: true });
  expect(await trashedAt('a')).toBeNull();
  expect(await trashedAt('a-child')).toEqual(expect.any(Number));
  expect(subtreePurge).toEqual({ ok: true, purged: 0 });

  // Uncontested, the same purges go through and say how many pages went.
  expect(await purging.command(WS, { type: 'remove-document', documentId: 'retrashed', purge: true })).toEqual({ ok: true, purged: 1 });
  await other.command(WS, { type: 'remove-folder', folderId: 'a' });
  expect(await purging.command(WS, { type: 'remove-folder', folderId: 'a', purge: true })).toEqual({ ok: true, purged: 2 });
  expect((await other.snapshot(WS)).items.map((item) => item.documentId).sort()).toEqual(['restored']);
}


/** A page's own fields: patched per key, cleared by null, validated on the way in. */
async function pageFieldsRoundTrip(service: PersonalPagesService, relaunch?: () => Promise<PersonalPagesService>): Promise<void> {
  await service.command(WS, { type: 'register-document', documentId: 'p1', title: 'Pricing', documentType: 'markdown', parentFolderId: null });
  expect((await service.snapshot(WS)).pageFields).toBe(true);
  await service.command(WS, { type: 'set-document-fields', documentId: 'p1', fields: { status: 'current', owner: 'ana@example.com', tags: ['pricing', 'pricing'] } });
  await service.command(WS, { type: 'set-document-fields', documentId: 'p1', fields: { owner: null, summary: 'What we charge', status: 'shipped' } });
  const reopened = relaunch ? await relaunch() : service;
  const page = (await reopened.snapshot(WS)).items.find((doc) => doc.documentId === 'p1');
  // An unknown status is dropped, not stored; the earlier valid one stays.
  expect(page?.fields).toEqual({ status: 'current', summary: 'What we charge', tags: ['pricing'] });
  await expect(reopened.command(WS, { type: 'set-document-fields', documentId: 'missing', fields: { status: 'draft' } })).rejects.toThrow();
}

describe('PersonalPagesService', () => {
  let tmp: string;
  let db: SQLiteDatabase;
  const history = { createSnapshot: vi.fn(async () => undefined) };
  const notify = vi.fn();

  const open = async () => {
    db = new SQLiteDatabase({
      dbDir: path.join(tmp, 'sqlite-db'),
      schemaDir: SCHEMA_DIR,
      slowQueryThresholdMs: 1000,
      sampleRate: 0,
    });
    await db.initialize();
    return new PersonalPagesService({ db: () => db, history, notify });
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-personal-pages-'));
    history.createSnapshot.mockClear();
    notify.mockClear();
  });

  afterEach(async () => {
    await db?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('keeps pages, placements, documents and bodies across a second launch', async () => {
    let service = await open();
    // A folder command from an older renderer makes a page.
    await service.command(WS, { type: 'register-folder', folderId: 'f1', name: 'Specs', parentFolderId: null, sortOrder: 1 });
    await service.command(WS, { type: 'set-type-placement', typeId: 'decision', parentFolderId: 'f1', sortOrder: 2 });
    await service.command(WS, { type: 'set-item-placement', itemId: 'item-1', parentId: 'f1', sortOrder: 3 });
    await service.command(WS, {
      type: 'register-document', documentId: 'd1', title: 'Intro', documentType: 'markdown', parentFolderId: 'f1',
      metadata: { metadataVersion: 2, fileExtension: '.md', editorId: 'markdown' },
    });
    expect(await service.updateBody(WS, 'd1', '# Hello', 0)).toEqual({ version: 1 });
    expect(history.createSnapshot).toHaveBeenCalledWith(
      personalDocHistoryKey('d1'), '# Hello', 'auto-save', 'Auto-save',
    );
    expect(notify).toHaveBeenCalledWith(WS);
    service.dispose();
    await db.close();

    service = await open();
    const snapshot = await service.snapshot(WS);
    expect(snapshot.pageTree).toBe(true);
    expect(snapshot.containers).toEqual([]);
    expect(snapshot.typePlacements).toEqual([expect.objectContaining({ typeId: 'decision', parentFolderId: 'f1', sortOrder: 2, projectId: null })]);
    expect(snapshot.itemPlacements).toEqual([expect.objectContaining({ itemId: 'item-1', parentId: 'f1', sortOrder: 3, projectId: null })]);
    expect(snapshot.items).toEqual([
      expect.objectContaining({ documentId: 'f1', title: 'Specs', documentType: 'markdown', parentFolderId: null }),
      expect.objectContaining({
        documentId: 'd1', title: 'Intro', documentType: 'markdown', parentFolderId: 'f1', teamProjectId: null,
        metadataVersion: 2, fileExtension: '.md', editorId: 'markdown', createdBy: 'local', trashedAt: null,
      }),
    ]);
    expect(snapshot.items[0]).not.toHaveProperty('metadataVersion');
    expect(typeof snapshot.items[1].createdAt).toBe('number');
    expect(await service.getBody(WS, 'd1')).toEqual({ content: '# Hello', version: 1 });
    // Another workspace sees none of it.
    expect((await service.snapshot('/ws/other')).items).toEqual([]);
  });

  it('turns an older build\'s folders into pages, keeps the folder rows, and stays converted on a second launch', async () => {
    // An older build's database: every migration up to 0049, with its rows.
    const dbDir = path.join(tmp, 'sqlite-db');
    const olderSchemas = path.join(tmp, 'schemas-before-0050');
    fs.mkdirSync(dbDir, { recursive: true });
    fs.cpSync(SCHEMA_DIR, olderSchemas, { recursive: true });
    for (const file of fs.readdirSync(olderSchemas)) {
      if (Number(file.slice(0, 4)) >= 50) fs.rmSync(path.join(olderSchemas, file));
    }
    const Sqlite = loadBetterSqlite();
    const older = new Sqlite(path.join(dbDir, 'nimbalyst.sqlite'));
    expect(() => runMigrations(older, olderSchemas)).toThrow();
    expect(older.prepare('SELECT MAX(version) AS v FROM _migrations').get()).toEqual({ v: 49 });
    const at = '2026-09-01T10:00:00.000Z';
    older.exec(`
      INSERT INTO personal_page_folders (workspace_path, folder_id, parent_folder_id, name, sort_order, created_at, updated_at)
      VALUES ('${WS}', 'f-arch', NULL, 'Architecture', 1, '${at}', '${at}'),
             ('${WS}', 'f-specs', 'f-arch', 'Specs', 2, '${at}', '${at}'),
             ('/ws/other', 'f-other', NULL, 'Elsewhere', 0, '${at}', '${at}');
      INSERT INTO personal_page_documents (workspace_path, document_id, title, document_type, metadata_version, parent_folder_id, body, body_version, created_at, updated_at)
      VALUES ('${WS}', 'd1', 'Intro', 'markdown', 2, 'f-specs', '# Intro', 3, '${at}', '${at}');
      INSERT INTO personal_page_type_placements (workspace_path, type_id, parent_folder_id, sort_order, created_at, updated_at)
      VALUES ('${WS}', 'decision', 'f-arch', 0, '${at}', '${at}');
    `);
    older.close();

    let service = await open();
    let snapshot = await service.snapshot(WS);
    expect(snapshot.pageTree).toBe(true);
    expect(snapshot.containers).toEqual([]);
    expect(snapshot.items.map((doc) => [doc.documentId, doc.title, doc.parentFolderId, doc.documentType])).toEqual([
      ['d1', 'Intro', 'f-specs', 'markdown'],
      ['f-arch', 'Architecture', null, 'markdown'],
      ['f-specs', 'Specs', 'f-arch', 'markdown'],
    ]);
    expect(snapshot.typePlacements).toEqual([expect.objectContaining({ typeId: 'decision', parentFolderId: 'f-arch' })]);
    expect(snapshot.itemPlacements).toEqual([]);
    expect(await service.getBody(WS, 'f-arch')).toEqual({ content: '', version: 0 });
    expect(await service.getBody(WS, 'd1')).toEqual({ content: '# Intro', version: 3 });
    expect((await service.snapshot('/ws/other')).items.map((doc) => doc.documentId)).toEqual(['f-other']);
    // The folder rows stay, marked, as the record of the old tree.
    const { rows } = await db.query<{ folder_id: string; converted_at: string | null }>(
      'SELECT folder_id, converted_at FROM personal_page_folders ORDER BY folder_id',
    );
    expect(rows.map((row) => row.folder_id)).toEqual(['f-arch', 'f-other', 'f-specs']);
    expect(rows.every((row) => typeof row.converted_at === 'string')).toBe(true);

    // Delete a converted page for good (Trash, then purge); the second launch must not bring it back.
    await service.command(WS, { type: 'remove-document', documentId: 'f-specs' });
    await service.command(WS, { type: 'remove-document', documentId: 'f-specs', purge: true });
    service.dispose();
    await db.close();
    service = await open();
    snapshot = await service.snapshot(WS);
    expect(snapshot.items.map((doc) => doc.documentId)).toEqual(['d1', 'f-arch']);
  });

  it('upgrades a 0050 database to unordered page parents, and keeps it on a second launch', async () => {
    const dbDir = path.join(tmp, 'sqlite-db');
    const olderSchemas = path.join(tmp, 'schemas-before-0051');
    fs.mkdirSync(dbDir, { recursive: true });
    fs.cpSync(SCHEMA_DIR, olderSchemas, { recursive: true });
    for (const file of fs.readdirSync(olderSchemas)) {
      if (Number(file.slice(0, 4)) >= 51) fs.rmSync(path.join(olderSchemas, file));
    }
    const older = new (loadBetterSqlite())(path.join(dbDir, 'nimbalyst.sqlite'));
    expect(() => runMigrations(older, olderSchemas)).toThrow();
    expect(older.prepare('SELECT MAX(version) AS v FROM _migrations').get()).toEqual({ v: 50 });
    const at = '2026-09-01T10:00:00.000Z';
    older.exec(`
      INSERT INTO personal_page_documents (workspace_path, document_id, title, document_type, parent_folder_id, created_at, updated_at)
      VALUES ('${WS}', 'd1', 'Intro', 'markdown', NULL, '${at}', '${at}');
      INSERT INTO personal_page_type_placements (workspace_path, type_id, parent_folder_id, sort_order, created_at, updated_at)
      VALUES ('${WS}', 'decision', 'd1', 7, '${at}', '${at}');
      INSERT INTO personal_page_item_placements (workspace_path, item_id, parent_id, sort_order, created_at, updated_at)
      VALUES ('${WS}', 'item-1', 'd1', 8, '${at}', '${at}');
    `);
    older.close();

    for (let launch = 0; launch < 2; launch += 1) {
      const service = await open();
      const snapshot = await service.snapshot(WS);
      expect(snapshot.items).toEqual([expect.objectContaining({ documentId: 'd1', parentKind: 'page', sortOrder: null })]);
      expect(snapshot.typePlacements).toEqual([expect.objectContaining({ typeId: 'decision', parentKind: 'page', sortOrder: 7 })]);
      expect(snapshot.itemPlacements).toEqual([expect.objectContaining({ itemId: 'item-1', parentKind: 'page', sortOrder: 8 })]);
      service.dispose();
      await db.close();
    }
  });

  it('puts pages, types and typed pages under typed pages that exist, refusing cycles, across a second launch', async () => {
    let service = await open();
    const at = new Date().toISOString();
    await db.query(
      `INSERT INTO tracker_items (id, type, data, workspace, created, updated) VALUES ($1, 'module', '{}', $2, $3, $3)`,
      ['item-1', WS, at],
    );
    const register = (documentId: string, parentFolderId: string | null, extra: Record<string, unknown> = {}) =>
      service.command(WS, { type: 'register-document', documentId, title: documentId, documentType: 'markdown', parentFolderId, ...extra });
    await register('p', null, { sortOrder: 1024 });
    await service.command(WS, { type: 'set-item-placement', itemId: 'item-1', parentId: 'p', sortOrder: 2048 });
    await register('child', 'item-1', { parentKind: 'item' });
    await expect(register('lost', 'no-such-item', { parentKind: 'item' })).rejects.toThrow(/Unknown typed page/);
    // p -> child -> item-1 -> p
    await expect(service.command(WS, { type: 'move-document', documentId: 'p', parentFolderId: 'child' })).rejects.toThrow(/cycle/);
    // Unplaced, item-1 sits under its type: module -> child -> item-1 -> module.
    await service.command(WS, { type: 'remove-item-placement', itemId: 'item-1' });
    await service.command(WS, { type: 'set-type-placement', typeId: 'module', parentFolderId: 'item-1', parentKind: 'item', sortOrder: 0 })
      .then(() => { throw new Error('expected a cycle'); }, (error: Error) => expect(error.message).toMatch(/cycle/));
    await service.command(WS, { type: 'set-item-placement', itemId: 'item-1', parentId: 'p', sortOrder: 2048 });
    await service.command(WS, { type: 'set-type-placement', typeId: 'decision', parentFolderId: 'item-1', parentKind: 'item', sortOrder: 1 });
    // Same parent, new order: a reorder.
    await service.command(WS, { type: 'move-document', documentId: 'child', parentFolderId: 'item-1', parentKind: 'item', sortOrder: 5 });
    // Removing p drops item-1's placement; what sits under item-1 stays with it.
    await removeForGood(service, 'p');
    service.dispose();
    await db.close();

    service = await open();
    const snapshot = await service.snapshot(WS);
    expect(snapshot.items).toEqual([expect.objectContaining({ documentId: 'child', parentFolderId: 'item-1', parentKind: 'item', sortOrder: 5 })]);
    expect(snapshot.itemPlacements).toEqual([]);
    expect(snapshot.typePlacements).toEqual([expect.objectContaining({ typeId: 'decision', parentFolderId: 'item-1', parentKind: 'item' })]);
  });

  it('trashes and restores a document without deleting it', async () => {
    const service = await open();
    await service.command(WS, { type: 'register-document', documentId: 'd1', title: 'Doc', documentType: 'markdown', parentFolderId: null });
    await service.command(WS, { type: 'trash-document', documentId: 'd1', trashedAt: 1_700_000_000_000 });
    expect((await service.snapshot(WS)).items[0].trashedAt).toBe(1_700_000_000_000);
    await service.command(WS, { type: 'restore-document', documentId: 'd1' });
    expect((await service.snapshot(WS)).items[0].trashedAt).toBeNull();
  });

  it('deletes a page for good only on a purge of a page already in Trash, as the team store does', async () => {
    const service = await open();
    await service.command(WS, { type: 'register-document', documentId: 'd1', title: 'Doc', documentType: 'markdown', parentFolderId: null });
    const only = async () => (await service.snapshot(WS)).items.filter((item) => item.documentId === 'd1');

    // A live page goes to Trash, purge or not: one call never removes it.
    await service.command(WS, { type: 'remove-document', documentId: 'd1', purge: true });
    const [trashed] = await only();
    expect(trashed.trashedAt).toEqual(expect.any(Number));
    // A plain remove of a page in Trash changes nothing.
    await service.command(WS, { type: 'remove-document', documentId: 'd1' });
    expect(await only()).toEqual([expect.objectContaining({ trashedAt: trashed.trashedAt })]);

    await service.command(WS, { type: 'remove-document', documentId: 'd1', purge: true });
    expect(await only()).toEqual([]);
  });

  it('sends a removed subtree to Trash and deletes it only on a purge of what is in Trash', async () => {
    const service = await open();
    const page = (documentId: string, parentFolderId: string | null) =>
      service.command(WS, { type: 'register-document', documentId, title: documentId, documentType: 'markdown', parentFolderId });
    await page('a', null);
    await page('b', 'a');
    await page('deep', 'b');
    await page('earlier', 'a');
    await service.command(WS, { type: 'trash-document', documentId: 'earlier', trashedAt: 5 });
    await service.command(WS, { type: 'set-type-placement', typeId: 'bug', parentFolderId: 'b', sortOrder: 0 });
    const state = async () => Object.fromEntries((await service.snapshot(WS)).items.map((doc) => [doc.documentId, doc.trashedAt]));

    // An older renderer's delete, purge or not: one call never removes a live subtree.
    await service.command(WS, { type: 'remove-folder', folderId: 'a', purge: true });
    const trashed = await state();
    expect(trashed.a).toEqual(expect.any(Number));
    // One trash time for the subtree, so restore brings it back together; a page already in Trash keeps its own.
    expect([trashed.b, trashed.deep]).toEqual([trashed.a, trashed.a]);
    expect(trashed.earlier).toBe(5);
    // Placements stay, so a restored page gets its types back.
    expect((await service.snapshot(WS)).typePlacements).toEqual([expect.objectContaining({ typeId: 'bug', parentFolderId: 'b' })]);
    await service.command(WS, { type: 'remove-folder', folderId: 'a' });
    expect(await state()).toEqual(trashed);

    await service.command(WS, { type: 'remove-folder', folderId: 'a', purge: true });
    expect(await state()).toEqual({});
    expect((await service.snapshot(WS)).typePlacements).toEqual([]);
  });

  it('never purges a page another window restored after the purge read it', async () => {
    await open();
    await purgeLosesARaceWithARestore(db);
  });

  it('refuses to move a page into its own descendant or under a missing page', async () => {
    const service = await open();
    await service.command(WS, { type: 'register-document', documentId: 'a', title: 'A', documentType: 'markdown', parentFolderId: null });
    await service.command(WS, { type: 'register-document', documentId: 'b', title: 'B', documentType: 'markdown', parentFolderId: 'a' });
    await expect(service.command(WS, { type: 'move-document', documentId: 'a', parentFolderId: 'b' })).rejects.toThrow(/cycle|descendant/i);
    await expect(service.command(WS, { type: 'move-folder', folderId: 'a', parentFolderId: 'a' })).rejects.toThrow();
    await expect(service.command(WS, { type: 'set-item-placement', itemId: 'i', parentId: 'gone', sortOrder: 0 })).rejects.toThrow(/Unknown personal page/);
    const pages = (await service.snapshot(WS)).items;
    expect(pages.find((page) => page.documentId === 'a')?.parentFolderId).toBeNull();
  });

  it('removes a page subtree, letting types and typed pages placed in it fall back', async () => {
    const service = await open();
    await service.command(WS, { type: 'register-folder', folderId: 'a', name: 'A', parentFolderId: null, sortOrder: 0 });
    await service.command(WS, { type: 'register-folder', folderId: 'b', name: 'B', parentFolderId: 'a', sortOrder: 0 });
    await service.command(WS, { type: 'register-document', documentId: 'd1', title: 'Deep', documentType: 'markdown', parentFolderId: 'b' });
    await service.command(WS, { type: 'register-document', documentId: 'd2', title: 'Root', documentType: 'markdown', parentFolderId: null });
    await service.command(WS, { type: 'set-type-placement', typeId: 'bug', parentFolderId: 'b', sortOrder: 0 });
    await service.command(WS, { type: 'set-item-placement', itemId: 'in-b', parentId: 'b', sortOrder: 0 });
    await service.command(WS, { type: 'set-item-placement', itemId: 'at-root', parentId: null, sortOrder: 0 });
    await removeForGood(service, 'a');
    const snapshot = await service.snapshot(WS);
    expect(snapshot.typePlacements).toEqual([]);
    expect(snapshot.itemPlacements.map((p) => p.itemId)).toEqual(['at-root']);
    expect(snapshot.items.map((d) => d.documentId)).toEqual(['d2']);
  });

  it('keeps a type page\'s prose with its type across moves and subtree removal', async () => {
    const service = await open();
    const page = (documentId: string, parentFolderId: string | null) =>
      service.command(WS, { type: 'register-document', documentId, title: documentId, documentType: 'markdown', parentFolderId });
    await page('p', null);
    await page('q', null);
    await page('p-child', 'p');
    await service.command(WS, { type: 'set-type-placement', typeId: 'module', parentFolderId: 'p', sortOrder: 0 });
    await service.command(WS, { type: 'set-type-placement', typeId: 'person', parentFolderId: 'p-child', sortOrder: 0 });
    await page('type-page:module', 'p');
    await page('type-page:person', 'p-child');
    // Prose left under P by an older build while its type sits under Q.
    await page('type-page:stale', 'p');
    await service.command(WS, { type: 'set-type-placement', typeId: 'stale', parentFolderId: 'q', sortOrder: 0 });
    await service.command(WS, { type: 'move-document', documentId: 'type-page:stale', parentFolderId: 'p' });

    // Moving the type moves its prose.
    await service.command(WS, { type: 'set-type-placement', typeId: 'module', parentFolderId: 'q', sortOrder: 0 });
    const parentOf = async (id: string) =>
      (await service.snapshot(WS)).items.find((doc) => doc.documentId === id)?.parentFolderId;
    expect(await parentOf('type-page:module')).toBe('q');

    await removeForGood(service, 'p');
    const ids = (await service.snapshot(WS)).items.map((doc) => doc.documentId).sort();
    // person's type was inside P, so its prose went too; stale's was outside, so it moved out.
    expect(ids).toEqual(['q', 'type-page:module', 'type-page:stale']);
    expect(await parentOf('type-page:stale')).toBe('q');
  });

  it('keeps a page moved out of the subtree before the removal, even mid-removal', async () => {
    const service = await open();
    const seed = async (svc: PersonalPagesService) => {
      await svc.command(WS, { type: 'register-folder', folderId: 'a', name: 'A', parentFolderId: null, sortOrder: 0 });
      await svc.command(WS, { type: 'register-folder', folderId: 'b', name: 'B', parentFolderId: 'a', sortOrder: 0 });
      await svc.command(WS, { type: 'register-document', documentId: 'in-b', title: 'In B', documentType: 'markdown', parentFolderId: 'b' });
    };
    const survivors = async () => (await service.snapshot(WS)).items.map((d) => d.documentId);

    // Sequential: the move lands first.
    await seed(service);
    await service.command(WS, { type: 'move-folder', folderId: 'b', parentFolderId: null });
    await removeForGood(service, 'a');
    expect(await survivors()).toEqual(['b', 'in-b']);
    await removeForGood(service, 'b');

    // Interleaved: the move commits after remove-folder has started, right
    // before its transaction takes the write lock. Membership captured any
    // earlier would still delete B.
    await seed(service);
    const racing = new PersonalPagesService({
      db: () => ({
        query: (sql, params) => db.query(sql, params),
        runTransaction: async (statements) => {
          await service.command(WS, { type: 'move-folder', folderId: 'b', parentFolderId: null });
          return db.runTransaction(statements);
        },
      }),
      history,
      notify,
    });
    await removeForGood(racing, 'a');
    expect(await survivors()).toEqual(['b', 'in-b']);
  });

  // Seeded once per workspace: a renamed, edited or deleted Home is never
  // restored or overwritten on a later launch.
  it('seeds an editable Home page once per workspace, across launches', async () => {
    const seeded = new Set<string>();
    const homeSeed = { seeded: (ws: string) => seeded.has(ws), markSeeded: (ws: string) => { seeded.add(ws); } };
    const relaunch = async () => {
      await db?.close();
      const plain = await open();
      plain.dispose();
      return new PersonalPagesService({ db: () => db, history, notify, homeSeed });
    };

    let service = await relaunch();
    const first = await service.snapshot(WS);
    expect(first.items).toEqual([expect.objectContaining({ documentId: PERSONAL_HOME_PAGE_ID, title: 'Home', documentType: 'markdown', parentFolderId: null })]);
    const body = await service.getBody(WS, PERSONAL_HOME_PAGE_ID);
    expect(body?.content).toContain('New page');
    expect(seeded.has(WS)).toBe(true);

    await service.command(WS, { type: 'update-document-title', documentId: PERSONAL_HOME_PAGE_ID, title: 'Start here' });
    await service.updateBody(WS, PERSONAL_HOME_PAGE_ID, 'My own notes', body!.version);
    service = await relaunch();
    expect((await service.snapshot(WS)).items).toEqual([expect.objectContaining({ documentId: PERSONAL_HOME_PAGE_ID, title: 'Start here' })]);
    expect((await service.getBody(WS, PERSONAL_HOME_PAGE_ID))?.content).toBe('My own notes');

    // Trashed is not deleted, and the seed must not bring it back either way.
    await service.command(WS, { type: 'remove-document', documentId: PERSONAL_HOME_PAGE_ID });
    service = await relaunch();
    expect((await service.snapshot(WS)).items).toEqual([expect.objectContaining({ documentId: PERSONAL_HOME_PAGE_ID, trashedAt: expect.any(Number) })]);
    await service.command(WS, { type: 'remove-document', documentId: PERSONAL_HOME_PAGE_ID, purge: true });
    service = await relaunch();
    expect((await service.snapshot(WS)).items).toEqual([]);
    // A workspace that already has pages gets its Home too.
    await service.command('/ws/existing', { type: 'register-document', documentId: 'd1', title: 'Doc', documentType: 'markdown', parentFolderId: null });
    expect((await service.snapshot('/ws/existing')).items.map((item) => item.documentId).sort()).toEqual(['d1', PERSONAL_HOME_PAGE_ID]);
  });

  it('returns a conflict with the current content on a stale expectedVersion', async () => {
    const service = await open();
    await service.command(WS, { type: 'register-document', documentId: 'd1', title: 'Doc', documentType: 'markdown', parentFolderId: null });
    await service.updateBody(WS, 'd1', 'first', 0);
    await service.updateBody(WS, 'd1', 'second', 1);
    expect(await service.updateBody(WS, 'd1', 'stale', 1)).toEqual({ conflict: true, version: 2, content: 'second' });
    expect(await service.getBody(WS, 'd1')).toEqual({ content: 'second', version: 2 });
  });

  it('keeps a page\'s own fields across a second launch', async () => {
    const service = await open();
    await pageFieldsRoundTrip(service, async () => {
      service.dispose();
      await db.close();
      return open();
    });
  });

  it('requires a workspace path', async () => {
    const service = await open();
    await expect(service.snapshot('')).rejects.toThrow(/workspacePath/);
  });
});

describe('PersonalPagesService on PGLite', () => {
  // Runs the worker.js mirror DDL itself, so the PGLite schema cannot drift
  // from what this store queries without failing here.
  const mirrorDdl = (version = '0049') => {
    const source = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'worker.js'), 'utf8');
    const start = source.indexOf(`Mirror of SQLite migration ${version}`);
    const ddl = source.slice(start).match(/exec\(`([\s\S]*?)`\)/);
    if (start < 0 || !ddl) throw new Error(`${version} mirror block not found in worker.js`);
    return ddl[1];
  };

  it('turns folders into pages once, keeping the folder rows, across launches', async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    const pglite = new PGlite();
    try {
      await pglite.exec(mirrorDdl('0049'));
      await pglite.exec(`
        INSERT INTO personal_page_folders (workspace_path, folder_id, parent_folder_id, name, sort_order, created_at, updated_at)
        VALUES ('${WS}', 'f-arch', NULL, 'Architecture', 1, NOW(), NOW()), ('${WS}', 'f-specs', 'f-arch', 'Specs', 2, NOW(), NOW());
        INSERT INTO personal_page_documents (workspace_path, document_id, title, document_type, parent_folder_id, created_at, updated_at)
        VALUES ('${WS}', 'd1', 'Intro', 'markdown', 'f-specs', NOW(), NOW());
      `);
      await pglite.exec(mirrorDdl('0050'));
      const pages = async () => (await pglite.query<{ document_id: string; title: string; parent_folder_id: string | null }>(
        `SELECT document_id, title, parent_folder_id FROM personal_page_documents ORDER BY document_id`,
      )).rows.map((row) => [row.document_id, row.title, row.parent_folder_id]);
      expect(await pages()).toEqual([['d1', 'Intro', 'f-specs'], ['f-arch', 'Architecture', null], ['f-specs', 'Specs', 'f-arch']]);
      const marked = await pglite.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM personal_page_folders WHERE converted_at IS NOT NULL');
      expect(marked.rows[0].n).toBe(2);

      // The worker reruns the block on every launch: a deleted page stays deleted.
      await pglite.query(`DELETE FROM personal_page_documents WHERE document_id = 'f-specs'`);
      await pglite.exec(mirrorDdl('0049'));
      await pglite.exec(mirrorDdl('0050'));
      expect(await pages()).toEqual([['d1', 'Intro', 'f-specs'], ['f-arch', 'Architecture', null]]);
    } finally {
      await pglite.close();
    }
  });

  /** A PGLite on the current mirror schema, behind the store's database interface. */
  const openPglite = async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    const pglite = new PGlite();
    await pglite.exec(mirrorDdl('0049'));
    await pglite.exec(mirrorDdl('0050'));
    // The worker reruns every block on each launch.
    await pglite.exec(mirrorDdl('0051'));
    await pglite.exec(mirrorDdl('0051'));
    await pglite.exec(mirrorDdl('0052'));
    await pglite.exec(mirrorDdl('0052'));
    const db = {
      query: (sql: string, params?: unknown[]) => pglite.query(sql, params) as Promise<{ rows: any[] }>,
      runTransaction: async (statements: Array<{ sql: string; params?: unknown[] }>) => {
        await pglite.transaction(async (tx) => {
          for (const statement of statements) await tx.query(statement.sql, statement.params);
        });
      },
    };
    const service = new PersonalPagesService({ db: () => db, history: { createSnapshot: vi.fn(async () => undefined) }, notify: vi.fn() });
    return { pglite, db, service };
  };

  it('sends a removed subtree to Trash and deletes it only on a purge of what is in Trash', async () => {
    const { pglite, service } = await openPglite();
    try {
      const page = (documentId: string, parentFolderId: string | null) =>
        service.command(WS, { type: 'register-document', documentId, title: documentId, documentType: 'markdown', parentFolderId });
      await page('a', null);
      await page('b', 'a');
      await page('deep', 'b');
      await page('earlier', 'a');
      await service.command(WS, { type: 'trash-document', documentId: 'earlier', trashedAt: 5 });
      await service.command(WS, { type: 'set-type-placement', typeId: 'bug', parentFolderId: 'b', sortOrder: 0 });
      const state = async () => Object.fromEntries((await service.snapshot(WS)).items.map((doc) => [doc.documentId, doc.trashedAt]));

      await service.command(WS, { type: 'remove-folder', folderId: 'a', purge: true });
      const trashed = await state();
      expect(trashed.a).toEqual(expect.any(Number));
      expect([trashed.b, trashed.deep]).toEqual([trashed.a, trashed.a]);
      expect(trashed.earlier).toBe(5);
      expect((await service.snapshot(WS)).typePlacements).toEqual([expect.objectContaining({ typeId: 'bug', parentFolderId: 'b' })]);
      await service.command(WS, { type: 'remove-folder', folderId: 'a' });
      expect(await state()).toEqual(trashed);

      await service.command(WS, { type: 'remove-folder', folderId: 'a', purge: true });
      expect(await state()).toEqual({});
      expect((await service.snapshot(WS)).typePlacements).toEqual([]);
    } finally {
      await pglite.close();
    }
  });

  it('never purges a page another window restored after the purge read it', async () => {
    const { pglite, db } = await openPglite();
    try {
      await purgeLosesARaceWithARestore(db);
    } finally {
      await pglite.close();
    }
  });

  it('keeps a page\'s own fields', async () => {
    const { pglite, service } = await openPglite();
    try {
      await pageFieldsRoundTrip(service);
    } finally {
      await pglite.close();
    }
  });

  it('round-trips the tree, trash timestamps and a body conflict', async () => {
    const { pglite, db, service } = await openPglite();
    try {
      await service.command(WS, { type: 'register-folder', folderId: 'f1', name: 'Specs', parentFolderId: null, sortOrder: 1.5 });
      await service.command(WS, { type: 'set-type-placement', typeId: 'bug', parentFolderId: 'f1', sortOrder: 0 });
      await service.command(WS, { type: 'register-document', documentId: 'd1', title: 'Doc', documentType: 'markdown', parentFolderId: 'f1' });
      await service.command(WS, { type: 'trash-document', documentId: 'd1', trashedAt: 1_700_000_000_000 });
      await service.updateBody(WS, 'd1', 'first', 0);
      expect(await service.updateBody(WS, 'd1', 'stale', 0)).toEqual({ conflict: true, version: 1, content: 'first' });

      const snapshot = await service.snapshot(WS);
      expect(snapshot.items[0]).toMatchObject({ documentId: 'f1', title: 'Specs', parentFolderId: null });
      expect(snapshot.items[1]).toMatchObject({ documentId: 'd1', trashedAt: 1_700_000_000_000, parentFolderId: 'f1' });
      expect(typeof snapshot.items[1].createdAt).toBe('number');
      await service.command(WS, { type: 'set-item-placement', itemId: 'item-1', parentId: 'f1', sortOrder: 0.5 });
      expect((await service.snapshot(WS)).itemPlacements).toEqual([expect.objectContaining({ itemId: 'item-1', sortOrder: 0.5, parentKind: 'page' })]);
      await service.command(WS, { type: 'move-document', documentId: 'd1', parentFolderId: 'f1', sortOrder: 2048 });
      expect((await service.snapshot(WS)).items[1]).toMatchObject({ documentId: 'd1', sortOrder: 2048, parentKind: 'page' });

      // Prose of a type placed outside the removed page survives at its type's parent (root here).
      await service.command(WS, { type: 'register-document', documentId: 'type-page:task', title: 'Tasks', documentType: 'markdown', parentFolderId: 'f1' });
      await service.command(WS, { type: 'set-type-placement', typeId: 'task', parentFolderId: null, sortOrder: 0 });
      await service.command(WS, { type: 'move-document', documentId: 'type-page:task', parentFolderId: 'f1' });

      await removeForGood(service, 'f1');
      const after = await service.snapshot(WS);
      expect(after.items.map((doc) => [doc.documentId, doc.parentFolderId])).toEqual([['type-page:task', null]]);
      expect(after.itemPlacements).toEqual([]);
      expect(after.typePlacements.map((placement) => placement.typeId)).toEqual(['task']);

      const seeding = new PersonalPagesService({
        db: () => db, history: { createSnapshot: vi.fn(async () => undefined) }, notify: vi.fn(),
        homeSeed: { seeded: () => false, markSeeded: vi.fn() },
      });
      expect((await seeding.snapshot(WS)).items.find((doc) => doc.documentId === PERSONAL_HOME_PAGE_ID)).toMatchObject({ title: 'Home' });
      expect((await seeding.getBody(WS, PERSONAL_HOME_PAGE_ID))?.content).toContain('New page');
    } finally {
      await pglite.close();
    }
  });
});
